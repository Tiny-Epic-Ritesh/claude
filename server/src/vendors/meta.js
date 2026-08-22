/**
 * Meta — Facebook and Instagram.
 *
 * Four capabilities behind one adapter, because they share an app, a token and
 * a webhook, and splitting them would mean four places to get the signature
 * verification wrong.
 *
 *   Lead Ads          a form submission becomes a lead, within seconds
 *   Messenger / IG    a DM becomes an interaction on the lead's timeline
 *   Ad campaigns      publish from the CRM, pull spend and results back
 *   Custom Audiences  push a segment to Meta for targeting
 *
 * THE ONE THAT IS DIFFERENT
 * -------------------------
 * The first three pull data in or push our own ad copy out. Custom Audiences
 * pushes *client identifiers* — hashed, but still client data — to Meta's
 * servers. That is client data leaving India, which contradicts the standing
 * constraint on this project.
 *
 * It is lawful under DPDP with consent and it is what every advertiser does.
 * But it breaks a rule the business set for itself, at a SEBI-regulated broker,
 * so it is off unless someone deliberately turns it on:
 *
 *     CRM_META_AUDIENCES_ENABLED=true
 *
 * The flag is checked in the adapter, not in the route, so no future endpoint
 * can reach the capability without passing this comment.
 *
 * WEBHOOK VERIFICATION IS NOT OPTIONAL
 * ------------------------------------
 * A Lead Ads webhook writes leads into the CRM. Anyone who learns the URL could
 * otherwise inject them. Meta signs every delivery with an HMAC over the raw
 * body; we verify it and refuse anything unsigned, exactly as the QuickCall and
 * Smartping adapters do.
 */

import crypto from 'node:crypto';
import { meta as cfg, FORCE_SIMULATION } from './config.js';
import { vendorFetch, safeEqual } from './http.js';

const live = () => cfg.isLive && !FORCE_SIMULATION;

/** Custom Audiences is the one capability that must be switched on by hand. */
export const audiencesEnabled = () =>
  String(process.env.CRM_META_AUDIENCES_ENABLED ?? '').toLowerCase() === 'true';

export const GRAPH = 'https://graph.facebook.com/v21.0';

/* --------------------------------------------------- webhook security */

/**
 * Verify Meta's `X-Hub-Signature-256` over the raw body.
 *
 * The raw body matters: re-serialising the parsed JSON changes whitespace and
 * key order, and the signature stops matching. The route keeps the raw buffer
 * for exactly this.
 */
export function verifyWebhook(req) {
  // Matches the shared guard's contract: a reason travels with the refusal so
  // the audit row says which check failed, not merely that one did.
  if (!live()) return { ok: true, reason: null };
  if (!cfg.appSecret) return { ok: false, reason: 'Meta app secret is not configured' };

  const header = req.get('X-Hub-Signature-256');
  if (!header?.startsWith('sha256=')) {
    return { ok: false, reason: 'Missing X-Hub-Signature-256' };
  }

  const expected = crypto
    .createHmac('sha256', cfg.appSecret)
    .update(req.rawBody ?? Buffer.from(''))
    .digest('hex');

  return safeEqual(header.slice(7), expected)
    ? { ok: true, reason: null }
    : { ok: false, reason: 'Signature does not match' };
}

/** Meta's one-time subscription handshake. */
export function verifySubscription(query) {
  const ok = query['hub.mode'] === 'subscribe'
    && query['hub.verify_token']
    && cfg.verifyToken
    && safeEqual(String(query['hub.verify_token']), cfg.verifyToken);
  return ok ? String(query['hub.challenge']) : null;
}

/* ------------------------------------------------------ normalisation */

/**
 * A Lead Ads payload → the shape the CRM understands.
 *
 * Meta delivers answers as an array of `{ name, values }`, with names the
 * advertiser chose when they built the form. Mapping them is the vendor detail
 * this file exists to quarantine: everything downstream sees `{ name, mobile,
 * email, … }` and never learns what Meta called them.
 */
const FIELD_ALIASES = {
  full_name: 'name', first_name: 'first_name', last_name: 'last_name',
  email: 'email', phone_number: 'mobile', phone: 'mobile',
  city: 'city', state: 'state', company_name: 'company',
};

export function normaliseLead(raw) {
  const answers = {};
  for (const f of raw?.field_data ?? []) {
    const key = FIELD_ALIASES[f.name] ?? f.name;
    answers[key] = Array.isArray(f.values) ? f.values[0] : f.values;
  }

  if (!answers.name && (answers.first_name || answers.last_name)) {
    answers.name = [answers.first_name, answers.last_name].filter(Boolean).join(' ');
  }

  // Indian mobiles arrive as +91XXXXXXXXXX; the CRM stores ten digits.
  if (answers.mobile) {
    const digits = String(answers.mobile).replace(/\D/g, '');
    answers.mobile = digits.length > 10 ? digits.slice(-10) : digits;
  }

  return {
    name: answers.name?.trim() || 'Unnamed Meta lead',
    mobile: answers.mobile || null,
    email: answers.email || null,
    city: answers.city || null,
    state: answers.state || null,
    external_id: raw?.leadgen_id ? String(raw.leadgen_id) : null,
    form_id: raw?.form_id ? String(raw.form_id) : null,
    page_id: raw?.page_id ? String(raw.page_id) : null,
    ad_id: raw?.ad_id ? String(raw.ad_id) : null,
    campaign_name: raw?.campaign_name ?? null,
    platform: raw?.platform === 'instagram' ? 'Instagram' : 'Facebook',
    created_at: raw?.created_time ?? null,
  };
}

/** A Messenger or Instagram DM → an interaction. */
export function normaliseMessage(raw, platform = 'Facebook') {
  return {
    external_id: raw?.mid ? String(raw.mid) : null,
    from: raw?.sender?.id ? String(raw.sender.id) : null,
    to: raw?.recipient?.id ? String(raw.recipient.id) : null,
    body: raw?.message?.text ?? '',
    attachments: (raw?.message?.attachments ?? []).length,
    platform,
    at: raw?.timestamp ? new Date(Number(raw.timestamp)).toISOString() : new Date().toISOString(),
  };
}

/**
 * Pull the whole lead from Meta.
 *
 * The webhook carries only a `leadgen_id` — the answers must be fetched. In
 * simulation we invent a plausible one so the whole path is exercised without
 * a Meta app.
 */
export async function fetchLead(leadgenId) {
  if (!live()) {
    return normaliseLead({
      leadgen_id: leadgenId,
      created_time: new Date().toISOString(),
      field_data: [
        { name: 'full_name', values: ['Simulated Meta Lead'] },
        { name: 'phone_number', values: [`+9198${String(Date.now()).slice(-8)}`] },
        { name: 'email', values: ['simulated.meta@example.com'] },
        { name: 'city', values: ['Mumbai'] },
      ],
      form_id: 'sim-form', page_id: 'sim-page', platform: 'facebook',
    });
  }

  const res = await vendorFetch('meta', `${GRAPH}/${leadgenId}?access_token=${encodeURIComponent(cfg.pageToken)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  return normaliseLead(res);
}

/* ------------------------------------------------------- ad campaigns */

/**
 * Publish an ad campaign.
 *
 * Deliberately creates it PAUSED. Something in a CRM pressing a button that
 * starts spending real money the same second is a bad idea however good the
 * confirmation dialog is — a human should start it in Ads Manager, having seen
 * it.
 */
export async function publishCampaign({ name, objective = 'OUTCOME_LEADS', dailyBudget }) {
  if (!live()) {
    return {
      id: `sim-camp-${Date.now()}`,
      name,
      status: 'PAUSED',
      simulated: true,
      note: 'Simulated — no Meta ad account is configured.',
    };
  }

  const res = await vendorFetch('meta', `${GRAPH}/act_${cfg.adAccountId}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      name,
      objective,
      status: 'PAUSED',
      special_ad_categories: ['FINANCIAL_PRODUCTS_AND_SERVICES'],
      daily_budget: dailyBudget ? Math.round(Number(dailyBudget) * 100) : undefined,
      access_token: cfg.pageToken,
    },
  });
  return { ...res, status: 'PAUSED' };
}

/** Spend and results, back from Meta. */
export async function campaignInsights(campaignId) {
  if (!live()) {
    const seed = String(campaignId).length;
    return {
      campaign_id: campaignId,
      impressions: 12_400 + seed * 137,
      clicks: 388 + seed * 7,
      leads: 41 + seed,
      spend: 18_500 + seed * 210,
      currency: 'INR',
      simulated: true,
    };
  }

  const res = await vendorFetch('meta',
    `${GRAPH}/${campaignId}/insights?fields=impressions,clicks,spend,actions&access_token=${encodeURIComponent(cfg.pageToken)}`,
    { method: 'GET' });

  const row = res?.data?.[0] ?? {};
  const leads = (row.actions ?? []).find((a) => a.action_type === 'lead')?.value;
  return {
    campaign_id: campaignId,
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    leads: Number(leads ?? 0),
    spend: Number(row.spend ?? 0),
    currency: res?.data?.[0]?.account_currency ?? 'INR',
  };
}

/* --------------------------------------------------- custom audiences */

/**
 * SHA-256 of a normalised identifier, which is what Meta requires and all it
 * ever receives. Normalisation matters: Meta hashes lowercase and trimmed, so
 * an un-normalised hash simply never matches and the audience is empty.
 */
const hash = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

/**
 * Push a segment to Meta as a Custom Audience.
 *
 * Refuses unless the flag is on. The refusal names the conflict rather than
 * saying "disabled", because the person hitting it needs to know it is a policy
 * decision and not a missing credential.
 */
export async function pushAudience({ name, leads }) {
  if (!audiencesEnabled()) {
    return {
      ok: false,
      code: 'audiences_disabled',
      error: 'Custom Audiences are switched off',
      detail: 'Sending a segment to Meta means sending hashed client identifiers '
        + 'outside India, which conflicts with this firm’s data-residency rule. '
        + 'Set CRM_META_AUDIENCES_ENABLED=true only with compliance sign-off.',
    };
  }

  // Only ever hashes. The raw values do not leave this function.
  const payload = leads
    .filter((l) => l.mobile || l.email)
    .map((l) => [
      l.email ? hash(l.email) : '',
      l.mobile ? hash(`91${String(l.mobile).replace(/\D/g, '').slice(-10)}`) : '',
    ]);

  if (!live()) {
    return { ok: true, audience: `sim-aud-${Date.now()}`, matched: payload.length, simulated: true };
  }

  const created = await vendorFetch('meta', `${GRAPH}/act_${cfg.adAccountId}/customaudiences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { name, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', access_token: cfg.pageToken },
  });

  await vendorFetch('meta', `${GRAPH}/${created.id}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      payload: { schema: ['EMAIL', 'PHONE'], data: payload },
      access_token: cfg.pageToken,
    },
  });

  return { ok: true, audience: created.id, matched: payload.length };
}

/* ------------------------------------------------------------- status */

export const status = () => ({
  live: live(),
  configured: cfg.configured,
  audiences_enabled: audiencesEnabled(),
  capabilities: {
    lead_ads: true,
    messaging: true,
    ad_campaigns: Boolean(cfg.adAccountId) || !live(),
    custom_audiences: audiencesEnabled(),
  },
  note: live()
    ? 'Connected to Meta.'
    : 'No Meta app configured — running the simulator. Set META_APP_ID, META_APP_SECRET, '
      + 'META_PAGE_TOKEN and META_VERIFY_TOKEN to connect.',
  residency_note: audiencesEnabled()
    ? 'Custom Audiences are ON — hashed client identifiers are sent to Meta.'
    : 'Custom Audiences are off. No client identifier leaves India.',
});

export { hash as hashIdentifier };
