/**
 * Calling a lead from a phone.
 *
 * WHY THE SWITCH DIALS AND NOT THE HANDSET
 * ----------------------------------------
 * The obvious mobile answer is a `tel:` link, and for the app's main user it is
 * impossible. A Sales RM asking for a lead receives `••••••9300` — the number is
 * masked by role, and you cannot dial dots. An Admin receives `9708641969`.
 *
 * So `POST /api/leads/:id/call` is not a nicety here, it is the only route that
 * works: the server holds the number, hands it to the switch, and the rep never
 * sees it. Masking survives onto the phone rather than being the first thing a
 * mobile app quietly gives up.
 *
 * Two other things come free with going through the server, and both would have
 * had to be rebuilt badly on the client otherwise: consent is checked before the
 * call (a withdrawn number is refused with a reason and a fix), and the call is
 * logged against the lead without anybody remembering to.
 *
 * THE HANDSET IS STILL THE FALLBACK
 * ---------------------------------
 * The route's own comment says why: when the switch refuses, "they need to know
 * ... so they can call from the handset". So a 502, or no data at all, offers a
 * handset dial — but only when the number this device actually received is
 * dialable. The app does not reimplement the masking rules to decide that; it
 * looks at what it was given. Digits can be dialled, dots cannot.
 */

import * as Linking from 'expo-linking';
import { api } from './api.js';

/** Can this be dialled from the handset, or is it a mask? */
export const dialable = (mobile) => {
  const bare = String(mobile ?? '').replace(/[\s()-]/g, '');
  return /^\+?\d{6,15}$/.test(bare) ? bare : null;
};

/**
 * Ask the switch to connect the rep to the lead.
 *
 * Returns what the screen should say and offer, rather than throwing: every
 * outcome here is something a rep needs told, including the refusals.
 */
export async function viaSwitch(lead) {
  try {
    const data = await api.post(`/leads/${lead.id}/call`, {});

    /* The adapter says when it is simulating, and it must not be reported as a
       call. QuickCall has no credentials yet, so the switch accepts the request
       and rings nobody -- a rep who saw a success notice would stand there
       waiting for a phone that is never going to ring, and would blame the app
       rather than the missing configuration. */
    if (data?.simulated) {
      return {
        ok: false,
        simulated: true,
        message: 'No dialler is connected yet, so nothing was actually called.',
        fix: 'The call was recorded against the lead. Dial from the handset for now.',
        offerHandset: !!dialable(lead.mobile),
      };
    }

    return {
      ok: true,
      message: data?.message || 'Connecting — your phone should ring in a moment.',
    };
  } catch (err) {
    /* Consent. Not a fault and not something to work around: the number is
       withdrawn or dead, and the fix belongs to somebody else. Offering a
       handset dial here would route around a rule the CRM is enforcing. */
    if (err.status === 409) {
      return { ok: false, message: err.message, fix: err.fix, offerHandset: false };
    }

    /* The switch refused, or there is no data. Either way the rep can still use
       their own phone if they were given a real number. */
    return {
      ok: false,
      message: err.status === 502
        ? `The switch refused the call: ${err.message}`
        : err.message,
      offerHandset: !!dialable(lead.mobile),
    };
  }
}

/**
 * Dial from the handset.
 *
 * No `canOpenURL` check first: on Android it rejects when it cannot tell, which
 * turns "I do not know" into "you cannot call", and a rep standing outside a
 * client's office does not need that. Try it and report what happened.
 */
export async function viaHandset(mobile) {
  const number = dialable(mobile);
  if (!number) return { ok: false, message: 'This number is masked for your role, so it cannot be dialled from the handset.' };

  try {
    await Linking.openURL(`tel:${number}`);
    return { ok: true, message: null };
  } catch {
    return { ok: false, message: 'This device could not open the dialler.' };
  }
}
