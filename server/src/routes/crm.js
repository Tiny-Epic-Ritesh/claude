/**
 * Core CRM routes — leads, product cards, activities, tasks, notes and lists.
 */

import { Router } from 'express';
import { all, one, run, audit, notify, daysSince, ageBand, AGE_BANDS, CARD_COLOUR, LEAD_STAGES, CARD_STATES } from '../db.js';
import { can, requireUser, requirePermission, reqScope, isReadOnlyOnLeads, unmaskRequested, maskFor, orgsFor, activeOrg, mayUseOrg } from '../auth.js';
import { encryptField, decryptField, maskRecord, maskRecords, validate, blindIndex } from '../security.js';
import { applyScore } from '../engine/rules.js';
import { click2call, pushToAutodialler, send, logCall } from '../integrations.js';
import { checkConsent, contactability } from '../engine/consent.js';
import { derivedValues, describeFormula, describeRollup } from '../engine/formulas.js';
import { assignLead } from '../engine/assignment.js';
import { metricsFor } from '../engine/metrics.js';
import { kycStatusSql, kycStatusFor } from '../engine/kycstatus.js';
import { nextAction, nextStepForLead } from '../engine/nextaction.js';
import {
  listQueues, membersOf, mayTakeFrom, workIn, claimFromQueue, assignToQueue,
  setMembers, ownerOf,
} from '../engine/queues.js';
import {
  applyFieldSecurity, entityDef, fieldsOf, picklistValues, customValues,
  setCustomValues, recordChange, historyFor, FIELD_TYPES,
} from '../engine/metadata.js';

const router = Router();
router.use(requireUser);

/* ------------------------------------------------------------- helpers */

const decorate = (lead) => {
  const days = daysSince(lead.created_at) ?? 0;
  // PAN is stored encrypted; decrypt here, mask at the response boundary.
  lead = { ...lead, pan: decryptField(lead.pan) };
  const cards = all(
    `SELECT pc.*, pt.code AS product_code, pt.name AS product_name,
            pt.category AS product_category, pt.sort_order,
            prm.name AS product_rm_name
     FROM product_cards pc
     JOIN product_types pt ON pt.id = pc.product_type_id
     LEFT JOIN users prm ON prm.id = pc.product_rm_id
     WHERE pc.lead_id = ? AND pt.active = 1 ORDER BY pt.sort_order`,
    [lead.id],
  ).map((c) => ({ ...c, colour: CARD_COLOUR[c.state] || 'grey' }));

  const lastContact = one(
    "SELECT MAX(created_at) at FROM activities WHERE lead_id = ? AND type IN ('Call','WhatsApp','Email','SMS','Meeting')",
    [lead.id],
  );

  // Score and AUM come from the projection, never from a column on the lead.
  // `metricsFor` computes them on first read, so a lead created a moment ago
  // still has a score rather than a zero that quietly means "not yet built".
  const m = metricsFor(lead.id);

  return {
    ...lead,
    score: m?.score ?? 0,
    aum: m?.aum ?? 0,
    signals: m ? {
      days_since_contact: m.days_since_contact,
      connect_rate: m.connect_rate,
      products_held: m.products_held,
      untapped_products: m.untapped_products,
      open_cases: m.open_cases,
      furthest_state: m.furthest_state,
    } : null,
    score_components: m?.score_components ?? null,
    age_days: days,
    age_band: ageBand(days),
    days_since_contact: lastContact?.at ? daysSince(lastContact.at) : null,
    last_activity_at: one('SELECT MAX(created_at) at FROM activities WHERE lead_id = ?', [lead.id]).at,
    cards,
    open_tickets: one("SELECT COUNT(*) n FROM tickets WHERE lead_id = ? AND status NOT IN ('Resolved','Closed')", [lead.id]).n,
    owner_name: lead.owner_id ? one('SELECT name FROM users WHERE id = ?', [lead.owner_id])?.name : null,
    partner_name: lead.partner_id ? one('SELECT name FROM partners WHERE id = ?', [lead.partner_id])?.name : null,
  };
};

/** Every new lead gets one card per active product type — never created on demand. */
/**
 * Sources that represent a lead ARRIVING rather than being entered.
 * Only these are auto-routed; anything else stays with whoever created it.
 */
export const INBOUND_SOURCES = new Set([
  'Google', 'Google Ads', 'Facebook', 'Facebook Lead Ads', 'Instagram', 'LinkedIn',
  'Website', 'Web Form', 'Landing Page', 'Campaign', 'WhatsApp Campaign',
  'Email Campaign', 'Import', 'API', 'Partner Referral', 'Portal', 'Chatbot',
]);

export function generateCards(leadId) {
  // Only the selling org's catalogue. A Bonanza lead has no business carrying a
  // Bigul Connect card, and vice versa — the two businesses sell different
  // things to different people, which is exactly why products carry an org.
  const lead = one('SELECT sales_org FROM leads WHERE id = ?', [leadId]);
  const org = lead?.sales_org || 'BONANZA';

  const types = all('SELECT id FROM product_types WHERE active = 1 AND sales_org = ?', [org]);
  for (const t of types) {
    run('INSERT OR IGNORE INTO product_cards (lead_id, product_type_id, state) VALUES (?,?,?)', [leadId, t.id, 'INACTIVE']);
  }
}

/* --------------------------------------------------------------- leads */

/**
 * The lead list.
 *
 * WHY THIS IS NOT `decorate()` IN A LOOP
 * -------------------------------------
 * It used to be. `decorate()` runs four queries per lead — the product cards
 * with two joins, a MAX over activities, the metrics projection, and a PAN
 * decrypt — which is right for one record and catastrophic for a page of them.
 * At 289 leads that was roughly 1,150 queries, 1.4MB of JSON and up to two
 * seconds, on the screen every RM opens first.
 *
 * This does the same job in five set-based queries regardless of page size, and
 * returns only what a list row draws. `decorate()` stays exactly as it is for
 * the record view, where the per-lead cost is the point.
 *
 * PAN IS NOT DECRYPTED HERE
 * -------------------------
 * The list never shows it. Decrypting 500 PANs to mask all 500 of them is work
 * done purely to throw away, and it puts plaintext identifiers in memory on a
 * request that has no use for them.
 *
 * PAGING IS REAL NOW
 * ------------------
 * `limit` and `offset` are honoured and the unpaged total goes back in
 * `X-Total-Count`. The response stays a bare array so every existing caller and
 * test keeps working — the count is additive, not a breaking envelope.
 *
 * The age-band filter moved into SQL. It used to run in JavaScript *after*
 * `LIMIT 500`, so asking for "Cold" returned however many of the first 500 rows
 * happened to be cold — a number that looked like an answer and was not.
 */
router.get('/leads', (req, res) => {
  const scope = reqScope(req, 'l');
  const where = ['l.deleted_at IS NULL', scope.sql];
  const params = [...scope.params];

  const {
    q, stage, band, card_state, product_id, owner_id, partner_id, list_id,
  } = req.query;

  if (q) {
    // PAN is encrypted at rest, so it cannot be LIKE-searched. Exact PAN lookup
    // would use security.blindIndex(); name/mobile/email remain searchable.
    where.push('(l.name LIKE ? OR l.mobile LIKE ? OR l.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (stage) { where.push('l.stage = ?'); params.push(stage); }

  /* P2-17c. What the charts count, so clicking a bar opens its own records.
   *
   * `stages` is plural because the funnel is cumulative: "Contacted" on that
   * chart means Contacted and everything past it, and a single-stage filter
   * would open a strict subset while claiming to be the bar the reader
   * clicked. */
  if (req.query.stages) {
    const list = String(req.query.stages).split(',').map((x) => x.trim()).filter(Boolean);
    if (list.length) {
      where.push(`l.stage IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (req.query.source) {
    // 'Unknown' is what the chart labels a blank source, so it has to mean the
    // same thing here or that bar opens nothing.
    if (req.query.source === 'Unknown') where.push("COALESCE(NULLIF(TRIM(l.source), ''), 'Unknown') = 'Unknown'");
    else { where.push('l.source = ?'); params.push(req.query.source); }
  }

  /* P2-13. The date range the figure was counted over.
   *
   * A homepage tile reading "New leads 32" that opens a list of 40 is worse
   * than one that opens nothing: the reader believes the list. The tile now
   * hands over the same window it counted, and this is what applies it. */
  if (req.query.created_from) { where.push('date(l.created_at) >= date(?)'); params.push(req.query.created_from); }
  if (req.query.created_to) { where.push('date(l.created_at) <= date(?)'); params.push(req.query.created_to); }

  /* Nobody has logged contact, and it has been long enough to matter.
   *
   * Present tense on purpose, and deliberately not a date range: "unattended"
   * is a fact about now, not about a window. Expressed here rather than
   * approximated with an age band, which counts a different set. */
  if (req.query.unattended_hours) {
    const hours = Math.min(Math.max(Number(req.query.unattended_hours) || 48, 1), 24 * 90);
    where.push(`l.stage NOT IN ('Won','Lost')
      AND NOT EXISTS (SELECT 1 FROM activities a
                       WHERE a.lead_id = l.id
                         AND a.type IN ('Call','WhatsApp','Email','SMS','Meeting')
                         AND a.created_at > datetime('now', ?))`);
    params.push(`-${hours} hours`);
  }
  if (owner_id) { where.push('l.owner_id = ?'); params.push(owner_id); }
  if (partner_id) { where.push('l.partner_id = ?'); params.push(partner_id); }

  if (card_state) {
    where.push(`EXISTS (SELECT 1 FROM product_cards pc WHERE pc.lead_id = l.id AND pc.state = ?${product_id ? ' AND pc.product_type_id = ?' : ''})`);
    params.push(card_state);
    if (product_id) params.push(product_id);
  } else if (product_id) {
    where.push('EXISTS (SELECT 1 FROM product_cards pc WHERE pc.lead_id = l.id AND pc.product_type_id = ?)');
    params.push(product_id);
  }

  if (list_id) {
    where.push('EXISTS (SELECT 1 FROM lead_list_members m WHERE m.lead_id = l.id AND m.list_id = ?)');
    params.push(list_id);
  }

  // The band, in SQL, so it narrows before the limit rather than after it.
  const bandDef = AGE_BANDS.find((b) => b.code === band);
  if (bandDef) {
    const age = "CAST(julianday('now') - julianday(l.created_at) AS INTEGER)";
    where.push(Number.isFinite(bandDef.max) ? `${age} BETWEEN ? AND ?` : `${age} >= ?`);
    params.push(bandDef.min);
    if (Number.isFinite(bandDef.max)) params.push(bandDef.max);
  }

  const clause = where.join(' AND ');

  // Bounded whatever the caller asks for: an unbounded list over 495k rows is
  // a denial of service someone reaches by typing a big number into a URL.
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const total = one(`SELECT COUNT(*) n FROM leads l WHERE ${clause}`, params).n;

  const rows = all(
    `SELECT l.id, l.name, l.mobile, l.email, l.city, l.state, l.source, l.stage,
            l.language, l.risk_profile, l.sales_org, l.owner_id, l.partner_id,
            l.client_code, l.marketing_opt_out, l.mobile_invalid,
            l.created_at, l.updated_at, l.callback_at,
            ${kycStatusSql('l')} AS kyc_status,
            CAST(julianday('now') - julianday(l.created_at) AS INTEGER) AS age_days,
            u.name AS owner_name,
            p.name AS partner_name
     FROM leads l
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN partners p ON p.id = l.partner_id
     WHERE ${clause}
     ORDER BY l.updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  if (rows.length === 0) {
    res.set('X-Total-Count', String(total));
    return res.json([]);
  }

  // Everything else in one query each, keyed on just this page of ids.
  const ids = rows.map((r) => r.id);
  const list = ids.map(() => '?').join(',');

  const cards = all(
    `SELECT pc.lead_id, pc.state, pc.value, pt.code AS product_code, pt.name AS product_name
     FROM product_cards pc
     JOIN product_types pt ON pt.id = pc.product_type_id
     WHERE pc.lead_id IN (${list}) AND pt.active = 1
     ORDER BY pt.sort_order`,
    ids,
  );
  const cardsByLead = new Map();
  for (const c of cards) {
    if (!cardsByLead.has(c.lead_id)) cardsByLead.set(c.lead_id, []);
    cardsByLead.get(c.lead_id).push({ ...c, colour: CARD_COLOUR[c.state] || 'grey' });
  }

  const metrics = new Map(
    all(`SELECT lead_id, score, aum, days_since_contact FROM lead_metrics WHERE lead_id IN (${list})`, ids)
      .map((m) => [m.lead_id, m]),
  );

  const tickets = new Map(
    all(
      `SELECT lead_id, COUNT(*) n FROM tickets
       WHERE lead_id IN (${list}) AND status NOT IN ('Resolved','Closed')
       GROUP BY lead_id`,
      ids,
    ).map((t) => [t.lead_id, t.n]),
  );

  const leads = rows.map((l) => {
    const m = metrics.get(l.id);
    return {
      ...l,
      cards: cardsByLead.get(l.id) ?? [],
      score: m?.score ?? 0,
      aum: m?.aum ?? 0,
      days_since_contact: m?.days_since_contact ?? null,
      age_band: ageBand(l.age_days ?? 0),
      open_tickets: tickets.get(l.id) ?? 0,
    };
  });

  res.set('X-Total-Count', String(total));
  return res.json(maskRecords(leads, maskFor(req, 'lead_list')));
});

router.get('/leads/:id', (req, res) => {
  const lead = one(
    `SELECT l.*, ${kycStatusSql('l')} AS kyc_status
     FROM leads l WHERE l.id = ? AND l.deleted_at IS NULL`,
    [req.params.id],
  );
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const scope = reqScope(req, 'l');
  const visible = one(`SELECT 1 v FROM leads l WHERE l.id = ? AND ${scope.sql}`, [req.params.id, ...scope.params]);
  if (!visible) return res.status(403).json({ error: 'This lead is outside your visibility scope' });

  const id = req.params.id;
  const masking = maskFor(req, 'lead', Number(id));
  const full = decorate(lead);
  res.json({
    ...maskRecord(full, masking),
    /* P2-12. Computed here rather than in the browser: the ordering depends on
       what this role may actually do, and the client does not hold the
       capability set. */
    next_step: nextStepForLead(full.cards, req.caps ?? new Set()),
    read_only: isReadOnlyOnLeads(req.user.role),
    // Metadata open, content restricted: the fact and outcome of every
    // interaction stay visible; notes and recordings need ownership or
    // supervision. See engine/metadata.js.
    // One answer for "who owns this", whether that is a person or a queue.
    owner: ownerOf(lead),
    // What the action menu may offer, and why not when it may not. The API
    // re-checks on every send; this is so the UI can explain rather than fail.
    contactability: contactability(lead),
    // Whatever an administrator added in Setup, alongside the core columns.
    custom: customValues('lead', Number(id)),
    // Formula and roll-up fields, computed on read. Nothing is stored, so
    // nothing can be stale — which is the whole argument for schema over
    // automation.
    derived: derivedValues('lead', lead),
    // Field history is first-class, so "who changed the stage, and when?" is a
    // query rather than an archaeology exercise across the audit log.
    field_history: historyFor('lead', Number(id), 40),
    activities: applyFieldSecurity('interaction',
      all('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY a.created_at DESC LIMIT 100', [id]),
      req.user, { caps: req.caps }),
    tasks: all('SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.lead_id = ? ORDER BY t.status, t.due_at', [id]),
    notes: all('SELECT n.*, u.name AS user_name, u.role AS user_role FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.lead_id = ? ORDER BY n.pinned DESC, n.created_at DESC', [id]),
    tickets: all('SELECT * FROM tickets WHERE lead_id = ? ORDER BY created_at DESC', [id]),
    journeys: all(`SELECT j.*, pt.name AS product_name FROM kyc_journeys j JOIN product_types pt ON pt.id = j.product_type_id WHERE j.lead_id = ? ORDER BY j.created_at DESC`, [id]),
  });
});

router.post('/leads', requirePermission('lead.create'), (req, res) => {
  const { name, mobile, email, source, pan, city, state, risk_profile, language, owner_id, partner_id } = req.body;

  const invalid = validate(req.body, {
    name: ['required', 'max:120'],
    mobile: ['mobile'],
    email: ['email'],
    pan: ['pan'],
  });
  if (invalid) return res.status(400).json(invalid);

  // Duplicate guard on mobile — the single most common import defect.
  if (mobile) {
    const dupe = one('SELECT id, name FROM leads WHERE mobile = ? AND deleted_at IS NULL', [mobile]);
    if (dupe) return res.status(409).json({ error: `Mobile already belongs to lead #${dupe.id} (${dupe.name})`, duplicate_id: dupe.id });
  }

  // The lead belongs to a business. A caller may nominate one when they work in
  // both, but only from their own entitlement — never an org they cannot see.
  const org = req.body.sales_org || activeOrg(req) || req.user.sales_org || 'BONANZA';
  if (!mayUseOrg(req.user, org)) {
    return res.status(403).json({ error: `You cannot create leads in ${org}.` });
  }

  const result = run(
    `INSERT INTO leads (sales_org, name, mobile, email, source, pan, pan_bidx, city, state, risk_profile, language, owner_id, partner_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org, name, mobile || null, email || null, source || 'Manual',
      encryptField(pan ? String(pan).toUpperCase() : null),
      // The searchable fingerprint, written alongside the ciphertext so the two
      // can never describe different PANs.
      pan ? blindIndex(String(pan).toUpperCase()) : null,
      city || null, state || null,
      risk_profile || null, language || 'English', owner_id || req.user.id, partner_id || null],
  );
  const id = Number(result.lastInsertRowid);
  generateCards(id);

  /**
   * Who should own this?
   *
   * Automatic routing is for leads that ARRIVE — from a campaign, a web form,
   * an import or a partner. A lead a rep types in by hand is one they just
   * spoke to, and taking it off them would be perverse. So the default follows
   * the channel, and a caller can force either behaviour explicitly.
   *
   * An explicit owner always wins: someone naming an owner has already made
   * the decision the router exists to make.
   */
  const routable = req.body.route ?? (!owner_id && INBOUND_SOURCES.has(String(source || '').trim()));

  const routing = routable
    ? assignLead(one('SELECT * FROM leads WHERE id = ?', [id]), { fallbackUserId: req.user.id })
    : { user_id: owner_id || req.user.id, rule_id: null, assigned: false, reason: 'Kept with the creator (manual entry)' };

  audit(req.user.id, 'lead_created', 'lead', id, {
    name, source, sales_org: org, routed_to: routing.user_id, rule: routing.reason,
  });
  res.status(201).json({ ...decorate(one('SELECT * FROM leads WHERE id = ?', [id])), routing });
});

/**
 * The field list for a record form, from the metadata layer.
 *
 * This is what the metadata work was for. The edit form is not a hand-written
 * list of inputs that drifts from the schema every time someone adds a field —
 * it asks what the fields are and renders them. An administrator who adds
 * "Referral Code" in Setup sees it on this form immediately, with no deploy.
 *
 * Field-level security is applied here rather than in the client, so a field the
 * caller may not read never reaches the browser at all.
 */
router.get('/meta/fields/:entity', (req, res) => {
  const def = entityDef(req.params.entity);
  if (!def) return res.status(404).json({ error: 'No such object' });

  const caps = req.caps ?? new Set();

  const fields = fieldsOf(req.params.entity)
    .filter((f) => {
      // A capability-scoped field is only offered to holders. Owner-scoped
      // fields still appear — ownership is per-record and is enforced when the
      // record is read, not when the form is described.
      if (f.read_scope === 'capability') return f.read_capability ? caps.has(f.read_capability) : false;
      return true;
    })
    .map((f) => ({
      api_name: f.api_name,
      label: f.label,
      type: f.type,
      storage: f.storage,
      required: Boolean(f.required),
      help_text: f.help_text,
      length: f.length,
      encrypted: Boolean(f.encrypted),
      derived: Boolean(FIELD_TYPES[f.type]?.derived),
      derived_as: f.type === 'formula'
        ? describeFormula(req.params.entity, (() => { try { return JSON.parse(f.formula); } catch { return null; } })())
        : f.type === 'rollup'
          ? describeRollup(req.params.entity, (() => { try { return JSON.parse(f.rollup); } catch { return null; } })())
          : undefined,
      is_custom: Boolean(f.is_custom),
      values: (f.type === 'picklist' || f.type === 'multipicklist')
        ? picklistValues(f.id).map((v) => ({ value: v.value, label: v.label }))
        : undefined,
    }));

  return res.json({ object: { api_name: def.api_name, label: def.label }, fields });
});

router.patch('/leads/:id', (req, res) => {
  const lead = one('SELECT * FROM leads WHERE id = ?', [req.params.id]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (isReadOnlyOnLeads(req.user.role)) return res.status(403).json({ error: 'Your role has read-only access to leads' });

  const body = { ...req.body };

  // Stage and owner are supervisor-gated (BRD §3.2).
  if (body.stage !== undefined && body.stage !== lead.stage && !can(req.user.role, 'lead.stage.change')) {
    return res.status(403).json({ error: 'Stage changes require a Sales Supervisor or Admin', required: 'lead.stage.change' });
  }
  if (body.owner_id !== undefined && Number(body.owner_id) !== lead.owner_id && !can(req.user.role, 'lead.reassign')) {
    return res.status(403).json({ error: 'Reassignment requires a Sales Supervisor or Admin', required: 'lead.reassign' });
  }

  const invalid = validate(body, { mobile: ['mobile'], email: ['email'], pan: ['pan'], name: ['max:120'] });
  if (invalid) return res.status(400).json(invalid);

  /**
   * The core columns a lead form may write.
   *
   * `mobile_invalid` and `marketing_opt_out` were missing, so the edit form
   * offered both as checkboxes, reported a successful save, and silently
   * discarded them. An RM ticking "opted out of marketing" after a client asked
   * them to stop would have changed nothing at all — and now that consent is
   * enforced, that flag is load-bearing.
   */
  const fields = [
    'name', 'mobile', 'email', 'pan', 'city', 'state', 'risk_profile', 'language',
    'source', 'stage', 'owner_id', 'partner_id', 'callback_at',
    'mobile_invalid', 'marketing_opt_out',
    // Per-channel withdrawals. Separate from the blanket flag because "do not
    // call me" and "stop marketing to me" are different statements, and a
    // regulator asks about the specific one.
    'no_call', 'no_sms', 'no_email', 'no_whatsapp', 'consent_source',
  ];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (body[f] === undefined) continue;
    const raw = body[f] === '' ? null : body[f];
    sets.push(`${f} = ?`);
    params.push(f === 'pan' ? encryptField(raw ? String(raw).toUpperCase() : null) : raw);
    // A PAN that changes without its index changing would be findable under the
    // old value and invisible under the new one.
    if (f === 'pan') {
      sets.push('pan_bidx = ?');
      params.push(raw ? blindIndex(String(raw).toUpperCase()) : null);
    }
  }
  // Custom fields declared in Setup, validated by the metadata layer. Their
  // cascade and requiredness are enforced there, so an API caller gets the same
  // rules the form does.
  if (body.custom && typeof body.custom === 'object') {
    const result = setCustomValues('lead', Number(req.params.id), body.custom, {
      actorId: req.user.id, source: 'ui',
    });
    if (!result.ok) return res.status(400).json({ error: 'Some fields could not be saved', fields: result.errors });
  }

  if (!sets.length) return res.json(decorate(one('SELECT * FROM leads WHERE id = ?', [req.params.id])));

  // Field history, before the row moves — non-negotiable 4. Only fields marked
  // history_tracked record anything; the check lives in recordChange().
  for (const f of fields) {
    if (body[f] === undefined) continue;
    recordChange('lead', Number(req.params.id), f, lead[f], body[f] === '' ? null : body[f], {
      actorId: req.user.id, source: 'ui',
    });
  }

  run(`UPDATE leads SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...params, req.params.id]);
  audit(req.user.id, 'lead_updated', 'lead', Number(req.params.id), body);

  if (body.stage && body.stage !== lead.stage) {
    run('INSERT INTO activities (lead_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)', [
      req.params.id, 'Note', 'system', 'Stage changed', `${lead.stage} → ${body.stage}`, req.user.id,
    ]);
  }
  res.json(decorate(one('SELECT * FROM leads WHERE id = ?', [req.params.id])));
});

router.delete('/leads/:id', requirePermission('lead.delete'), (req, res) => {
  run("UPDATE leads SET deleted_at = datetime('now') WHERE id = ?", [req.params.id]);
  audit(req.user.id, 'lead_deleted', 'lead', Number(req.params.id), {});
  res.status(204).end();
});

router.get('/recycle-bin', requirePermission('lead.delete'), (req, res) => {
  // Deleted records are still client records. This endpoint previously returned
  // SELECT * unmasked, which quietly made the recycle bin the one place in the
  // system where any lead.delete holder could read every mobile and PAN in the
  // book without the audited unmask step. Same masking rules as everywhere else.
  const rows = all(
    `SELECT l.id, l.name, l.mobile, l.email, l.city, l.source, l.stage, l.score, l.owner_id,
            ${kycStatusSql('l')} AS kyc_status, l.created_at, l.deleted_at
     FROM leads l WHERE l.deleted_at IS NOT NULL ORDER BY l.deleted_at DESC`,
  );
  res.json(maskRecords(rows, maskFor(req, 'recycle_bin')));
});

router.post('/leads/:id/restore', requirePermission('lead.delete'), (req, res) => {
  run('UPDATE leads SET deleted_at = NULL WHERE id = ?', [req.params.id]);
  audit(req.user.id, 'lead_restored', 'lead', Number(req.params.id), {});
  res.json({ restored: true });
});

/* --------------------------------------------------------- import/export */

router.post('/leads/import', requirePermission('lead.create'), (req, res) => {
  const { rows = [], commit = false } = req.body;

  // A bulk import lands in one business. Getting this wrong at scale is far
  // worse than getting it wrong once, so it is resolved before any row is read.
  const importOrg = req.body.sales_org || activeOrg(req) || req.user.sales_org || 'BONANZA';
  if (!mayUseOrg(req.user, importOrg)) {
    return res.status(403).json({ error: `You cannot import leads into ${importOrg}.` });
  }

  const report = { total: rows.length, valid: 0, duplicates: [], invalid: [], imported: 0, sales_org: importOrg };

  for (const [i, r] of rows.entries()) {
    if (!r.name?.trim()) { report.invalid.push({ row: i + 1, reason: 'Missing name' }); continue; }
    if (r.mobile && !/^[6-9]\d{9}$/.test(String(r.mobile).trim())) { report.invalid.push({ row: i + 1, reason: 'Invalid mobile' }); continue; }
    if (r.mobile && one('SELECT id FROM leads WHERE mobile = ? AND deleted_at IS NULL', [String(r.mobile).trim()])) {
      report.duplicates.push({ row: i + 1, mobile: r.mobile }); continue;
    }
    report.valid += 1;

    if (commit) {
      const result = run('INSERT INTO leads (sales_org, name, mobile, email, source, city, owner_id) VALUES (?,?,?,?,?,?,?)', [
        importOrg,
        r.name.trim(), r.mobile ? String(r.mobile).trim() : null, r.email || null, r.source || 'Import', r.city || null, req.user.id,
      ]);
      generateCards(Number(result.lastInsertRowid));
      report.imported += 1;
    }
  }
  if (commit) audit(req.user.id, 'lead_import', 'lead', null, report);
  res.json(report);
});

/* --------------------------------------------------------- product cards */

router.get('/cards', (req, res) => {
  // Product RM view: every lead carrying their product, in any state.
  const productId = req.query.product_id || req.user.product_type_id;
  const rows = all(
    `SELECT pc.*, pt.name AS product_name, pt.code AS product_code,
            l.name AS lead_name, l.stage, l.created_at AS lead_created, l.owner_id,
            u.name AS sales_rm_name,
            (SELECT MAX(created_at) FROM activities a WHERE a.card_id = pc.id) AS last_card_activity,
            (SELECT j.status FROM kyc_journeys j WHERE j.card_id = pc.id ORDER BY j.created_at DESC LIMIT 1) AS kyc_status,
            (SELECT j.current_step FROM kyc_journeys j WHERE j.card_id = pc.id ORDER BY j.created_at DESC LIMIT 1) AS kyc_step
     FROM product_cards pc
     JOIN product_types pt ON pt.id = pc.product_type_id
     JOIN leads l ON l.id = pc.lead_id AND l.deleted_at IS NULL
     LEFT JOIN users u ON u.id = l.owner_id
     ${productId ? 'WHERE pc.product_type_id = ?' : ''}
     ORDER BY pc.last_state_at DESC LIMIT 500`,
    productId ? [productId] : [],
  );

  res.json(rows.map((r) => ({
    ...r,
    colour: CARD_COLOUR[r.state] || 'grey',
    age_days: daysSince(r.lead_created) ?? 0,
    age_band: ageBand(daysSince(r.lead_created) ?? 0),
  })));
});

/** The state machine — every transition is role-gated here, at the API. */
router.post('/cards/:id/state', (req, res) => {
  const card = one(
    'SELECT pc.*, pt.name AS product_name, pt.code AS product_code FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id WHERE pc.id = ?',
    [req.params.id],
  );
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const { state, contact_flag, note, lost_reason } = req.body;
  if (!CARD_STATES.includes(state)) return res.status(400).json({ error: `Unknown state. Allowed: ${CARD_STATES.join(', ')}` });

  const permissionFor = {
    EXPLORING: 'card.mark.exploring',
    WARM: 'card.mark.warm',
    PRODUCT_RM_ENGAGED: 'card.engage',
    KYC_IN_PROGRESS: 'kyc.manage',
    ACTIVE: 'card.close',
    LOST: 'card.close',
    ON_HOLD: 'card.mark.warm',
    INACTIVE: 'card.mark.exploring',
  }[state];

  if (!can(req.user.role, permissionFor)) {
    return res.status(403).json({ error: `Your role cannot set a card to ${state}`, required: permissionFor });
  }

  const from = card.state;
  run(
    'UPDATE product_cards SET state = ?, contact_flag = COALESCE(?, contact_flag), lost_reason = ?, last_state_at = datetime(\'now\') WHERE id = ?',
    [state, contact_flag || null, lost_reason || null, req.params.id],
  );
  run('INSERT INTO card_audit (card_id, from_state, to_state, user_id, note) VALUES (?,?,?,?,?)', [
    req.params.id, from, state, req.user.id, note || null,
  ]);
  run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,?)', [
    card.lead_id, card.id, 'Note', 'system', `${card.product_name}: ${from} → ${state}`, note || null, req.user.id,
  ]);
  applyScore(card.lead_id, 'Note', state === 'WARM' ? 15 : state === 'EXPLORING' ? 5 : 0);

  // Warm notifies the Product RM for awareness only — no action required by default (OD-03).
  if (state === 'WARM') {
    const productRms = all("SELECT id FROM users WHERE role = 'product_rm' AND product_type_id = ? AND active = 1", [card.product_type_id]);
    const lead = one('SELECT name FROM leads WHERE id = ?', [card.lead_id]);
    for (const rm of productRms) {
      notify(rm.id, `Warm card — ${card.product_name}`,
        `${lead?.name} was marked Warm by ${req.user.name}. Awareness only; no action needed unless the Sales RM requests it.`,
        `/leads/${card.lead_id}`);
    }
  }

  // A card going Active raises the cross-sell prompt (BRD §7.2).
  if (state === 'ACTIVE') {
    const lead = one('SELECT * FROM leads WHERE id = ?', [card.lead_id]);
    const other = one(
      `SELECT pt.name FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
       WHERE pc.lead_id = ? AND pc.state = 'INACTIVE' AND pt.active = 1 ORDER BY pt.sort_order LIMIT 1`,
      [card.lead_id],
    );
    if (other && lead?.owner_id) {
      run("INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, priority) VALUES (?,?,?,?,datetime('now','+2 days'),'Normal')", [
        `${card.product_name} is now Active — consider introducing ${other.name}`, card.lead_id, lead.owner_id, req.user.id,
      ]);
    }
  }

  audit(req.user.id, 'card_state', 'product_card', card.id, { from, to: state });
  res.json({ ok: true, from, to: state });
});

router.post('/cards/:id/request-product-rm', requirePermission('card.request.productrm'), (req, res) => {
  const card = one('SELECT pc.*, pt.name AS product_name FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id WHERE pc.id = ?', [req.params.id]);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const lead = one('SELECT * FROM leads WHERE id = ?', [card.lead_id]);
  const rms = all("SELECT id FROM users WHERE role = 'product_rm' AND product_type_id = ? AND active = 1", [card.product_type_id]);

  for (const rm of rms) {
    notify(rm.id, `Intervention requested — ${card.product_name}`,
      `${req.user.name} has asked for your involvement on ${lead?.name}. ${req.body.reason || ''}`, `/leads/${card.lead_id}`);
    run("INSERT INTO tasks (title, lead_id, card_id, assignee_id, created_by, due_at, priority) VALUES (?,?,?,?,?,datetime('now','+4 hours'),'High')", [
      `Product RM intervention requested on ${lead?.name} (${card.product_name})`, card.lead_id, card.id, rm.id, req.user.id,
    ]);
  }
  run('INSERT INTO activities (lead_id, card_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?,?)', [
    card.lead_id, card.id, 'Note', 'system', 'Product RM intervention requested', req.body.reason || null, req.user.id,
  ]);
  audit(req.user.id, 'product_rm_requested', 'product_card', card.id, { reason: req.body.reason });
  res.json({ requested: true, notified: rms.length });
});

/**
 * Everything about one product against one lead (ENH-10b, ENH-10c).
 *
 * The View pop-up used to show a pitch list and a row of state buttons. That is
 * a reference card, not a working surface: it did not say how long the card had
 * been sitting, what had already been tried, whether the client could lawfully
 * be contacted, or what to do next.
 *
 * One request rather than five, because the pop-up opens on a click and five
 * round trips is how a modal comes up empty and then jumps.
 */
router.get('/cards/:id/detail', (req, res) => {
  const scope = reqScope(req, 'l');
  const card = one(
    `SELECT pc.*, pt.name AS product_name, pt.code AS product_code,
            pt.category AS product_category, pt.pitch_points, pt.objections,
            pt.min_investment, pt.lock_in, pt.risk_category, pt.brochure_url,
            l.id AS lead_id, l.name AS lead_name, l.stage AS lead_stage,
            l.mobile, l.email, l.sales_org, l.marketing_opt_out,
            l.no_call, l.no_sms, l.no_email, l.no_whatsapp, l.mobile_invalid,
            rm.name AS product_rm_name,
            CAST(julianday('now') - julianday(pc.last_state_at) AS INTEGER) AS days_in_state
       FROM product_cards pc
       JOIN product_types pt ON pt.id = pc.product_type_id
       JOIN leads l ON l.id = pc.lead_id
       LEFT JOIN users rm ON rm.id = pc.product_rm_id
      WHERE pc.id = ? AND l.deleted_at IS NULL AND ${scope.sql}`,
    [req.params.id, ...scope.params],
  );
  if (!card) return res.status(404).json({ error: 'Product not found' });

  const parse = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  };

  /* What has actually been tried on this product, rather than on this lead.
     A rep about to pitch needs to know they pitched it a fortnight ago. */
  const activities = all(
    `SELECT a.id, a.type, a.subject, a.body, a.outcome, a.sub_disposition,
            a.created_at, u.name AS user_name
       FROM activities a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.card_id = ?
      ORDER BY a.created_at DESC LIMIT 20`,
    [card.id],
  );

  const history = all(
    `SELECT ca.from_state, ca.to_state, ca.note, ca.created_at, u.name AS user_name
       FROM card_audit ca LEFT JOIN users u ON u.id = ca.user_id
      WHERE ca.card_id = ? ORDER BY ca.created_at DESC LIMIT 20`,
    [card.id],
  );

  const journey = one(
    `SELECT id, status, resume_token, current_step FROM kyc_journeys
      WHERE card_id = ? ORDER BY id DESC LIMIT 1`,
    [card.id],
  );

  /* Contactability, per channel, on the card itself -- so the quick actions
     below can be offered honestly rather than failing after the click. */
  const channels = ['call', 'whatsapp', 'sms', 'email'].map((channel) => {
    const verdict = checkConsent(card, channel, 'service');
    return { channel, allowed: verdict.allowed, reason: verdict.reason };
  });

  res.json({
    ...maskRecord(card, maskFor(req, 'card_detail', Number(req.params.id))),
    pitch_points: parse(card.pitch_points),
    objections: parse(card.objections),
    next: nextAction(card, req.caps ?? new Set(), { daysInState: card.days_in_state ?? 0 }),
    channels,
    activities,
    history,
    kyc: journey ?? null,
  });
});

router.get('/cards/:id/audit', (req, res) => {
  /* Scoped the same way as /cards/:id/detail just above.
   *
   * card_audit carries no owner and no org of its own -- it hangs off the card,
   * which hangs off the lead -- so without this join the state history of any
   * card in the firm was readable by anyone who could guess a card id. */
  const scope = reqScope(req, 'l');
  const visible = one(
    `SELECT 1 v FROM product_cards pc JOIN leads l ON l.id = pc.lead_id
      WHERE pc.id = ? AND ${scope.sql}`,
    [req.params.id, ...scope.params],
  );
  if (!visible) return res.status(403).json({ error: 'This card is outside your visibility scope' });

  res.json(all('SELECT ca.*, u.name AS user_name FROM card_audit ca LEFT JOIN users u ON u.id = ca.user_id WHERE ca.card_id = ? ORDER BY ca.created_at DESC', [req.params.id]));
});

/* ---------------------------------------------------------- activities */

router.get('/activities', (req, res) => {
  const { lead_id, type, limit = 200 } = req.query;
  const where = [];
  const params = [];
  if (lead_id) { where.push('a.lead_id = ?'); params.push(lead_id); }
  if (type) { where.push('a.type = ?'); params.push(type); }

  res.json(applyFieldSecurity('interaction', all(
    `SELECT a.*, u.name AS user_name, l.name AS lead_name
     FROM activities a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN leads l ON l.id = a.lead_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.created_at DESC LIMIT ?`,
    [...params, Number(limit)],
  ), req.user, { caps: req.caps }));
});

router.post('/activities', (req, res) => {
  const { lead_id, card_id, type = 'Note', direction = 'outbound', subject, body, outcome, duration_s } = req.body;
  const result = run(
    'INSERT INTO activities (lead_id, card_id, type, direction, subject, body, outcome, duration_s, user_id) VALUES (?,?,?,?,?,?,?,?,?)',
    [lead_id || null, card_id || null, type, direction, subject || null, body || null, outcome || null, duration_s || null, req.user.id],
  );
  const delta = applyScore(lead_id, type);
  res.status(201).json({ id: Number(result.lastInsertRowid), score_delta: delta });
});

/* ---------------------------------------------- telephony & messaging */

router.post('/leads/:id/call', requirePermission('lead.contact'), async (req, res, next) => {
  const lead = one('SELECT * FROM leads WHERE id = ?', [req.params.id]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // A call is service by nature — an RM ringing a client back is not a
  // campaign. What it still respects is a dead number: dialling one wastes the
  // RM's time and tells us nothing we did not already know.
  const consent = checkConsent(lead, 'call', 'service');
  if (!consent.allowed) {
    return res.status(409).json({ error: consent.reason, code: consent.code, fix: consent.fix });
  }

  try {
    return res.json(await click2call({ userId: req.user.id, leadId: lead.id, mobile: lead.mobile }));
  } catch (err) {
    // A dial failure is the agent's problem to act on, not a server fault: they
    // need to know the switch refused so they can call from the handset.
    if (err.name === 'VendorError') {
      return res.status(502).json({ error: err.message, vendor: err.vendor });
    }
    return next(err);
  }
});

router.post('/leads/:id/log-call', requirePermission('lead.contact'), (req, res) => {
  const id = logCall({ leadId: Number(req.params.id), userId: req.user.id, durationS: req.body.duration_s, outcome: req.body.outcome });
  applyScore(Number(req.params.id), 'Call');
  res.status(201).json({ activity_id: id });
});

router.post('/leads/:id/message', requirePermission('lead.contact'), (req, res) => {
  const lead = one('SELECT * FROM leads WHERE id = ?', [req.params.id]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const { channel = 'whatsapp', body, subject, template_id, intent = 'marketing' } = req.body;

  // Enforced here rather than in the form, because the form is not where volume
  // sends come from — imports, rules and bulk actions all land on this route.
  const consent = checkConsent(lead, channel, intent === 'service' ? 'service' : 'marketing');
  if (!consent.allowed) {
    return res.status(409).json({ error: consent.reason, code: consent.code, fix: consent.fix });
  }

  const template = template_id ? one('SELECT * FROM templates WHERE id = ?', [template_id]) : null;
  const text = (body || template?.body || '').replace(/\{\{name\}\}/g, lead.name);
  if (!text.trim()) return res.status(400).json({ error: 'Message body is required' });

  const entry = send(channel, { to: lead.mobile || lead.email, body: text, subject: subject || template?.subject, leadId: lead.id, templateId: template_id });
  applyScore(lead.id, channel === 'email' ? 'Email' : channel === 'sms' ? 'SMS' : 'WhatsApp');
  res.status(201).json(entry);
});

router.post('/autodialler', requirePermission('lead.contact'), async (req, res, next) => {
  try {
    return res.json(await pushToAutodialler(req.body.lead_ids || [], req.user.id));
  } catch (err) {
    if (err.name === 'VendorError') return res.status(502).json({ error: err.message, vendor: err.vendor });
    return next(err);
  }
});

/* --------------------------------------------------------------- tasks */

router.get('/tasks', (req, res) => {
  const where = [];
  const params = [];

  /* A task carries its lead's name, so it carries its lead's book.
   *
   * This route had no lead scope at all. With `all=true` a Bigul supervisor
   * was returned every task in the system -- forty of them on Bonanza leads,
   * each labelled with that client's name. The record routes were scoped in
   * August and the list routes were assumed already filtered; this one was
   * not, and nothing looked at it until a dashboard tile disagreed with its
   * own drill-through.
   *
   * Tasks with no lead are kept: a standalone reminder belongs to whoever it
   * is assigned to and has no book to be outside of. */
  const scope = reqScope(req, 'l');
  where.push(`(t.lead_id IS NULL OR EXISTS (
    SELECT 1 FROM leads l WHERE l.id = t.lead_id AND l.deleted_at IS NULL AND ${scope.sql}))`);
  params.push(...scope.params);

  if (!(req.query.all === 'true' && can(req.user.role, 'report.team'))) {
    where.push('t.assignee_id = ?');
    params.push(req.user.id);
  }

  /* P2-13. Past its due date and still open -- the same predicate the
     "Overdue follow-ups" tile counts, so the number and the list are one set
     rather than two definitions that happen to agree. */
  if (req.query.overdue === 'true') {
    where.push("t.status = 'Open' AND t.due_at < datetime('now')");
  }
  if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }

  res.json(all(
    `SELECT t.*, l.name AS lead_name, u.name AS assignee_name
     FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN users u ON u.id = t.assignee_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.status, t.due_at`,
    params,
  ));
});

router.post('/tasks', (req, res) => {
  const { title, description, lead_id, card_id, ticket_id, partner_id, assignee_id, due_at, priority = 'Normal' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!due_at) return res.status(400).json({ error: 'A due date is required — tasks without one cannot be created' });

  const result = run(
    'INSERT INTO tasks (title, description, lead_id, card_id, ticket_id, partner_id, assignee_id, created_by, due_at, priority) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [title, description || null, lead_id || null, card_id || null, ticket_id || null, partner_id || null,
      assignee_id || req.user.id, req.user.id, due_at, priority],
  );
  res.status(201).json(one('SELECT * FROM tasks WHERE id = ?', [Number(result.lastInsertRowid)]));
});

router.patch('/tasks/:id', (req, res) => {
  const { status, assignee_id, due_at, priority } = req.body;
  const sets = [];
  const params = [];
  if (status) { sets.push('status = ?'); params.push(status); }
  if (assignee_id) { sets.push('assignee_id = ?'); params.push(assignee_id); }
  if (due_at) { sets.push('due_at = ?'); params.push(due_at); }
  if (priority) { sets.push('priority = ?'); params.push(priority); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
  res.json(one('SELECT * FROM tasks WHERE id = ?', [req.params.id]));
});

/* --------------------------------------------------------------- notes */

router.post('/notes', (req, res) => {
  const { lead_id, partner_id, parent_id, body, mentions = [] } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Note body is required' });

  const result = run('INSERT INTO notes (lead_id, partner_id, parent_id, body, mentions, user_id) VALUES (?,?,?,?,?,?)', [
    lead_id || null, partner_id || null, parent_id || null, body, JSON.stringify(mentions), req.user.id,
  ]);

  for (const uid of mentions) {
    notify(uid, `${req.user.name} mentioned you`, body.slice(0, 140), lead_id ? `/leads/${lead_id}` : `/partners/${partner_id}`);
  }
  res.status(201).json(one('SELECT n.*, u.name AS user_name, u.role AS user_role FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = ?', [Number(result.lastInsertRowid)]));
});

router.post('/notes/:id/pin', (req, res) => {
  const note = one('SELECT * FROM notes WHERE id = ?', [req.params.id]);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const allowed = note.user_id === req.user.id || ['sales_supervisor', 'product_supervisor', 'admin', 'superadmin'].includes(req.user.role);
  if (!allowed) return res.status(403).json({ error: 'Only the author, a Supervisor or an Admin can pin a note' });

  run('UPDATE notes SET pinned = ? WHERE id = ?', [note.pinned ? 0 : 1, req.params.id]);
  res.json({ pinned: !note.pinned });
});

/* Lists moved to routes/lists.js (BUG-25), which is mounted at /api/lists
 * ahead of this router. Three routes lived here -- list, create, add
 * members -- with no kinds, no refresh, no scope composition and no bulk
 * actions. They are gone rather than left as a second way in. */

/* ------------------------------------------------------- notifications */

router.get('/notifications', (req, res) => {
  res.json(all('SELECT * FROM notifications WHERE user_id = ? ORDER BY read, created_at DESC LIMIT 50', [req.user.id]));
});

router.post('/notifications/:id/read', (req, res) => {
  run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

router.post('/notifications/read-all', (req, res) => {
  run('UPDATE notifications SET read = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
});

/* ------------------------------------------------------------ metadata */

router.get('/meta', (req, res) => {
  // Products and colleagues are scoped to the orgs this user works in: a Bonanza
  // RM has no use for Bigul's catalogue in a product picker, and offering it
  // would let them open a card the business cannot service.
  const orgs = orgsFor(req.user);
  const placeholders = orgs.map(() => '?').join(',') || 'NULL';

  res.json({
    stages: LEAD_STAGES,
    card_states: CARD_STATES,
    card_colours: CARD_COLOUR,
    products: all(
      `SELECT * FROM product_types WHERE active = 1 AND sales_org IN (${placeholders}) ORDER BY sales_org, sort_order`,
      orgs,
    ),
    users: all(
      `SELECT id, name, role, product_type_id, sales_org, employee_code, branch
       FROM users WHERE active = 1 AND sales_org IN (${placeholders}) ORDER BY name`,
      orgs,
    ),
    // Partner attribution decides who gets paid, so it is chosen from a list,
    // never typed as an id. Scoped to the caller's orgs like everything else.
    partners: all(
      `SELECT id, name, business_name, partner_code
       FROM partners WHERE state_code = 'ACTIVE' AND sales_org IN (${placeholders})
       ORDER BY name`,
      orgs,
    ),
    ticket_categories: all('SELECT * FROM ticket_categories WHERE active = 1'),
    templates: all('SELECT id, name, channel, subject, body, product_type_id FROM templates WHERE approved = 1'),
    orgs,
    me: {
      id: req.user.id, name: req.user.name, role: req.user.role,
      product_type_id: req.user.product_type_id,
      sales_org: req.user.sales_org, employee_code: req.user.employee_code, branch: req.user.branch,
    },
  });
});

/* -------------------------------------------------------------- queues */

/**
 * Queues — an owner that is not a person.
 *
 * Work sits here visibly until somebody takes it, which is the third answer
 * between "belongs to nobody" and "parked on a placeholder human".
 */
router.get('/queues', (req, res) => {
  res.json(listQueues(req.query.entity || null).map((q) => ({
    ...q,
    members: membersOf(q.id),
    can_take: mayTakeFrom(req.user, q),
  })));
});

router.get('/queues/:id/work', (req, res) => {
  const queue = one('SELECT * FROM queues WHERE id = ?', [req.params.id]);
  if (!queue) return res.status(404).json({ error: 'Queue not found' });
  return res.json({
    queue,
    can_take: mayTakeFrom(req.user, queue),
    work: workIn(queue.id, Number(req.query.limit) || 100),
  });
});

/** Take a lead out of a queue and own it. */
router.post('/queues/claim/:leadId', requirePermission('lead.contact'), (req, res) => {
  const out = claimFromQueue(Number(req.params.leadId), req.user);
  if (!out.ok) return res.status(409).json(out);
  audit(req.user.id, 'lead_claimed_from_queue', 'lead', Number(req.params.leadId), { queue: out.queue });
  return res.json(out);
});

/** Put a lead into a queue — reassignment, so it is gated like one. */
router.post('/queues/:id/place/:leadId', requirePermission('lead.reassign'), (req, res) => {
  const out = assignToQueue(Number(req.params.leadId), Number(req.params.id), { actorId: req.user.id });
  if (!out.ok) return res.status(400).json(out);
  audit(req.user.id, 'lead_placed_in_queue', 'lead', Number(req.params.leadId), { queue: out.queue });
  return res.json(out);
});

/** Who may take work out of a queue. Roles, not people. */
router.put('/queues/:id/members', requirePermission('admin.users'), (req, res) => {
  const queue = one('SELECT * FROM queues WHERE id = ?', [req.params.id]);
  if (!queue) return res.status(404).json({ error: 'Queue not found' });

  const n = setMembers(queue.id, req.body?.roles ?? []);
  audit(req.user.id, 'queue_members_set', 'queue', queue.id, { roles: req.body?.roles });
  return res.json({ ok: true, roles: n, members: membersOf(queue.id) });
});

export default router;
