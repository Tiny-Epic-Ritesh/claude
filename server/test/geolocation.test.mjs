/**
 * Meeting location capture (P2-01).
 *
 * The business need is proof of physical presence. The risk is that capturing
 * where an employee stands is personal data about a member of staff, which
 * under DPDP needs a stated purpose, a retention period, and the person being
 * told.
 *
 * So these tests are mostly about restraint. The interesting assertions are the
 * ones that say the feature does NOT do something: does not ask on a phone
 * call, does not block a save when refused, does not keep a position for
 * thirteen months, and does not turn itself on.
 */

import { strict as assert } from 'node:assert';
import { all, one, run } from '../src/db.js';
import { readFileSync } from 'node:fs';
import * as geo from '../src/engine/geolocation.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const withCapture = (fn) => {
  const before = process.env.GEO_CAPTURE_ENABLED;
  process.env.GEO_CAPTURE_ENABLED = 'true';
  try { fn(); } finally {
    if (before === undefined) delete process.env.GEO_CAPTURE_ENABLED;
    else process.env.GEO_CAPTURE_ENABLED = before;
  }
};

console.log('\nMeeting location capture');

/* ------------------------------------------------------------ the switch */

test('it is off unless somebody turns it on', () => {
  /* Whether the firm may do this at all is Compliance's call. Shipping it on
     by default would be engineering making that decision for them. */
  const before = process.env.GEO_CAPTURE_ENABLED;
  delete process.env.GEO_CAPTURE_ENABLED;
  assert.equal(geo.isEnabled(), false, 'capture defaults to on');
  assert.equal(geo.wants('Meeting', 'Physical'), false, 'it captures while switched off');
  if (before !== undefined) process.env.GEO_CAPTURE_ENABLED = before;
});

/* ---------------------------------------------------------- what it asks */

test('only in-person meetings are asked at all', () => {
  /* Position on a phone call is surveillance with no purpose attached, and the
     first time it is questioned the whole feature becomes contentious --
     including the part that was justified. */
  withCapture(() => {
    assert(geo.wants('Meeting', 'Physical'), 'a physical meeting is not captured');
    assert(geo.wants('Meeting', 'Branch Visit'), 'a branch visit is not captured');

    assert(!geo.wants('Meeting', 'Virtual'), 'a virtual meeting was captured');
    assert(!geo.wants('Call', 'Physical'), 'a phone call was captured');
    assert(!geo.wants('WhatsApp', 'Physical'), 'a WhatsApp message was captured');
    assert(!geo.wants('Note', 'Physical'), 'a note was captured');
    assert(!geo.wants('Meeting', null), 'a meeting with no mode was captured');
  });
});

/* --------------------------------------------------------- what it stores */

test('a refusal is a value, not a failure', () => {
  /* Blocking the save means the meeting goes unlogged, and an unlogged meeting
     is worse for the business than an unlocated one. */
  const g = geo.normalise({ status: 'declined' });
  assert.equal(g.status, 'declined');
  assert.equal(g.lat, null, 'a refusal carried a position anyway');
});

test('"could not get a fix" is told apart from "would not give one"', () => {
  // Collapsing the two would make a refusal indistinguishable from a dead GPS,
  // and the refusal is the one that carries a management signal.
  assert.equal(geo.normalise({ status: 'unavailable' }).status, 'unavailable');
  assert.notEqual(geo.normalise({ status: 'unavailable' }).status, geo.normalise({ status: 'declined' }).status);
});

test('the accuracy radius is kept, because the address alone would mislead', () => {
  /* A 2 km cell-tower fix presented as a precise street address is evidence
     that will not survive being challenged. */
  const g = geo.normalise({ lat: 19.076, lng: 72.8777, accuracy: 1840.4, address: 'Nariman Point, Mumbai' });
  assert.equal(g.status, 'captured');
  assert.equal(g.accuracy_m, 1840, 'the accuracy radius was lost or not rounded');
  assert.equal(g.address, 'Nariman Point, Mumbai');
});

test('an impossible position is unavailable, not captured', () => {
  for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 'x', lng: 'y' }, {}]) {
    assert.equal(geo.normalise(bad).status, 'unavailable', `${JSON.stringify(bad)} was accepted as a fix`);
  }
});

/* ------------------------------------------------------------- retention */

test('a position older than twelve months is cleared, and the meeting is not', () => {
  const act = one("SELECT id FROM activities WHERE type = 'Meeting' LIMIT 1");
  assert(act, 'fixture: no meeting to age');

  run(
    `UPDATE activities SET geo_status = 'captured', geo_lat = 19.07, geo_lng = 72.87,
            geo_accuracy_m = 40, geo_address = 'somewhere',
            geo_captured_at = datetime('now', '-13 months')
      WHERE id = ?`, [act.id],
  );

  const cleared = geo.purge();
  assert(cleared >= 1, 'nothing was purged');

  const after = one('SELECT * FROM activities WHERE id = ?', [act.id]);
  assert.equal(after.geo_lat, null, 'the position survived its retention period');
  assert.equal(after.geo_address, null, 'the address survived its retention period');
  assert.equal(after.geo_status, 'expired', 'the record of having captured it was lost too');
  assert(after.id, 'the meeting itself was deleted');

  run('UPDATE activities SET geo_status = NULL, geo_captured_at = NULL WHERE id = ?', [act.id]);
});

test('a position inside the window is left alone', () => {
  const act = one("SELECT id FROM activities WHERE type = 'Meeting' LIMIT 1");
  run(
    `UPDATE activities SET geo_status = 'captured', geo_lat = 19.07, geo_lng = 72.87,
            geo_captured_at = datetime('now', '-2 months') WHERE id = ?`, [act.id],
  );
  geo.purge();
  assert.equal(one('SELECT geo_lat FROM activities WHERE id = ?', [act.id]).geo_lat, 19.07,
    'a position well inside the retention period was purged');
  run('UPDATE activities SET geo_status = NULL, geo_lat = NULL, geo_lng = NULL, geo_captured_at = NULL WHERE id = ?', [act.id]);
});

/* ------------------------------------------------------------- the DPDP bits */

test('every location field carries a stated purpose', () => {
  /* The obligation is that the purpose is stated. Putting it on the field
     definition means it cannot drift away from the field it justifies. */
  const fields = all("SELECT api_name, purpose, read_scope FROM field_def WHERE entity = 'interaction' AND api_name LIKE 'geo%'");
  assert(fields.length >= 5, `only ${fields.length} location fields are defined`);
  for (const f of fields) {
    assert(f.purpose, `${f.api_name} holds staff location with no stated purpose`);
    assert(/12 months/.test(f.purpose), `${f.api_name} does not state its retention`);
  }
});

test('a person can see what was recorded about their own movements', () => {
  // Both fair, and the defensible position if it is ever questioned.
  for (const f of all("SELECT api_name, read_scope FROM field_def WHERE entity = 'interaction' AND api_name LIKE 'geo%'")) {
    assert.equal(f.read_scope, 'owner_or_manager',
      `${f.api_name} is scoped "${f.read_scope}" — the RM cannot see their own location`);
  }
});

test('the notice says all four things a person is owed', () => {
  const n = geo.notice();
  for (const key of ['purpose', 'retention', 'visibility', 'optional']) {
    assert(n[key] && n[key].length > 10, `the notice does not explain "${key}"`);
  }
});

test('refusals are reported as a rate, never as a list of movements', () => {
  /* The management signal the "not mandatory" decision produces. The question
     worth asking is "does this person always decline", not "where was this
     person on Tuesday". */
  const rows = geo.refusalRates({ sinceDays: 90 });
  assert(Array.isArray(rows));
  for (const r of rows) {
    assert(!('geo_lat' in r) && !('geo_address' in r), 'the refusal report leaks positions');
    assert('declined' in r && 'asked' in r, 'a rate needs both halves to be a rate');
  }
});

/* ------------------------------------------------- the web form. P3-10 */

/**
 * Reported as "the geolocation feature has still not been added", and that was
 * right about what was tested even though the server half had been complete for
 * a fortnight. Capture, storage, the retention rule, the consent notice and the
 * physical-mode logic all existed and were tested; the mobile app used them;
 * and `client/src` contained no geolocation call at all. From the web the
 * feature genuinely was not there.
 *
 * So these assert the half that was missing, because "the server supports it"
 * is exactly the reasoning that let it ship half-built.
 */

const CRLF = /\r\n/g;
const read = (p) => readFileSync(p, 'utf8').replace(CRLF, '\n');

const COMPOSER = '../client/src/crm/ActivityComposer.jsx';
const HELPER = '../client/src/location.js';

test('the web has a location helper at all', () => {
  const src = read(HELPER);
  assert(/navigator\.geolocation/.test(src), 'the helper never asks the browser for a position');
  assert(/getCurrentPosition/.test(src), 'no position is requested');
});

test('every path returns a status the server understands', () => {
  /* normalise() accepts captured, declined and unavailable. A helper that
     resolved to undefined on some path would post `geo: undefined` and the
     activity would record nothing, silently. */
  const src = read(HELPER);
  for (const status of ['captured', 'declined', 'unavailable']) {
    assert(src.includes(`'${status}'`), `the helper never produces "${status}"`);
  }

  // And the engine accepts each of them.
  assert.equal(geo.normalise({ status: 'declined' }).status, 'declined');
  assert.equal(geo.normalise({ status: 'unavailable' }).status, 'unavailable');
  assert.equal(geo.normalise({ status: 'captured', lat: 19.07, lng: 72.87 }).status, 'captured');
});

test('a refusal never blocks the save', () => {
  /* Ritesh, 4 Sep: the activity saves regardless and the reason is recorded.
     A form that refuses without a position teaches people to log visits from
     their desk afterwards, which is worse evidence than an honest refusal. */
  const src = read(HELPER);
  assert(!/reject\(/.test(src), 'the helper can reject, which would fail the save');
  assert(!/throw /.test(src), 'the helper can throw, which would fail the save');
  assert(/code === 1/.test(src), 'a denied permission is not told apart from a failure');
});

test('the composer sends a location and only when it is wanted', () => {
  const src = read(COMPOSER);
  assert(/geo: geo \?\? undefined/.test(src), 'the composer never puts a location in the payload');
  assert(/wantsGeo\(meta, type, form\.meeting_mode\)/.test(src),
    'the composer does not ask the server whether a location is wanted');
  assert(/await capture\(\)/.test(src),
    'the position is not awaited before the post, so the activity would save without it');
});

test('the consent notice is shown before the browser prompts', () => {
  /* The server has supplied this notice all along and only the mobile app ever
     showed it, so a web user met a bare permission prompt with no statement of
     purpose, retention or the right to refuse. Under DPDP that statement is the
     point rather than a courtesy. */
  const src = read(COMPOSER);
  for (const part of ['purpose', 'retention', 'visibility', 'optional']) {
    assert(src.includes(`notice.${part}`), `the web form does not show the ${part} of the notice`);
  }

  const notice = geo.notice();
  assert(/decline/i.test(notice.optional), 'the notice does not say refusing is allowed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
