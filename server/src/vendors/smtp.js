/**
 * Outbound email over SMTP.
 *
 * WHY SMTP AND NOT MICROSOFT GRAPH
 * --------------------------------
 * Per-user Outlook sending is the better product: an RM sends as themselves and
 * replies land in their own mailbox, so attribution is exact. It is blocked on
 * a residency decision — Microsoft Graph moves data outside India, and this is
 * a SEBI-regulated broker whose client data must not leave the country.
 *
 * That decision has been open since the leadership deck. Meanwhile the composer
 * could not send at all: every email was recorded on the timeline and silently
 * never delivered. SMTP relays through a mail server Bonanza runs, so nothing
 * leaves India and the composer becomes usable today. Outlook is added later as
 * a second sender rather than a rewrite, which is why `send()` chooses a
 * transport rather than calling this directly.
 *
 * WHY A DEPENDENCY, IN A PROJECT WITH FOUR
 * ----------------------------------------
 * Node has no SMTP client. The alternative is hand-rolling AUTH negotiation,
 * STARTTLS and — the real problem — MIME multipart encoding for attachments.
 * Getting MIME subtly wrong produces mail that renders as base64 soup in one
 * client and fine in another, discovered by a client rather than by a test.
 * That is not a good trade for a firm sending regulated collateral, so
 * nodemailer carries it.
 *
 * SIMULATION SITS BELOW THE MESSAGE BUILD
 * ---------------------------------------
 * Same rule as the QuickCall adapter: the message is assembled identically
 * whether or not credentials exist, and only the final handoff is skipped. A
 * mistake in the envelope, the attachment encoding or the reply-to therefore
 * fails a test today instead of surviving until the first live send.
 */

import { smtp as cfg, FORCE_SIMULATION } from './config.js';
import { VendorError } from './http.js';

export const name = 'SMTP';
export const isLive = () => cfg.configured && !FORCE_SIMULATION;

/** Lazily created, then reused: a transport per process, not per message. */
let transport = null;

async function getTransport() {
  if (transport) return transport;
  const { createTransport } = await import('nodemailer');
  transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this backwards
    // fails to connect rather than sending in the clear, but say it explicitly.
    secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
  });
  return transport;
}

/** Drop the cached transport, so a credential change is picked up. */
export function reset() { transport = null; }

/**
 * A display name and address, formatted for a header.
 *
 * The RM's name with the firm's address: the client sees who wrote to them,
 * while the mail still comes from a domain that will pass SPF and DKIM. Sending
 * as the RM's own address would fail both and land in spam.
 */
const fromHeader = (userName) =>
  (userName ? `"${String(userName).replace(/"/g, '')}" <${cfg.from}>` : cfg.from);

/**
 * Send one message.
 *
 * Returns `{ simulated, message_id, envelope }`. `envelope` is what would go on
 * the wire, and is returned in both modes so a test can assert on it without a
 * mail server.
 */
export async function sendMail({
  to, subject, html, text, userName = null, replyTo = null, attachments = [],
} = {}) {
  if (!to) throw new VendorError(name, 'No recipient address');

  const message = {
    from: fromHeader(userName),
    to,
    subject: subject || '(no subject)',
    text: text || undefined,
    html: html || undefined,
    /* Replies go to the RM who wrote it, not to a shared inbox nobody reads.
       This is the nearest SMTP gets to the attribution Outlook would give for
       free, and it is the reason a reply is not simply lost. */
    replyTo: replyTo || undefined,
    attachments: attachments.map((a) => ({
      filename: a.name,
      content: a.content,
      encoding: a.encoding || 'base64',
      contentType: a.type || undefined,
    })),
  };

  const envelope = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    reply_to: message.replyTo ?? null,
    attachments: message.attachments.map((a) => a.filename),
    has_html: Boolean(html),
    has_text: Boolean(text),
  };

  if (!isLive()) {
    return {
      simulated: true,
      message_id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      envelope,
    };
  }

  try {
    const info = await (await getTransport()).sendMail(message);
    return { simulated: false, message_id: info.messageId ?? null, envelope };
  } catch (err) {
    throw new VendorError(name, err.message);
  }
}
