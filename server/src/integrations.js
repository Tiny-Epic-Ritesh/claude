/**
 * Integration facade — every external system the CRM touches, in one place.
 *
 * Each adapter is LIVE when its credentials are configured and SIMULATED when
 * they are not, with identical call signatures either way. The same build runs
 * in a credential-free demo, in UAT against vendor sandboxes, and in production.
 * Nothing takes a code path in production that was never taken in test.
 *
 * Bonanza's real stack lives in ./vendors:
 *   quickcall.js   Cube Software QuickCall — dialler / CTI
 *   aisensy.js     Smartping WhatsApp (a white-labelled AiSensy tenant)
 *   bonanzakyc.js  kyc.bonanzaonline.com — the production eKYC journey
 *
 * SENDING IS QUEUED, NOT BLOCKING.
 * `send()` stays synchronous because the rules engine calls it inside a sweep.
 * It records the activity and an outbox entry immediately, then dispatches to
 * the vendor in the background and reconciles the entry when the vendor answers.
 * That is also the correct production shape: an RM should not wait on Meta, and
 * true delivery status arrives later by webhook regardless.
 */

import { run, one, all, audit } from './db.js';
import { rebuild } from './engine/metrics.js';
import * as quickcall from './vendors/quickcall.js';
import * as aisensy from './vendors/aisensy.js';
import * as bonanzakyc from './vendors/bonanzakyc.js';
import * as smtp from './vendors/smtp.js';
import { vendorStatus, FORCE_SIMULATION } from './vendors/config.js';
import { recordIntent } from './engine/callmatch.js';

export { vendorStatus };
export { bonanzakyc, quickcall, aisensy };

const LOG_LIMIT = 200;
const outbox = [];   // recent activity, kept in memory for the Integrations panel

/**
 * Record one integration event, durably.
 *
 * This used to write only to `outbox` — an array capped at 200 that vanished on
 * restart. "Show me the telephony logs" (P2-15a) is asked after something goes
 * wrong and the process has been bounced, which is exactly when that array was
 * empty. It now writes a row as well, and the array stays as the fast path for
 * the live panel.
 *
 * WHAT IS NOT WRITTEN: the body. A WhatsApp message is the client's own words,
 * a KYC callback carries their PAN. The row records that something happened, to
 * which record, through which vendor, and whether it worked — never what was
 * said. `to` is dropped for the same reason: it is a mobile number, and the
 * lead id already says who it was.
 */
const record = (channel, payload, meta = {}) => {
  const entry = { id: outbox.length + 1, channel, ...payload, ...meta, at: new Date().toISOString() };
  outbox.unshift(entry);
  if (outbox.length > LOG_LIMIT) outbox.pop();

  try {
    run(
      `INSERT INTO integration_log
         (kind, direction, vendor, status, simulated, lead_id, partner_id, user_id, reference, summary, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        channel,
        meta.direction ?? 'out',
        meta.vendor ?? null,
        meta.status ?? (meta.simulated ? 'simulated' : 'ok'),
        meta.simulated ? 1 : 0,
        meta.lead_id ?? null,
        meta.partner_id ?? null,
        meta.user_id ?? null,
        meta.call_id ?? meta.message_id ?? meta.reference ?? null,
        // The one-line summary the caller already writes, which is safe to keep.
        payload.body && String(payload.body).length <= 120 ? payload.body : (meta.summary ?? null),
        meta.error ?? null,
      ],
    );
  } catch {
    /* A log write must never fail the thing being logged. A dialler outage is
       bad; a dialler outage that also refuses to place calls because the log
       table is locked is worse. */
  }

  return entry;
};

export const getOutbox = () => outbox;

/** True when an adapter should pretend rather than call out. */
const simulate = (live) => FORCE_SIMULATION || !live();

/* ------------------------------------------------------------ messaging */

/**
 * Outbound message on any channel.
 *
 * Returns immediately with a queued entry. When a live vendor is configured the
 * dispatch happens in the background and the entry's status is updated in place,
 * so the Admin outbox shows the true outcome without the caller having waited.
 */
export function send(channel, {
  to, body, subject, leadId, partnerId, templateId,
  campaignName, templateOrder, templateVars, userName,
  attachmentNames = [], userId = null,
  text = null, attachments = [], replyTo = null,
}) {
  /* Email was hardcoded to simulate, so every message the composer produced was
     recorded on the timeline and silently never delivered. It relays through a
     mail server Bonanza runs, which keeps the data in India — the reason this
     is SMTP and not Microsoft Graph, whose residency question is still open. */
  const simulated = channel === 'whatsapp'
    ? simulate(aisensy.isLive)
    : channel === 'email' ? simulate(smtp.isLive) : true;

  const entry = record(channel, { to, body, subject, template_id: templateId }, {
    simulated,
    status: simulated ? 'delivered' : 'queued',
    lead_id: leadId ?? null,
    partner_id: partnerId ?? null,
  });

  /* The single writer of the outbound timeline entry.
   *
   * The composer used to insert its own as well, so every email from it landed
   * on the lead twice -- a mirrored interaction, which is the first
   * non-negotiable in CLAUDE.md and the shape the LeadSquared audit spent
   * findings on. The e2e check found the activity by id and so never noticed
   * there were two of them; it counts now.
   *
   * Owning it here rather than adding a "do not log" flag means the next caller
   * cannot reintroduce the duplicate by forgetting to pass one. Anything the
   * caller knows and this does not -- attachment names -- comes in as an
   * argument. */
  if (leadId) {
    entry.activity_id = Number(run(
      'INSERT INTO activities (lead_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)', [
        leadId,
        channel === 'email' ? 'Email' : channel === 'sms' ? 'SMS' : channel === 'ivr' ? 'Call' : 'WhatsApp',
        'outbound',
        subject || `${channel.toUpperCase()} sent`,
        attachmentNames.length ? `${body}\n\nAttached: ${attachmentNames.join(', ')}` : body,
        userId ?? null,
      ],
    ).lastInsertRowid);
  }
  if (partnerId) {
    run('INSERT INTO activities (partner_id, type, direction, subject, body) VALUES (?,?,?,?,?)', [
      partnerId, 'Partner Activity', 'outbound', `${channel.toUpperCase()} sent`, body,
    ]);
  }

  if (!simulated && channel === 'email') {
    /* Same background shape as WhatsApp below: the RM has already been told the
       mail is away, and a relay that is slow to answer must not hold the
       request open behind it. A failure lands on the outbox entry and the audit
       log, where the operator surface reads it. */
    smtp.sendMail({
      to, subject, html: body, text, userName, replyTo,
      attachments,
    })
      .then((res) => {
        entry.status = 'sent';
        entry.message_id = res.message_id;
      })
      .catch((err) => {
        entry.status = 'failed';
        entry.error = err.message;
        audit(null, 'vendor_send_failed', 'integration', leadId ?? null, { channel, vendor: err.vendor ?? null, reason: err.message });
      });
  }

  if (!simulated && channel === 'whatsapp') {
    // Background dispatch. Failures land on the outbox entry and the audit log,
    // never as an unhandled rejection that takes the process down.
    aisensy.sendTemplateNamed({
      to,
      campaignName,
      userName,
      order: templateOrder,
      named: templateVars || {},
    })
      .then((res) => {
        entry.status = res.accepted ? 'sent' : 'rejected';
        entry.message_id = res.message_id;
      })
      .catch((err) => {
        entry.status = 'failed';
        entry.error = err.message;
        audit(null, 'vendor_send_failed', 'integration', leadId ?? null, { channel, vendor: err.vendor ?? null, reason: err.message });
      });
  }

  return entry;
}

/* ------------------------------------------------------------ telephony */

/**
 * Which CUBE queue a call goes into.
 *
 * This is what the cross-campaign requirement actually needs. AuthClick2Call
 * carries the campaign per request, so a Bigul desk and a Bonanza desk can dial
 * from different queues on the same switch, and neither is tied to whatever the
 * agent happened to log into.
 *
 * Most specific wins:
 *   1. a queue registered for this lead's product, in this lead's book
 *   2. the book's default queue
 *   3. the environment default — the placeholder, which is not a real CUBE
 *      campaign and exists so the product runs unconfigured
 *
 * The book is taken from the lead, never from the caller. A supervisor working
 * across both books dials each lead into its own book's queue, which is the
 * same boundary every other query in the product holds.
 */
export function campaignFor(lead, productTypeId = null, userId = null) {
  const org = lead?.sales_org || 'BONANZA';

  /* The caller's team first, because a Cube campaign is per team: Cube creates
     one campaign per team and that team's agents log into it. This is asked
     before product for a reason — a team is a property of the person dialling,
     while a product is a property of the lead, and two people on one team
     calling the same lead about different products belong in the same queue.

     `sales_org = ?` on both the team and the row keeps the boundary the rest of
     this function keeps: an agent whose team sits in the other book finds no
     campaign here and falls through, rather than dialling out of a queue that
     is not theirs. */
  /* The caller's own campaign first. P3-12.
   *
   * Above the team on purpose, and consistent with the rule the team lookup
   * itself follows: the more specific answer wins. A campaign on the team is
   * where most people's comes from -- Ritesh settled that on 3 Sep -- and a
   * campaign on the person is the exception that outranks it, for somebody
   * seconded to another desk who would otherwise dial out under a queue they
   * are not working and take the reporting with them.
   *
   * Book-checked like every other branch. A campaign set on a user in the other
   * business is not a reason to cross the boundary. */
  const byUser = userId && one(
    `SELECT u.cube_campaign_id FROM users u
      WHERE u.id = ? AND u.active = 1
        AND u.cube_campaign_id IS NOT NULL AND u.cube_campaign_id != ''
        AND u.sales_org = ?`,
    [userId, org],
  );
  if (byUser) return { campaign: byUser.cube_campaign_id, source: 'user' };

  const byTeam = userId && one(
    `SELECT dc.cube_campaign_id FROM dialler_campaigns dc
       JOIN teams tm      ON tm.id = dc.team_id
       JOIN team_members m ON m.team_id = tm.id
      WHERE dc.active = 1 AND tm.active = 1 AND m.user_id = ?
        AND dc.sales_org = ? AND tm.sales_org = ?
      ORDER BY dc.is_default DESC, dc.id LIMIT 1`,
    [userId, org, org],
  );
  if (byTeam) return { campaign: byTeam.cube_campaign_id, source: 'team' };

  /* A lead has no product column — products hang off it as product_cards, and
     it can hold several. "The lead's product" therefore needs a stated rule
     rather than a guess, because picking arbitrarily among several open cards
     would put the call in an arbitrary queue and nothing would ever say so.

     When the RM calls from a product card we know the product exactly, and it
     is passed in. Only when we do not — a call from the lead header, or from a
     list row — is it inferred, and then the rule is the open card touched most
     recently, which is the product they are actually working. Closed cards are
     ignored: a won or lost product is not what this call is about. */
  const card = productTypeId
    ? { product_type_id: productTypeId }
    : lead?.id && one(
      `SELECT product_type_id FROM product_cards
       WHERE lead_id = ? AND state NOT IN ('Won', 'Lost')
       ORDER BY COALESCE(last_state_at, created_at) DESC, id DESC
       LIMIT 1`,
      [lead.id],
    );

  const byProduct = card?.product_type_id && one(
    `SELECT cube_campaign_id FROM dialler_campaigns
     WHERE active = 1 AND sales_org = ? AND product_type_id = ?
     ORDER BY is_default DESC, id LIMIT 1`,
    [org, card.product_type_id],
  );
  if (byProduct) return { campaign: byProduct.cube_campaign_id, source: 'product' };

  const byOrg = one(
    `SELECT cube_campaign_id FROM dialler_campaigns
     WHERE active = 1 AND sales_org = ? AND product_type_id IS NULL
     ORDER BY is_default DESC, id LIMIT 1`,
    [org],
  );
  if (byOrg) return { campaign: byOrg.cube_campaign_id, source: 'book' };

  // Nothing registered. The adapter falls back to the configured placeholder,
  // and the caller is told the queue was not chosen so a screen can say so.
  return { campaign: null, source: 'fallback' };
}

/**
 * Click-to-call. Async because the agent needs to know whether the switch
 * actually rang — a silently failed dial is worse than an error toast.
 */
export async function click2call({ userId, leadId, mobile, campaign = null, productTypeId = null }) {
  const agent = one('SELECT id, name, phone_extension, cti_agent_id FROM users WHERE id = ?', [userId]);
  const lead = leadId
    ? one('SELECT id, name, sales_org FROM leads WHERE id = ?', [leadId])
    : null;

  // An explicit campaign always wins; otherwise it is resolved from the lead.
  const resolved = campaign ? { campaign, source: 'explicit' } : campaignFor(lead, productTypeId, userId);

  /* No simulation branch here any more. The adapter simulates below its own
     field mapping, so the same code builds the request body whether or not
     credentials are present — a typo in a CUBE field name now fails a test
     instead of surviving until the first live call. */
  try {
    const res = await quickcall.makeCall({
      /* The CUBE agent id, or nothing. Never our internal user id: CUBE would
         either reject it or attribute the call to whichever of its agents
         happens to be called "2". AgentID is optional on Click2Call, so an
         unmapped user places an unattributed call rather than a misattributed
         one — and `agent_mapped` below says which happened. */
      agentId: agent?.cti_agent_id || null,
      mobile,
      leadId,
      leadName: lead?.name,
      campaign: resolved.campaign,
    });
    record('telephony', { to: mobile, body: 'Click2Call placed' }, {
      simulated: res.simulated, call_id: res.call_id, lead_id: leadId, user_id: userId, status: res.status,
    });

    /* Who we rang, so the result can be matched back to them exactly. CUBE's
       call log does not return ClientId, and the phone number alone cannot
       separate a family sharing one handset. */
    recordIntent({ mobile, leadId, userId, callId: res.call_id });
    return {
      ...res,
      agent_mapped: Boolean(agent?.cti_agent_id),
      // How the queue was chosen, so a screen can distinguish "dialled into the
      // Bigul equity queue" from "dialled into the placeholder because nobody
      // has registered a queue yet".
      campaign_source: resolved.source,
    };
  } catch (err) {
    record('telephony', { to: mobile, body: `Click2Call failed — ${err.message}` }, { simulated: false, lead_id: leadId, user_id: userId, status: 'failed' });
    throw err;
  }
}

export function logCall({ leadId, userId, durationS, outcome, direction = 'outbound', recordingUrl = null, callId = null }) {
  const result = run(
    'INSERT INTO activities (lead_id, type, direction, subject, outcome, duration_s, user_id, external_id, recording_url) VALUES (?,?,?,?,?,?,?,?,?)',
    [
      leadId, 'Call', direction, `Call — ${outcome || 'completed'}`, outcome || null,
      durationS || 0, userId || null, callId, recordingUrl,
    ],
  );
  return Number(result.lastInsertRowid);
}

/** Push a list into a QuickCall dial campaign for progressive/predictive dialling. */
export async function pushToAutodialler(leadIds, userId) {
  const leads = leadIds.length
    ? all(`SELECT id, name, mobile FROM leads WHERE id IN (${leadIds.map(() => '?').join(',')})`, leadIds)
    : [];

  const res = await quickcall.loadCampaign({ leads });

  /* The upload endpoint returns a real load report, so a partial load is
     reported as one. "500 queued" when 40 were rejected is the kind of quiet
     success that is discovered a week later by someone wondering why nobody
     called their list. */
  const note = res.rejected || res.duplicates || res.malformed
    ? `Loaded ${res.inserted} of ${leads.length} into ${res.campaign}`
      + ` — ${res.rejected} rejected, ${res.duplicates} duplicate, ${res.malformed} malformed`
    : `Loaded ${res.inserted} into ${res.campaign}`;

  record('autodialler', { to: `${leads.length} leads`, body: note }, { simulated: res.simulated, user_id: userId });
  return {
    queued: res.inserted, leads, campaign: res.campaign, simulated: res.simulated,
    rejected: res.rejected, duplicates: res.duplicates, malformed: res.malformed,
  };
}

/* --------------------------------------------------------- KYC vendors */

/**
 * DigiLocker Aadhaar fetch.
 * Still simulated: which KYC sub-vendor performs this on kyc.bonanzaonline.com
 * has not been disclosed to us, and guessing a provider would be worse than
 * being explicit that it is pending.
 */
export function digilockerFetch({ pan, dob }) {
  record('digilocker', { to: pan, body: 'Aadhaar eKYC fetch' }, { simulated: true });
  return {
    simulated: true,
    verified: true,
    name_as_per_aadhaar: null,
    address_available: true,
    photo_available: true,
    reference_id: `DL-${Date.now().toString(36).toUpperCase()}`,
    dob_match: Boolean(dob),
  };
}

/**
 * Bank penny drop.
 * Deterministic simulation: accounts ending in an odd digit fail, so the
 * fallback path (bank proof upload, BRD KYC step 9) is demonstrable without
 * random flakiness.
 */
export function pennyDrop({ accountNumber, ifsc, accountHolder }) {
  record('penny_drop', { to: `${accountNumber}/${ifsc}`, body: 'Penny drop verification' }, { simulated: true });

  const failed = /[13579]$/.test(String(accountNumber || ''));
  return {
    simulated: true,
    verified: !failed,
    failed,
    name_at_bank: failed ? null : accountHolder,
    reason: failed ? 'Name mismatch at bank — manual verification required' : null,
    reference_id: `PD-${Date.now().toString(36).toUpperCase()}`,
  };
}

/** Aadhaar eSign (NSDL/CDAC ASP). */
export function esign({ otp }) {
  record('esign', { to: 'NSDL eSign', body: 'Aadhaar OTP eSign' }, { simulated: true });
  return {
    simulated: true,
    signed: String(otp || '').length === 6,
    document_id: `ESIGN-${Date.now().toString(36).toUpperCase()}`,
    signed_at: new Date().toISOString(),
  };
}

/**
 * Hand a lead to the production eKYC portal with attribution intact.
 * Returns the link and records the handoff, so the RM can see exactly what the
 * client was sent and the commission trail has a starting point.
 */
export function kycHandoff({ lead, owner, partner, productCode, campaign }) {
  const url = bonanzakyc.journeyUrl({ lead, owner, partner, productCode, campaign });
  record('bonanza_kyc', { to: lead?.mobile, body: 'eKYC handoff link issued' }, {
    simulated: !bonanzakyc.isLive(), lead_id: lead?.id ?? null, url,
  });
  audit(owner?.id ?? null, 'kyc_handoff', 'lead', lead?.id ?? null, {
    mode: bonanzakyc.mode(), partner_id: partner?.id ?? null,
  });
  return { url, mode: bonanzakyc.mode() };
}

/** OTP dispatch for the CRM's own DKYC portal. Demo OTP is fixed so it is testable. */
export const DEMO_OTP = '123456';

export function sendOtp(channel, destination) {
  record(channel === 'email' ? 'email' : 'sms', { to: destination, body: `Your Bonanza verification code is ${DEMO_OTP}` }, { simulated: true, otp: true });
  return { sent: true, simulated: true, hint: `Demo build — use ${DEMO_OTP}` };
}

export const verifyOtp = (submitted) => String(submitted) === DEMO_OTP;

/* ------------------------------------------------------- internal data */

/**
 * Trading database (BRD OD-06).
 * Nightly batch; values carry an "as of" date because the feed is not live.
 */
export function syncTradingDb() {
  const activeCards = all("SELECT pc.*, l.id AS lead_id FROM product_cards pc JOIN leads l ON l.id = pc.lead_id WHERE pc.state = 'ACTIVE'");
  const asOf = new Date().toISOString().slice(0, 10);

  for (const card of activeCards) {
    const seed = (card.id * 7919) % 100;
    const value = card.value || Math.round((50_000 + seed * 12_500) / 1000) * 1000;
    run('UPDATE product_cards SET value = ? WHERE id = ?', [value, card.id]);
  }

  // AUM is no longer stamped onto the lead. It is the sum of the ACTIVE cards
  // this job just wrote, so `lead_metrics` derives it and can never disagree
  // with the cards it came from. Rebuilding here keeps the projection fresh
  // immediately rather than waiting for the next sweep.
  rebuild(null);

  record('trading_db', { to: 'internal', body: `Nightly AUM sync — ${activeCards.length} active cards` }, { simulated: true });
  return { cards: activeCards.length, as_of: asOf, simulated: true };
}

/** Partner LMS. */
export function lmsSync(partnerId) {
  const modules = all('SELECT * FROM partner_lms WHERE partner_id = ?', [partnerId]);
  record('lms', { to: `partner ${partnerId}`, body: `Progress sync — ${modules.length} modules` }, { simulated: true });
  return modules;
}

/* ------------------------------------------------------------- registry */

/** Drives the Admin → Integrations health panel. */
export function integrationRegistry() {
  const v = vendorStatus();
  return [
    { key: 'telephony', name: 'Cube QuickCall — Click2Call', status: v.quickcall.state, contract: 'POST /QuickCall61AuthToken/AuthClick2Call/ {PhoneNo, CampaignID, AgentID, ClientID} → callID. Campaign travels per call, so an agent is not tied to the one they logged into.' },
    { key: 'autodialler', name: 'Cube QuickCall — Campaign dialler', status: v.quickcall.state, contract: 'POST /QuickCallRaphsody/Uploadlead61.php {CampaignId, data[]} → load report with rejected/duplicate counts' },
    { key: 'whatsapp', name: 'Smartping WhatsApp (AiSensy)', status: v.smartping.state, contract: 'POST /campaign/t1/api/v2 {apiKey, campaignName, destination, templateParams[]}; delivery + reply webhooks' },
    { key: 'bonanza_kyc', name: 'Bonanza eKYC portal', status: v.bonanza_kyc.state, contract: `Mode "${v.bonanza_kyc.mode}" — attributed handoff link + status callback` },
    { key: 'sms', name: 'SMS Gateway', status: 'simulated', contract: 'Provider not yet nominated' },
    { key: 'email', name: 'Email Service', status: v.smtp.state, contract: 'SMTP relay; open + click tracking webhooks' },
    { key: 'digilocker', name: 'DigiLocker Aadhaar eKYC', status: 'simulated', contract: 'Performed inside the eKYC portal — sub-vendor not disclosed' },
    { key: 'penny_drop', name: 'Bank Penny Drop', status: 'simulated', contract: 'Performed inside the eKYC portal — sub-vendor not disclosed' },
    { key: 'esign', name: 'Aadhaar eSign (NSDL)', status: 'simulated', contract: 'Performed inside the eKYC portal — sub-vendor not disclosed' },
    { key: 'trading_db', name: 'Trading DB (AUM)', status: 'simulated', contract: 'Nightly cron batch; values stamped "as of" date' },
    { key: 'lms', name: 'Partner LMS', status: 'simulated', contract: 'SCORM/xAPI callback or nightly roster export' },
    { key: 'ai', name: 'AI Engine', status: process.env.ANTHROPIC_API_KEY ? 'live' : 'configurable', contract: 'Claude Messages API, behind the residency policy' },
  ];
}

/** Kept as a named export because the cockpit and admin routes both import it. */
export const INTEGRATIONS = integrationRegistry();
