/**
 * Vendor configuration.
 *
 * Bonanza's actual stack:
 *   • Cube Software QuickCall  — dialler / CTI  (cubehosted.net)
 *   • Smartping WhatsApp       — a white-labelled AiSensy tenant
 *   • Bonanza eKYC             — kyc.bonanzaonline.com, shared with Bigul
 *
 * Every adapter is live when its credentials are present and simulated when they
 * are not. That is deliberate: the same build runs in a demo with no secrets, in
 * UAT against vendor sandboxes, and in production — the only difference is the
 * environment. No code path is exercised in production that was never exercised
 * in test.
 *
 * Nothing here is hard-coded to a Bonanza account. Endpoints have defaults
 * discovered from the live tenants, but every one is overridable, because a
 * vendor changing a host must never require a code change.
 */

const env = (key, fallback = null) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

const flag = (key, fallback = false) => {
  const v = env(key);
  if (v === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

/* ------------------------------------------------------------ telephony */

export const quickcall = {
  /** QuickCall REST base, e.g. https://cubehosted.net/QuickCallComp */
  baseUrl: env('CUBE_QUICKCALL_URL'),
  user: env('CUBE_QUICKCALL_USER'),
  password: env('CUBE_QUICKCALL_PASSWORD'),
  /** Tenant/campaign identifiers as issued by Cube. */
  tenant: env('CUBE_QUICKCALL_TENANT'),
  campaign: env('CUBE_QUICKCALL_CAMPAIGN'),
  /**
   * Shared secret QuickCall presents on its Save Call callback. We refuse
   * unsigned call events rather than trusting anything that reaches the URL:
   * a webhook that writes to the activity timeline is an authenticated endpoint.
   */
  webhookSecret: env('CUBE_QUICKCALL_WEBHOOK_SECRET'),
  get configured() { return Boolean(this.baseUrl && this.user && this.password); },
};

/* ------------------------------------------------------------ meta */

/**
 * Facebook and Instagram, via one Meta app.
 *
 * `appSecret` is what signs the webhook; without it a Lead Ads delivery cannot
 * be trusted, and a webhook that writes leads must be authenticated like any
 * other write endpoint.
 */
export const meta = {
  appId: env('META_APP_ID'),
  appSecret: env('META_APP_SECRET'),
  /** Long-lived page access token, from Business Manager. */
  pageToken: env('META_PAGE_TOKEN'),
  /** Our own string, echoed back during Meta's subscription handshake. */
  verifyToken: env('META_VERIFY_TOKEN'),
  /** Ad account, digits only — the `act_` prefix is added at call time. */
  adAccountId: env('META_AD_ACCOUNT_ID'),
  get isLive() { return Boolean(this.appId && this.appSecret && this.pageToken); },
  get configured() { return this.isLive; },
};

/* ---------------------------------------------------------- market data */

/**
 * NSE / BSE market data.
 *
 * Bonanza already licenses a feed for the trading platform; the vendor is not
 * yet named here, so the adapter runs its simulator until these are set. That
 * is deliberate — the feature ships and is tested today, and goes live by
 * setting two variables rather than by writing code.
 *
 * `isLive` rather than `configured` to match how the adapter reads it, and
 * because a URL without a key is a misconfiguration, not a live feed.
 */
export const marketData = {
  baseUrl: env('CRM_MARKETDATA_URL'),
  apiKey: env('CRM_MARKETDATA_KEY'),
  /** Which vendor's response shape to expect, once we know. */
  provider: env('CRM_MARKETDATA_PROVIDER', 'simulated'),
  get isLive() { return Boolean(this.baseUrl && this.apiKey); },
  get configured() { return this.isLive; },
};

/* ------------------------------------------------------------- whatsapp */

export const aisensy = {
  /**
   * Smartping runs on AiSensy's white-label backend. Direct-API traffic goes to
   * backend.api-wa.co for partner tenants and backend.aisensy.com for direct
   * ones; both accept the same v2 campaign contract.
   */
  baseUrl: env('SMARTPING_API_URL', 'https://backend.api-wa.co'),
  apiKey: env('SMARTPING_API_KEY'),
  /** AiSensy addresses templates by campaign name, not template id. */
  defaultCampaign: env('SMARTPING_CAMPAIGN', 'BONANZA_CRM'),
  /** Verifies inbound delivery receipts and customer replies. */
  webhookSecret: env('SMARTPING_WEBHOOK_SECRET'),
  get configured() { return Boolean(this.apiKey); },
};

/* ------------------------------------------------------------------ kyc */

export const bonanzaKyc = {
  /** The live customer-facing eKYC journey. */
  portalUrl: env('BONANZA_KYC_URL', 'https://kyc.bonanzaonline.com'),
  /** Server-to-server status API, if the KYC team exposes one. */
  apiUrl: env('BONANZA_KYC_API_URL'),
  apiKey: env('BONANZA_KYC_API_KEY'),
  webhookSecret: env('BONANZA_KYC_WEBHOOK_SECRET'),

  /**
   * Which KYC surface the CRM drives:
   *   'internal' — the CRM's own 16-step journey (BRD §7). Full visibility,
   *                every step timed and coachable. Correct for demo and UAT.
   *   'handoff'  — the CRM attributes and sends a link to the live portal, and
   *                tracks status from callbacks. Correct once production eKYC
   *                must remain the system of record for regulatory filing.
   *   'both'     — internal journey for CRM-sourced leads, handoff for the rest.
   */
  mode: env('BONANZA_KYC_MODE', 'internal'),
  get configured() { return Boolean(this.apiUrl && this.apiKey); },
};

/* ----------------------------------------------------------------- misc */

export const smtp = {
  host: env('SMTP_HOST'),
  port: Number(env('SMTP_PORT', '587')),
  user: env('SMTP_USER'),
  password: env('SMTP_PASSWORD'),
  from: env('SMTP_FROM', 'crm@bonanzaonline.com'),
  get configured() { return Boolean(this.host && this.user); },
};

/** Global kill switch: forces every adapter to simulate regardless of credentials. */
export const FORCE_SIMULATION = flag('CRM_SIMULATE_INTEGRATIONS', false);

/** Outbound HTTP timeout, milliseconds. */
export const TIMEOUT_MS = Number(env('CRM_VENDOR_TIMEOUT_MS', '12000'));

/**
 * What is live, for the Admin health panel. Reports presence, never values —
 * an integrations page that prints API keys is a credential leak with a nice UI.
 */
export function vendorStatus() {
  const state = (cfg) => {
    if (FORCE_SIMULATION) return 'simulated (forced)';
    return cfg.configured ? 'live' : 'simulated (not configured)';
  };
  return {
    forced_simulation: FORCE_SIMULATION,
    quickcall: { state: state(quickcall), endpoint: quickcall.baseUrl, signed_callbacks: Boolean(quickcall.webhookSecret) },
    smartping: { state: state(aisensy), endpoint: aisensy.baseUrl, campaign: aisensy.defaultCampaign, signed_callbacks: Boolean(aisensy.webhookSecret) },
    bonanza_kyc: { state: state(bonanzaKyc), endpoint: bonanzaKyc.portalUrl, mode: bonanzaKyc.mode, signed_callbacks: Boolean(bonanzaKyc.webhookSecret) },
    smtp: { state: state(smtp), endpoint: smtp.host },
  };
}
