/**
 * AI routes — the four BRD capabilities plus the cockpit copilot.
 */

import { Router } from 'express';
import { all, one, run, audit, notify, CARD_STATES } from '../db.js';
import { requireUser, requirePermission, can, leadScope, activeOrg, userCan } from '../auth.js';
import { loadInBook } from '../engine/bookscope.js';
import { openCase } from '../engine/cases.js';
/* QA-28. The category and priority each compliance flag opens are now
   configuration, ruled 14 Oct and changeable in Setup: engine/compliance.js. */
import { routeFor } from '../engine/compliance.js';
import * as ai from '../ai/index.js';
import { sendCsv } from '../engine/csv.js';
import { sourceOf } from '../engine/history.js';
import { dispositionByCode } from '../engine/dispositions.js';
import { moveCard } from '../engine/cardmoves.js';
import { MOVE_NEEDS } from '../engine/nextaction.js';

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
/**
 * The residency policy, narrowable and exportable. P3-25.
 *
 * Filtered server-side even though the report is small and the screen could do
 * it in the browser -- because the export has to carry exactly what the screen
 * shows, and the only way to guarantee that is for both to ask the same
 * question of the same code.
 */
function residencyFilter(req) {
  const report = ai.residency();
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const cls = req.query.data_class || '';
  const leaves = req.query.leaves_india || '';

  const capabilities = report.capabilities.filter((c) => {
    if (q && !`${c.capability} ${c.classification_reason}`.toLowerCase().includes(q)) return false;
    if (cls && c.data_class !== cls) return false;
    /* Explicit strings rather than a truthy test: "no" is a filter somebody
       chose, and treating it as absent would silently show them everything. */
    if (leaves === 'yes' && !c.leaves_india) return false;
    if (leaves === 'no' && c.leaves_india) return false;
    return true;
  });

  return { report, capabilities };
}

router.get('/residency', (req, res) => {
  const { report, capabilities } = residencyFilter(req);
  res.json({
    ...report,
    capabilities,
    /* The unfiltered count, so the screen can say "6 of 14" rather than
       leaving somebody to wonder whether a filter hid something. */
    capabilities_total: report.capabilities.length,
    /* The values present, so a filter cannot be set to something that returns
       nothing. */
    data_classes: [...new Set(report.capabilities.map((c) => c.data_class))].sort(),
  });
});

/**
 * The same report as a file, for compliance.
 *
 * This is the artefact somebody hands to an auditor asking which capabilities
 * send data outside India, so the note travels with it as a row rather than as
 * a caption on a screen nobody exported.
 */
router.get('/residency/export', requirePermission('report.system'), (req, res) => {
  const { report, capabilities } = residencyFilter(req);

  const rows = capabilities.map((c) => ({
    capability: c.capability,
    data_class: c.data_class,
    routed_to: c.routed_to,
    leaves_india: c.leaves_india ? 'Yes' : 'No',
    deidentified: c.deidentified ? 'Yes' : 'No',
    classification_reason: c.classification_reason,
  }));

  rows.push({
    capability: `Mode: ${report.mode}`,
    data_class: '',
    routed_to: '',
    leaves_india: '',
    deidentified: '',
    classification_reason: report.note,
  });

  audit(req.user.id, 'residency_report_exported', 'residency', null, {
    rows: capabilities.length,
    of_total: report.capabilities.length,
  });

  return sendCsv(res, 'data-residency', rows, [
    { key: 'capability', label: 'Capability' },
    { key: 'data_class', label: 'Data class' },
    { key: 'routed_to', label: 'Processed by' },
    { key: 'leaves_india', label: 'Leaves India' },
    { key: 'deidentified', label: 'De-identified' },
    { key: 'classification_reason', label: 'Why' },
  ]);
});

/**
 * Egress evidence — the audit trail of every AI call, showing what was removed
 * before the payload crossed the border. Values are never recorded, only kinds
 * and counts, so the log itself is not a second copy of the PII.
 */
router.get('/residency/log', (req, res) => {
  if (!userCan(req.user, 'audit.read')) return res.status(403).json({ error: 'Not permitted' });

  res.json(all(
    `SELECT id, action, detail, created_at FROM audit_log
     WHERE action IN ('ai_egress', 'ai_egress_blocked')
     ORDER BY id DESC LIMIT ?`,
    [Number(req.query.limit) || 100],
  ).map(({ detail, ...r }) => ({ ...r, meta: detail ? JSON.parse(detail) : null })));
});

/*
 * A4 (QA-10; ruled 19 Nov, OPS-74): a call drafted by the AI is saved like any
 * other call -- through POST /activities, with one of Setup's call outcomes --
 * so it counts as a call everywhere a call is counted, and Setup's rules for
 * that outcome (a follow-up, a retry, a date it needs) apply to it. Before,
 * the confirm wrote an "AI Call Summary" that no call count, scorecard or
 * last-contacted date reads, with an outcome from the AI's own list of seven.
 *
 * The providers still answer in that coarse vocabulary. It is turned into
 * Setup's outcome here, by the outcome's API name (fixed; only its label can
 * be renamed). When Setup has retired that outcome, none is drafted and the
 * person chooses one: the call cannot be saved without it.
 */
const OUTCOME_TO_DISPOSITION = {
  'Connected — Interested': 'CALL_PITCH_DONE',
  'Connected — Not Interested': 'CALL_NOT_INTERESTED',
  'Connected — Callback Requested': 'CALL_CALLBACK',
  'Not Reachable': 'CALL_NO_ANSWER',
  'Wrong Number': 'CALL_WRONG_NUMBER',
  'Busy — Call Later': 'CALL_BUSY',
  'Do Not Call': 'CALL_DND',
};
/* An interested client, and a next step that says more exactly what happened. */
const NEXT_TO_DISPOSITION = {
  'Schedule Meeting': 'CALL_MEETING_FIXED',
  'Send Brochure': 'CALL_NEEDS_INFO',
};

/** India time, `hours` from now, on the next half hour, as a datetime-local value. */
const istLocalIn = (hours) => {
  const t = new Date(Date.now() + hours * 3600_000 + 330 * 60_000);
  t.setUTCSeconds(0, 0);
  const m = t.getUTCMinutes();
  t.setUTCMinutes(m === 0 ? 0 : m <= 30 ? 30 : 60);
  return t.toISOString().slice(0, 16);
};

/** The draft's outcome as one of Setup's call outcomes, with the date it needs, if any. */
function asSetupOutcome(proposal) {
  const interested = proposal.outcome === 'Connected — Interested';
  const code = (interested && NEXT_TO_DISPOSITION[proposal.next_action]) || OUTCOME_TO_DISPOSITION[proposal.outcome];
  const d = dispositionByCode(code);
  if (!d || d.activity_type !== 'Call') return { disposition: null, disposition_label: null };
  const when = d.requires_datetime ? istLocalIn(Number(proposal.next_action_due_hours) || 24) : null;
  return {
    disposition: d.code,
    disposition_label: d.label,
    disposition_group: d.outcome,
    ...(when ? { [d.next_step === 'meeting' ? 'meeting_at' : 'follow_up_at']: when } : {}),
  };
}

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

    /* The AI reads the lead and answers about it, so this handed back a summary
       of the other book's call. */
    const inBook = loadInBook(req, 'lead', lead_id);
    if (inBook.error) return res.status(inBook.status).json({ error: inBook.error });

    const ctx = ai.dispositionContext(Number(lead_id), transcript, duration_s);
    if (!ctx) return res.status(404).json({ error: 'Lead not found' });

    const started = Date.now();
    const proposal = await ai.disposition(ctx);

    res.json({
      ...proposal,
      ...asSetupOutcome(proposal),
      /* Each proposed change names the card it is about, so the confirm moves
         that card and no other; a change to a product the lead has no card
         for, or to the stage it is already in, is not offered. */
      card_changes: (proposal.card_changes ?? []).map((c) => {
        const card = ctx.cards.find((k) => k.product_code === c.product_code);
        return card && card.state !== c.to_state
          ? { ...c, card_id: card.id, from_state: card.state, product_name: card.product_name }
          : null;
      }).filter(Boolean),
      latency_ms: Date.now() - started,
      provider: ai.providerName,
      // The UI shows current state alongside each proposed change.
      cards: ctx.cards.map((c) => ({ id: c.id, code: c.product_code, name: c.product_name, state: c.state })),
    });
  } catch (err) { next(err); }
});

/**
 * What the AI drafted beyond the call itself, applied once the call is saved.
 *
 * A4 (QA-10; ruled 19 Nov, OPS-74). The call is saved first, by POST
 * /activities, like any other: its outcome, note, follow-up and score are
 * Setup's. This then marks that call as drafted by the AI, moves the product
 * cards the person kept from the draft -- through the same move as the card
 * panel's, so each says what it did -- and opens the compliance case a flag
 * calls for. It no longer writes a call of its own, a task outside the
 * follow-up rules (so with no reminders), or the lead's callback time.
 */
router.post('/disposition/confirm', (req, res) => {
  const { lead_id, activity_id, card_changes = [], compliance_flag, compliance_note, summary } = req.body;

  /* OPS-18. The preview above checks the book; this is the half that writes
     -- card states, a compliance case -- and it did not, so any user could
     apply a disposition to a lead in the other business. */
  const inBook = loadInBook(req, 'lead', lead_id);
  if (inBook.error) return res.status(inBook.status).json({ error: inBook.error });

  const lead = one('SELECT * FROM leads WHERE id = ?', [lead_id]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  /* The call this draft belongs to: this person's own, on this lead, saved as a call. */
  const call = activity_id
    ? one("SELECT * FROM activities WHERE id = ? AND lead_id = ? AND user_id = ? AND type = 'Call'", [activity_id, lead.id, req.user.id])
    : null;
  if (!call) {
    return res.status(400).json({
      error: 'Save the call first. An AI draft is saved as the call itself, then confirmed here.',
      field: 'activity_id',
    });
  }
  run('UPDATE activities SET ai_generated = 1 WHERE id = ?', [call.id]);

  // Card moves, each still role-gated, through the card panel's own move.
  const applied = [];
  const refused = [];
  for (const change of card_changes) {
    const card = one(
      `SELECT pc.*, pt.name AS product_name, pt.code AS product_code FROM product_cards pc JOIN product_types pt ON pt.id = pc.product_type_id
       WHERE pc.lead_id = ? AND (pc.id = ? OR pt.code = ?)`,
      [lead.id, Number(change.card_id) || -1, change.product_code ?? ''],
    );
    if (!card) continue;
    if (!CARD_STATES.includes(change.to_state)) {
      refused.push({ ...change, card_id: card.id, reason: `${change.to_state} is not a stage` });
      continue;
    }
    if (!userCan(req.user, MOVE_NEEDS[change.to_state])) {
      refused.push({ ...change, card_id: card.id, reason: `Your role cannot set a card to ${change.to_state}` });
      continue;
    }
    if (card.state === change.to_state) continue;
    const moved = moveCard({
      card, state: change.to_state, user: req.user,
      note: `From the call: ${change.evidence || 'AI draft, confirmed'}`, source: sourceOf(req),
    });
    if (moved.refused) refused.push({ ...change, card_id: card.id, reason: moved.refused });
    else applied.push({ ...change, card_id: card.id, effects: moved.effects });
  }

  // A compliance flag raises a ticket — it is never left in a note.
  let ticketId = null;
  if (compliance_flag && compliance_flag !== 'None') {
    /* QA-28. The same case every other door opens: the lead's book, a category
       where one fits, the least-loaded agent in that book, and the SLA clock --
       which this door never started, so a High compliance case had no deadline
       at all. It also took the first Customer Care agent in the table, in
       either business, and numbered the case BNZ- regardless. */
    const route = routeFor(compliance_flag);
    const opened = openCase({
      subject: `Compliance flag: ${compliance_flag}`,
      description: `${compliance_note || ''}\n\nFrom the call: ${summary || call.body || ''}`,
      priority: route.priority,
      categoryId: route.categoryId,
      leadId: lead.id, channel: 'CRM', createdBy: req.user.id, org: lead.sales_org,
    });
    ticketId = opened.id;
    if (opened.assignee) {
      notify(opened.assignee.id, 'Compliance flag raised', `${lead.name}: ${compliance_flag}`, `/tickets/${ticketId}`);
    }
  }

  audit(req.user.id, 'ai_disposition_confirmed', 'lead', lead.id, {
    activity_id: call.id, applied: applied.length, refused: refused.length, compliance_flag: compliance_flag || 'None',
  });

  res.json({ ok: true, activity_id: call.id, cards_updated: applied, cards_refused: refused, compliance_ticket_id: ticketId });
});

router.get('/leads/:id/next-action', async (req, res, next) => {
  try {
    /* The advice is assembled from the lead's tickets, cards and KYC state, so
     * an unscoped answer describes the record about as thoroughly as the
     * record itself does. */
    const scope = leadScope(req.user, 'l', activeOrg(req));
    const visible = one(
      `SELECT 1 v FROM leads l WHERE l.id = ? AND l.deleted_at IS NULL AND ${scope.sql}`,
      [req.params.id, ...scope.params],
    );
    if (!visible) return res.status(403).json({ error: 'This lead is outside your visibility scope' });

    const ctx = ai.nextActionContext(Number(req.params.id));
    if (!ctx) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ...(await ai.nextAction(ctx)), provider: ai.providerName });
  } catch (err) { next(err); }
});


/**
 * Turn an answer into clickable destinations (ENH-14).
 *
 * Deliberately NOT done by asking the model for links, and not by parsing URLs
 * out of its prose. Both let it invent a record that does not exist, or link to
 * one this user cannot open -- and a link that 404s in a CRM reads as data loss.
 *
 * Instead the snapshot is the allowlist. It was already built under the
 * caller's own leadScope, so a record can only become a link if it is both
 * named in the reply and already visible to the person reading it. Nothing else
 * can be linked, however confidently the model writes about it.
 */
function linksFor(reply, snapshot) {
  const text = String(reply || '');
  const seen = new Set();
  const links = [];

  const add = (label, to) => {
    if (!label || seen.has(to)) return;
    seen.add(to);
    links.push({ label, to });
  };

  for (const l of snapshot.leads ?? []) {
    // Whole-name match. A first name alone would link "Priya the RM" to a
    // client called Priya, which is worse than no link.
    if (l.name && text.includes(l.name)) add(l.name, `/leads/${l.id}`);
  }
  for (const t of snapshot.tickets ?? []) {
    if (t.ref && text.includes(t.ref)) add(t.ref, `/tickets/${t.id}`);
    else if (t.subject && text.includes(t.subject)) add(t.subject, `/tickets/${t.id}`);
  }

  return links.slice(0, 8);
}

/**
 * Where the user is standing, as a sentence the model can use.
 *
 * The assistant is one assistant, per the confirmed answer to Q-14 -- it is the
 * Copilot, told what page it was opened from. A second assistant would mean two
 * prompts, two grounding paths and two sets of behaviour to keep honest.
 */
function contextLine(context, user) {
  if (!context?.tab) return null;
  const where = `The user is currently on the ${context.tab} screen.`;
  if (!context.entity || !context.id) return where;

  if (context.entity === 'lead') {
    const scope = leadScope(user, 'l');
    const lead = one(
      `SELECT l.id, l.name, l.stage, l.source, l.city FROM leads l
        WHERE l.id = ? AND l.deleted_at IS NULL AND ${scope.sql}`,
      [context.id, ...scope.params],
    );
    if (lead) {
      return `${where} They are looking at the lead "${lead.name}" (id ${lead.id}, stage ${lead.stage}, source ${lead.source || 'unknown'}). Answer about this lead unless they clearly ask about something else.`;
    }
  }
  return where;
}

router.post('/copilot', async (req, res, next) => {
  try {
    const { question, history = [], context = null } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: 'A question is required' });

    const snapshot = ai.copilotSnapshot(req.user);
    const where = contextLine(context, req.user);

    const result = await ai.copilot({
      question: where ? `${where}\n\n${question}` : question,
      snapshot,
      history: history.slice(-8),
    });

    res.json({
      ...result,
      links: linksFor(result.reply, snapshot),
      context_used: Boolean(where),
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
