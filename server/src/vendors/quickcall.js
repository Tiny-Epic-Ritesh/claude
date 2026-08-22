/**
 * Cube Software QuickCall — dialler / CTI adapter.
 *
 * WHAT WE ESTABLISHED FROM THE LIVE TENANT
 * ----------------------------------------
 * cubehosted.net/cube/ serves "QuickCall Agent Popup" v7.2.4.5, an Ionic app
 * whose bundle exposes the vocabulary this adapter is written against:
 *
 *   MakeCall / DialNumber        click-to-call origination
 *   saveCallAPI, getSaveCallAPIurl,
 *   getSaveCallPostAPIurl        a CONFIGURABLE URL that QuickCall posts each
 *                                completed call to — the CTI→CRM hook
 *   MANUAL / Preview / Predictive / INBOUND / OUTBOUND   dial modes
 *   Ready / Break / ACW / HOLD / HANGUP / Mute / Logout  agent + call states
 *   CallStatus, callType, customerID, fileName           call-record fields
 *
 * SO THE INTEGRATION IS TWO-DIRECTIONAL
 * -------------------------------------
 *   CRM → QuickCall   click-to-call, and pushing a list into a dial campaign
 *   QuickCall → CRM   the Save Call callback, which lands on our webhook and
 *                     becomes an Activity, an AI disposition proposal, and a
 *                     screen-pop for inbound calls
 *
 * The exact REST paths and the field casing differ per Cube deployment, so both
 * are configuration rather than constants. The defaults below match the observed
 * tenant; `CUBE_QUICKCALL_*` overrides them without a code change.
 */

import { quickcall as cfg } from './config.js';
import { vendorFetch, safeEqual, VendorError } from './http.js';

export const name = 'QuickCall (Cube Software)';
export const isLive = () => cfg.configured;

/* ------------------------------------------------------------- outbound */

const authHeader = () => ({
  Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
});

/** Indian numbers reach the switch as bare 10 digits; strip +91, 0, spaces, dashes. */
export function normaliseMsisdn(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/**
 * Click-to-call. QuickCall rings the agent's extension first, then the customer,
 * which is why the agent extension is required and not merely nice to have.
 */
export async function makeCall({ agentExtension, agentId, mobile, leadId, campaign }) {
  if (!cfg.configured) throw new VendorError(name, 'QuickCall is not configured');
  if (!agentExtension) throw new VendorError(name, 'The agent has no QuickCall extension mapped');

  const destination = normaliseMsisdn(mobile);
  if (destination.length !== 10) throw new VendorError(name, `Not a dialable number: ${mobile}`);

  const { data } = await vendorFetch(name, `${cfg.baseUrl.replace(/\/$/, '')}/MakeCall`, {
    headers: authHeader(),
    body: {
      AgentID: agentId,
      Extension: agentExtension,
      DialNumber: destination,
      CampaignName: campaign || cfg.campaign,
      CallType: 'MANUAL',
      // Round-trips untouched on the Save Call callback, which is how we match
      // the completed call back to the lead without guessing by phone number.
      customerID: leadId ? String(leadId) : undefined,
      Tenant: cfg.tenant || undefined,
    },
    // Origination is not idempotent: a retry can place a second call to a
    // client. One attempt only — a failure surfaces to the agent, who redials.
    attempts: 1,
  });

  return {
    call_id: data?.CallID || data?.callId || data?.UCID || null,
    status: data?.Status || data?.CallStatus || 'originating',
    raw: data,
  };
}

/**
 * Push a list into a dial campaign for progressive/predictive dialling.
 * Chunked, because campaign-load endpoints commonly cap the batch size.
 */
export async function loadCampaign({ campaign, leads }) {
  if (!cfg.configured) throw new VendorError(name, 'QuickCall is not configured');

  const base = cfg.baseUrl.replace(/\/$/, '');
  const CHUNK = 500;
  let loaded = 0;

  for (let i = 0; i < leads.length; i += CHUNK) {
    const batch = leads.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    await vendorFetch(name, `${base}/LoadCampaignData`, {
      headers: authHeader(),
      body: {
        CampaignName: campaign || cfg.campaign,
        Tenant: cfg.tenant || undefined,
        Records: batch.map((l) => ({
          customerID: String(l.id),
          DialNumber: normaliseMsisdn(l.mobile),
          CustomerName: l.name,
          Priority: l.priority ?? 1,
        })),
      },
    });
    loaded += batch.length;
  }

  return { campaign: campaign || cfg.campaign, loaded };
}

/* -------------------------------------------------------------- inbound */

/**
 * QuickCall's Save Call payload, normalised.
 *
 * Field casing varies between deployments (the bundle contains both `callType`
 * and `CallType`), so every lookup is case-insensitive and accepts the aliases
 * seen in the wild. A silently unmapped field would mean a call that vanishes
 * from the timeline, which is worse than a loud failure.
 */
const pick = (payload, ...keys) => {
  const lower = {};
  for (const [k, v] of Object.entries(payload || {})) lower[k.toLowerCase()] = v;
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

export function parseCallEvent(payload) {
  const rawDirection = String(pick(payload, 'CallType', 'calltype', 'Direction') || '').toUpperCase();
  const direction = rawDirection.includes('IN') ? 'inbound' : 'outbound';

  const durationRaw = pick(payload, 'TalkTime', 'Duration', 'CallDuration', 'talktime');
  const duration = Number(String(durationRaw ?? '0').replace(/[^\d]/g, '')) || 0;

  return {
    call_id: pick(payload, 'CallID', 'UCID', 'UniqueID', 'callId'),
    lead_id: Number(pick(payload, 'customerID', 'CustomerID', 'LeadID')) || null,
    agent_id: pick(payload, 'AgentID', 'AgentId', 'Agent'),
    extension: pick(payload, 'Extension', 'AgentExtension'),
    mobile: normaliseMsisdn(pick(payload, 'DialNumber', 'CustomerNumber', 'Phone', 'MobileNo')),
    direction,
    status: pick(payload, 'CallStatus', 'Status', 'DialStatus'),
    disposition: pick(payload, 'Disposition', 'Remarks', 'SubDisposition'),
    duration_s: duration,
    recording_url: pick(payload, 'RecordingURL', 'fileName', 'FileName', 'RecordFile'),
    campaign: pick(payload, 'CampaignName', 'Campaign'),
    started_at: pick(payload, 'CallStartTime', 'StartTime'),
    ended_at: pick(payload, 'CallEndTime', 'EndTime'),
  };
}

/**
 * Authenticate a Save Call callback.
 *
 * This endpoint writes to the client timeline, so it is an authenticated route,
 * not a public one. If no secret is configured we refuse rather than accept —
 * an unauthenticated writer of client records is not an acceptable default, and
 * failing loudly at setup is far better than discovering it in an audit.
 */
export function verifyWebhook(req) {
  if (!cfg.webhookSecret) {
    return { ok: false, reason: 'CUBE_QUICKCALL_WEBHOOK_SECRET is not set — call events are refused until it is.' };
  }
  const presented = req.get('x-quickcall-signature')
    || req.get('x-webhook-secret')
    || req.query?.token
    || req.body?.token;

  if (!presented) return { ok: false, reason: 'No callback signature presented.' };
  if (!safeEqual(presented, cfg.webhookSecret)) return { ok: false, reason: 'Callback signature did not match.' };
  return { ok: true };
}

/** Wrap-up codes QuickCall reports that mean "no conversation happened". */
export const NO_CONTACT = new Set(['NOANSWER', 'BUSY', 'FAILED', 'CANCEL', 'CONGESTION', 'ABANDON', 'NA']);

export const wasAnswered = (event) =>
  event.duration_s > 0 && !NO_CONTACT.has(String(event.status || '').toUpperCase().replace(/[\s_-]/g, ''));
