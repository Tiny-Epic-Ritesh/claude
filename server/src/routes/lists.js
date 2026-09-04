/**
 * Lead Lists (BUG-25).
 *
 * A list is a saved question, not a grant. Membership is composed with the
 * reader's own scope on every read, so sharing a list never widens what someone
 * can see — a supervisor and an RM opening the same list correctly get
 * different row counts.
 *
 * The bulk actions are the reason this module needs care. They are the fastest
 * way to do something regrettable to several thousand client records at once,
 * so every one of them states its count before it runs, filters for consent
 * before it sends, and writes one audit row per record rather than one per
 * action — because "was this client contacted" has to stay answerable.
 */

import { Router } from 'express';
import { all, one, run, audit, notify, LEAD_STAGES } from '../db.js';
import {
  requireUser, requirePermission, reqScope, activeOrg, orgsFor, can,
} from '../auth.js';
import { validate, activeMaskers } from '../security.js';
import { validateTree, describe, conditionSchema, FIELDS } from '../engine/conditions.js';
import {
  LIST_KINDS, KIND_LABEL, KIND_HELP, normaliseKind, membersSql, refreshList,
  mayReadList, mayWriteList, isSnapshot, validateGovernance, defaultExpiry,
  DEFAULT_SNAPSHOT_DAYS, DEFAULT_KIND,
} from '../engine/leadlists.js';
import { request as requestApproval, BULK_THRESHOLD } from '../engine/approvals.js';
import { checkConsent } from '../engine/consent.js';
import { send, pushToAutodialler } from '../integrations.js';

const router = Router();
router.use(requireUser);

/** The largest set one action may touch. Past this, it is an import job. */
const BULK_CAP = 5000;

/**
 * Why a send was suppressed, in words a marketer can act on.
 *
 * Grouped by code rather than by the consent engine's message, because that
 * message names the person — "Arnav's mobile number is flagged invalid" — which
 * is right on one record and useless in a summary, where it produces one row
 * per lead instead of a count.
 */
const SUPPRESSION_LABEL = {
  no_destination: 'no contact detail on record',
  invalid_destination: 'contact detail flagged invalid',
  channel_opted_out: 'opted out of this channel',
  opted_out: 'opted out of marketing',
  unknown_channel: 'channel not available',
  no_lead: 'record missing',
};

const tally = (counts) => [...counts]
  .map(([code, count]) => ({ code, count, reason: SUPPRESSION_LABEL[code] ?? code }))
  .sort((a, b) => b.count - a.count);

const loadList = (req) => one('SELECT * FROM lead_lists WHERE id = ?', [req.params.id]);

/**
 * Resolve a list to lead ids the caller may actually see.
 *
 * membersSql answers "what is in this list"; reqScope answers "what may this
 * person open". Both, always, ANDed.
 */
function memberIds(list, req, cap = BULK_CAP) {
  const members = membersSql(list);
  const scope = reqScope(req, 'l');
  return all(
    `SELECT l.id FROM leads l
      WHERE l.deleted_at IS NULL AND (${members.sql}) AND (${scope.sql})
      LIMIT ?`,
    [...members.params, ...scope.params, cap],
  ).map((r) => r.id);
}

function memberCount(list, req) {
  const members = membersSql(list);
  const scope = reqScope(req, 'l');
  return one(
    `SELECT COUNT(*) n FROM leads l
      WHERE l.deleted_at IS NULL AND (${members.sql}) AND (${scope.sql})`,
    [...members.params, ...scope.params],
  ).n;
}

/**
 * The condition schema, with real choices attached to the enum fields.
 *
 * The engine knows a field is an enum; it does not know that `stage` means
 * New / Contacted / Qualified. Those live in the metadata layer, which is where
 * an administrator edits them. Joining the two here means the builder offers
 * the same values the pickers on a lead offer — a filter written against a
 * value nobody can select is a filter that matches nothing.
 */
function enrichedSchema() {
  const schema = conditionSchema();
  return {
    ...schema,
    fields: schema.fields.map((f) => {
      if (f.type !== 'enum') return f;
      const def = one(
        "SELECT id FROM field_def WHERE entity = 'lead' AND api_name = ? AND active = 1",
        [f.code],
      );
      if (!def) return f;
      const values = all(
        'SELECT value, label FROM picklist_value WHERE field_id = ? AND active = 1 ORDER BY sort_order, label',
        [def.id],
      );
      return values.length ? { ...f, values } : f;
    }),
  };
}

/* --------------------------------------------------------------- meta */

router.get('/meta', (_req, res) => res.json({
  kinds: LIST_KINDS.map((k) => ({
    code: k, label: KIND_LABEL[k], help: KIND_HELP[k], snapshot: isSnapshot(k),
    /* Stated rather than assumed, so the interface preselects what the API
       would have chosen anyway and the two cannot drift apart. */
    default: k === DEFAULT_KIND,
  })),
  default_kind: DEFAULT_KIND,
  stages: LEAD_STAGES,
  bulk_cap: BULK_CAP,
  /* The 27 fields and their operators, so a builder can be driven by the same
     definitions the query compiler uses. The engine has always supported nested
     AND/OR groups over all of them; nothing exposed the catalogue, so the only
     filter anybody could express through the interface was a single stage. */
  schema: enrichedSchema(),
  /* What a snapshot costs to make, stated where it is made. */
  snapshot_default_days: DEFAULT_SNAPSHOT_DAYS,
  default_expiry: defaultExpiry(),
  /* Which lead columns a list may choose to show. */
  columns: COLUMN_CHOICES,
  /* Which fields a bulk edit may set. Stated here rather than repeated in the
     interface, so a dialog cannot offer a field the route will refuse. Labels
     and values come from the schema above, which is where they already live. */
  bulk_editable: [...BULK_EDITABLE],
}));

/* --------------------------------------------------------------- list */

router.get('/', (req, res) => {
  const orgs = orgsFor(req.user);
  const rows = all(
    `SELECT ll.*, u.name AS owner_name, r.name AS refreshed_by_name
       FROM lead_lists ll
       LEFT JOIN users u ON u.id = ll.owner_id
       LEFT JOIN users r ON r.id = ll.last_refreshed_by
      WHERE ll.sales_org IN (${orgs.map(() => '?').join(',') || "''"})
      ORDER BY ll.created_at DESC`,
    orgs,
  ).filter((l) => mayReadList(l, req.user));

  res.json(rows.map((l) => ({
    ...l,
    kind: normaliseKind(l.kind),
    kind_label: KIND_LABEL[normaliseKind(l.kind)],
    // Counted under the reader's scope, so the number on the card always
    // matches the number of rows they get when they open it.
    member_count: memberCount(l, req),
  })));
});

/* ------------------------------------------------------------- create */

router.post('/', requirePermission('list.create'), (req, res) => {
  const {
    name, criteria = null, description = null, shared_with = [],
    snapshot_reason: reason = null, expires_at: expires = null, columns = null,
  } = req.body ?? {};

  /* A destructuring default only fires on `undefined`, and "not stated" arrives
     as `null` just as often — an interface that has not finished loading its
     metadata sends the field empty rather than omitting it. Both mean the same
     thing to a person, so they mean the same thing here. */
  const kind = req.body?.kind ?? DEFAULT_KIND;

  const bad = validate(req.body, { name: ['required', 'max:120'] });
  if (bad) return res.status(400).json(bad);

  const k = normaliseKind(kind);
  if (!LIST_KINDS.includes(kind)) {
    return res.status(400).json({ error: `Kind must be one of: ${LIST_KINDS.join(', ')}` });
  }

  /* A filter-driven list without a filter is not a list, it is an empty set
     waiting to confuse someone. And a snapshot has to say why it is frozen and
     when it lapses — the two questions nobody could answer about the legacy
     tenant's 4,810 lists. */
  if (!isSnapshot(k)) {
    /* Absent and malformed are different mistakes and get different answers.
       Asking validateTree about `null` gets "Not a condition", which was then
       reported as though somebody had written a bad filter rather than none —
       masked until now because the default kind was static and an unstated kind
       never reached this branch. */
    if (!criteria) {
      return res.status(400).json({
        error: `A ${KIND_LABEL[k].toLowerCase()} list needs a filter to build from.`,
        field: 'criteria',
      });
    }
    const problems = validateTree(criteria);
    if (problems.length) return res.status(400).json({ error: problems[0].error, problems });
  }

  const governance = validateGovernance({ kind: k, criteria, snapshot_reason: reason, expires_at: expires });
  if (governance) return res.status(400).json(governance);

  const org = activeOrg(req) || req.user.sales_org;
  const result = run(
    `INSERT INTO lead_lists
       (name, kind, criteria, description, owner_id, created_by, shared_with, sales_org,
        snapshot_reason, expires_at, columns, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`,
    [
      String(name).trim(), k, criteria ? JSON.stringify(criteria) : null,
      description || (criteria ? describe(criteria) : null),
      req.user.id, req.user.id, JSON.stringify(shared_with), org,
      isSnapshot(k) ? String(reason).trim() : null,
      isSnapshot(k) ? expires : null,
      columns ? JSON.stringify(columns) : null,
    ],
  );

  const id = Number(result.lastInsertRowid);
  // A refreshable list is built once at creation, so it is never born empty.
  if (k === 'refreshable') refreshList(id, req.user.id);

  audit(req.user.id, 'list.create', 'lead_list', id, { kind: k, name });
  const list = one('SELECT * FROM lead_lists WHERE id = ?', [id]);
  res.status(201).json({ ...list, member_count: memberCount(list, req) });
});

/* ------------------------------------------------------------- detail */

router.get('/:id', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const members = membersSql(list);
  const scope = reqScope(req, 'l');
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  /* Sort, from a whitelist rather than the query string, because this lands in
     an ORDER BY. A list that can only be read in the order it happens to be
     stored is a list somebody exports to sort — the habit this whole feature
     exists to stop. */
  const sort = COLUMN_CHOICES.some((c) => c.key === req.query.sort) ? req.query.sort : null;
  const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sort
    ? `${sort === 'owner_name' ? 'u.name' : `l.${sort}`} ${dir}, l.id ASC`
    : 'l.updated_at DESC';

  /* Search within the list. Not a filter on the list itself — the list is still
     whatever its criteria say — just a way to find one row among thousands
     without paging to it. Bound to the identifiers somebody would actually
     search a lead by. */
  const q = String(req.query.q ?? '').trim();
  const search = q
    ? {
      sql: '(l.name LIKE ? OR l.mobile LIKE ? OR l.email LIKE ? OR l.client_code LIKE ?)',
      params: Array(4).fill(`%${q}%`),
    }
    : { sql: '1=1', params: [] };

  /* The list's own size, never narrowed by the search box. Every bulk action
     acts on the whole list, and the delete guard compares against this number —
     if a search could shrink it, "delete all 41" would fire after someone
     searched their way down to 3. */
  const total = memberCount(list, req);

  const matched = q
    ? one(
      `SELECT COUNT(*) n FROM leads l
         LEFT JOIN users u ON u.id = l.owner_id
        WHERE l.deleted_at IS NULL AND (${members.sql}) AND (${scope.sql}) AND ${search.sql}`,
      [...members.params, ...scope.params, ...search.params],
    ).n
    : total;
  const rows = all(
    /* Every choosable column, not just the five the table used to show. The
       chooser can only offer what the row actually carries, and at a 500-row
       cap the extra seven columns cost nothing worth measuring. The consent
       flags are not choosable — they are why a send count differs from a member
       count, so they are never hidden. */
    `SELECT l.id, l.name, l.mobile, l.email, l.stage, l.source, l.sales_org,
            l.client_code, l.city, l.state, l.language, l.risk_profile,
            l.aum, l.score, l.next_follow_up_at,
            l.marketing_opt_out, l.no_call, l.no_sms, l.no_email,
            l.no_whatsapp, l.mobile_invalid, l.created_at,
            u.name AS owner_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.deleted_at IS NULL AND (${members.sql}) AND (${scope.sql}) AND ${search.sql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...members.params, ...scope.params, ...search.params, limit, offset],
  );

  let criteria = null;
  try { criteria = list.criteria ? JSON.parse(list.criteria) : null; } catch { criteria = null; }

  res.set('X-Total-Count', String(total));
  res.json({
    ...list,
    kind: normaliseKind(list.kind),
    kind_label: KIND_LABEL[normaliseKind(list.kind)],
    kind_help: KIND_HELP[normaliseKind(list.kind)],
    criteria,
    criteria_text: criteria ? describe(criteria) : null,
    member_count: total,
    may_edit: mayWriteList(list, req.user),
    // Stated on the list itself, so nobody has to remember the rule.
    campaign_safe: normaliseKind(list.kind) !== 'dynamic',
    columns: columnsOf(list),
    /* What the caller is actually holding, so the interface can say "41 of
       12,519" instead of showing a hundred rows as though they were all of
       them. The legacy tenant had lists of 21,379; a table with no way past
       row 100 shows half a percent of one and says nothing about it. */
    limit,
    offset,
    shown: rows.length,
    matched,
    has_more: offset + rows.length < matched,
    sort,
    dir: dir.toLowerCase(),
    q: q || null,
    members: rows,
  });
});

/**
 * Choose which columns this list shows.
 *
 * The choice belongs to the list, not to the person looking at it: a list is
 * shared, and the columns are part of what is being shared. Someone who sends
 * "leads with no follow-up date" wants the recipient to see the follow-up
 * column without being told to add it.
 */
router.patch('/:id/columns', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) {
    return res.status(403).json({ error: 'Only the owner of a list can change its columns' });
  }

  const chosen = (Array.isArray(req.body?.columns) ? req.body.columns : [])
    .filter((k) => COLUMN_CHOICES.some((c) => c.key === k));
  // Order is the caller's, deduplicated — dragging a column twice is a slip,
  // not an instruction to show it twice.
  const columns = [...new Set(chosen)];
  if (!columns.length) return res.status(400).json({ error: 'A list has to show at least one column' });

  run("UPDATE lead_lists SET columns = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(columns), list.id]);
  audit(req.user.id, 'list.columns', 'lead_list', list.id, { columns });
  res.json({ columns });
});

/* ------------------------------------------------------------ refresh */

router.post('/:id/refresh', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) return res.status(403).json({ error: 'Only the list owner or an admin can refresh it' });

  const r = refreshList(list.id, req.user.id);
  if (!r.ok) return res.status(400).json({ error: r.error });

  const fresh = one('SELECT * FROM lead_lists WHERE id = ?', [list.id]);
  res.json({ ...r, list: { ...fresh, member_count: memberCount(fresh, req) } });
});

/* ------------------------------------------------------- membership */

const requireStatic = (list, res) => {
  if (normaliseKind(list.kind) === 'dynamic') {
    res.status(400).json({ error: 'A dynamic list is defined by its filter. Change the filter, not the members.' });
    return false;
  }
  return true;
};

router.post('/:id/members', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) return res.status(403).json({ error: 'Only the list owner or an admin can change membership' });
  if (!requireStatic(list, res)) return;

  const ids = (req.body?.lead_ids ?? []).map(Number).filter(Boolean).slice(0, BULK_CAP);
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one lead' });

  // Only leads the caller can actually see may be added — otherwise a list
  // becomes a way to launder visibility.
  const scope = reqScope(req, 'l');
  const allowed = all(
    `SELECT l.id FROM leads l
      WHERE l.deleted_at IS NULL AND l.id IN (${ids.map(() => '?').join(',')}) AND (${scope.sql})`,
    [...ids, ...scope.params],
  ).map((r) => r.id);

  for (const id of allowed) {
    run('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list.id, id]);
  }
  audit(req.user.id, 'list.members.add', 'lead_list', list.id, { added: allowed.length, requested: ids.length });
  res.json({ added: allowed.length, skipped: ids.length - allowed.length });
});

router.delete('/:id/members/:leadId', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) return res.status(403).json({ error: 'Only the list owner or an admin can change membership' });
  if (!requireStatic(list, res)) return;

  run('DELETE FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [list.id, req.params.leadId]);
  audit(req.user.id, 'list.members.remove', 'lead_list', list.id, { lead_id: Number(req.params.leadId) });
  res.json({ ok: true });
});

/* --------------------------------------------------------------- bulk */

/**
 * What a bulk action would do, before it does it.
 *
 * Every destructive or outbound action goes through this first, and the client
 * shows the count it returns. "412 of 500 will receive this, 88 suppressed" is
 * the difference between an informed decision and a surprise.
 */
router.post('/:id/preview', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const { action, channel } = req.body ?? {};
  const ids = memberIds(list, req);

  if (action !== 'message') {
    return res.json({ action, total: ids.length, will_apply: ids.length, suppressed: 0, reasons: [] });
  }

  const reasons = new Map();
  let willSend = 0;
  for (const id of ids) {
    const lead = one('SELECT * FROM leads WHERE id = ?', [id]);
    const verdict = checkConsent(lead, channel, 'marketing');
    if (verdict.allowed) { willSend += 1; continue; }
    reasons.set(verdict.code, (reasons.get(verdict.code) || 0) + 1);
  }

  res.json({
    action: 'message',
    channel,
    total: ids.length,
    will_apply: willSend,
    suppressed: ids.length - willSend,
    reasons: tally(reasons),
  });
});

/** Reassign every member to one owner. */
/* --------------------------------------------------- columns and export */

/**
 * The lead columns a list may choose to show, and how to read each one.
 *
 * Salesforce list views let every view pick and order its own columns. Ours
 * showed one fixed set, so anybody needing a different field exported to Excel
 * instead — which the audit identifies as the real signal behind 4,810 lists.
 *
 * `pii` marks the ones masked unless the reader may unmask, so an export cannot
 * quietly become the way client identifiers leave the building.
 */
export const COLUMN_CHOICES = [
  { key: 'name', label: 'Name' },
  { key: 'mobile', label: 'Mobile', pii: true },
  { key: 'email', label: 'Email', pii: true },
  { key: 'stage', label: 'Stage' },
  { key: 'source', label: 'Source' },
  { key: 'owner_name', label: 'Owner' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'language', label: 'Language' },
  { key: 'risk_profile', label: 'Risk profile' },
  { key: 'aum', label: 'AUM' },
  { key: 'score', label: 'Lead score' },
  { key: 'client_code', label: 'Client code' },
  { key: 'sales_org', label: 'Business' },
  { key: 'created_at', label: 'Created' },
  { key: 'next_follow_up_at', label: 'Next follow-up' },
];

const DEFAULT_COLUMNS = ['name', 'mobile', 'stage', 'owner_name', 'city'];

const columnsOf = (list) => {
  try {
    const saved = JSON.parse(list.columns ?? 'null');
    if (Array.isArray(saved) && saved.length) {
      return saved.filter((k) => COLUMN_CHOICES.some((c) => c.key === k));
    }
  } catch { /* a column set that will not parse is one nobody chose */ }
  return DEFAULT_COLUMNS;
};

/** One CSV cell. Quotes everything, so a comma in a name cannot shift a column. */
const csvCell = (v) => {
  if (v === null || v === undefined) return '""';
  return `"${String(v).replace(/"/g, '""')}"`;
};

/**
 * Export a list.
 *
 * People are exporting anyway — they were just doing it outside the product,
 * which is why the trail ended at the list. Recording who exported what, when,
 * how many rows and whether identifiers were in the clear turns an invisible
 * habit into evidence, which for a SEBI-regulated broker is the point.
 *
 * Masked by default. Unmasking is a separate capability and is recorded as
 * such — an export is the highest-volume way client data leaves, and it should
 * not be the one path where masking is skipped by omission.
 */
router.post('/:id/export', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const chosen = Array.isArray(req.body?.columns) && req.body.columns.length
    ? req.body.columns.filter((k) => COLUMN_CHOICES.some((c) => c.key === k))
    : columnsOf(list);
  if (!chosen.length) return res.status(400).json({ error: 'Choose at least one column' });

  const wantsClear = Boolean(req.body?.unmask);
  const mayUnmask = can(req.user.role, 'pii.unmask');
  if (wantsClear && !mayUnmask) {
    return res.status(403).json({
      error: 'Exporting identifiers in the clear needs the unmask permission',
      required: 'pii.unmask',
    });
  }
  const unmasked = wantsClear && mayUnmask;

  const members = membersSql(list);
  const scope = reqScope(req, 'l');
  const rows = all(
    `SELECT l.*, u.name AS owner_name FROM leads l
       LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.deleted_at IS NULL AND (${members.sql}) AND (${scope.sql})
      ORDER BY l.id
      LIMIT ?`,
    [...members.params, ...scope.params, BULK_CAP],
  );

  /* Which fields, and how much of them, from the maskable set rather than from
     this file (P3-11). `pii: true` on a column stays as a floor: it was the
     answer before the set was configurable and removing it could only ever
     unmask something that used to be masked. */
  const maskers = activeMaskers();
  const mask = (key, value) => {
    if (unmasked || !value) return value;

    const fn = maskers[key];
    if (fn) return fn(String(value)).replace(/\u2022/g, '*');

    const col = COLUMN_CHOICES.find((c) => c.key === key);
    return col?.pii ? `******${String(value).slice(-4)}` : value;
  };

  const header = chosen.map((k) => csvCell(COLUMN_CHOICES.find((c) => c.key === k)?.label ?? k)).join(',');
  const body = rows.map((r) => chosen.map((k) => csvCell(mask(k, r[k]))).join(',')).join('\n');

  /* One audit row for the export itself, naming what left. Not one per lead:
     this is a single act by one person, and 5,000 rows would bury the fact. */
  audit(req.user.id, 'list.export', 'lead_list', list.id, {
    list: list.name, rows: rows.length, columns: chosen, unmasked,
  });

  res.json({
    filename: `${list.name.replace(/[^\w\- ]+/g, '').trim() || 'list'}.csv`,
    rows: rows.length,
    unmasked,
    truncated: rows.length >= BULK_CAP,
    csv: `${header}\n${body}`,
  });
});

/**
 * Import a CSV of identifiers into a snapshot list.
 *
 * The other half of the round-trip the audit describes: somebody has a column
 * of client codes or mobiles from somewhere else and needs the leads behind
 * them. Doing it here makes the matching visible — what matched, what did not,
 * and why — instead of it happening in a spreadsheet nobody keeps.
 *
 * Only into a snapshot: adding rows by hand to a live query would make the
 * query a lie.
 */
router.post('/:id/import', (req, res) => {
  const list = loadList(req);
  if (!list || !mayWriteList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!isSnapshot(list.kind)) {
    return res.status(400).json({
      error: 'A live list is defined by its filter, so rows cannot be added to it',
      fix: 'Import into a snapshot, or widen the filter.',
    });
  }

  const field = ['client_code', 'mobile', 'pan'].includes(req.body?.match_on) ? req.body.match_on : 'client_code';
  const values = String(req.body?.values ?? '')
    .split(/[\r\n,;\t]+/)
    .map((v) => v.trim())
    .filter(Boolean);

  if (!values.length) return res.status(400).json({ error: 'Nothing to import' });
  if (values.length > BULK_CAP) {
    return res.status(400).json({ error: `That is ${values.length} rows — the most one import may carry is ${BULK_CAP}` });
  }

  const scope = reqScope(req, 'l');
  const matched = [];
  const missed = [];

  for (const v of values) {
    /* Mobile is matched on the last ten digits, because a column pasted out of
       a spreadsheet carries +91, spaces and hyphens inconsistently. */
    const row = field === 'mobile'
      ? one(
        `SELECT l.id FROM leads l WHERE l.deleted_at IS NULL AND (${scope.sql})
           AND replace(replace(replace(l.mobile,' ',''),'-',''),'+','') LIKE ?
         LIMIT 1`,
        [...scope.params, `%${v.replace(/\D/g, '').slice(-10)}`],
      )
      : one(
        `SELECT l.id FROM leads l WHERE l.deleted_at IS NULL AND (${scope.sql})
           AND lower(l.${field}) = lower(?) LIMIT 1`,
        [...scope.params, v],
      );
    if (row) matched.push(row.id); else missed.push(v);
  }

  let added = 0;
  for (const id of new Set(matched)) {
    if (one('SELECT 1 v FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [list.id, id])) continue;
    run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [list.id, id]);
    added += 1;
  }

  audit(req.user.id, 'list.import', 'lead_list', list.id, {
    match_on: field, offered: values.length, matched: matched.length, added, missed: missed.length,
  });

  res.json({
    ok: true,
    offered: values.length,
    matched: matched.length,
    added,
    already_present: matched.length - added,
    /* The rows that did not match come back, not just a count. "43 did not
       match" is not actionable; the 43 values are. */
    missed: missed.slice(0, 200),
    missed_total: missed.length,
  });
});

/* ------------------------------------------------------- more bulk actions */

/**
 * Push every member into the dialler campaign.
 *
 * Goes through the same `pushToAutodialler` the single-lead button uses, so a
 * list push and a one-off push load the campaign identically and report the
 * same partial-load truth. Inventing a second queue here would have given the
 * two paths different behaviour on the day one of them mattered.
 */
router.post('/:id/bulk/dialler', requirePermission('lead.contact'), async (req, res, next) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const ids = memberIds(list, req);
  const skipped = new Map();
  const eligible = [];

  for (const id of ids) {
    const lead = one('SELECT * FROM leads WHERE id = ?', [id]);
    if (!lead?.mobile) { skipped.set('no_destination', (skipped.get('no_destination') ?? 0) + 1); continue; }
    if (lead.mobile_invalid) { skipped.set('invalid_destination', (skipped.get('invalid_destination') ?? 0) + 1); continue; }

    // A dial is contact, so consent is checked the same way a send is.
    const verdict = checkConsent(lead, 'call', 'service');
    if (!verdict.allowed) {
      const code = verdict.code ?? 'opted_out';
      skipped.set(code, (skipped.get(code) ?? 0) + 1);
      continue;
    }
    eligible.push(id);
  }

  try {
    const result = eligible.length
      ? await pushToAutodialler(eligible, req.user.id)
      : { queued: 0, rejected: 0 };

    for (const id of eligible) {
      audit(req.user.id, 'lead.dialler.push', 'lead', id, { via_list: list.id });
    }

    return res.json({
      ok: true,
      requested: ids.length,
      pushed: result.queued ?? eligible.length,
      rejected: result.rejected ?? 0,
      simulated: result.simulated ?? undefined,
      skipped: tally(skipped),
    });
  } catch (err) {
    if (err.name === 'VendorError') return res.status(502).json({ error: err.message, vendor: err.vendor });
    return next(err);
  }
});

/** Add every member to another list, or take them out of one. */
router.post('/:id/bulk/membership', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const target = one('SELECT * FROM lead_lists WHERE id = ?', [Number(req.body?.target_id)]);
  if (!target || !mayWriteList(target, req.user)) return res.status(404).json({ error: 'Target list not found' });
  if (target.id === list.id) return res.status(400).json({ error: 'That is the same list' });
  if (!isSnapshot(target.kind)) {
    return res.status(400).json({ error: `"${target.name}" is a live list — its members come from its filter` });
  }

  const remove = req.body?.action === 'remove';
  const ids = memberIds(list, req);
  let changed = 0;

  for (const id of ids) {
    if (remove) {
      const r = run('DELETE FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [target.id, id]);
      changed += Number(r.changes ?? 0);
    } else if (!one('SELECT 1 v FROM lead_list_members WHERE list_id = ? AND lead_id = ?', [target.id, id])) {
      run('INSERT INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [target.id, id]);
      changed += 1;
    }
  }

  audit(req.user.id, remove ? 'list.members.remove' : 'list.members.add', 'lead_list', target.id, {
    from_list: list.id, requested: ids.length, changed,
  });

  res.json({ ok: true, requested: ids.length, changed, target: target.name, action: remove ? 'removed' : 'added' });
});

/**
 * Set one field to one value across the list.
 *
 * Deliberately narrow: only fields somebody would sensibly set in bulk, never
 * an identifier. `mobile` in this list would be a way to destroy the thing
 * every other record is matched on, and renaming 1,200 people at once is not a
 * feature anybody asked for.
 */
const BULK_EDITABLE = new Set(['stage', 'source', 'city', 'state', 'language', 'risk_profile', 'marketing_opt_out']);

router.post('/:id/bulk/field', requirePermission('lead.edit'), (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const field = String(req.body?.field ?? '');
  if (!BULK_EDITABLE.has(field)) {
    return res.status(400).json({
      error: `"${field}" cannot be set in bulk`,
      fix: `Bulk editing is limited to: ${[...BULK_EDITABLE].join(', ')}.`,
    });
  }

  const value = req.body?.value ?? null;
  const ids = memberIds(list, req);
  let changed = 0;
  let unchanged = 0;

  for (const id of ids) {
    const before = one(`SELECT ${field} AS v FROM leads WHERE id = ?`, [id]);
    if (!before) continue;
    if (String(before.v ?? '') === String(value ?? '')) { unchanged += 1; continue; }
    run(`UPDATE leads SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`, [value, id]);
    // One row per record: "what did this used to be" is the question asked
    // after a bulk edit goes wrong.
    audit(req.user.id, 'lead.bulk.field', 'lead', id, { field, from: before.v, to: value, via_list: list.id });
    changed += 1;
  }

  res.json({ ok: true, requested: ids.length, changed, unchanged });
});

/**
 * Delete every member of the list.
 *
 * Built at Ritesh's explicit instruction, against my recommendation, with the
 * safeguards that make it defensible: a soft delete the recovery path can undo,
 * its own capability, and a count the caller has to have seen. A mis-scoped
 * list is the likeliest input here — the audit shows lists are frequently
 * wrong — so the confirmation names the number rather than asking "are you
 * sure".
 */
router.post('/:id/bulk/delete', requirePermission('lead.delete'), (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const ids = memberIds(list, req);
  const confirmed = Number(req.body?.confirm_count);

  /* The count has to match what the caller was shown. A live query changes
     constantly, and this is the difference between deleting what they saw and
     deleting what they did not. */
  if (confirmed !== ids.length) {
    return res.status(409).json({
      error: `This list now holds ${ids.length} leads, not ${Number.isFinite(confirmed) ? confirmed : 'the number shown'}`,
      fix: 'It changed since you last looked. Check it again before deleting.',
      count: ids.length,
    });
  }

  let deleted = 0;
  for (const id of ids) {
    run(
      "UPDATE leads SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    audit(req.user.id, 'lead.delete', 'lead', id, { via_list: list.id, soft: true });
    deleted += 1;
  }

  audit(req.user.id, 'list.bulk.delete', 'lead_list', list.id, { deleted, list: list.name });
  res.json({ ok: true, deleted, recoverable: true });
});

router.post('/:id/bulk/reassign', requirePermission('lead.reassign'), (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const ownerId = Number(req.body?.owner_id);
  const owner = one('SELECT id, name, sales_org FROM users WHERE id = ? AND active = 1', [ownerId]);
  if (!owner) return res.status(400).json({ error: 'Choose an active user' });

  const ids = memberIds(list, req);

  /* Above the threshold this becomes a request rather than a change.

     It always should have been. `bulk_reassign` has been an approval scope
     since round 2 -- "bulk actions & lead reassignment" is one of the four the
     firm signed off -- and engine/approvals.js has carried a handler that
     applies it. Nothing ever asked for one, so a route could move any number of
     leads alone and BULK_THRESHOLD decided nothing. */
  const movable = ids.filter((id) => {
    const lead = one('SELECT sales_org FROM leads WHERE id = ?', [id]);
    return lead && lead.sales_org === owner.sales_org;
  });

  if (movable.length >= BULK_THRESHOLD) {
    const out = requestApproval({
      scope: 'bulk_reassign',
      entityId: owner.id,
      subjectName: owner.name,
      payload: { lead_ids: movable, owner_id: owner.id },
      reason: req.body?.reason,
      requestedBy: req.user.id,
    });
    if (!out.ok) return res.status(400).json(out);

    return res.status(202).json({
      ok: true,
      approval_required: true,
      request_id: out.request.id,
      requested: movable.length,
      threshold: BULK_THRESHOLD,
      message: `${movable.length} leads is over the ${BULK_THRESHOLD} that one person may move alone. `
        + 'It is waiting for approval.',
    });
  }

  let moved = 0;
  for (const id of ids) {
    const lead = one('SELECT id, owner_id, sales_org FROM leads WHERE id = ?', [id]);
    // Never move a lead into a business its new owner does not work in.
    if (!lead || lead.sales_org !== owner.sales_org) continue;
    run("UPDATE leads SET owner_id = ?, updated_at = datetime('now') WHERE id = ?", [ownerId, id]);
    // One row per record: "who was moved, and by whom" must stay answerable.
    audit(req.user.id, 'lead.reassign', 'lead', id, { from: lead.owner_id, to: ownerId, via_list: list.id });
    moved += 1;
  }

  notify(ownerId, 'Leads assigned to you', `${moved} leads from "${list.name}"`, '/leads');
  res.json({ ok: true, requested: ids.length, moved, skipped: ids.length - moved });
});

/** Move every member to one stage. */
router.post('/:id/bulk/stage', requirePermission('lead.stage.change'), (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const stage = req.body?.stage;
  if (!LEAD_STAGES.includes(stage)) {
    return res.status(400).json({ error: `Stage must be one of: ${LEAD_STAGES.join(', ')}` });
  }

  const ids = memberIds(list, req);
  for (const id of ids) {
    const before = one('SELECT stage FROM leads WHERE id = ?', [id]);
    if (!before || before.stage === stage) continue;
    run("UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE id = ?", [stage, id]);
    audit(req.user.id, 'lead.stage.change', 'lead', id, { from: before.stage, to: stage, via_list: list.id });
  }
  res.json({ ok: true, applied: ids.length, stage });
});

/** Create the same task against every member. */
router.post('/:id/bulk/task', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Give the task a title' });
  // due_at is NOT NULL, and a bulk task with no date is a bulk task nobody
  // does. Default to tomorrow rather than rejecting the request.
  const dueAt = req.body?.due_at
    || new Date(Date.now() + 864e5).toISOString().slice(0, 19).replace('T', ' ');

  const ids = memberIds(list, req);
  for (const id of ids) {
    const lead = one('SELECT owner_id FROM leads WHERE id = ?', [id]);
    run(
      `INSERT INTO tasks (lead_id, title, due_at, assignee_id, created_by, status)
       VALUES (?,?,?,?,?, 'Open')`,
      [id, title, dueAt, lead?.owner_id ?? req.user.id, req.user.id],
    );
  }
  audit(req.user.id, 'list.bulk.task', 'lead_list', list.id, { count: ids.length, title });
  res.json({ ok: true, created: ids.length });
});

/**
 * Bulk message.
 *
 * Consent is filtered here, not at the vendor, and the response reports exactly
 * who was suppressed and why. A send that silently drops half its audience is
 * indistinguishable from a broken integration.
 */
router.post('/:id/bulk/message', requirePermission('lead.contact'), (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });

  const { channel, body, intent = 'marketing' } = req.body ?? {};
  if (!['sms', 'whatsapp', 'email'].includes(channel)) {
    return res.status(400).json({ error: 'Channel must be sms, whatsapp or email' });
  }
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Write a message first' });

  const ids = memberIds(list, req);
  const reasons = new Map();
  let sent = 0;

  for (const id of ids) {
    const lead = one('SELECT * FROM leads WHERE id = ?', [id]);
    const verdict = checkConsent(lead, channel, intent);
    if (!verdict.allowed) {
      reasons.set(verdict.code, (reasons.get(verdict.code) || 0) + 1);
      continue;
    }
    // send() wants a destination, not a record — it has no business knowing
    // what a lead is.
    send(channel, {
      to: channel === 'email' ? lead.email : lead.mobile,
      body,
      subject: channel === 'email' ? `A note from ${req.user.name}` : undefined,
      leadId: id,
      userName: req.user.name,
    });
    run(
      `INSERT INTO activities (lead_id, type, direction, subject, body, user_id)
       VALUES (?,?, 'outbound', ?, ?, ?)`,
      [id, channel === 'email' ? 'Email' : channel === 'sms' ? 'SMS' : 'WhatsApp',
        `Bulk send from "${list.name}"`, body, req.user.id],
    );
    audit(req.user.id, 'lead.message', 'lead', id, { channel, intent, via_list: list.id });
    sent += 1;
  }

  res.json({
    ok: true,
    total: ids.length,
    sent,
    suppressed: ids.length - sent,
    reasons: tally(reasons),
  });
});

/* ------------------------------------------------------------- delete */

router.delete('/:id', (req, res) => {
  const list = loadList(req);
  if (!list || !mayReadList(list, req.user)) return res.status(404).json({ error: 'List not found' });
  if (!mayWriteList(list, req.user)) return res.status(403).json({ error: 'Only the list owner or an admin can delete it' });

  // A campaign pointing at a deleted list would lose its audience record, and
  // with it the ability to say who a send went to.
  const used = one('SELECT COUNT(*) n FROM campaigns WHERE list_id = ?', [list.id]).n;
  if (used) {
    return res.status(409).json({
      error: `"${list.name}" is used by ${used} campaign${used === 1 ? '' : 's'}. Detach it there first.`,
    });
  }

  run('DELETE FROM lead_lists WHERE id = ?', [list.id]);
  audit(req.user.id, 'list.delete', 'lead_list', list.id, { name: list.name });
  res.json({ ok: true });
});

export default router;
