/**
 * Bar chart label geometry.
 *
 * P2-17: "Referral" and "IPO enquiry" sat on top of each other on the Leads by
 * source chart, and "Campaign — WhatsApp" ran into both its neighbours. The
 * band was a fixed 56px while the label is 10px proportional sans, so nineteen
 * characters wanted about a hundred pixels and were given fifty-six.
 *
 * Two labels colliding is the kind of defect only a browser normally notices,
 * and by then it is on somebody's homepage. The rule that decides whether they
 * can collide is arithmetic, so it is tested here as arithmetic.
 */

import { strict as assert } from 'node:assert';
import {
  bandWidth, fitLabel, labelWidth, MIN_BAND, MAX_BAND,
} from '../../client/src/components/chartLayout.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

/** The labels that were actually overlapping on the dashboard. */
const REAL = [
  'Manual', 'Website', 'Google Ads', 'IPO enquiry',
  'Facebook Lead Ads', 'Partner referral', 'Import', 'Campaign — WhatsApp',
];

console.log('\nBar label geometry');

test('no two labels can collide at the chosen band', () => {
  const band = bandWidth(REAL);
  for (const label of REAL) {
    const drawn = fitLabel(label, band);
    assert(labelWidth(drawn) <= band,
      `"${drawn}" needs ${Math.round(labelWidth(drawn))}px in a ${band}px band`);
  }
});

test('the real labels are not trimmed at all — they fit', () => {
  // The point of widening rather than truncating: the reader still gets the
  // whole word. Trimming is the fallback, not the plan.
  const band = bandWidth(REAL);
  for (const label of REAL) {
    assert.equal(fitLabel(label, band), label, `${label} was trimmed unnecessarily`);
  }
});

test('the fixed 56px band this replaced would have collided', () => {
  /* Proves the test can fail. Against the old geometry, the longest label
   * overruns its band, which is exactly what was on screen. */
  assert(labelWidth('Campaign — WhatsApp') > MIN_BAND,
    'the old band was wide enough after all — this test proves nothing');
});

test('short labels do not stretch the chart', () => {
  assert.equal(bandWidth(['Won', 'New', 'Lost']), MIN_BAND,
    'short labels widened the band beyond the minimum');
});

test('one very long label does not stretch every band', () => {
  // Otherwise the reader scrolls past eight columns of whitespace to reach
  // the ninth.
  const band = bandWidth(['A'.repeat(200), 'Won']);
  assert.equal(band, MAX_BAND);
  const drawn = fitLabel('A'.repeat(200), band);
  assert(drawn.length < 200 && drawn.endsWith('…'), 'the long label was not trimmed');
  assert(labelWidth(drawn) <= band, 'the trimmed label still overruns its band');
});

test('an empty chart does not divide by nothing', () => {
  assert.equal(bandWidth([]), MIN_BAND);
  assert.equal(bandWidth(), MIN_BAND);
});

test('a missing or odd label does not throw', () => {
  // Source comes from data, and data has holes.
  assert.equal(fitLabel(null, 100), '');
  assert.equal(fitLabel(undefined, 100), '');
  assert.equal(typeof fitLabel(42, 100), 'string');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
