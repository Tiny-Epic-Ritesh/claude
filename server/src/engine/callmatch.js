/**
 * Which person a telephony event belongs to.
 *
 * CUBE's `AuthCallLog` does not return `ClientId`, though both dialling
 * endpoints accept it, so the only join back to a lead is the phone number.
 * That is ambiguous for family accounts sharing one mobile — common in Indian
 * broking, where a demat account per family member on one handset is ordinary.
 *
 * The rule this module exists to enforce: **a call attributed to the wrong
 * family member is worse than a call attributed to nobody.** The previous
 * lookup ended in `ORDER BY id DESC LIMIT 1`, which silently picked whichever
 * matching lead was created most recently and produced a confident, wrong
 * timeline entry on somebody's account.
 *
 * Four ways to resolve, best first. The first three are facts; only the fourth
 * is inference, and it refuses rather than guessing when it cannot be sure.
 */

import { all, one, run } from '../db.js';

/**
 * How long after dialling a result may still be matched to that intent.
 *
 * Long enough to cover a call that rings, connects and runs on; short enough
 * that tomorrow's call to the same number is never matched to today's intent.
 */
export const INTENT_WINDOW_MINUTES = 180;

/** Last ten digits — vendors are inconsistent about the 91 prefix. */
export const last10 = (mobile) => String(mobile ?? '').replace(/\D/g, '').slice(-10);

/**
 * Remember who we dialled, at the moment we dial them.
 *
 * Never throws: a dial that succeeded must not be reported as failed because
 * the bookkeeping behind it did not. A missing intent costs attribution on one
 * call; a thrown error costs the call.
 */
export function recordIntent({ mobile, leadId, userId = null, callId = null }) {
  const msisdn = last10(mobile);
  if (!msisdn || !leadId) return null;
  try {
    const res = run(
      'INSERT INTO call_intent (msisdn10, lead_id, user_id, call_id) VALUES (?,?,?,?)',
      [msisdn, leadId, userId, callId ? String(callId) : null],
    );
    return Number(res.lastInsertRowid);
  } catch (err) {
    console.error('[callmatch] could not record dial intent:', err.message);
    return null;
  }
}

/**
 * Resolve a telephony event to a lead.
 *
 * Returns `{ lead, match, candidates }`:
 *
 *   id         the event carried a lead id outright
 *   intent     we placed this call and recorded who we were ringing
 *   mobile     exactly one lead holds this number
 *   ambiguous  several do — `lead` is null and `candidates` lists them
 *   none       nobody holds it
 */
export function resolveLead({ leadId = null, mobile = null, callId = null } = {}) {
  if (leadId) {
    const byId = one('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [leadId]);
    if (byId) return { lead: byId, match: 'id', candidates: [] };
  }

  if (callId) {
    const byCall = one(
      `SELECT l.* FROM call_intent ci JOIN leads l ON l.id = ci.lead_id
        WHERE ci.call_id = ? AND l.deleted_at IS NULL
        ORDER BY ci.id DESC LIMIT 1`,
      [String(callId)],
    );
    if (byCall) return { lead: byCall, match: 'intent', candidates: [] };
  }

  const msisdn = last10(mobile);
  if (!msisdn) return { lead: null, match: 'none', candidates: [] };

  /* An outbound call we placed ourselves. This is the whole point of the
     intent record: we are not inferring who was rung, we are reading back what
     we asked the switch to do. */
  const byIntent = one(
    `SELECT l.* FROM call_intent ci JOIN leads l ON l.id = ci.lead_id
      WHERE ci.msisdn10 = ?
        AND ci.created_at >= datetime('now', ?)
        AND l.deleted_at IS NULL
      ORDER BY ci.id DESC LIMIT 1`,
    [msisdn, `-${INTENT_WINDOW_MINUTES} minutes`],
  );
  if (byIntent) return { lead: byIntent, match: 'intent', candidates: [] };

  const holders = all(
    `SELECT * FROM leads
      WHERE deleted_at IS NULL
        AND replace(replace(replace(mobile,' ',''),'-',''),'+','') LIKE ?
      ORDER BY id DESC LIMIT 25`,
    [`%${msisdn}`],
  );

  if (holders.length === 1) return { lead: holders[0], match: 'mobile', candidates: [] };
  if (holders.length === 0) return { lead: null, match: 'none', candidates: [] };

  /* Several people share this handset. Refusing to choose is the point: the
     call is still recorded, against nobody, with the candidates named so a
     human can place it. */
  return {
    lead: null,
    match: 'ambiguous',
    candidates: holders.map((l) => ({ id: l.id, name: l.name, sales_org: l.sales_org, owner_id: l.owner_id })),
  };
}
