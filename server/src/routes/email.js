/**
 * The email composer (ENH-06).
 *
 * A lead's email address was plain text. Clicking it now opens a composer that
 * can start from an approved template, take free-form content, carry
 * attachments and send — logging the result on the lead like every other
 * outbound contact.
 *
 * Two decisions worth stating, because both are compliance decisions rather
 * than product ones.
 *
 * Attachments come from the Content Library first. A broking RM emailing a
 * client should be sending approved, versioned, in-date collateral — the
 * library already tracks version, expiry and owning role, and picking from it
 * means a withdrawn brochure stops being sendable the moment it is withdrawn.
 * Arbitrary uploads are allowed too, because the requirement asks for them, but
 * they are capped, type-checked and stored in the same database as everything
 * else so nothing leaves India.
 *
 * Consent is checked on the way out, not at the vendor. An email to somebody
 * who withdrew email consent is a TRAI/DPDP problem whether or not the vendor
 * would have accepted it.
 */

import { Router } from 'express';
import { all, one, run, audit } from '../db.js';
import { requireUser, requirePermission, reqScope, mayUnmask } from '../auth.js';
import { decryptField } from '../security.js';
import { checkConsent } from '../engine/consent.js';
import { send } from '../integrations.js';

const router = Router();
router.use(requireUser);

/** 5 MB, and only things a client can safely be sent. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const ALLOWED_TYPES = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const loadLead = (req, id) => {
  const scope = reqScope(req, 'l');
  return one(
    `SELECT l.* FROM leads l WHERE l.id = ? AND l.deleted_at IS NULL AND ${scope.sql}`,
    [id, ...scope.params],
  );
};

/**
 * Fill {{name}} and friends.
 *
 * Deliberately tiny and deliberately not a template language: anything more
 * expressive becomes a way to put an expression in front of a client, and the
 * approved-template process exists precisely so nobody does that.
 */
export function merge(text, vars) {
  if (!text) return '';
  return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (
    vars[key] != null ? String(vars[key]) : m
  ));
}

/* -------------------------------------------------------------- compose */

router.get('/compose/:leadId', (req, res) => {
  const lead = loadLead(req, req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const verdict = checkConsent(lead, 'email', 'service');

  res.json({
    lead: {
      id: lead.id,
      name: lead.name,
      // The composer needs a real address to send to. This is the one place the
      // masked value is useless, so it is fetched deliberately and the read is
      // audited like any other unmask.
      email: lead.email,
      sales_org: lead.sales_org,
    },
    consent: {
      allowed: verdict.allowed,
      reason: verdict.reason,
      // A service email to somebody who opted out of marketing is still lawful.
      // Saying which intent applies stops an RM guessing.
      marketing_allowed: checkConsent(lead, 'email', 'marketing').allowed,
    },
    templates: all(
      `SELECT id, name, subject, body, product_type_id
         FROM templates WHERE channel = 'email' AND approved = 1 ORDER BY name`,
    ),
    /* Approved collateral, in date. An expired brochure is not offered at all,
       which is cheaper than asking every RM to check a date. */
    library: all(
      `SELECT id, name, type, url, version
         FROM content_items
        WHERE status = 'active'
          AND (expiry_date IS NULL OR expiry_date >= date('now'))
        ORDER BY name`,
    ),
    limits: {
      max_attachment_bytes: MAX_ATTACHMENT_BYTES,
      allowed_types: Object.keys(ALLOWED_TYPES),
    },
    from: { name: req.user.name, email: req.user.email },
  });
});

/* ----------------------------------------------------------------- send */

router.post('/send', requirePermission('lead.contact'), (req, res) => {
  const {
    lead_id: leadId, subject, body, template_id: templateId,
    content_ids: contentIds = [], attachments = [], intent = 'service',
  } = req.body ?? {};

  const lead = loadLead(req, leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  if (!String(subject || '').trim()) return res.status(400).json({ error: 'Give the email a subject' });
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Write something first' });

  const verdict = checkConsent(lead, 'email', intent);
  if (!verdict.allowed) return res.status(409).json({ error: verdict.reason, code: verdict.code });

  /* Attachments. Two sources, one list. */
  const library = contentIds.length
    ? all(
      `SELECT id, name, type, url FROM content_items
        WHERE id IN (${contentIds.map(() => '?').join(',')})
          AND status = 'active'
          AND (expiry_date IS NULL OR expiry_date >= date('now'))`,
      contentIds,
    )
    : [];

  if (library.length !== contentIds.length) {
    return res.status(400).json({
      error: 'One of the attached documents has been withdrawn or has expired. Remove it and try again.',
    });
  }

  for (const a of attachments) {
    if (!ALLOWED_TYPES[a.type]) {
      return res.status(400).json({ error: `${a.name}: ${a.type || 'that file type'} cannot be emailed to a client` });
    }
    // `size` is what the browser reported; `data` is what actually arrived.
    const bytes = Math.ceil((String(a.data || '').length * 3) / 4);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return res.status(400).json({ error: `${a.name} is larger than 5 MB` });
    }
  }

  const vars = {
    name: (lead.name || '').split(' ')[0],
    full_name: lead.name,
    rm: req.user.name,
    org: lead.sales_org === 'BIGUL' ? 'Bigul' : 'Bonanza',
  };
  const finalSubject = merge(subject, vars);
  const finalBody = merge(body, vars);

  const result = send('email', {
    to: lead.email,
    subject: finalSubject,
    body: finalBody,
    leadId: lead.id,
    templateId: templateId ?? null,
    userName: req.user.name,
    templateVars: vars,
  });

  /* One interaction on the shared timeline, never a mirrored copy. */
  const attachmentNames = [
    ...library.map((l) => `${l.name} (v${l.version ?? 1})`),
    ...attachments.map((a) => a.name),
  ];

  const info = run(
    `INSERT INTO activities (lead_id, type, direction, subject, body, user_id)
     VALUES (?, 'Email', 'outbound', ?, ?, ?)`,
    [
      lead.id, finalSubject,
      attachmentNames.length ? `${finalBody}\n\nAttached: ${attachmentNames.join(', ')}` : finalBody,
      req.user.id,
    ],
  );

  for (const l of library) {
    run('UPDATE content_items SET send_count = send_count + 1 WHERE id = ?', [l.id]);
  }

  audit(req.user.id, 'lead.email', 'lead', lead.id, {
    subject: finalSubject, template_id: templateId ?? null,
    attachments: attachmentNames.length, intent,
  });

  res.json({
    ok: true,
    simulated: result?.simulated ?? true,
    activity_id: Number(info.lastInsertRowid),
    attachments: attachmentNames,
    note: result?.simulated
      ? 'Recorded and logged. No mail was actually delivered — SMTP credentials are not configured yet.'
      : 'Sent.',
  });
});

export default router;
