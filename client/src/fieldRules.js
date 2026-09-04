/**
 * Field formats, checked at the point of entry. P3-30.
 *
 * WHY THESE EXIST AT ALL
 * ----------------------
 * The server has always validated these and always answered with a specific
 * message — "PAN must look like ABCDE1234F", not "invalid". What it could not
 * do is say so while somebody was still typing, and a format you learn about
 * only after pressing Save is a format you get wrong twice.
 *
 * WHY THEY MIRROR THE SERVER RATHER THAN REPLACING IT
 * ---------------------------------------------------
 * These are a courtesy, not a control. Imports, automation, the API and bulk
 * actions all reach the same routes without passing through a form, so the
 * server check is the one that matters and it stays exactly where it is. If the
 * two ever disagree the server wins, and the user sees its message.
 *
 * The patterns are copied from `V` in server/src/security.js deliberately, and
 * a test asserts they still match — two regexes drifting apart is how a form
 * starts rejecting values the API would have accepted, which is worse than no
 * inline validation at all.
 */

/** Mirrors `V` in server/src/security.js. Keep the two in step. */
export const FORMATS = {
  mobile: {
    test: (v) => /^[6-9]\d{9}$/.test(String(v).trim()),
    message: 'Enter a valid 10-digit Indian mobile number, starting 6 to 9.',
  },
  pan: {
    test: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(v).trim().toUpperCase()),
    message: 'PAN must look like ABCDE1234F — five letters, four digits, one letter.',
  },
  ifsc: {
    test: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v).trim().toUpperCase()),
    message: 'IFSC must look like HDFC0001234 — four letters, a zero, then six characters.',
  },
  email: {
    test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim()),
    message: 'Enter a valid email address, like name@example.com.',
  },
  pincode: {
    test: (v) => /^[1-9]\d{5}$/.test(String(v).trim()),
    message: 'Enter a valid 6-digit PIN code.',
  },
};

/**
 * Which format a field is held to.
 *
 * Keyed on the field's own name first, because `pan` is an `encrypted_text`
 * column and its type says nothing about its shape. Type is the fallback, so a
 * custom field added in Setup as an email is checked without anybody listing it
 * here.
 */
const BY_NAME = {
  mobile: 'mobile',
  alt_mobile: 'mobile',
  phone: 'mobile',
  pan: 'pan',
  ifsc: 'ifsc',
  email: 'email',
  alt_email: 'email',
  pincode: 'pincode',
  pin_code: 'pincode',
};

const BY_TYPE = {
  email: 'email',
  phone: 'mobile',
};

export const formatFor = (field) =>
  FORMATS[BY_NAME[field?.api_name] ?? BY_TYPE[field?.type] ?? ''] ?? null;

/**
 * The message for one value, or null when it is fine.
 *
 * An empty value is never a format error. Whether a field is required is a
 * different question with a different answer, and conflating them means a form
 * shouting about the address somebody has not reached yet.
 */
export function checkField(field, value) {
  const raw = value ?? '';
  if (String(raw).trim() === '') return null;

  const format = formatFor(field);
  if (format && !format.test(raw)) return format.message;

  /* Numbers, named rather than generic. "Lead Score cannot contain letters"
     tells somebody what they did; "invalid input" tells them they failed. */
  if (field?.type === 'number' || field?.type === 'currency') {
    if (!/^-?\d+(\.\d+)?$/.test(String(raw).trim())) {
      return `${field.label ?? field.api_name} cannot contain letters — enter a number.`;
    }
  }

  if (field?.length && String(raw).length > field.length) {
    return `${field.label ?? field.api_name} is too long — ${field.length} characters at most, and this is ${String(raw).length}.`;
  }

  return null;
}

/** Every problem in a form, keyed by field name. Empty object when it is clean. */
export function checkAll(fields, values) {
  const out = {};
  for (const f of fields ?? []) {
    const message = checkField(f, values?.[f.api_name]);
    if (message) out[f.api_name] = message;
  }
  return out;
}

/**
 * Field-level messages out of a failed request.
 *
 * The server answers `{ error, errors: [{ field, message }] }`. The edit form
 * used to read `payload.fields`, which has never been a key the API sends — so
 * every field-level message the server took the trouble to produce was dropped,
 * and only the first one survived as the banner text.
 */
export function fieldErrorsFrom(err) {
  const rows = err?.payload?.errors;
  if (!Array.isArray(rows)) return {};
  return Object.fromEntries(rows.filter((r) => r?.field).map((r) => [r.field, r.message]));
}
