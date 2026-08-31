/**
 * HTML sanitiser for anything a person composes and the firm then sends.
 *
 * P2-09 gave the email composer formatting, which means the body arriving at
 * this server is no longer plain text somebody typed — it is markup, and an RM
 * can paste into it from a web page, from Word, or from anywhere at all. Three
 * separate things then have to be true:
 *
 *   1. Nothing executable survives. A CRM that stores client-facing HTML and
 *      renders it back in an activity timeline is one careless paste away from
 *      running somebody else's script in a colleague's session.
 *   2. Nothing phones home. A pasted <img src="https://tracker/..."> turns
 *      every internal preview of that email into a tracking event on somebody
 *      else's server, which is a data-residency problem as much as a privacy
 *      one.
 *   3. What is left still looks like the email that was written.
 *
 * ALLOW-LIST, NEVER DENY-LIST. Blocking <script> and moving on is how these
 * are usually got wrong: the attacks that matter are `onerror=` on an
 * otherwise innocent tag, `javascript:` in an href, and the dozen tags nobody
 * remembers. Anything not named below is removed, so a tag invented after this
 * was written is dropped rather than waved through.
 *
 * Hand-written rather than pulled from npm on purpose. This runs on a system
 * holding client PII, and a sanitiser is exactly the dependency an attacker
 * would most like to own. The cost of that choice is that the parser below is
 * deliberately unclever: it does not try to repair bad markup, it discards it.
 */

/** Tags a client email may contain. Everything structural, nothing active. */
const ALLOWED = new Set([
  'p', 'br', 'div', 'span',
  'b', 'strong', 'i', 'em', 'u', 's',
  'ul', 'ol', 'li',
  'a',
  'h1', 'h2', 'h3', 'h4',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'hr',
]);

/**
 * Attributes each tag may keep.
 *
 * No `id`, no `class`, no `on*`. Style is allowed on a narrow set because the
 * toolbar produces it — font and size — and is itself filtered below.
 */
const ATTRS = {
  a: ['href', 'title'],
  span: ['style'],
  p: ['style'],
  div: ['style'],
  td: ['style', 'colspan', 'rowspan'],
  th: ['style', 'colspan', 'rowspan'],
  table: ['style'],
  h1: ['style'], h2: ['style'], h3: ['style'], h4: ['style'],
  li: ['style'], ul: ['style'], ol: ['style'],
};

/** CSS properties the toolbar can set. Anything else in a style is dropped. */
const STYLE_PROPS = new Set([
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-decoration', 'text-align', 'color', 'background-color',
]);

/**
 * URL schemes a link may use.
 *
 * `javascript:` is the obvious one. `data:` is the less obvious one — a
 * data: URL can carry a whole HTML document, so allowing it re-opens
 * everything else this file closes.
 */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

const escapeText = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** A style attribute reduced to the properties above, with urls stripped. */
function cleanStyle(value) {
  return String(value)
    .split(';')
    .map((rule) => {
      const [rawProp, ...rest] = rule.split(':');
      const prop = rawProp.trim().toLowerCase();
      const val = rest.join(':').trim();
      if (!STYLE_PROPS.has(prop) || !val) return null;
      // url() and expression() are how a style attribute becomes a fetch or,
      // historically, a script.
      if (/url\s*\(|expression\s*\(|javascript:/i.test(val)) return null;
      return `${prop}: ${val}`;
    })
    .filter(Boolean)
    .join('; ');
}

function cleanAttrs(tag, raw) {
  const allowed = ATTRS[tag];
  if (!allowed) return '';

  const out = [];
  // name="value" | name='value' | name=value
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const m of raw.matchAll(re)) {
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if (!allowed.includes(name)) continue;

    if (name === 'href') {
      if (!SAFE_SCHEME.test(value.trim())) continue;
      out.push(`href="${escapeText(value.trim())}"`);
      // A link the firm sends should not hand the destination a referrer or
      // a window handle back to the CRM.
      out.push('target="_blank"', 'rel="noopener noreferrer"');
      continue;
    }

    if (name === 'style') {
      const style = cleanStyle(value);
      if (style) out.push(`style="${escapeText(style)}"`);
      continue;
    }

    out.push(`${name}="${escapeText(value)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

const VOID = new Set(['br', 'hr']);

/**
 * Return `html` reduced to the allow-list above.
 *
 * Everything not recognised is dropped rather than escaped: an email that
 * shows a client the literal text `<script>` is not better than one that
 * shows nothing.
 */
export function sanitizeHtml(html) {
  if (!html) return '';

  let s = String(html);

  /* Whole elements whose *content* is as dangerous as their tag. Removing
     just the tag would leave the script body as visible text. */
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template)[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template)\b[^>]*\/?>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  const open = [];
  let out = '';
  let i = 0;

  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { out += escapeText(s.slice(i)); break; }

    out += escapeText(s.slice(i, lt));

    const gt = s.indexOf('>', lt);
    if (gt === -1) break;                       // truncated tag: discard the rest

    const inner = s.slice(lt + 1, gt);
    const closing = inner.startsWith('/');
    const m = (closing ? inner.slice(1) : inner).match(/^([a-zA-Z0-9]+)([\s\S]*)$/);
    i = gt + 1;
    if (!m) continue;

    const tag = m[1].toLowerCase();
    if (!ALLOWED.has(tag)) continue;            // dropped, content kept

    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;                  // never opened: ignore
      // Close anything left open inside it, so the output nests correctly.
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }

    if (VOID.has(tag)) { out += `<${tag}>`; continue; }

    out += `<${tag}${cleanAttrs(tag, m[2] || '')}>`;
    open.push(tag);
  }

  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/**
 * A plain-text rendering of the same content.
 *
 * Kept alongside the HTML rather than derived at read time, because the
 * activity timeline, the search index and any text-only mail client all want
 * it, and each deriving its own would produce three different answers.
 */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/(p|div|h[1-4]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trimEnd()).join('\n')
    .trim();
}

/** True when the body carries nothing a reader would see. */
export const isEmptyHtml = (html) => htmlToText(html).replace(/\s/g, '') === '';
