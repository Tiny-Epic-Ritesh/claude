/**
 * The mechanics of elevating a partner, extracted so both paths share them.
 *
 * There are two ways a partner gets elevated now — directly by someone who
 * holds `partner.elevate`, and through an approval someone else requested — and
 * they must do exactly the same thing. Two copies of "issue a code, set a
 * password, tell them" is how one path quietly stops sending the welcome
 * message.
 */

import { all, one, run, audit, notify } from '../db.js';
import { mayUseOrg } from '../auth.js';
import { hashPasswordSync, temporaryPassword } from '../security.js';
import { send } from '../integrations.js';

/* The partner's business decides its code prefix and the name it is welcomed
   by. A partner with no business recorded predates OPS-17 and is Bonanza's by
   the column default, which is what it was treated as everywhere else. */
const BOOKS = {
  BONANZA: { prefix: 'BNZ', brand: 'Bonanza' },
  BIGUL: { prefix: 'BGL', brand: 'Bigul' },
};
const bookOf = (partner) => BOOKS[partner.sales_org] ?? BOOKS.BONANZA;

/**
 * The partner code. Stable and derived, so it never collides or renumbers.
 *
 * OPS-16: every partner was issued `BNZ-P`, Bigul's included, while the seeded
 * Bigul partners carry `BGL-P`. The prefix is now the partner's business.
 */
export const newPartnerCode = (partner) => `${bookOf(partner).prefix}-P${String(partner.id).padStart(4, '0')}`;

/** Onboarding steps not yet done. One definition, so the request, the direct
    activation and the approval cannot disagree about it again (QA-33, OPS-25). */
export const stepsOutstanding = (partnerId) =>
  one("SELECT COUNT(*) n FROM partner_steps WHERE partner_id = ? AND status != 'done'", [partnerId]).n;

/**
 * Make a partner ACTIVE and tell the people who need to know.
 *
 * Portal access is a separate step, `issuePortalCredential`, because the
 * person who activates the partner is not always there to receive a password:
 * an approval is granted on the approvals screen, which has nowhere to show one.
 */
export function activatePartner(partner, userId = null) {
  const code = newPartnerCode(partner);
  run(
    "UPDATE partners SET state_code = 'ACTIVE', partner_code = ?, onboarded_at = datetime('now') WHERE id = ?",
    [code, partner.id],
  );
  run(
    'INSERT INTO activities (partner_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)',
    [partner.id, 'Partner Activity', 'system', 'Elevated to Partner entity', `Partner code ${code} issued.`, userId],
  );

  if (partner.mobile) {
    send('whatsapp', {
      to: partner.mobile,
      body: `Welcome to ${bookOf(partner).brand}, ${partner.name}. Your partner code is ${code}. `
        + 'Your Partner RM will share your Partner Portal sign-in.',
      partnerId: partner.id,
    });
  }
  if (partner.owner_id) {
    notify(partner.owner_id, 'Partner activated',
      `${partner.name} is now an active partner (${code}).`, `/partners/${partner.id}`);
  }
  audit(userId, 'partner_elevated', 'partner', partner.id, { code });
  return code;
}

/** How long the partner's owner has to finish what an emergency activation skipped. */
export const EMERGENCY_FOLLOW_UP_DAYS = 7;

/**
 * Activate a partner whose onboarding is not finished (QA-33).
 *
 * Ruled 13 Oct: a Superadmin may, when it cannot wait. The auditor's finding
 * was a 0-of-8 prospect made ACTIVE by one click with nothing to show for it;
 * this is the same act made answerable. It is the ordinary activation, plus:
 *
 *   - the reason and the steps that were open, on the partner for good and
 *     in the audit trail;
 *   - an entry on the partner's timeline saying it was an emergency;
 *   - a notice to every Admin of the partner's business, and to the other
 *     Superadmins, because an override nobody hears about is not oversight;
 *   - a High-priority task for the partner's owner to finish the steps.
 *
 * The steps stay exactly as they were. Nothing is marked done that was not.
 */
export function emergencyActivate(partner, user, reason) {
  const open = all(
    "SELECT label FROM partner_steps WHERE partner_id = ? AND status != 'done' ORDER BY sort_order",
    [partner.id],
  ).map((s) => s.label);

  const code = activatePartner(partner, user.id);
  run(
    `UPDATE partners SET emergency_activated_at = datetime('now'), emergency_activated_by = ?,
            emergency_reason = ?, emergency_steps_open = ? WHERE id = ?`,
    [user.id, reason, open.length, partner.id],
  );
  run(
    'INSERT INTO activities (partner_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)',
    [partner.id, 'Partner Activity', 'system', 'Activated in an emergency',
      `${open.length} onboarding step(s) were still open: ${open.join(', ')}. Reason: ${reason}`, user.id],
  );
  audit(user.id, 'partner_emergency_activation', 'partner', partner.id, { code, reason, steps_open: open });

  const told = all("SELECT id, role, sales_org, org_access FROM users WHERE active = 1 AND role IN ('admin', 'superadmin') AND id != ?", [user.id])
    .filter((u) => u.role === 'superadmin' || mayUseOrg(u, partner.sales_org));
  for (const u of told) {
    notify(u.id, 'Partner activated in an emergency',
      `${user.name} activated ${partner.name} with ${open.length} onboarding step(s) open. Reason: ${reason}`,
      `/partners/${partner.id}`);
  }

  const assignee = partner.owner_id ?? user.id;
  run(
    `INSERT INTO tasks (title, description, partner_id, assignee_id, created_by, due_at, priority)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?), 'High')`,
    [`Finish onboarding: ${partner.name}`,
      `Activated in an emergency by ${user.name} with these steps open: ${open.join(', ')}. Reason: ${reason}`,
      partner.id, assignee, user.id, `+${EMERGENCY_FOLLOW_UP_DAYS} days`],
  );

  return { code, steps_open: open, notified: told.length };
}

/**
 * Give a partner a one-time portal password, and end every session they have.
 *
 * OPS-15. This used to default to `partner<id>` -- the screen never sent a
 * password, so every partner activated from it got one, and anybody who knew
 * or guessed a partner's number could sign in as them. A password is now
 * always generated, never chosen: it is returned once, to be passed on by
 * whoever is onboarding the partner, and the portal makes the partner replace
 * it before anything else opens. It is hashed on the way into the database
 * and cannot be read back.
 *
 * Re-issuing is the same call, which is why it ends the sessions: a new
 * password that left the old sessions open would not lock anybody out.
 */
export function issuePortalCredential(partner, userId = null) {
  const password = temporaryPassword();
  run(
    `UPDATE partners SET portal_password = ?, portal_password_temp = 1, portal_password_set_at = datetime('now')
      WHERE id = ?`,
    [hashPasswordSync(password), partner.id],
  );
  const ended = Number(run('DELETE FROM sessions WHERE partner_id = ?', [partner.id]).changes);
  run(
    'INSERT INTO activities (partner_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)',
    [partner.id, 'Partner Activity', 'system', 'Portal password issued',
      'A one-time Partner Portal password was issued. The partner sets their own at first sign-in.', userId],
  );
  audit(userId, 'partner_portal_credential_issued', 'partner', partner.id, { sessions_ended: ended });
  return { email: partner.email, password, one_time: true };
}

/** Take a partner's portal access away: no password, and no open session. */
export function withdrawPortalAccess(partner, userId, reason) {
  run(
    'UPDATE partners SET portal_password = NULL, portal_password_temp = 0, portal_password_set_at = datetime(\'now\') WHERE id = ?',
    [partner.id],
  );
  const ended = Number(run('DELETE FROM sessions WHERE partner_id = ?', [partner.id]).changes);
  run(
    'INSERT INTO activities (partner_id, type, direction, subject, body, user_id) VALUES (?,?,?,?,?,?)',
    [partner.id, 'Partner Activity', 'system', 'Portal access withdrawn', reason, userId],
  );
  audit(userId, 'partner_portal_withdrawn', 'partner', partner.id, { reason, sessions_ended: ended });
  return { withdrawn: true, sessions_ended: ended };
}

export { one };
