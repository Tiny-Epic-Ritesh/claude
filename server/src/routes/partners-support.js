/**
 * The mechanics of elevating a partner, extracted so both paths share them.
 *
 * There are two ways a partner gets elevated now — directly by someone who
 * holds `partner.elevate`, and through an approval someone else requested — and
 * they must do exactly the same thing. Two copies of "issue a code, set a
 * password, tell them" is how one path quietly stops sending the welcome
 * message.
 */

import { one, run, audit, notify } from '../db.js';
import { hashPasswordSync } from '../security.js';
import { send } from '../integrations.js';

/** The partner code. Stable and derived, so it never collides or renumbers. */
export const newPartnerCode = (partner) => `BNZ-P${String(partner.id).padStart(4, '0')}`;

/**
 * Give a partner portal access and tell them.
 *
 * Returns the plaintext password once, to be shown to whoever is onboarding
 * them — it is hashed on the way into the database and cannot be read back.
 */
export function issuePortalCredential(partner, plaintext = null) {
  const password = plaintext || `partner${partner.id}`;
  run('UPDATE partners SET portal_password = ? WHERE id = ?', [hashPasswordSync(password), partner.id]);

  const code = newPartnerCode(partner);
  run(
    'INSERT INTO activities (partner_id, type, direction, subject, body) VALUES (?,?,?,?,?)',
    [partner.id, 'Partner Activity', 'system', 'Elevated to Partner entity',
      `Partner code ${code} issued. Portal access enabled.`],
  );

  if (partner.mobile) {
    send('whatsapp', {
      to: partner.mobile,
      body: `Welcome to Bonanza, ${partner.name}. Your partner code is ${code}. `
        + 'You can now sign in to the Partner Portal.',
      partnerId: partner.id,
    });
  }
  if (partner.owner_id) {
    notify(partner.owner_id, 'Partner activated',
      `${partner.name} is now an active partner (${code}).`, `/partners/${partner.id}`);
  }
  audit(null, 'partner_elevated', 'partner', partner.id, { code });

  return { email: partner.email, password };
}

export { one };
