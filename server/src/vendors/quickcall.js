/**
 * Cube Software QuickCall — dialler / CTI adapter.
 *
 * REWRITTEN 31 AUGUST 2026 AGAINST THE PUBLISHED SPECIFICATION
 * ------------------------------------------------------------
 * The previous version of this file was written against vocabulary read out of
 * the QuickCall Agent Popup's JavaScript bundle — `MakeCall`, `LoadCampaignData`,
 * Basic auth, `DialNumber`, `CampaignName`. It was honest about being inferred.
 * It was also wrong in nearly every particular. The real API, now documented in
 * `docs/integrations/CUBE-QUICKCALL-API.md`, uses different endpoints, a
 * different authentication scheme and different field names.
 *
 * Keeping the guessed version would have meant an integration that fails on its
 * first live call, months after anyone remembers it was guesswork.
 *
 * HOW A CALL IS PLACED, AND WHY IT IS THIS ENDPOINT
 * ------------------------------------------------
 * Requirement (Ritesh, 31 Aug): an agent must be able to call a lead regardless
 * of which campaign they logged into, in CUBE or in the CRM.
 *
 * `AuthManualPass` — the endpoint whose name suggests "place a manual call" —
 * cannot do this. It takes `AuthId` and no campaign at all; the campaign is
 * welded to whatever was fixed at `AuthLogin`, with no override and no endpoint
 * to change a live session. Meeting the requirement there would mean logging the
 * agent off and on for every cross-campaign call.
 *
 * `AuthClick2Call` carries `CampaignID` per call and takes no `AuthId`. So it
 * works for any campaign, and for an agent who signed into CUBE's own client
 * rather than ours — or into nothing at all.
 *
 * The consequence is larger than the requirement: `AuthClick2Call` authenticates
 * on the tenant token alone, so **no agent's CUBE password is needed anywhere in
 * the calling path**. Session control (break, hold, transfer, dispose, agent
 * status) does need `AuthLogin` and is therefore a separate, opt-in feature that
 * is deliberately not built here.
 *
 * THE ONE THING NOT YET VERIFIED
 * -----------------------------
 * Whether `AuthClick2Call` dials immediately or inserts the number into the
 * campaign's queue. The specification does not say, and two details point at
 * queue-insertion: `Priority` and `Duplicate` are list-management fields, and its
 * response shape (`status` / `callID` / `message`) differs from the
 * `Api` / `Status` every other call-control endpoint returns.
 *
 * Until it is checked on UAT this adapter does not claim the phone is ringing.
 * It reports what CUBE reported. Telling an agent a call is connecting when it
 * is actually forty-third in a queue is the kind of small lie that destroys
 * trust in a tool.
 */

import { quickcall as cfg, FORCE_SIMULATION } from './config.js';
import { vendorFetch, safeEqual, VendorError } from './http.js';

export const name = 'QuickCall (Cube Software)';
export const isLive = () => cfg.configured;

/** Simulated when credentials are absent, or when the kill switch is on. */
const simulating = () => FORCE_SIMULATION || !cfg.configured;

const base = () => String(cfg.baseUrl || 'https://raphsody.in').replace(/\/$/, '');

/* ------------------------------------------------------------ numbers */

/** Indian numbers reach the switch as bare 10 digits; strip +91, 0, spaces, dashes. */
export function normaliseMsisdn(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/* ---------------------------------------------------- the tenant token */

/**
 * `AuthToken` returns a token and the seconds it lives for. Every secure
 * endpoint wants it as the bare `Authorization` header value — not `Bearer x`,
 * just `x`. Getting that wrong produces a 401 that reads like bad credentials.
 *
 * Cached at module scope and refreshed early. The margin matters: a token that
 * expires between our check and CUBE's check fails a call the agent is waiting
 * on, and there is no safe automatic retry for "place a call".
 */
let cached = { token: null, expiresAt: 0 };

/** Refresh this many ms before expiry rather than at it. */
const REFRESH_MARGIN_MS = 60_000;

/** Exported for tests, and for a sign-out that should not leave a token behind. */
export function resetToken() { cached = { token: null, expiresAt: 0 }; }

async function token() {
  if (cached.token && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;

  const { data } = await request('/QuickCall61AuthToken/AuthToken/', {
    UserID: cfg.user,
    Password: cfg.password,
  }, { authenticated: false });

  if (!data?.Token) throw new VendorError(name, 'CUBE returned no token for our credentials');

  // ExpiresIn is documented in seconds. Treated as a floor: if it is missing or
  // nonsense we assume a short life rather than a long one, because the failure
  // from refreshing too often is a wasted request and the failure from
  // refreshing too rarely is a dropped call.
  const ttl = Number(data.ExpiresIn);
  cached = {
    token: data.Token,
    expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 300) * 1000,
  };
  return cached.token;
}

/* -------------------------------------------------------- the transport */

/**
 * One CUBE request, live or simulated.
 *
 * The simulator sits *here*, below the field mapping, rather than above it in
 * `integrations.js`. That is deliberate: a simulator that short-circuits before
 * the request body is built never exercises the field names, so a typo in
 * `CampaignID` would pass every test and fail on the first live call. This way
 * the body that the tests inspect is the body that CUBE would receive.
 */
async function request(path, body, { authenticated = true, attempts = 3 } = {}) {
  const clean = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );

  if (simulating()) return { data: simulate(path, clean), simulated: true, sent: clean };

  const headers = authenticated ? { Authorization: await token() } : {};
  const { data } = await vendorFetch(name, `${base()}${path}`, { headers, body: clean, attempts });
  return { data, simulated: false, sent: clean };
}

/**
 * The simulator.
 *
 * Shapes match the specification exactly, including the two inconsistencies the
 * real API has — `AuthClick2Call` answering in lowercase `status` while every
 * other endpoint answers in `Api` / `Status`. Smoothing those over here would
 * hide the thing most likely to break us.
 */
function simulate(path, body) {
  const stamp = Date.now().toString(36).toUpperCase();

  /* Matched on the last path segment, never on a substring of the whole path.
     Every secure endpoint lives under `/QuickCall61AuthToken/`, so a substring
     test for 'AuthToken' matches AuthClick2Call, AuthCallLog and every other
     one — which is exactly the bug this comment replaced. */
  const endpoint = path.split('/').filter(Boolean).pop();

  switch (endpoint) {
    case 'AuthToken':
      return { Api: 'AuthToken', Status: 'Success', Token: `SIMTOKEN-${stamp}`, ExpiresIn: 3600 };

    case 'AuthClick2Call':
      // Lowercase `status`, and a `callID` — as the specification has it.
      return { status: 'Success', callID: `SIMCALL-${stamp}`, message: 'Simulated: no dialler configured' };

    case 'AuthCallLog':
      return { Status: 'Success', Records: [] };

    case 'Uploadlead61.php': {
      const rows = Array.isArray(body.data) ? body.data.length : 0;
      return {
        UploadLead: 'Success',
        Response: {
          Records: rows, Inserted: rows, Rejected: 0,
          AlphaNumeric: 0, DuplicateRows: 0, PhoneNoLength: 0,
        },
      };
    }

    default:
      // Loudly, rather than a bland success that hides an unrouted endpoint.
      return { Api: endpoint, Status: 'Failure', message: `No simulator for ${endpoint}` };
  }
}

/* ------------------------------------------------------------- calling */

/**
 * Place a call, into any campaign.
 *
 * `ClientId` is our lead id. CUBE accepts it on the way in and — per §4 of the
 * reference — does not return it on the call log, so the `callID` that comes
 * back here is the only reliable key we get. It is stored on the activity.
 */
export async function makeCall({ agentId, mobile, leadId, leadName, campaign, remark } = {}) {
  const destination = normaliseMsisdn(mobile);
  if (destination.length !== 10) throw new VendorError(name, `Not a dialable number: ${mobile}`);

  const campaignId = campaign || cfg.campaign;
  if (!campaignId) {
    throw new VendorError(name, 'No CUBE campaign is configured for this call');
  }

  const { data, simulated, sent } = await request('/QuickCall61AuthToken/AuthClick2Call/', {
    PhoneNo: destination,
    CampaignID: campaignId,
    AgentID: agentId,
    ClientID: leadId != null ? String(leadId) : undefined,
    Name: leadName,
    Remark: remark,
  }, {
    // Origination is not idempotent: a retry can place a second call to a
    // client. One attempt only — a failure surfaces to the agent, who redials.
    attempts: 1,
  });

  const ok = /success|ok/i.test(String(data?.status ?? data?.Status ?? ''));
  if (!ok) {
    throw new VendorError(name, data?.message || 'CUBE refused the call', { body: data });
  }

  return {
    call_id: data?.callID ?? null,
    // Deliberately not "ringing". See the header note: until Click2Call's
    // dial-versus-queue behaviour is verified on UAT, we report acceptance,
    // which is all we actually know.
    status: 'accepted',
    campaign: campaignId,
    message: data?.message ?? null,
    simulated,
    sent,
  };
}

/* ------------------------------------------------- pushing a dial list */

/**
 * Push leads into a campaign for progressive/predictive dialling.
 *
 * Chunked, because campaign-load endpoints commonly cap the batch size and the
 * specification does not state a limit. The response is a genuine load report —
 * rejected, duplicate and malformed counts — so a partial load is reported as a
 * partial load rather than as success.
 */
export async function loadCampaign({ campaign, leads = [], fixedAgent = null } = {}) {
  const campaignId = campaign || cfg.campaign;
  if (!campaignId) throw new VendorError(name, 'No CUBE campaign is configured for this upload');

  const CHUNK = 500;
  const totals = { records: 0, inserted: 0, rejected: 0, duplicates: 0, malformed: 0 };
  let simulated = false;

  for (let i = 0; i < leads.length; i += CHUNK) {
    const batch = leads.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const { data, simulated: sim } = await request('/QuickCallRaphsody/Uploadlead61.php', {
      CampaignId: campaignId,
      FixedAgent: fixedAgent || undefined,
      DuplicityCheck: '1',
      data: batch.map((l) => ({
        PhoneNo: normaliseMsisdn(l.mobile),
        Name: l.name,
        ClientID: String(l.id),
      })),
    });
    simulated = simulated || sim;

    const r = data?.Response ?? {};
    totals.records += Number(r.Records) || 0;
    totals.inserted += Number(r.Inserted) || 0;
    totals.rejected += Number(r.Rejected) || 0;
    totals.duplicates += Number(r.DuplicateRows) || 0;
    totals.malformed += (Number(r.AlphaNumeric) || 0) + (Number(r.PhoneNoLength) || 0);
  }

  return { campaign: campaignId, ...totals, simulated };
}

/* ------------------------------------------------------- reading calls */

/**
 * Fetch a window of call records for a campaign.
 *
 * The documented way to get calls back. Note what it does *not* return: our
 * `ClientId`, or any call identifier. Matching a record to a lead therefore
 * falls back to phone number plus time window, which is ambiguous for family
 * accounts sharing a mobile — common in Indian broking. Callers must treat the
 * lead attribution from this source as inferred, not certain.
 */
export async function fetchCallLog({ campaign, date, fromTime = '00:00:00', toTime = '23:59:59' } = {}) {
  const campaignId = campaign || cfg.campaign;
  if (!campaignId) throw new VendorError(name, 'No CUBE campaign is configured for this report');

  const { data, simulated } = await request('/QuickCall61AuthToken/AuthCallLog/', {
    CampaignId: campaignId,
    FromDate: date,
    FromTime: fromTime,
    ToTime: toTime,
  });

  const records = Array.isArray(data?.Records) ? data.Records : [];
  return {
    campaign: campaignId,
    simulated,
    records: records.map((r) => ({
      mobile: normaliseMsisdn(r.PhoneNo),
      agent_id: r.AgentId ?? null,
      status: r.CallStatus ?? null,
      started_at: r.StartTime ?? null,
      ended_at: r.EndTime ?? null,
      duration_s: Number(r.Duration) || 0,
      // No ClientId comes back on this endpoint. Anything built on it is a
      // guess, and says so.
      lead_id: null,
      match: 'inferred',
    })),
  };
}

/* -------------------------------------------------------------- inbound */

/**
 * QuickCall's Save Call callback, normalised.
 *
 * NOT in the published specification — no webhook is documented. It is real
 * nonetheless: the Agent Popup bundle exposes `getSaveCallPostAPIurl`, a
 * configurable URL QuickCall posts each completed call to. It is kept because it
 * is the only route by which an *inbound* call reaches us; `AuthCallLog` is
 * outbound-shaped and poll-based.
 *
 * Because it is undocumented, field casing is not trusted. Every lookup is
 * case-insensitive and accepts the aliases seen in the wild. A silently unmapped
 * field means a call that vanishes from the timeline, which is worse than a
 * loud failure.
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
    call_id: pick(payload, 'callID', 'CallID', 'UCID', 'UniqueID', 'callId'),
    // ClientID is what we sent on Click2Call, so a call we originated comes back
    // attributable. customerID is the older popup's name for the same thing.
    lead_id: Number(pick(payload, 'ClientID', 'ClientId', 'customerID', 'CustomerID', 'LeadID')) || null,
    agent_id: pick(payload, 'AgentID', 'AgentId', 'Agent'),
    extension: pick(payload, 'Extension', 'AgentExtension'),
    mobile: normaliseMsisdn(pick(payload, 'PhoneNo', 'DialNumber', 'CustomerNumber', 'Phone', 'MobileNo')),
    direction,
    status: pick(payload, 'CallStatus', 'Status', 'DialStatus'),
    disposition: pick(payload, 'DispositionCode', 'Disposition', 'Remarks', 'SubDisposition'),
    duration_s: duration,
    recording_url: pick(payload, 'RecordingURL', 'fileName', 'FileName', 'RecordFile'),
    campaign: pick(payload, 'CampaignID', 'CampaignId', 'CampaignName', 'Campaign'),
    started_at: pick(payload, 'StartTime', 'CallStartTime'),
    ended_at: pick(payload, 'EndTime', 'CallEndTime'),
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
