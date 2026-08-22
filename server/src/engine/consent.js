/**
 * Consent and contactability.
 *
 * WHY THIS EXISTS
 * ---------------
 * The disposition matrix already sets `marketing_opt_out` when a client says
 * "stop sending me things", and `mobile_invalid` when a number is dead. The
 * condition tree can filter on both. Nothing, anywhere, ever checked them
 * before an outbound call or message went out.
 *
 * That was survivable while contacting a lead took several deliberate steps. It
 * stops being survivable the moment there is a one-click "Send WhatsApp" button
 * on every row of the lead list — which is exactly what is being built. One
 * stray click on an opted-out client is a TRAI DND complaint against a
 * SEBI-registered broker.
 *
 * MARKETING IS NOT SERVICE
 * ------------------------
 * The distinction the business decision turns on. A client who opts out of
 * marketing has not opted out of being told their KYC failed, or that their
 * account is about to be frozen. Blocking those would be worse service, not
 * better compliance — and is not what an opt-out means.
 *
 *   marketing   promotional sends: campaigns, product pitches, offers
 *   service     transactional and regulatory: KYC, statements, SLA, dues
 *
 * The caller declares which one it is. Defaulting to `marketing` is deliberate:
 * a route that forgets to say gets the safer answer.
 *
 * ENFORCED AT THE API, NOT IN THE FORM
 * ------------------------------------
 * Hiding a button stops an RM. It does not stop an import, an automation rule,
 * a bulk action or an integration — which is where volume sends actually come
 * from, and where a DND breach would actually happen.
 */

import { one } from '../db.js';

/** Channels that carry a marketing payload, and the flag that gates each. */
const CHANNEL_RULES = {
  call: { needs: 'mobile', flag: 'mobile_invalid' },
  sms: { needs: 'mobile', flag: 'mobile_invalid' },
  whatsapp: { needs: 'mobile', flag: 'mobile_invalid' },
  ivr: { needs: 'mobile', flag: 'mobile_invalid' },
  email: { needs: 'email', flag: null },
};

export const CHANNELS = Object.keys(CHANNEL_RULES);
export const INTENTS = ['marketing', 'service'];

/**
 * May we contact this lead on this channel, for this reason?
 *
 * Returns `{ allowed, reason, code }`. `reason` is written for the person who
 * will read it on screen — "Aarav opted out of marketing messages" tells an RM
 * what happened and what to do; "consent violation" does not.
 */
export function checkConsent(lead, channel, intent = 'marketing') {
  if (!lead) return { allowed: false, code: 'no_lead', reason: 'Lead not found' };

  const rule = CHANNEL_RULES[channel];
  if (!rule) {
    return { allowed: false, code: 'unknown_channel', reason: `${channel} is not a channel we can send on` };
  }

  const who = (lead.name || 'This client').split(' ')[0];

  // 1. Is there anything to contact them on? A missing address is not a consent
  //    question, but it fails first because nothing else matters if it is empty.
  const destination = rule.needs === 'email' ? lead.email : lead.mobile;
  if (!destination) {
    return {
      allowed: false,
      code: 'no_destination',
      reason: `${who} has no ${rule.needs} on record`,
      fix: `Add a ${rule.needs} to the lead first.`,
    };
  }

  // 2. Is the destination known bad? A dead number blocks every use of it,
  //    service included — there is no point dialling a number that does not ring.
  if (rule.flag && lead[rule.flag]) {
    return {
      allowed: false,
      code: 'invalid_destination',
      reason: `${who}'s mobile number is flagged invalid`,
      fix: 'Correct the number on the lead, then clear the flag.',
    };
  }

  // 3. Consent. Only marketing is gated — service must still get through.
  if (intent === 'marketing' && lead.marketing_opt_out) {
    return {
      allowed: false,
      code: 'opted_out',
      reason: `${who} has opted out of marketing messages`,
      fix: 'Service and regulatory messages are still allowed — send it as a service message if that is what it is.',
    };
  }

  return { allowed: true, code: 'ok', reason: null };
}

/** The same check, by lead id, for routes that only have the id. */
export const checkConsentById = (leadId, channel, intent) =>
  checkConsent(one('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [leadId]), channel, intent);

/**
 * What the UI should offer for this lead.
 *
 * Returned with the lead so the client can grey out an action and say why,
 * rather than showing a live button that fails on click. The API still runs
 * `checkConsent` on every send — this is a courtesy, not the control.
 */
export function contactability(lead) {
  const out = {};
  for (const channel of CHANNELS) {
    const marketing = checkConsent(lead, channel, 'marketing');
    const service = checkConsent(lead, channel, 'service');
    out[channel] = {
      marketing: marketing.allowed,
      service: service.allowed,
      // The reason to show is the one that blocks the common case.
      reason: marketing.allowed ? null : marketing.reason,
      code: marketing.allowed ? 'ok' : marketing.code,
    };
  }
  return out;
}

/**
 * Which intent a channel send carries, when the caller has not said.
 *
 * A templated send inherits the template's own classification; a free-typed
 * message from an RM on a lead record is service by nature — they are replying
 * to a person, not running a campaign. Campaign and bulk paths must pass
 * 'marketing' explicitly, and they do.
 */
export const intentOf = (body) => (body?.intent === 'service' ? 'service' : 'marketing');
