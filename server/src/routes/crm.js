/**
 * Core CRM routes — leads, product cards, activities, tasks, notes and lists.
 */

import { Router } from 'express';
import { all, one, run, audit, notify, daysSince, ageBand, CARD_COLOUR, LEAD_STAGES, CARD_STATES } from '../db.js';
import { can, requireUser, requirePermission, reqScope, isReadOnlyOnLeads, unmaskRequested, orgsFor, activeOrg, mayUseOrg } from '../auth.js';
import { encryptField, decryptField, maskRecord, maskRecords, validate } from '../security.js';
import { applyScore } from '../engine/rules.js';
import { click2call, pushToAutodialler, send, logCall } from '../integrations.js';
import { checkConsent, contactability } from '../engine/consent.js';
import { derivedValues, describeFormula, describeRollup } from '../engine/formulas.js';
import { assignLead } from '../engine/assignment.js';
import { metricsFor } from '../engine/metrics.js';
import { kycStatusSql, kycStatusFor } from '../engine/kycstatus.js';
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

router.get('/leads', (req, res) => {
  const scope = reqScope(req, 'l');
  const where = ['l.deleted_at IS NULL', scope.sql];
  const params = [...scope.params];

  const { q, stage, band, card_state, product_id, owner_id, partner_id, list_id } = req.query;

  if (q) {
    // PAN is encrypted at rest, so it cannot be LIKE-searched. Exact PAN lookup
    // would use security.blindIndex(); name/mobile/email remain searchable.
    where.push('(l.name LIKE ? OR l.mobile LIKE ? OR l.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (stage) { where.push('l.stage = ?'); params.push(stage); }
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

  let leads = all(
    `SELECT l.*, ${kycStatusSql('l')} AS kyc_status
     FROM leads l WHERE ${where.join(' AND ')} ORDER BY l.updated_at DESC LIMIT 500`,
    params,
  ).map(decorate);

  if (band) leads = leads.filter((l) => l.age_band === band);

  res.json(maskRecords(leads, { unmask: unmaskRequested(req, 'lead_list') }));
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
  const unmask = unmaskRequested(req, 'lead', Number(id));
  res.json({
    ...maskRecord(decorate(lead), { unmask }),
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
    `INSERT INTO leads (sales_org, name, mobile, email, source, pan, city, state, risk_profile, language, owner_id, partner_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org, name, mobile || null, email || null, source || 'Manual', encryptField(pan ? String(pan).toUpperCase() : null),
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
  ];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (body[f] === undefined) continue;
    const raw = body[f] === '' ? null : body[f];
    sets.push(`${f} = ?`);
    params.push(f === 'pan' ? encryptField(raw ? String(raw).toUpperCase() : null) : raw);
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
  res.json(maskRecords(rows, { unmask: unmaskRequested(req, 'recycle_bin') }));
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

router.get('/cards/:id/audit', (req, res) => {
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
  const mine = req.query.all === 'true' && can(req.user.role, 'report.team') ? '' : 'WHERE t.assignee_id = ?';
  res.json(all(
    `SELECT t.*, l.name AS lead_name, u.name AS assignee_name
     FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN users u ON u.id = t.assignee_id
     ${mine} ORDER BY t.status, t.due_at`,
    mine ? [req.user.id] : [],
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

/* --------------------------------------------------------------- lists */

router.get('/lists', (req, res) => {
  const lists = all(
    `SELECT ll.*, u.name AS owner_name,
            (SELECT COUNT(*) FROM lead_list_members m WHERE m.list_id = ll.id) AS member_count
     FROM lead_lists ll LEFT JOIN users u ON u.id = ll.owner_id`,
  ).filter((l) => l.owner_id === req.user.id || (JSON.parse(l.shared_with || '[]')).some((s) => s === req.user.role || s === req.user.id));
  res.json(lists);
});

router.post('/lists', requirePermission('list.create'), (req, res) => {
  const { name, kind = 'static', criteria, shared_with = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'List name is required' });

  const result = run('INSERT INTO lead_lists (name, kind, criteria, owner_id, shared_with) VALUES (?,?,?,?,?)', [
    name, kind, criteria ? JSON.stringify(criteria) : null, req.user.id, JSON.stringify(shared_with),
  ]);
  res.status(201).json(one('SELECT * FROM lead_lists WHERE id = ?', [Number(result.lastInsertRowid)]));
});

router.post('/lists/:id/members', (req, res) => {
  const ids = req.body.lead_ids || [];
  for (const leadId of ids) {
    run('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id) VALUES (?,?)', [req.params.id, leadId]);
  }
  res.json({ added: ids.length });
});

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
