/**
 * Message templates, and what each channel will actually accept (P3-17).
 *
 * The rules here are not ours. A WhatsApp template is submitted to Meta and
 * approved or rejected by Meta, so a builder that lets somebody write a 90
 * character header is a builder that collects work and then loses it a day
 * later with a rejection nobody can read. The limits below are the provider's,
 * enforced at the point of writing rather than discovered at the point of
 * sending.
 *
 * WHY THE BODY STAYS A COLUMN
 * ---------------------------
 * `templates.body` already carries the message and everything that sends one
 * reads it — campaigns, automation actions, the composer. The structured parts
 * go in a `components` JSON alongside rather than replacing it, so a template
 * built here is sendable by everything that could already send one, and an
 * older template with no components is still a valid template.
 */

import { isEmptyHtml } from './sanitize.js';

/**
 * Merge fields, and the fact that they are ours rather than Meta's.
 *
 * WhatsApp numbers its variables {{1}}, {{2}} — positional, and the meaning
 * lives in the submission rather than the text. Ours are named, because a
 * person writing a template should not have to hold a numbering in their head,
 * and because a named field can be checked against what we can actually supply.
 * They are translated to positions on the way out to the provider.
 */
export const MERGE_FIELDS = [
  { key: 'name', label: 'First name', example: 'Rohan' },
  { key: 'full_name', label: 'Full name', example: 'Rohan Kulkarni' },
  { key: 'rm', label: 'Their RM', example: 'Priya Sharma' },
  { key: 'org', label: 'Business', example: 'Bonanza' },
  { key: 'product', label: 'Product', example: 'Mutual Funds' },
];

const MERGE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Every merge field a piece of text uses. */
export const fieldsIn = (text) => [...String(text ?? '').matchAll(MERGE)].map((m) => m[1]);

/**
 * What each channel allows.
 *
 * WhatsApp's numbers are Meta's published template limits. SMS is one GSM-7
 * segment at 160 characters, and the count matters because a template that
 * spills to two segments costs twice as much per send — at Bonanza's volume
 * that is a real number, so the builder shows it rather than letting somebody
 * discover it on an invoice.
 */
export const CHANNELS = {
  whatsapp: {
    label: 'WhatsApp',
    /* Meta needs a machine name, lower case with underscores, and it cannot be
       changed after submission. */
    name_pattern: '^[a-z0-9_]{1,512}$',
    name_hint: 'Lower case, digits and underscores. Meta will not let this change once submitted.',
    categories: [
      { key: 'MARKETING', label: 'Marketing', note: 'Offers, and anything promotional. Needs opt-in.' },
      { key: 'UTILITY', label: 'Utility', note: 'About something the client already did — an order, an account, a reminder.' },
      { key: 'AUTHENTICATION', label: 'Authentication', note: 'One-time passcodes only.' },
    ],
    header: { max: 60, variables: 1, types: ['none', 'text', 'image', 'document', 'video'] },
    body: { max: 1024, required: true },
    footer: { max: 60, variables: 0 },
    buttons: { quick_reply_max: 3, cta_max: 2, label_max: 25 },
  },
  sms: {
    label: 'SMS',
    body: { max: 918, required: true },
    /* One GSM-7 segment. Past this a message is billed as two. */
    segment: 160,
    segment_unicode: 70,
  },
  email: {
    label: 'Email',
    subject: { max: 150, required: true },
    body: { required: true, html: true },
    /* The grey line an inbox shows after the subject. Free space that is
       currently unused, and the cheapest open-rate change available. */
    preheader: { max: 140 },
    /* Not a label. `checkConsent(lead, 'email', intent)` already blocks a
       marketing send to a lead who opted out and lets a KYC or statement
       through, so declaring intent on the template rather than at send time
       is what stops a campaign being posted as "service" to get past a
       suppression. */
    intents: [
      { key: 'service', label: 'Service', note: 'Transactional and regulatory: KYC, statements, dues, SLA. Reaches an opted-out lead.' },
      { key: 'marketing', label: 'Marketing', note: 'Campaigns, pitches, offers. Suppressed for anyone opted out, and carries an unsubscribe link.' },
    ],
    attachments: { max: 5 },
  },
};

/* ---------------------------------------------------------- validation */

const len = (s) => String(s ?? '').length;

/**
 * Everything wrong with a template, not the first thing.
 *
 * Being told about one problem, fixing it, and being told about the next is how
 * a form becomes something people work around — the same reasoning the
 * validation engine already applies to records.
 */
export function checkTemplate({ channel, name, subject, body, components = {} }) {
  const spec = CHANNELS[channel];
  const problems = [];
  if (!spec) return [{ field: 'channel', message: `"${channel}" is not a channel` }];

  if (!String(name ?? '').trim()) problems.push({ field: 'name', message: 'Give the template a name' });
  if (spec.name_pattern && name && !new RegExp(spec.name_pattern).test(name)) {
    problems.push({ field: 'name', message: spec.name_hint });
  }

  if (spec.subject?.required && !String(subject ?? '').trim()) {
    problems.push({ field: 'subject', message: 'An email needs a subject' });
  }
  if (spec.subject && len(subject) > spec.subject.max) {
    problems.push({ field: 'subject', message: `A subject is at most ${spec.subject.max} characters` });
  }

  if (spec.body.required && !String(body ?? '').trim()) {
    problems.push({ field: 'body', message: 'The message has no body' });
  }
  if (spec.body.max && len(body) > spec.body.max) {
    problems.push({ field: 'body', message: `The body is at most ${spec.body.max} characters — this is ${len(body)}` });
  }

  /* Merge fields we cannot fill. A template naming {{account_number}} renders
     the literal text to a client, which is worse than refusing it here. */
  const known = new Set(MERGE_FIELDS.map((f) => f.key));
  for (const part of [subject, body, components.header?.text, components.footer, components.preheader]) {
    for (const field of fieldsIn(part)) {
      if (!known.has(field)) {
        problems.push({ field: 'body', message: `There is no merge field called "${field}"` });
      }
    }
  }

  if (channel === 'whatsapp') problems.push(...checkWhatsApp(components, spec));
  if (channel === 'email') problems.push(...checkEmail(components, spec, body));
  return problems;
}

/**
 * An email address, to the only standard worth applying here.
 *
 * Deliberately loose. The exhaustive RFC 5322 pattern rejects addresses that
 * work and accepts ones that do not, and the real test of an address is
 * whether mail to it is delivered. This catches the typo -- a missing @, a
 * trailing comma, a space -- and leaves the rest to the mail server.
 */
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function checkEmail(c, spec, body) {
  const problems = [];

  if (!c.intent) {
    problems.push({ field: 'intent', message: 'Say whether this is a service or a marketing email' });
  } else if (!spec.intents.some((i) => i.key === c.intent)) {
    problems.push({ field: 'intent', message: `"${c.intent}" is not an intent` });
  }

  if (len(c.preheader) > spec.preheader.max) {
    problems.push({ field: 'preheader', message: `A preheader is at most ${spec.preheader.max} characters -- this is ${len(c.preheader)}` });
  }

  /* An empty body is not an empty string. The editor leaves <p><br></p> behind
     when everything is deleted, which passes a .trim() check and sends a blank
     email to a client. */
  if (body && isEmptyHtml(body)) {
    problems.push({ field: 'body', message: 'The body looks empty. Formatting on its own is not a message.' });
  }

  if (c.reply_to && !EMAIL.test(String(c.reply_to).trim())) {
    problems.push({ field: 'reply_to', message: `"${c.reply_to}" is not an email address replies could go to` });
  }

  const attachments = c.attachments ?? [];
  if (!Array.isArray(attachments)) {
    problems.push({ field: 'attachments', message: 'Attachments must be a list' });
  } else if (attachments.length > spec.attachments.max) {
    problems.push({ field: 'attachments', message: `At most ${spec.attachments.max} attachments` });
  }

  /* Marketing mail must carry a way out of it, and the template is not the
     place that decision gets made. Refused rather than silently corrected, so
     nobody believes they turned it off. */
  if (c.intent === 'marketing' && c.unsubscribe === false) {
    problems.push({ field: 'intent', message: 'A marketing email has to carry an unsubscribe link. Send it as service if it is not marketing.' });
  }

  return problems;
}

/**
 * Attachments that are still sendable.
 *
 * Separate from checkTemplate because it needs rows from the database and the
 * rest of this module is pure. The route resolves the ids and passes what it
 * found; anything asked for and not returned was withdrawn or has expired,
 * which is the same rule the send route applies at the moment of sending. A
 * template holding a withdrawn document is not an error until somebody notices
 * -- so it is said here, while the template is open.
 */
export function checkAttachments(ids = [], found = []) {
  const have = new Map(found.map((r) => [r.id, r]));
  return ids
    .filter((id) => !have.has(Number(id)))
    .map((id) => ({
      field: 'attachments',
      message: `An attached document (#${id}) has been withdrawn or has expired. Remove it.`,
    }));
}

function checkWhatsApp(c, spec) {
  const problems = [];

  if (!c.category) {
    problems.push({ field: 'category', message: 'Meta needs a category before it will review a template' });
  } else if (!spec.categories.some((k) => k.key === c.category)) {
    problems.push({ field: 'category', message: `"${c.category}" is not a category Meta recognises` });
  }
  if (!c.language) problems.push({ field: 'language', message: 'Say which language this is in' });

  const header = c.header ?? { type: 'none' };
  if (!spec.header.types.includes(header.type)) {
    problems.push({ field: 'header', message: `A header cannot be a ${header.type}` });
  }
  if (header.type === 'text') {
    if (!String(header.text ?? '').trim()) {
      problems.push({ field: 'header', message: 'The header is empty. Choose "none" if there is no header.' });
    }
    if (len(header.text) > spec.header.max) {
      problems.push({ field: 'header', message: `A header is at most ${spec.header.max} characters` });
    }
    if (fieldsIn(header.text).length > spec.header.variables) {
      problems.push({ field: 'header', message: 'A header may carry one merge field at most' });
    }
  }

  if (len(c.footer) > spec.footer.max) {
    problems.push({ field: 'footer', message: `A footer is at most ${spec.footer.max} characters` });
  }
  if (fieldsIn(c.footer).length) {
    /* Meta's rule, not ours: a footer is fixed text. */
    problems.push({ field: 'footer', message: 'A footer cannot carry a merge field' });
  }

  const buttons = Array.isArray(c.buttons) ? c.buttons : [];
  const quick = buttons.filter((b) => b.type === 'quick_reply');
  const cta = buttons.filter((b) => b.type !== 'quick_reply');

  if (quick.length > spec.buttons.quick_reply_max) {
    problems.push({ field: 'buttons', message: `At most ${spec.buttons.quick_reply_max} quick replies` });
  }
  if (cta.length > spec.buttons.cta_max) {
    problems.push({ field: 'buttons', message: `At most ${spec.buttons.cta_max} call-to-action buttons` });
  }
  for (const b of buttons) {
    if (!String(b.text ?? '').trim()) {
      problems.push({ field: 'buttons', message: 'A button with no label cannot be shown' });
    }
    if (len(b.text) > spec.buttons.label_max) {
      problems.push({ field: 'buttons', message: `A button label is at most ${spec.buttons.label_max} characters` });
    }
    if (b.type === 'url' && !/^https?:\/\//i.test(String(b.url ?? ''))) {
      problems.push({ field: 'buttons', message: `"${b.text}" needs a URL starting http:// or https://` });
    }
    if (b.type === 'phone' && !/^\+?[\d\s-]{6,20}$/.test(String(b.phone ?? ''))) {
      problems.push({ field: 'buttons', message: `"${b.text}" needs a phone number` });
    }
  }

  return problems;
}

/* ------------------------------------------------------------- preview */

/** Fill the merge fields with the example values, so a preview reads as a message. */
export const withExamples = (text) => String(text ?? '').replace(
  MERGE,
  (whole, key) => MERGE_FIELDS.find((f) => f.key === key)?.example ?? whole,
);

/**
 * The GSM-7 alphabet (GSM 03.38), as two sets rather than one regex.
 *
 * A character in the basic set costs one septet. The eight in the extended
 * set are reached through an escape and cost two. Anything in neither forces
 * the whole message into UCS-2 -- one Greek letter, one em dash, one curly
 * quote pasted out of Word, and every character in the message doubles.
 */
const GSM7 = [
  '@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5',
  '\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9',
  ' !"#\u00a4%&\'()*+,-./0123456789:;<=>?',
  '\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7',
  '\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0',
].join('');

/* Two septets each. The euro sign is the one people are surprised by. */
const GSM7_EXTENDED = '^{}\\[~]|\u20ac';

/**
 * What an SMS actually costs to send.
 *
 * Anything outside GSM-7 forces the whole message into UCS-2, where a segment
 * is 70 characters rather than 160 — one rupee sign or curly quote pasted from
 * Word can double the bill for a campaign. Worth saying on the screen where the
 * character is typed.
 */
export function smsSegments(text) {
  const s = withExamples(text);

  let septets = 0;
  for (const ch of s) {
    if (GSM7_EXTENDED.includes(ch)) septets += 2;
    else if (GSM7.includes(ch)) septets += 1;
    else return ucs2(s);
  }

  /* 160 septets in a message that fits one part. Past that every part carries
     the header that stitches them together, which costs 7 of them. */
  const per = septets > 160 ? 153 : 160;
  return {
    characters: s.length,
    unicode: false,
    per_segment: per,
    segments: Math.max(1, Math.ceil(septets / per)),
  };
}

/* 70 characters alone, 67 once the concatenation header takes its share. */
function ucs2(s) {
  const units = [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
  const per = units > 70 ? 67 : 70;
  return {
    characters: s.length,
    unicode: true,
    per_segment: per,
    segments: Math.max(1, Math.ceil(units / per)),
  };
}

/**
 * The shape Meta is sent.
 *
 * Built here rather than in the vendor module so it can be shown on screen
 * before anybody submits anything — the translation from named merge fields to
 * Meta's positional {{1}} is the part most likely to be wrong, and it is much
 * cheaper to read it than to have a template rejected.
 */
export function toMetaTemplate({ name, body, components = {} }) {
  const order = [];
  const positional = (text) => String(text ?? '').replace(MERGE, (whole, key) => {
    if (!order.includes(key)) order.push(key);
    return `{{${order.indexOf(key) + 1}}}`;
  });

  const out = [];
  if (components.header?.type === 'text') {
    out.push({ type: 'HEADER', format: 'TEXT', text: positional(components.header.text) });
  } else if (components.header && !['none', undefined].includes(components.header.type)) {
    out.push({ type: 'HEADER', format: String(components.header.type).toUpperCase() });
  }

  out.push({ type: 'BODY', text: positional(body) });
  if (String(components.footer ?? '').trim()) out.push({ type: 'FOOTER', text: components.footer });

  const buttons = (components.buttons ?? []).map((b) => {
    if (b.type === 'url') return { type: 'URL', text: b.text, url: b.url };
    if (b.type === 'phone') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone };
    return { type: 'QUICK_REPLY', text: b.text };
  });
  if (buttons.length) out.push({ type: 'BUTTONS', buttons });

  return {
    name,
    language: components.language ?? 'en',
    category: components.category ?? 'UTILITY',
    components: out,
    /* Which of our fields fills each numbered slot. Kept with the payload
       because the numbering is meaningless without it. */
    variable_order: order,
  };
}
