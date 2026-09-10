/**
 * Posting a queued webhook (P3-16).
 *
 * The action card queues a row; this sends it. Awaiting somebody else's server
 * inside the automation tick would let one slow endpoint hold up every other
 * automation on the system, and a flow that is late because a partner's box is
 * down is a flow that looks broken.
 *
 * WHY AN ENDPOINT IS REGISTERED RATHER THAN TYPED
 *
 * A free-text URL on an automation card is an egress path nobody reviewed:
 * whoever last edited the flow decided where client data goes. Bonanza is a
 * SEBI-regulated broker whose client data may not leave India, which makes that
 * a compliance decision belonging to a named admin, not a form field. So the
 * destination is a row in `webhook_endpoint`, and the body carries only the
 * fields that row names — with none named it carries the lead id and nothing
 * else, and the receiver looks the rest up over an authenticated API.
 *
 * The signature is there so the receiver can prove the call came from us. It is
 * over the exact bytes sent, so a receiver that re-serialises the JSON before
 * checking will not match — that is the receiver's bug, and the usual one.
 */

import { createHmac } from 'node:crypto';
import { all, run } from '../db.js';

/** How many times a delivery is tried before it is left alone. */
const MAX_ATTEMPTS = 3;

/** Ten seconds. A partner's server that has not answered by then is down. */
const TIMEOUT_MS = 10_000;

export const sign = (secret, body) =>
  createHmac('sha256', secret).update(body).digest('hex');

/**
 * Send what is queued.
 *
 * Each delivery is independent: one endpoint refusing does not stop the rest,
 * for the same reason one dead template does not abort a flow.
 */
export async function sweepWebhooks({ limit = 50, fetchImpl = fetch } = {}) {
  const due = all(
    `SELECT d.*, e.url, e.secret, e.name AS endpoint_name
       FROM webhook_delivery d
       JOIN webhook_endpoint e ON e.id = d.endpoint_id
      WHERE d.status = 'queued' AND d.attempts < ? AND e.active = 1
      ORDER BY d.id LIMIT ?`,
    [MAX_ATTEMPTS, limit],
  );

  let sent = 0;
  let failed = 0;

  for (const d of due) {
    const attempt = d.attempts + 1;
    const body = d.payload ?? '{}';
    const headers = { 'Content-Type': 'application/json' };
    if (d.secret) headers['X-Bonanza-Signature'] = `sha256=${sign(d.secret, body)}`;

    try {
      const res = await fetchImpl(d.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.ok) {
        run(
          "UPDATE webhook_delivery SET status = 'sent', attempts = ?, http_status = ?, error = NULL, attempted_at = datetime('now') WHERE id = ?",
          [attempt, res.status, d.id],
        );
        sent += 1;
      } else {
        /* Kept queued while attempts remain: a 502 is usually a restart, and
           the next sweep catches it. A 4xx will not fix itself, but retrying
           twice more costs little and one rule is easier to reason about than
           a table of which statuses are worth repeating. */
        const done = attempt >= MAX_ATTEMPTS;
        run(
          `UPDATE webhook_delivery SET status = ?, attempts = ?, http_status = ?, error = ?,
                  attempted_at = datetime('now') WHERE id = ?`,
          [done ? 'failed' : 'queued', attempt, res.status, `HTTP ${res.status}`, d.id],
        );
        if (done) failed += 1;
      }
    } catch (err) {
      const done = attempt >= MAX_ATTEMPTS;
      run(
        `UPDATE webhook_delivery SET status = ?, attempts = ?, error = ?,
                attempted_at = datetime('now') WHERE id = ?`,
        [done ? 'failed' : 'queued', attempt, err.message, d.id],
      );
      if (done) failed += 1;
    }
  }

  return { sent, failed, tried: due.length };
}
