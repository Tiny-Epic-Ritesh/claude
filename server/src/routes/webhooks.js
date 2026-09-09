/**
 * Vendor webhooks — the inbound half of every integration.
 *
 * These routes are deliberately NOT behind `requireUser`: the caller is a vendor,
 * not a person. That makes them the most exposed surface in the system, so every
 * one of them:
 *
 *   1. verifies a shared secret before reading the body, and refuses when no
 *      secret is configured — an unauthenticated writer of client records is
 *      never an acceptable default;
 *   2. de-duplicates on the vendor's own event id, because every one of these
 *      vendors retries on timeout and at-least-once delivery is the norm;
 *   3. answers 200 as soon as the event is durably recorded. A webhook that
 *      returns 500 because our AI step failed will be redelivered forever.
 *
 * A rejected callback is audited. A vendor silently failing to reach us looks
 * exactly like a quiet week on the desk, which is how integrations rot unnoticed.
 */

import { Router } from 'express';
import { all, one, run, audit, notify, SALES_ORGS } from '../db.js';
import * as quickcall from '../vendors/quickcall.js';
import * as aisensy from '../vendors/aisensy.js';
import * as bonanzakyc from '../vendors/bonanzakyc.js';
import * as meta from '../vendors/meta.js';
import { formFor, applyMap, recordDelivery } from '../engine/leadads.js';
import { saveMessage } from '../engine/metaads.js';
import { applyScore } from '../engine/rules.js';
import { assignLead } from '../engine/assignment.js';
import { kycStatusSql, kycStatusFor } from '../engine/kycstatus.js';
import { resolveLead } from '../engine/callmatch.js';

const router = Router();

/** Shared guard: verify, audit the refusal, and stop. */
const guard = (vendor, verify) => (req, res, next) => {
  const result = verify(req);
  if (!result.ok) {
    audit(null, 'webhook_rejected', 'integration', null, { vendor, reason: result.reason });
    return res.status(401).json({ error: result.reason });
  }
  return next();
};

/** Has this vendor event already been recorded? */
const seen = (externalId) =>
  Boolean(externalId && one('SELECT id FROM activities WHERE external_id = ?', [externalId]));

/**
 * Find the lead a vendor event belongs to.
 *
 * Was `ORDER BY id DESC LIMIT 1` on the phone number, which silently picked
 * whichever matching lead was created last — so a family sharing one handset
 * got a confident, wrong entry on somebody's timeline. `resolveLead` refuses to
 * choose instead, and the callers below record the call against nobody with the
 * candidates named.
 */
const findLead = ({ leadId, mobile, callId = null }) =>
  resolveLead({ leadId, mobile, callId }).lead;

/* ------------------------------------------------------ QuickCall (CTI) */

/**
 * QuickCall's Save Call callback: one POST per completed call.
 *
 * This is where a call becomes CRM history. The AI disposition is deliberately
 * NOT run inline — it is proposed, never applied, and an RM confirms it (BRD
 * §6.1). Running it here would also couple call logging to model latency.
 */
router.post('/quickcall/call', guard('quickcall', quickcall.verifyWebhook), (req, res) => {
  const event = quickcall.parseCallEvent(req.body);

  if (seen(event.call_id)) {
    return res.json({ ok: true, duplicate: true, call_id: event.call_id });
  }

  const resolved = resolveLead({ leadId: event.lead_id, mobile: event.mobile, callId: event.call_id });
  const lead = resolved.lead;
  if (!lead) {
    /* Record it rather than dropping it: an unmatched call is a real call, and
       usually means an inbound from someone not yet in the CRM.

       `ambiguous` is the other case, and it is deliberate — several leads share
       this handset and nothing in the event says which of them was on it. A
       call attributed to the wrong family member is worse than a call
       attributed to nobody, so the candidates are recorded and a human places
       it. */
    audit(null, resolved.match === 'ambiguous' ? 'call_ambiguous' : 'call_unmatched', 'integration', null, {
      call_id: event.call_id, direction: event.direction, status: event.status,
      candidates: resolved.candidates.map((c) => c.id),
    });
    return res.json({
      ok: true, matched: false, call_id: event.call_id,
      ambiguous: resolved.match === 'ambiguous',
      candidates: resolved.candidates,
    });
  }

  const agent = event.agent_id
    ? one('SELECT id FROM users WHERE cti_agent_id = ? OR id = ?', [String(event.agent_id), Number(event.agent_id) || 0])
    : null;

  const answered = quickcall.wasAnswered(event);

  const result = run(
    `INSERT INTO activities (lead_id, type, direction, subject, body, outcome, duration_s, user_id, external_id, recording_url)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      lead.id, 'Call', event.direction,
      `Call — ${answered ? 'connected' : (event.status || 'not connected')}`,
      event.disposition || null,
      event.disposition || event.status || null,
      event.duration_s, agent?.id ?? null, event.call_id, event.recording_url,
    ],
  );

  if (answered) applyScore(lead.id, 'call_connected');

  // An inbound call from a known client is the moment an RM most wants to know.
  if (event.direction === 'inbound' && lead.owner_id) {
    notify(lead.owner_id, 'Inbound call', `${lead.name} called — ${answered ? 'connected' : 'missed'}`, `/leads/${lead.id}`);
  }

  return res.json({
    ok: true, matched: true, lead_id: lead.id,
    activity_id: Number(result.lastInsertRowid),
    ai_disposition_available: answered && Boolean(event.recording_url),
  });
});

/**
 * Screen pop. QuickCall calls this the instant a call starts ringing, and the
 * agent popup opens whatever URL we return. Kept to a single indexed lookup
 * because it sits in front of a ringing phone.
 */
router.get('/quickcall/screenpop', guard('quickcall', quickcall.verifyWebhook), (req, res) => {
  const mobile = quickcall.normaliseMsisdn(req.query.number || req.query.DialNumber);
  const resolved = resolveLead({ mobile });
  const lead = resolved.lead;

  /* Several people share this handset. Popping one of their files would put
     the wrong person's name in front of an agent who is about to say it out
     loud, so the pop offers the choice instead — the one place where guessing
     is not just wrong in the data but wrong in the room. */
  if (resolved.match === 'ambiguous') {
    return res.json({
      found: false,
      ambiguous: true,
      candidates: resolved.candidates.map((c) => ({ id: c.id, name: c.name })),
      url: `/leads?mobile=${encodeURIComponent(mobile)}`,
    });
  }

  if (!lead) {
    return res.json({
      found: false,
      // Offer a create-with-number link so an unknown caller becomes a lead in
      // one click rather than being retyped from memory after the call.
      url: `/leads?new=1&mobile=${encodeURIComponent(mobile)}`,
    });
  }

  return res.json({
    found: true,
    lead_id: lead.id,
    name: lead.name,
    url: `/leads/${lead.id}`,
    owner_id: lead.owner_id,
    kyc_status: kycStatusFor(lead.id),
  });
});

/* -------------------------------------------------- Smartping WhatsApp */

router.post('/smartping/whatsapp', guard('smartping', aisensy.verifyWebhook), (req, res) => {
  const event = aisensy.parseWebhook(req.body);

  if (event.kind === 'status') {
    // Delivery receipts update the message we already logged; only a failure is
    // worth an RM's attention, since "delivered" is the expected case.
    if (event.status === 'failed' && event.mobile) {
      const lead = findLead({ mobile: event.mobile });
      if (lead?.owner_id) {
        notify(lead.owner_id, 'WhatsApp not delivered', `${lead.name}: ${event.failure_reason || 'delivery failed'}`, `/leads/${lead.id}`);
      }
    }
    audit(null, 'whatsapp_status', 'integration', null, { status: event.status, message_id: event.message_id });
    return res.json({ ok: true, kind: 'status' });
  }

  if (seen(event.message_id)) return res.json({ ok: true, duplicate: true });

  const lead = findLead({ mobile: event.mobile });
  if (!lead) {
    audit(null, 'whatsapp_unmatched', 'integration', null, { message_id: event.message_id });
    return res.json({ ok: true, matched: false });
  }

  run(
    `INSERT INTO activities (lead_id, type, direction, subject, body, external_id)
     VALUES (?,?,?,?,?,?)`,
    [lead.id, 'WhatsApp', 'inbound', 'WhatsApp reply', event.text || '[media]', event.message_id],
  );

  // Stamping this opens the 24-hour service window, which is what lets an RM
  // reply in free text instead of being forced into an approved template.
  run('UPDATE leads SET wa_last_inbound_at = datetime(\'now\') WHERE id = ?', [lead.id]);

  applyScore(lead.id, 'inbound_message');

  if (lead.owner_id) {
    notify(lead.owner_id, 'WhatsApp reply', `${lead.name}: ${String(event.text || '[media]').slice(0, 80)}`, `/leads/${lead.id}`);
  }

  return res.json({ ok: true, matched: true, lead_id: lead.id });
});

/* ------------------------------------------------------- Bonanza eKYC */

/**
 * eKYC status callback.
 *
 * The portal is the regulatory system of record, so its status always wins over
 * anything the CRM inferred. We mirror it rather than reconciling it.
 */
router.post('/bonanza-kyc/status', guard('bonanza_kyc', bonanzakyc.verifyWebhook), (req, res) => {
  const status = bonanzakyc.normaliseStatus(req.body);

  const crmRef = status.crm_ref || req.body?.crm_ref;
  const leadId = crmRef && /^LEAD-(\d+)$/.test(crmRef) ? Number(crmRef.match(/^LEAD-(\d+)$/)[1]) : null;
  const lead = findLead({ leadId, mobile: status.mobile });

  if (!lead) {
    audit(null, 'kyc_status_unmatched', 'integration', null, { crm_ref: crmRef, stage: status.raw_stage });
    return res.json({ ok: true, matched: false });
  }

  // The portal's own stage is kept; the lead's KYC status is derived from it
  // and from any internal journey rather than mirrored here.
  run(
    'UPDATE leads SET kyc_portal_stage = ?, kyc_external_ref = ?, client_code = COALESCE(?, client_code) WHERE id = ?',
    [status.raw_stage, crmRef || null, status.client_code, lead.id],
  );

  run(
    'INSERT INTO activities (lead_id, type, direction, subject, body) VALUES (?,?,?,?,?)',
    [lead.id, 'KYC Event', 'system', `eKYC portal: ${status.stage || status.raw_stage}`, status.reason || null],
  );

  if (status.complete && lead.owner_id) {
    notify(lead.owner_id, 'KYC complete', `${lead.name} — account opened${status.client_code ? ` (${status.client_code})` : ''}`, `/leads/${lead.id}`);
  }
  if (status.rejected && lead.owner_id) {
    notify(lead.owner_id, 'KYC rejected', `${lead.name} — ${status.reason || 'rejected at the portal'}`, `/leads/${lead.id}`);
  }

  audit(null, 'kyc_status_received', 'lead', lead.id, { stage: status.raw_stage, complete: status.complete });
  return res.json({ ok: true, matched: true, lead_id: lead.id, stage: status.stage });
});

/* ------------------------------------------------------------- meta */

/**
 * Meta's subscription handshake.
 *
 * Meta GETs this once when the webhook is registered and expects the challenge
 * echoed back. Unauthenticated by necessity — the whole point is that Meta can
 * reach it before any trust is established — so it does nothing except compare
 * a token we chose and return a number.
 */
router.get('/meta', (req, res) => {
  const challenge = meta.verifySubscription(req.query);
  if (!challenge) return res.status(403).send('verification failed');
  return res.status(200).send(challenge);
});

/**
 * Lead Ads, Messenger and Instagram, all on one webhook.
 *
 * Meta batches: one delivery carries several entries, each with several
 * changes. Every one is processed independently — a malformed entry must not
 * cost the rest of the batch, because Meta will not resend the good ones.
 */
router.post('/meta', guard('meta', meta.verifyWebhook), async (req, res) => {
  const body = req.body ?? {};
  const results = { leads: 0, messages: 0, skipped: 0, errors: [] };

  for (const entry of body.entry ?? []) {
    // ---- Lead Ads -------------------------------------------------
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen') { results.skipped += 1; continue; }
      try {
        const raw = await meta.fetchLead(change.value?.leadgen_id);
        const lead = {
          ...raw,
          page_id: change.value?.page_id ?? raw.page_id,
          form_id: change.value?.form_id ?? raw.form_id,
        };
        if (createMetaLead(lead, req)) results.leads += 1;
        else results.skipped += 1;
      } catch (err) {
        /* A delivery that threw is the one most worth recording: Meta will not
           resend it, so this row is the only evidence it ever arrived. */
        recordDelivery({
          leadgenId: change.value?.leadgen_id,
          formId: change.value?.form_id,
          outcome: 'failed',
          detail: { error: err.message },
        });
        results.errors.push(err.message);
      }
    }

    // ---- Messenger / Instagram DMs --------------------------------
    for (const msg of entry.messaging ?? []) {
      if (!msg.message) { results.skipped += 1; continue; }
      try {
        const platform = body.object === 'instagram' ? 'Instagram' : 'Facebook';
        if (recordMetaMessage(meta.normaliseMessage(msg, platform))) results.messages += 1;
        else results.skipped += 1;
      } catch (err) {
        results.errors.push(err.message);
      }
    }
  }

  // Meta retries anything that is not a 200, so acknowledge even a partial
  // batch and keep the detail in the response for our own logs.
  return res.json({ ok: true, ...results });
});

/**
 * Turn a Meta lead into a CRM lead.
 *
 * Deduplicated on the Meta id first and the mobile second: Meta re-delivers on
 * retry, and the same person may fill the form twice. Neither should produce a
 * duplicate for an RM to reconcile.
 */
function createMetaLead(lead) {
  /* The form decides the book. Registered on first sight, so the console lists
     the forms that are really sending leads rather than the ones somebody
     remembered to add. */
  const form = formFor(lead.form_id, lead.page_id);
  const org = form?.sales_org ?? SALES_ORGS[0];

  /* The advertiser's own questions, kept. `answers` carries every field on the
     form; the map says which are lead columns and which are notes. */
  const { fields, notes } = applyMap(lead.answers ?? {}, lead.form_id);
  const unmapped = notes.filter((n) => !n.known).map((n) => n.question);

  const record = (outcome, leadId = null, extra = {}) => recordDelivery({
    leadgenId: lead.external_id, formId: lead.form_id, outcome, leadId,
    detail: { platform: lead.platform, unmapped, ...extra },
  });

  if (lead.external_id) {
    const seen = one('SELECT id FROM leads WHERE external_id = ?', [lead.external_id]);
    if (seen) {
      /* Meta retried a delivery we already handled. Recorded so the console can
         say so, rather than counting as silence. */
      record('duplicate', seen.id);
      return false;
    }
  }

  /* Deduplicated within the book, not across it. The same person can be a
     Bonanza lead and a Bigul lead -- they are different relationships with
     different RMs, and collapsing them hides one of them from the book that
     owns it. */
  if (fields.mobile) {
    const seen = one(
      'SELECT id FROM leads WHERE mobile = ? AND sales_org = ? AND deleted_at IS NULL',
      [fields.mobile, org],
    );
    if (seen) {
      // Not a new lead, but the fact they responded to an ad is worth knowing.
      run(
        `INSERT INTO activities (lead_id, type, direction, subject, body, user_id)
         VALUES (?, 'Note', 'system', ?, ?, NULL)`,
        [seen.id, `${lead.platform} lead form submitted again`,
          [`Form ${form?.name || lead.form_id || '—'}`, lead.campaign_name,
            ...notes.map((n) => `${n.question}: ${n.value}`)].filter(Boolean).join(' · ')],
      );
      record('repeat', seen.id);
      return false;
    }
  }

  const source = form?.source_label
    || (lead.platform === 'Instagram' ? 'Instagram' : 'Facebook Lead Ads');

  const info = run(
    `INSERT INTO leads (name, mobile, email, city, state, pan, language, risk_profile,
                        source, stage, sales_org, owner_id, external_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'New', ?,?,?, datetime('now'))`,
    [fields.name || lead.name, fields.mobile ?? null, fields.email ?? null,
      fields.city ?? null, fields.state ?? null, fields.pan ?? null,
      fields.language ?? null, fields.risk_profile ?? null,
      source, org, form?.owner_id ?? null, lead.external_id],
  );
  const leadId = Number(info.lastInsertRowid);

  run(
    `INSERT INTO activities (lead_id, type, direction, subject, body, user_id)
     VALUES (?, 'Note', 'system', ?, ?, NULL)`,
    [leadId, `Arrived from ${source}`,
      [lead.campaign_name && `Campaign: ${lead.campaign_name}`,
        lead.ad_id && `Ad: ${lead.ad_id}`,
        form?.name && `Form: ${form.name}`,
        !form?.name && lead.form_id && `Form: ${lead.form_id}`,
        /* The answers with nowhere structured to go. Usually the only thing on
           the form that says why this person is interested. */
        ...notes.map((n) => `${n.question}: ${n.value}`),
      ].filter(Boolean).join(' · ') || 'No campaign detail supplied'],
  );

  /* A form with its own owner has already said where the lead goes. Otherwise
     it is routed by the same assignment rules as any other inbound lead -- the
     seed already carries "Facebook Lead Ads → Digital Desk". */
  if (!form?.owner_id) {
    try {
      assignLead(one('SELECT * FROM leads WHERE id = ?', [leadId]));
    } catch { /* an unrouted lead is still a lead; it lands unassigned */ }
  }

  record('created', leadId, { sales_org: org });
  audit(null, 'lead_created_from_meta', 'lead', leadId, {
    source, sales_org: org, form_id: lead.form_id, campaign: lead.campaign_name,
  });
  return true;
}

/**
 * A DM is kept, and lands on a timeline once somebody says whose it is.
 *
 * THE BUG THIS REPLACES
 *
 * The sender was looked up with `leads.external_id = msg.from`, and
 * `external_id` holds a Meta *leadgen* id. A page-scoped sender id is never
 * equal to one, so the lookup failed for every message ever received and each
 * was discarded — a connector reporting zero messages forever, which reads
 * exactly like nobody having messaged.
 *
 * There is no automatic fix. Meta sends no phone number and no email with a
 * DM; a page-scoped id identifies nobody on its own, and that is deliberate on
 * Meta\'s part. So the message is kept either way and the console shows the
 * conversations nobody has claimed, where a person who recognises one links it.
 *
 * Still not turned into a lead. A Messenger id is not a contact detail, and a
 * CRM full of records nobody can call is worse than a missed message — that
 * reasoning was right and is unchanged.
 */
function recordMetaMessage(msg) {
  const saved = saveMessage({
    externalId: msg.external_id,
    psid: msg.from,
    platform: msg.platform,
    body: msg.body,
    attachments: msg.attachments,
    at: msg.at.slice(0, 19).replace('T', ' '),
  });

  if (!saved) return false;          // Meta retried; we already have it

  /* Only once somebody has said who this sender is. Until then it waits in the
     console, and linking it back-fills the timeline. */
  if (saved.leadId) {
    run(
      `INSERT INTO activities (lead_id, type, direction, subject, body, external_id, user_id, created_at)
       VALUES (?, 'Messenger', 'inbound', ?, ?, ?, NULL, ?)`,
      [saved.leadId, `${msg.platform} message`, msg.body || `(${msg.attachments} attachment(s))`,
        msg.external_id, msg.at.slice(0, 19).replace('T', ' ')],
    );
  }

  return true;
}

export default router;
