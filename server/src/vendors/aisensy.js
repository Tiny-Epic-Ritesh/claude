/**
 * Smartping WhatsApp — adapter.
 *
 * CONFIRMED AGAINST SMARTPING'S OWN API REFERENCE, 31 AUGUST 2026
 * ---------------------------------------------------------------
 * Smartping is a white-labelled AiSensy deployment, and their API reference
 * confirms the contract is the AiSensy v2 campaign API — every field name the
 * adapter already used was right.
 *
 * The path was not. This adapter posted to `/campaign/t1/api/v2`, AiSensy's own
 * tenant segment; Smartping's is `/campaign/smartping/api/v2`. Every send would
 * have 404'd. Now configurable, defaulted to Smartping's.
 *
 * Full contract in `docs/integrations/SMARTPING-WHATSAPP-API.md`.
 *
 * WHAT THAT MEANS FOR THE CRM
 * ---------------------------
 * AiSensy addresses a template by CAMPAIGN NAME rather than by template id, and
 * template parameters are positional — `templateParams` is an ordered array with
 * no names. That is a real operational hazard: reordering the variables in the
 * Meta template silently changes what each CRM field means, with no error. So
 * this adapter takes named parameters and resolves them through an explicit
 * per-campaign order held in the database, and refuses to send when the mapping
 * is missing rather than sending a plausible-looking wrong message.
 *
 * WhatsApp also enforces the 24-hour customer service window: outside it, only
 * an approved template may be sent. Free-text replies are rejected by Meta, so
 * we check the window before choosing which call to make.
 */

import { aisensy as cfg } from './config.js';
import { vendorFetch, safeEqual, VendorError } from './http.js';
import { normaliseMsisdn } from './quickcall.js';

export const name = 'Smartping WhatsApp (AiSensy)';
export const isLive = () => cfg.configured;

/**
 * The destination, in the format the reference recommends: `+` then country
 * code then number. A number that cannot be resolved to a country is treated as
 * Indian (+91) by Smartping — fine for this book, but relying on a vendor's
 * fallback for something as consequential as which country a message goes to is
 * not a thing to do on purpose.
 */
export const toWhatsAppNumber = (raw) => {
  const local = normaliseMsisdn(raw);
  const digits = local.length === 10 ? `91${local}` : String(raw ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
};

/**
 * Send an approved template.
 *
 * `params` is an ordered array. Callers should use `sendTemplateNamed` instead;
 * this is the low-level call the resolver ends up in.
 */
export async function sendTemplate({ to, campaignName, userName, params = [], media = null, tags = [], attributes = {} }) {
  if (!cfg.configured) throw new VendorError(name, 'Smartping is not configured');

  const destination = toWhatsAppNumber(to);
  // '+' plus at least a dial code and a subscriber number.
  if (destination.replace(/\D/g, '').length < 11) {
    throw new VendorError(name, `Not a valid WhatsApp number: ${to}`);
  }

  const { data } = await vendorFetch(name, `${cfg.baseUrl.replace(/\/$/, '')}${cfg.campaignPath}`, {
    body: {
      apiKey: cfg.apiKey,
      campaignName: campaignName || cfg.defaultCampaign,
      destination,
      userName: userName || 'Customer',
      source: 'bonanza-crm',
      templateParams: params.map((p) => String(p ?? '')),
      ...(media ? { media } : {}),
      ...(tags.length ? { tags } : {}),
      ...(Object.keys(attributes).length ? { attributes } : {}),
    },
    // Sending is not idempotent — a retry can double-message a client. AiSensy
    // returns 2xx on accept, so a transport failure is genuinely ambiguous; we
    // would rather under-send and let the RM resend than spam a client.
    attempts: 1,
  });

  /* The reference documents no response body — success is HTTP 200 and nothing
     more. So there is frequently no id to correlate against, and delivery state
     has to come from the webhook, matched on number and time. `message_id` is
     read opportunistically and is expected to be null more often than not;
     nothing should be built on the assumption that it is present. */
  return {
    message_id: data?.messageId || data?.id || null,
    accepted: data?.success !== false,
    raw: data,
  };
}

/**
 * Resolve named parameters into AiSensy's positional array.
 *
 * `order` is the campaign's declared variable sequence, e.g.
 * ['name', 'product', 'rm_name']. Every declared variable must be supplied:
 * a missing one would shift every subsequent parameter by a position and
 * produce a message that reads correctly but says the wrong thing.
 */
export function resolveParams(order, named) {
  if (!Array.isArray(order) || order.length === 0) {
    throw new VendorError(name, 'This campaign has no declared variable order. Set it in Admin → Templates before sending.');
  }
  const missing = order.filter((key) => named[key] === undefined || named[key] === null || named[key] === '');
  if (missing.length) {
    throw new VendorError(name, `Template variables not supplied: ${missing.join(', ')}. Refusing to send a misaligned message.`);
  }
  return order.map((key) => String(named[key]));
}

export const sendTemplateNamed = ({ to, campaignName, userName, order, named = {}, ...rest }) =>
  sendTemplate({ to, campaignName, userName, params: resolveParams(order, named), ...rest });

/* -------------------------------------------------------------- inbound */

/**
 * Normalise an AiSensy webhook. Two distinct kinds arrive on one URL:
 * delivery receipts for messages we sent, and inbound messages from customers.
 */
export function parseWebhook(payload) {
  const type = String(payload?.type || payload?.event || '').toLowerCase();

  if (type.includes('status') || payload?.status) {
    return {
      kind: 'status',
      message_id: payload?.messageId || payload?.id || null,
      // sent → delivered → read, plus failed
      status: String(payload?.status || '').toLowerCase(),
      mobile: normaliseMsisdn(payload?.destination || payload?.waNumber || payload?.from),
      failure_reason: payload?.error?.message || payload?.reason || null,
      at: payload?.timestamp || null,
    };
  }

  return {
    kind: 'message',
    message_id: payload?.messageId || payload?.id || null,
    mobile: normaliseMsisdn(payload?.waNumber || payload?.from || payload?.source),
    name: payload?.senderName || payload?.name || null,
    text: payload?.text || payload?.message?.text || payload?.body || null,
    media_url: payload?.mediaUrl || payload?.media?.url || null,
    at: payload?.timestamp || null,
  };
}

export function verifyWebhook(req) {
  if (!cfg.webhookSecret) {
    return { ok: false, reason: 'SMARTPING_WEBHOOK_SECRET is not set — WhatsApp callbacks are refused until it is.' };
  }
  const presented = req.get('x-smartping-signature') || req.get('x-webhook-secret') || req.query?.token;
  if (!presented) return { ok: false, reason: 'No callback signature presented.' };
  if (!safeEqual(presented, cfg.webhookSecret)) return { ok: false, reason: 'Callback signature did not match.' };
  return { ok: true };
}

/**
 * The 24-hour customer service window.
 *
 * Meta permits free-form replies only within 24 hours of the customer's last
 * inbound message. Outside it, a template is the only lawful option. Callers use
 * this to pick the right send, so a stale conversation fails at our boundary with
 * a clear reason rather than at Meta's with an opaque error code.
 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function windowOpen(lastInboundAt) {
  if (!lastInboundAt) return false;
  const at = new Date(lastInboundAt).getTime();
  return Number.isFinite(at) && Date.now() - at < WINDOW_MS;
}
