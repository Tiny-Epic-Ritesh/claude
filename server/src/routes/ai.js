/**
 * AI routes — the four BRD capabilities plus the cockpit copilot.
 */

import { Router } from 'express';
import { all, one, run, audit, notify } from '../db.js';
import { requireUser, can } from '../auth.js';
import { applyScore } from '../engine/rules.js';
import * as ai from '../ai/index.js';

const router = Router();
router.use(requireUser);

router.get('/status', (_req, res) => {
  res.json({
    provider: ai.providerName,
    live: ai.isLive,
    capabilities: [
      { key: 'disposition', name: 'AI call summary & auto-disposition', brd: '§6.1' },
      { key: 'ticket_summary', name: 'AI ticket summary (2-line)', brd: '§6.2' },
      { key: 'next_action', name: 'Next best action', brd: 'extension' },
      { key: 'kyc_coach', name: 'KYC stall coaching', brd: 'extension' },
      { key: 'copilot', name: 'Cockpit copilot', brd: 'extension' },
      { key: 'partner_insight', name: 'Partner health insight', brd: 'extension' },
    ],
    residency_mode: ai.residencyMode,
  });
});

/**
 * The data-residency policy, in a form an auditor or the compliance team can
 * read directly from the running system rather than from a slide.
 *
 * Deliberately readable by any authenticated user: an RM about to paste a
 * transcript into the disposition box is entitled to know where it goes.
 */
router.get('/residency', (_req, res) => res.json(ai.residency()));

/**
 * Egress evidence — the audit trail of every AI call, showing what was removed
 * before the payload crossed the border. Values are never recorded, only kinds
 * and counts, so the log itself is not a second copy of the PII.
 */
router.get('/residency/log', (req, res) => {
  if (!can(req.user.role, 'audit.read')) return res.status(403).json({ error: 'Not permitted' });

  res.json(all(
    `SELECT id, action, detail, created_at FROM audit_log
     WHERE action IN ('ai_egress', 'ai_egress_blocked')
     ORDER BY id DESC LIMIT ?`,
    [Number(req.query.limit) || 100],
  ).map(({ detail, ...r }) => ({ ...r, meta: detail ? JSON.parse(detail) : null })));
});

/**
 * Post-call disposition. Returns a proposal — nothing is applied until the
 * caller confirms, which is the human-in-the-loop control the BRD risk
 * register requires ("start with a confirm screen, not auto-apply").
 */
router.post('/disposition', async (req, res, next) => {
  try {
    const { lead_id, transcript, duration_s } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });
    if (!transcript?.trim()) return res.status(400).json({ error: 'A transcript or call note is required' });

    const ctx = ai.dispositionContext(Number(lead_id), transcript, duration_s);
    if (!ctx) return res.status(404).json({ error: 'Lead not found' });

    const started = Date.now();
    const proposal = await ai.disposition(ctx);

    res.json({
      ...proposal,
      latency_ms: Date.now() - started,
      provider: ai.providerName,
      // The UI shows current state alongside each proposed change.
      cards: ctx.cards.map((c) => ({ id: c.id, code: c.product_code, name: c.product_name, state: c.state })),
    });
  } catch (err) { next(err); }
});

/** Apply a confirmed (and possibly edited) disposition. */
router.post('/disposition/confirm', (req, res) => {
  const { lead_id, outcome, summary, card_changes = [], next_action, next_action_due_hours = 4,
    follow_up_task, compliance_flag, compliance_note, score_signal = 0, duration_s } = req.body;

  const lead = one('SELECT * FROM leads WHERE id = ?', [lead_id]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // 1. The call summary becomes an activity.
  run(
    `INSERT INTO activities (lead_id, type, direction, subject, body, outcome, duration_s, ai_generated, score_delta, user_id)
     VALUES (?,?,?,?,?,?,?,1,?,?)`,
    [lead_id, 'AI Call Summary', 'outbound', `Call — ${outcome}`, summary, outcome, duration_s || 0, score_signal, req.user.id],
  );
  applyScore(lead_id, 'AI Call Summary', score_signal);

  // 2. Card state changes, each still role-gated.
  const applied = [];
  const refused = [];
  for (const change of card_changes) {
    const card = one(
      `SELECT pc.*, pt.name AS product_name FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
       WHERE pc.lead_id = ? AND pt.code = ?`,
      [lead_id, change.product_code],
    );
    if (!card) continue;

    const permission = change.to_state === 'WARM' ? 'card.mark.warm' : 'card.mark.exploring';
    if (!can(req.user.role, permission)) {
      refused.push({ ...change, reason: `Your role cannot set ${change.to_state}` });
      continue;
    }

    run("UPDATE product_cards SET state = ?, last_state_at = datetime('now') WHERE id = ?", [change.to_state, card.id]);
    run('INSERT INTO card_audit (card_id, from_state, to_state, user_id, note) VALUES (?,?,?,?,?)', [
      card.id, card.state, change.to_state, req.user.id, `AI disposition: ${change.evidence || ''}`,
    ]);
    applied.push({ ...change, card_id: card.id });

    if (change.to_state === 'WARM') {
      for (const rm of all("SELECT id FROM users WHERE role = 'product_rm' AND product_type_id = ? AND active = 1", [card.product_type_id])) {
        notify(rm.id, `Warm card — ${card.product_name}`, `${lead.name} marked Warm from an AI-confirmed call.`, `/leads/${lead_id}`);
      }
    }
  }

  // 3. Follow-up task.
  if (follow_up_task) {
    run("INSERT INTO tasks (title, lead_id, assignee_id, created_by, due_at, priority) VALUES (?,?,?,?,datetime('now', ?),?)", [
      follow_up_task, lead_id, req.user.id, req.user.id, `+${Number(next_action_due_hours) || 4} hours`,
      compliance_flag && compliance_flag !== 'None' ? 'High' : 'Normal',
    ]);
  }

  // 4. Callback scheduling.
  if (next_action === 'Callback') {
    run("UPDATE leads SET callback_at = datetime('now', ?) WHERE id = ?", [`+${Number(next_action_due_hours) || 24} hours`, lead_id]);
  }

  // 5. A compliance flag raises a ticket — it is never left in a note.
  let ticketId = null;
  if (compliance_flag && compliance_flag !== 'None') {
    const cc = one("SELECT id FROM users WHERE role = 'customer_care' AND active = 1 LIMIT 1");
    const result = run(
      `INSERT INTO tickets (subject, description, priority, lead_id, channel, assignee_id, created_by, status)
       VALUES (?,?,?,?,?,?,?,'Open')`,
      [`Compliance flag: ${compliance_flag}`, `${compliance_note || ''}\n\nFrom call summary: ${summary}`,
        'High', lead_id, 'CRM', cc?.id || null, req.user.id],
    );
    ticketId = Number(result.lastInsertRowid);
    run('UPDATE tickets SET ref = ? WHERE id = ?', [`BNZ-${String(ticketId).padStart(5, '0')}`, ticketId]);
    if (cc?.id) notify(cc.id, 'Compliance flag raised', `${lead.name}: ${compliance_flag}`, `/tickets/${ticketId}`);
  }

  run("UPDATE leads SET updated_at = datetime('now') WHERE id = ?", [lead_id]);
  audit(req.user.id, 'ai_disposition_confirmed', 'lead', Number(lead_id), { outcome, applied: applied.length, refused: refused.length });

  res.json({ ok: true, cards_updated: applied, cards_refused: refused, compliance_ticket_id: ticketId });
});

router.get('/leads/:id/next-action', async (req, res, next) => {
  try {
    const ctx = ai.nextActionContext(Number(req.params.id));
    if (!ctx) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ...(await ai.nextAction(ctx)), provider: ai.providerName });
  } catch (err) { next(err); }
});

router.post('/copilot', async (req, res, next) => {
  try {
    const { question, history = [] } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: 'A question is required' });

    const snapshot = ai.copilotSnapshot(req.user);
    const result = await ai.copilot({ question, snapshot, history: history.slice(-8) });

    res.json({
      ...result,
      provider: ai.providerName,
      grounded_in: {
        leads: snapshot.leads.length,
        tickets: snapshot.tickets.length,
        journeys: snapshot.journeys.length,
        tasks: snapshot.tasks.length,
      },
    });
  } catch (err) { next(err); }
});

export default router;
