/**
 * The HTML sanitiser.
 *
 * P2-09 gave the composer formatting, so the email body is now markup an RM
 * can paste into from anywhere. This is the file standing between a pasted
 * payload and a client's inbox — and between it and a colleague's session,
 * since the same body is rendered back in the activity timeline.
 *
 * Written as attacks rather than as features. A sanitiser tested only on the
 * markup its own toolbar produces proves nothing at all: the toolbar was never
 * the threat.
 */

import { strict as assert } from 'node:assert';
import { sanitizeHtml, htmlToText, isEmptyHtml } from '../src/engine/sanitize.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/** Nothing that could run, fetch, or navigate on its own. */
const inert = (html) => {
  const out = sanitizeHtml(html);
  const lower = out.toLowerCase();
  for (const bad of ['<script', 'javascript:', 'onerror', 'onload', 'onclick',
    'onmouseover', '<iframe', '<object', '<embed', '<style', 'expression(']) {
    assert(!lower.includes(bad), `"${bad}" survived: ${out}`);
  }
  return out;
};

console.log('\nSanitiser — what must not survive');

test('a script tag and its contents go together', () => {
  const out = inert('<p>Hello</p><script>steal(document.cookie)</script>');
  // Removing the tag and leaving the body would put the payload on screen as
  // text, which is not obviously better and is certainly not clean.
  assert(!out.includes('steal'), `the script body is still there: ${out}`);
  assert(out.includes('Hello'), 'the real content was thrown away too');
});

test('event handlers on an otherwise innocent tag', () => {
  // The attack that actually gets used. <script> is the one everybody blocks.
  const out = inert('<p onmouseover="fetch(\'//x\')">Read me</p>');
  assert(out.includes('Read me'), 'the text was lost with the handler');
});

test('javascript: in a link', () => {
  const out = inert('<a href="javascript:alert(1)">Click</a>');
  assert(!out.includes('href='), `a dangerous href was kept: ${out}`);
  assert(out.includes('Click'), 'the link text was discarded');
});

test('a data: URL, which can carry a whole document', () => {
  const out = sanitizeHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>');
  assert(!out.includes('data:'), `data: URL survived: ${out}`);
});

test('an image that phones home', () => {
  // img is not on the allow-list at all: a remote image turns every internal
  // preview of the email into a tracking hit on somebody else's server.
  const out = sanitizeHtml('<img src="https://tracker.example/pixel.gif">');
  assert(!out.toLowerCase().includes('<img'), `img survived: ${out}`);
});

test('url() and expression() inside a style attribute', () => {
  const out = inert('<span style="background-image: url(//evil/x); font-size: 14px">t</span>');
  assert(!out.includes('url('), `url() survived: ${out}`);
  assert(out.includes('font-size'), 'the legitimate style was dropped as well');
});

test('a tag nobody thought of is dropped, not waved through', () => {
  // The reason this is an allow-list. Anything invented later fails closed.
  const out = sanitizeHtml('<marquee>hi</marquee><blink>x</blink><foo bar>y</foo>');
  assert(!/<(marquee|blink|foo)/i.test(out), `unknown tag survived: ${out}`);
  assert(out.includes('hi') && out.includes('x') && out.includes('y'),
    'the text inside unknown tags was thrown away');
});

test('uppercase and spaced-out tags do not slip past', () => {
  for (const attack of ['<SCRIPT>bad()</SCRIPT>', '<ScRiPt >bad()</ScRiPt>',
    '<a HREF="JavaScript:alert(1)">x</a>']) {
    inert(attack);
  }
});

test('a class or id cannot be smuggled in', () => {
  // Not dangerous alone, but they let pasted markup pick up the app's own
  // styles when the body is rendered back in the timeline.
  const out = sanitizeHtml('<p class="danger" id="x" data-foo="1">t</p>');
  assert(!/class=|id=|data-/.test(out), `an attribute survived: ${out}`);
});

console.log('\nSanitiser — what must survive');

test('the formatting the toolbar produces', () => {
  const html = '<p><b>Bold</b> and <i>italic</i> and <u>under</u></p>'
    + '<ul><li>One</li><li>Two</li></ul>'
    + '<span style="font-family: Arial; font-size: 14px">sized</span>';
  const out = sanitizeHtml(html);
  for (const keep of ['<b>', '<i>', '<u>', '<ul>', '<li>', 'font-family', 'font-size']) {
    assert(out.includes(keep), `${keep} was stripped: ${out}`);
  }
});

test('a real link keeps its href and gains a safe rel', () => {
  const out = sanitizeHtml('<a href="https://bonanzaonline.com/x">Our site</a>');
  assert(out.includes('href="https://bonanzaonline.com/x"'), `href lost: ${out}`);
  // A link the firm sends should not hand the destination a window handle back.
  assert(out.includes('rel="noopener noreferrer"'), `rel missing: ${out}`);
  assert(out.includes('target="_blank"'), `target missing: ${out}`);
});

test('mailto and tel still work', () => {
  for (const href of ['mailto:rm@bonanza.com', 'tel:+912212345678']) {
    assert(sanitizeHtml(`<a href="${href}">x</a>`).includes(href), `${href} was stripped`);
  }
});

test('merge fields pass through untouched', () => {
  // They are replaced after sanitising, so mangling them here would break
  // every template in the library.
  const out = sanitizeHtml('<p>Hello {{name}}, from {{rm}}</p>');
  assert(out.includes('{{name}}') && out.includes('{{rm}}'), `merge fields mangled: ${out}`);
});

test('unbalanced markup is closed rather than left open', () => {
  // A stray <b> that never closes would otherwise bold the rest of the page it
  // is rendered into.
  const out = sanitizeHtml('<p><b>bold <i>both</p>');
  const opens = (out.match(/<(b|i|p)>/g) || []).length;
  const closes = (out.match(/<\/(b|i|p)>/g) || []).length;
  assert.equal(opens, closes, `tags left unbalanced: ${out}`);
});

test('a closing tag that was never opened is ignored', () => {
  const out = sanitizeHtml('</b>text</p>');
  assert(!out.includes('</b>'), `stray close survived: ${out}`);
  assert(out.includes('text'));
});

console.log('\nPlain-text rendering');

test('block elements become line breaks, tags disappear', () => {
  const text = htmlToText('<p>One</p><p>Two</p><ul><li>A</li><li>B</li></ul>');
  assert(!text.includes('<'), `markup survived into the text: ${text}`);
  assert(/One\s+Two/.test(text), `paragraphs did not separate: ${JSON.stringify(text)}`);
  assert(text.includes('A') && text.includes('B'));
});

test('entities are decoded, not left as source', () => {
  assert.equal(htmlToText('<p>Tom &amp; Jerry &lt;3</p>'), 'Tom & Jerry <3');
});

test('a body with only markup counts as empty', () => {
  // The send route rejects an empty body. Without this, "<p><br></p>" — what
  // an empty contenteditable actually contains — would sail through as content.
  assert.equal(isEmptyHtml('<p><br></p>'), true);
  assert.equal(isEmptyHtml('<div>&nbsp;</div>'), true);
  assert.equal(isEmptyHtml(''), true);
  assert.equal(isEmptyHtml('<p>real</p>'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
