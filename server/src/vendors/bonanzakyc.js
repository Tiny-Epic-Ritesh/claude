/**
 * Bonanza eKYC — adapter for kyc.bonanzaonline.com.
 *
 * WHAT WE ESTABLISHED FROM THE LIVE PORTAL
 * ----------------------------------------
 *   • It is a Laravel application. The landing form posts to
 *     POST /kyc/send-otp-mobile with a CSRF `_token`, so the customer journey is
 *     a session-based browser flow, not a REST API.
 *   • Static assets are served from kyc.bigul.co — the same eKYC platform backs
 *     both the Bonanza and Bigul brands.
 *   • The entry form carries three hidden fields that matter to us:
 *         utm_get_data   the ENTIRE inbound query string, captured verbatim
 *         currentUrl     the full landing URL
 *         shortcode      an attribution code, defaulting to "NA"
 *   • Probing showed `?shortcode=…` lands in `utm_get_data` but leaves
 *     `shortcode` as "NA", so the shortcode is assigned by some other route — a
 *     campaign-link table or a path form we have not been told. That one detail
 *     is outstanding and is flagged in the integration report.
 *
 * THE ARCHITECTURAL POINT
 * -----------------------
 * Bonanza now has two KYC surfaces: this CRM's 16-step journey (built to BRD §7,
 * fully instrumented — per-step timers, stall detection, RM coaching) and the
 * live portal, which is the regulatory system of record.
 *
 * They are not competitors and this adapter does not assume which wins. The mode
 * is configuration:
 *
 *   internal  CRM journey only. Full step-level visibility. Right for demo/UAT.
 *   handoff   CRM attributes and sends a link to the live portal, then tracks
 *             status from callbacks. Right when production eKYC must remain the
 *             filing system of record.
 *   both      Internal journey for CRM-sourced leads; handoff for the rest.
 *
 * What the CRM must NOT do is re-implement the regulatory journey and file it
 * itself — so in handoff mode we drive attribution and follow-up, and treat the
 * portal's status as authoritative.
 */

import { bonanzaKyc as cfg } from './config.js';
import { vendorFetch, safeEqual, VendorError } from './http.js';

export const name = 'Bonanza eKYC';
export const MODES = ['internal', 'handoff', 'both'];
export const mode = () => (MODES.includes(cfg.mode) ? cfg.mode : 'internal');
export const isLive = () => cfg.configured;

/**
 * Build the attributed KYC link for a lead.
 *
 * Every parameter here exists so that a completed account can be traced back to
 * the RM or partner who sourced it — which is what the commission run depends on.
 * We send both `shortcode` and the UTM set: the portal preserves the whole query
 * string in `utm_get_data`, so even parameters it does not interpret survive and
 * can be reconciled later.
 */
export function journeyUrl({ lead, owner, partner, productCode, campaign }) {
  const params = new URLSearchParams();

  // Attribution. Partner takes precedence over RM: if a partner sourced the
  // lead, the commission is theirs regardless of who services it afterwards.
  const shortcode = partner?.kyc_shortcode || partner?.partner_code
    || owner?.kyc_shortcode || null;
  if (shortcode) params.set('shortcode', shortcode);

  params.set('utm_source', 'bonanza_crm');
  params.set('utm_medium', partner ? 'partner' : 'rm');
  params.set('utm_campaign', campaign || productCode || 'crm_referral');

  // Our own correlation id, echoed back on the callback so a completed KYC can
  // be matched to a lead without relying on the mobile number alone.
  if (lead?.id) params.set('crm_ref', `LEAD-${lead.id}`);
  if (owner?.id) params.set('crm_rm', String(owner.id));
  if (partner?.id) params.set('crm_partner', String(partner.id));
  if (lead?.mobile) params.set('mobile', String(lead.mobile).replace(/\D/g, '').slice(-10));

  return `${cfg.portalUrl.replace(/\/$/, '')}/?${params.toString()}`;
}

/**
 * Pull journey status from the KYC platform.
 *
 * Requires a server-to-server API the KYC team must expose. Until it exists this
 * throws rather than returning a hopeful empty status, because "no data" and
 * "not integrated" must never look the same on an RM's screen.
 */
export async function fetchStatus({ mobile, crmRef }) {
  if (!cfg.configured) {
    throw new VendorError(name, 'No Bonanza eKYC status API is configured (BONANZA_KYC_API_URL / BONANZA_KYC_API_KEY).');
  }

  const url = new URL(`${cfg.apiUrl.replace(/\/$/, '')}/status`);
  if (mobile) url.searchParams.set('mobile', String(mobile).replace(/\D/g, '').slice(-10));
  if (crmRef) url.searchParams.set('crm_ref', crmRef);

  const { data } = await vendorFetch(name, url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: null,
  });

  return normaliseStatus(data);
}

/**
 * Map the portal's stage vocabulary onto the CRM's.
 *
 * Deliberately conservative: an unrecognised stage becomes 'In Progress' with the
 * original preserved in `raw_stage`, never silently dropped or guessed into a
 * terminal state. Wrongly marking a journey Complete would take it off the
 * follow-up list and lose the account.
 */
const STAGE_MAP = {
  otp: 'Started', mobile_verified: 'Started', email_verified: 'Started',
  pan: 'PAN', pan_verified: 'PAN',
  aadhaar: 'Aadhaar', digilocker: 'Aadhaar', kra: 'Aadhaar',
  bank: 'Bank', penny_drop: 'Bank',
  documents: 'Documents', upload: 'Documents', signature: 'Documents',
  ipv: 'IPV', video: 'IPV',
  esign: 'eSign', nsdl: 'eSign',
  complete: 'Complete', completed: 'Complete', activated: 'Complete', ucc: 'Complete',
  rejected: 'Rejected', failed: 'Rejected',
};

export function normaliseStatus(payload) {
  const rawStage = String(payload?.stage || payload?.status || payload?.current_step || '').toLowerCase().trim();
  const key = rawStage.replace(/[\s-]+/g, '_');

  return {
    found: Boolean(payload && (payload.stage || payload.status || payload.current_step)),
    stage: STAGE_MAP[key] || (rawStage ? 'In Progress' : null),
    raw_stage: rawStage || null,
    complete: STAGE_MAP[key] === 'Complete',
    rejected: STAGE_MAP[key] === 'Rejected',
    client_code: payload?.client_code || payload?.ucc || payload?.clientCode || null,
    crm_ref: payload?.crm_ref || null,
    mobile: payload?.mobile ? String(payload.mobile).replace(/\D/g, '').slice(-10) : null,
    updated_at: payload?.updated_at || payload?.timestamp || null,
    reason: payload?.reason || payload?.remarks || null,
  };
}

/** Status callbacks from the KYC platform, same signing rule as the others. */
export function verifyWebhook(req) {
  if (!cfg.webhookSecret) {
    return { ok: false, reason: 'BONANZA_KYC_WEBHOOK_SECRET is not set — KYC callbacks are refused until it is.' };
  }
  const presented = req.get('x-bonanza-signature') || req.get('x-webhook-secret') || req.query?.token;
  if (!presented) return { ok: false, reason: 'No callback signature presented.' };
  if (!safeEqual(presented, cfg.webhookSecret)) return { ok: false, reason: 'Callback signature did not match.' };
  return { ok: true };
}
