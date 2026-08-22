/**
 * Working calendars.
 *
 * The thing worth proving is not that a Set lookup works. It is that the SLA
 * clock, which has always *claimed* in its own docstring to skip "nights,
 * Sundays and holidays", now actually does — and that the office and the
 * exchange stay different, because collapsing them is the mistake this exists
 * to prevent.
 */

import { strict as assert } from 'node:assert';
import { all, one, run, db } from '../src/db.js';
import {
  seedCalendars, isWorkingDay, isWorkingTime, closingHour, nextWorkingTime,
  addWorkingMinutes, workingDaysBetween, calendarFor, invalidate,
  addDay, removeDay, listCalendars, CALENDAR_KINDS,
} from '../src/engine/calendar.js';
import { addBusinessMinutes } from '../src/engine/sla.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

seedCalendars(2026);
invalidate();

const at = (iso, h = 10) => new Date(`${iso}T${String(h).padStart(2, '0')}:00:00`);
const OWN = [];

/* ------------------------------------------------------------ the seed */

console.log('\nThe two calendars');

test('both calendars exist and are different', () => {
  const office = calendarFor('office');
  const exchange = calendarFor('exchange');

  assert.notDeepEqual(office.week, exchange.week, 'the office and the exchange keep the same week');
  assert(office.week.includes(6), 'the office should be open on Saturday');
  assert(!exchange.week.includes(6), 'the exchange should not trade on Saturday');
});

test('a Saturday is an office day but not a trading day', () => {
  // 24 Jan 2026 is a Saturday. This is the divergence that makes one shared
  // calendar wrong for both.
  const sat = at('2026-01-24');
  eq2(sat.getDay(), 6, 'the fixture is not a Saturday');
  assert(isWorkingDay(sat, 'office'), 'the office should be open');
  assert(!isWorkingDay(sat, 'exchange'), 'the exchange should be shut');
});

test('only fixed-date holidays are seeded — nothing lunar is invented', () => {
  const days = listCalendars().flatMap((c) => c.days.filter((d) => d.source === 'seed'));
  const names = new Set(days.map((d) => d.name));

  for (const fixed of ['Republic Day', 'Independence Day', 'Gandhi Jayanti', 'Christmas']) {
    assert(names.has(fixed), `${fixed} is not seeded`);
  }
  // The dates that move each year must come from the NSE circular, not from us.
  for (const guessed of ['Diwali', 'Holi', 'Eid', 'Dussehra']) {
    assert(![...names].some((n) => n.includes(guessed)),
      `${guessed} was seeded with a guessed date — it moves every year`);
  }
});

test('Maharashtra Day closes the office but not the exchange', () => {
  assert(!isWorkingDay(at('2026-05-01'), 'office'), 'the office should be shut');
  assert(isWorkingDay(at('2026-05-01'), 'exchange'), 'the exchange should be trading');
});

test('seeding twice adds nothing', () => {
  const before = one('SELECT COUNT(*) n FROM calendar_days').n;
  seedCalendars(2026);
  eq2(one('SELECT COUNT(*) n FROM calendar_days').n, before, 'reseeding duplicated days');
});

/* ------------------------------------------------------ the SLA clock */

console.log('\nThe SLA clock respects holidays');

test('a two-hour SLA raised before a holiday does not expire during it', () => {
  // Sunday 25 Jan at 18:00. Monday 26 Jan is Republic Day. Before the calendar
  // existed this landed Monday morning and reported a breach nobody could have
  // prevented.
  const due = addBusinessMinutes('2026-01-25T18:00:00', 120);

  assert(isWorkingDay(due, 'office'), 'the SLA fell due on a non-working day');
  eq2(due.getDate(), 27, `expected Tuesday the 27th, got the ${due.getDate()}`);
});

test('a clock started mid-afternoon finishes the same day when it fits', () => {
  const due = addBusinessMinutes('2026-01-27T14:00:00', 60);
  eq2(due.getDate(), 27);
  eq2(due.getHours(), 15);
});

test('a clock started after hours begins at the next opening', () => {
  const due = addBusinessMinutes('2026-01-27T22:00:00', 30);
  eq2(due.getDate(), 28, 'did not roll to the next day');
  eq2(due.getHours(), 9, 'did not start at opening');
  eq2(due.getMinutes(), 30);
});

test('a long SLA crossing several closures still lands on a working day', () => {
  const due = addBusinessMinutes('2026-01-23T10:00:00', 4320);   // three office days
  assert(isWorkingDay(due, 'office'), 'a long SLA fell due on a closed day');
  assert(isWorkingTime(due, 'office'), 'a long SLA fell due outside working hours');
});

test('the clock is fast enough for a sweep', () => {
  // The first version stepped in five-minute slices and re-walked the calendar
  // on each one. It hung the server on boot.
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) addBusinessMinutes('2026-01-05T10:00:00', 4320);
  const ms = Date.now() - t0;
  assert(ms < 3000, `200 SLA computations took ${ms}ms — too slow for a sweep`);
});

/* ---------------------------------------------------- clustered closures */

console.log('\nClustered closures and half-days');

test('three consecutive closed days are all skipped', () => {
  // Diwali closes several days in a row. Arithmetic that assumes one closed day
  // at a time gets this wrong, which is why the walk is day by day.
  for (const d of ['2026-03-02', '2026-03-03', '2026-03-04']) {
    addDay('office', { on_date: d, name: 'Test cluster' });
    OWN.push(d);
  }
  invalidate();

  const next = nextWorkingTime(at('2026-03-02', 10), 'office');
  eq2(next.getDate(), 5, `expected the 5th, got the ${next.getDate()}`);
});

test('a half-day closes early but is still a working day', () => {
  addDay('exchange', { on_date: '2026-03-10', name: 'Muhurat trading', half_day: 1, close_hour: 13 });
  OWN.push('2026-03-10');
  invalidate();

  assert(isWorkingDay(at('2026-03-10'), 'exchange'), 'a half-day should still be a working day');
  eq2(closingHour(at('2026-03-10'), 'exchange'), 13, 'the early close was not applied');
  assert(isWorkingTime(at('2026-03-10', 11), 'exchange'), 'the morning should be open');
  assert(!isWorkingTime(at('2026-03-10', 15), 'exchange'), 'the afternoon should be shut');
});

test('working days between two dates skips closures', () => {
  // 23 Jan (Fri) to 28 Jan (Wed) on the office calendar: Sat 24 counts,
  // Sun 25 does not, Mon 26 is Republic Day, so Tue 27 and Wed 28 count.
  const n = workingDaysBetween('2026-01-23', '2026-01-28', 'office');
  eq2(n, 3, `expected 3 working days, got ${n}`);
});

test('the count is signed when the dates are reversed', () => {
  const fwd = workingDaysBetween('2026-01-23', '2026-01-28', 'office');
  const back = workingDaysBetween('2026-01-28', '2026-01-23', 'office');
  eq2(back, -fwd);
});

/* ----------------------------------------------------------- editing */

console.log('\nEditing');

test('a badly formed date is refused', () => {
  const r = addDay('office', { on_date: '9 Nov', name: 'Bad' });
  assert(!r.ok);
  assert.match(r.error, /2026-10-21/);
});

test('the same date twice is refused', () => {
  addDay('office', { on_date: '2026-04-14', name: 'First' });
  OWN.push('2026-04-14');
  const again = addDay('office', { on_date: '2026-04-14', name: 'Second' });
  assert(!again.ok);
  assert.match(again.error, /already on the office calendar/);
});

test('an unknown calendar is refused', () => {
  const r = addDay('lunar', { on_date: '2026-04-20', name: 'Nope' });
  assert(!r.ok);
  assert.match(r.error, /No lunar calendar/);
});

test('adding a day takes effect immediately', () => {
  // The cache is invalidated on write; without that an admin adds Diwali and
  // the SLA clock keeps counting it for the rest of the process's life.
  const date = '2026-06-15';
  assert(isWorkingDay(at(date), 'office'), 'the fixture day should start open');

  addDay('office', { on_date: date, name: 'Added mid-run' });
  OWN.push(date);
  assert(!isWorkingDay(at(date), 'office'), 'the new closure was not picked up until a restart');
});

test('removing a day takes effect immediately too', () => {
  const row = one("SELECT id FROM calendar_days WHERE on_date = '2026-06-15'");
  removeDay(row.id);
  assert(isWorkingDay(at('2026-06-15'), 'office'), 'the removal was not picked up');
  OWN.splice(OWN.indexOf('2026-06-15'), 1);
});

test('every declared calendar kind actually exists', () => {
  for (const kind of CALENDAR_KINDS) {
    assert(one('SELECT id FROM calendars WHERE kind = ?', [kind]), `${kind} is declared but not seeded`);
  }
});

/* ------------------------------------------------------------ cleanup */

for (const d of OWN) run('DELETE FROM calendar_days WHERE on_date = ?', [d]);
invalidate();

function eq2(a, b, msg) { assert.equal(a, b, msg); }

console.log(`\n${passed} passed, ${failed} failed\n`);
void all;
db.close();
process.exit(failed ? 1 : 0);
