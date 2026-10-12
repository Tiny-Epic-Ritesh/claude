/**
 * Vendor settings held in the CRM, not in the server's environment.
 *
 * WHY THIS EXISTS
 *
 * Every vendor credential used to live in `server/.env`, so connecting CUBE --
 * or any vendor -- needed a deployment and somebody with shell access. The firm
 * has neither to hand when a vendor rotates a password. An administrator should
 * paste it on a screen, and that is what this stores.
 *
 * THE RULES
 *
 * - A secret is encrypted at rest with the same key as a PAN, and is NEVER read
 *   back out to a screen or an API. `statusOf` reports that it is set, by whom
 *   and when; `valueOf` is for the adapter making the call.
 * - What is set here wins over the environment, and the environment is the
 *   fallback. A deployment that has always used `.env` keeps working, and one
 *   that sets a value here stops depending on the file.
 * - Reading never throws. These are consulted while a call is being placed, and
 *   a settings table that is somehow unavailable must degrade to "unconfigured"
 *   -- which simulates -- rather than take the dialler down.
 */

import { all, one, run } from '../db.js';
import { encryptField, decryptField } from '../security.js';

/** The value an administrator stored, decrypted, or null. */
export function valueOf(vendor, name) {
  try {
    const row = one('SELECT value, secret FROM vendor_setting WHERE vendor = ? AND name = ?', [vendor, name]);
    if (!row) return null;
    const value = Number(row.secret) ? decryptField(row.value) : row.value;
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/**
 * What a screen may know: set or not, by whom, when -- never the value.
 *
 * `from_environment` is the honest answer to "why does it work when I have set
 * nothing?", which otherwise looks like magic and gets "fixed" by pasting a
 * credential nobody needed.
 */
export function statusOf(vendor, names, env = {}) {
  let rows = [];
  try {
    rows = all(
      `SELECT s.name, s.secret, s.updated_at, u.name AS updated_by_name
         FROM vendor_setting s LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.vendor = ?`,
      [vendor],
    );
  } catch { rows = []; }

  const stored = new Map(rows.map((r) => [r.name, r]));
  return names.map((n) => {
    const row = stored.get(n.name);
    return {
      name: n.name,
      label: n.label,
      help: n.help ?? null,
      secret: n.secret !== false,
      set: Boolean(row) || Boolean(env[n.name]),
      /* Set here, or inherited from the server's environment. */
      from_environment: !row && Boolean(env[n.name]),
      updated_at: row?.updated_at ?? null,
      updated_by_name: row?.updated_by_name ?? null,
    };
  });
}

/**
 * Store one value. A blank clears it, which falls back to the environment
 * again rather than leaving the vendor half-configured with no way back.
 */
export function setValue(vendor, name, value, { secret = true, actorId = null } = {}) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) {
    run('DELETE FROM vendor_setting WHERE vendor = ? AND name = ?', [vendor, name]);
    return { cleared: true };
  }
  run(
    `INSERT INTO vendor_setting (vendor, name, value, secret, updated_by, updated_at)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(vendor, name) DO UPDATE SET
       value = excluded.value, secret = excluded.secret,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [vendor, name, secret ? encryptField(text) : text, secret ? 1 : 0, actorId],
  );
  return { cleared: false };
}
