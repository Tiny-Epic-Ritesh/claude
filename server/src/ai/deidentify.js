/**
 * De-identification — the mechanism that lets a frontier model reason about a
 * Bonanza client without any identifying data leaving India.
 *
 * WHY THIS EXISTS
 * ---------------
 * Claude is reachable from Mumbai on Bedrock only through *global* cross-Region
 * inference, which AWS documents as routing to commercial Regions worldwide.
 * For a SEBI-regulated broker whose policy is "client data must not leave India",
 * that is disqualifying on its own. This module removes the identity before the
 * call and restores it afterwards, so what crosses the boundary is a situation,
 * not a person.
 *
 * THE KEY DESIGN CHOICE
 * ---------------------
 * We do not ask a model to *find* the PII. We already know it: the lead's name,
 * mobile, email and PAN are columns in our own database. So substitution is
 * exact for every known value, and the regex sweep afterwards is defence in
 * depth for anything unknown that a caller happened to say aloud.
 *
 * That ordering matters. NER-based scrubbing misses names it has not seen;
 * known-value substitution cannot miss the name of the person whose record we
 * are literally holding.
 */

/* ------------------------------------------------------------- patterns */

/**
 * Ordered: the most specific pattern must run first, or a looser one consumes
 * the digits it needs. Aadhaar before generic account numbers, for instance.
 */
const PATTERNS = [
  { kind: 'PAN', re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  { kind: 'AADHAAR', re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { kind: 'EMAIL', re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/gi },
  { kind: 'MOBILE', re: /(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g },
  { kind: 'IFSC', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { kind: 'ACCOUNT', re: /\b\d{11,18}\b/g },
  { kind: 'PIN', re: /\b[1-9]\d{5}\b/g },
  { kind: 'CLIENTCODE', re: /\b[A-Z]{2,4}\d{4,8}\b/g },
];

/** Values too short or too generic to substitute safely. */
const isSubstitutable = (v) => typeof v === 'string' && v.trim().length >= 3;

/* ------------------------------------------------------------ the vault */

/**
 * Holds the mapping between real values and their tokens for one AI call.
 * It never leaves the process, and it is discarded when the call completes.
 */
export class Vault {
  constructor() {
    this.toToken = new Map();   // real value → token
    this.toReal = new Map();    // token → real value
    this.counters = new Map();  // kind → next ordinal
  }

  token(kind, real) {
    const key = String(real);
    if (this.toToken.has(key)) return this.toToken.get(key);

    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);

    const token = `[${kind}_${n}]`;
    this.toToken.set(key, token);
    this.toReal.set(token, key);
    return token;
  }

  /** Put the real values back into whatever the model returned. */
  rehydrate(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const [token, real] of this.toReal) {
      out = out.split(token).join(real);
    }
    return out;
  }

  /** Rehydrate every string in an arbitrarily nested structure. */
  rehydrateDeep(value) {
    if (typeof value === 'string') return this.rehydrate(value);
    if (Array.isArray(value)) return value.map((v) => this.rehydrateDeep(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.rehydrateDeep(v)]));
    }
    return value;
  }

  get size() { return this.toReal.size; }

  /** What was removed, for the audit trail — kinds and counts only, never values. */
  summary() {
    const counts = {};
    for (const token of this.toReal.keys()) {
      const kind = token.slice(1, token.lastIndexOf('_'));
      counts[kind] = (counts[kind] || 0) + 1;
    }
    return counts;
  }
}

/* ------------------------------------------------------------ scrubbing */

/**
 * Replace every known identifier, then sweep for unknown ones.
 * `known` is a list of {kind, value} drawn from our own database.
 */
const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile the known identifiers for one context into a SINGLE matcher.
 *
 * The obvious implementation — one `replace` per known value — costs a full pass
 * over the payload for every identifier. The copilot's snapshot carries sixty
 * leads, so that was roughly four hundred passes and about 1.6 seconds of CPU per
 * question. One alternation does it in one pass.
 *
 * Ordering carries the meaning: JavaScript alternation takes the FIRST matching
 * branch, so sorting longest-first is what makes "Aarav Malhotra" win over
 * "Aarav". Sorting is not a tidiness choice here — reversing it would silently
 * leave surnames in the payload.
 */
export function compileKnown(known, vault) {
  const values = new Map();   // value → kind, de-duplicated

  for (const { kind, value } of known) {
    if (!isSubstitutable(value)) continue;
    if (!values.has(value)) values.set(value, kind);

    // A full name also appears as its parts on a call transcript: the caller
    // says "Aarav", never "Aarav Malhotra".
    if (kind === 'NAME') {
      for (const part of String(value).split(/\s+/)) {
        if (part.length >= 3 && !values.has(part)) values.set(part, 'NAME');
      }
    }
  }

  if (values.size === 0) return null;

  const ordered = [...values.keys()].sort((a, b) => b.length - a.length);
  const kindOf = new Map([...values].map(([v, k]) => [v.toLowerCase(), k]));

  return {
    re: new RegExp(ordered.map(escapeRe).join('|'), 'gi'),
    replace: (match) => vault.token(kindOf.get(match.toLowerCase()) || 'VALUE', match),
    size: values.size,
  };
}

/**
 * Replace every known identifier, then sweep for unknown ones.
 * `known` is a list of {kind, value} drawn from our own database.
 */
export function scrubText(text, vault, known = [], compiled = undefined) {
  if (typeof text !== 'string' || !text) return text;

  // 1. Known values first — exact, and impossible to miss.
  const matcher = compiled === undefined ? compileKnown(known, vault) : compiled;
  let out = matcher ? text.replace(matcher.re, matcher.replace) : text;

  // 2. Pattern sweep for anything the record did not know about.
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (match) => vault.token(kind, match));
  }

  return out;
}

/** Scrub every string in a nested structure, leaving numbers and booleans alone. */
export function scrubDeep(value, vault, known = [], compiled = undefined) {
  // Compile once for the whole structure rather than per string.
  const matcher = compiled === undefined ? compileKnown(known, vault) : compiled;

  const walk = (v) => {
    if (typeof v === 'string') return scrubText(v, vault, known, matcher);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };

  return walk(value);
}

/**
 * Collect the identifiers we already hold for this context, so substitution is
 * exact rather than inferred. Everything here comes from our own tables.
 */
export function knownIdentifiers({
  lead, contact, partner, owner,
  leads = [], partners = [], cards = [], users = [],
}) {
  const known = [];
  const add = (kind, value) => { if (isSubstitutable(value)) known.push({ kind, value }); };

  // Single records and collections are treated identically. The copilot works
  // over a whole book, so the plural forms matter as much as the singular ones.
  const people = [lead, contact, partner, ...leads, ...partners].filter(Boolean);

  for (const person of people) {
    add('NAME', person.name);
    add('MOBILE', person.mobile);
    add('EMAIL', person.email);
    add('PAN', person.pan);
    add('ACCOUNT', person.bank_account);
    add('IFSC', person.bank_ifsc);
    add('CITY', person.city);
    add('NAME', person.business_name);
    add('NAME', person.father_spouse);
    add('ADDRESS', person.address);
  }

  // Staff names are personal data too, and are not needed for the reasoning.
  for (const user of [owner, ...users].filter(Boolean)) add('AGENT', user.name);

  // Product names are business vocabulary, not PII — deliberately not scrubbed,
  // because the model must reason about which product was discussed.
  void cards;

  return known;
}

/**
 * One call's worth of de-identification.
 * Returns the scrubbed payload plus the vault needed to restore the answer.
 */
export function deidentify(payload, context = {}) {
  const vault = new Vault();
  const known = knownIdentifiers(context);
  return { scrubbed: scrubDeep(payload, vault, known), vault };
}

/**
 * Structure-aware verifier — the one the routing layer must use.
 *
 * It walks the scrubbed payload rather than its JSON serialisation, because the
 * scrubber and the verifier have to examine the same surface. Numbers are left
 * untouched by design (the model needs the pipeline value, the score, the age in
 * days), so serialising first and pattern-matching the result flags every
 * six-figure rupee amount as a PIN code and blocks a lawful call.
 *
 * Strings get the full check. Numbers get an exact comparison against known
 * identifiers only — enough to catch a mobile number that ended up in a numeric
 * column, without treating arithmetic as personal data.
 */
export function residualPiiDeep(value, known = []) {
  const found = [];

  // Compiled once for the whole payload, not once per string.
  const matcher = compileVerifier(known);

  // Exact numeric lookups, so a mobile number that landed in a numeric column is
  // still caught without the loose patterns flagging every rupee amount.
  const numeric = new Map();
  for (const { kind, value: real } of known) {
    if (isSubstitutable(real)) numeric.set(String(real), kind);
  }

  const walk = (v) => {
    if (typeof v === 'string') {
      found.push(...residualPii(v, known, matcher));
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      const asText = String(v);
      const kind = numeric.get(asText);
      if (kind) found.push({ kind, value: `${asText.slice(0, 3)}…` });
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };

  walk(value);
  return found;
}

/**
 * Verifier for a single piece of text: returns any known identifier or
 * recognisable pattern still present. A non-empty result means it must not be
 * sent. Prefer residualPiiDeep for whole payloads.
 */
export function residualPii(text, known = [], compiled = undefined) {
  const found = [];
  const haystack = String(text ?? '');

  // Same single-pass treatment as the scrubber: the verifier runs on every
  // string in the payload, so a regex per known value per string is the same
  // quadratic cost, just paid on the way out instead of the way in.
  const matcher = compiled === undefined ? compileVerifier(known) : compiled;
  if (matcher) {
    for (const hit of haystack.matchAll(matcher.re)) {
      found.push({
        kind: matcher.kindOf.get(hit[0].toLowerCase()) || 'VALUE',
        value: `${hit[0].slice(0, 3)}…`,   // never echo the whole value
      });
    }
  }

  for (const { kind, re } of PATTERNS) {
    const m = haystack.match(new RegExp(re.source, re.flags.replace('g', '')));
    if (m) found.push({ kind, value: `${String(m[0]).slice(0, 3)}…` });
  }
  return found;
}

/** Known-value matcher for the verifier. Mirrors compileKnown, without a vault. */
export function compileVerifier(known = []) {
  const values = new Map();
  for (const { kind, value } of known) {
    if (isSubstitutable(value) && !values.has(value)) values.set(value, kind);
  }
  if (values.size === 0) return null;

  const ordered = [...values.keys()].sort((a, b) => b.length - a.length);
  return {
    re: new RegExp(ordered.map(escapeRe).join('|'), 'gi'),
    kindOf: new Map([...values].map(([v, k]) => [v.toLowerCase(), k])),
  };
}
