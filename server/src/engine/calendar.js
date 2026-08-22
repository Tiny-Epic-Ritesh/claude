/**
 * Working calendars — office hours, holidays, and the exchange's own list.
 *
 * WHY TWO CALENDARS AND NOT ONE
 * -----------------------------
 * A broking firm runs on two different weeks and they do not coincide.
 *
 *   office     when staff are in. Drives follow-up scheduling, SLA clocks and
 *              task due dates. Mon–Sat in most Indian broking houses.
 *   exchange   when NSE and BSE actually trade. Drives anything a client would
 *              act on — settlement expectations, "call me before the market
 *              opens", IPO windows.
 *
 * They diverge often. Maharashtra Day closes the Mumbai office but not every
 * desk; Muhurat trading opens the exchange for an hour on a day the office is
 * otherwise shut. Collapsing them into one list gets both wrong.
 *
 * WHAT THIS FIXES
 * ---------------
 * `engine/sla.js` already promised in its own docstring to skip "nights,
 * Sundays and holidays" — and there was no holiday data anywhere in the
 * system, so it skipped nights and Sundays and silently counted every Diwali as
 * a working day. An SLA that expires over a public holiday is a breach report
 * nobody can act on and a metric nobody trusts.
 *
 * ON THE SEEDED DATES
 * -------------------
 * Only the fixed-date national holidays are seeded, because those are the ones
 * that can be stated without checking: Republic Day, Independence Day, Gandhi
 * Jayanti, Christmas. The festival dates that move with the lunar calendar —
 * Holi, Diwali, Eid, Dussehra — are deliberately NOT invented here. They must be
 * pasted from the NSE circular each year, which is exactly why the whole list is
 * editable in Setup rather than compiled in.
 */

import { all, one, run, transact } from '../db.js';

export const CALENDAR_KINDS = ['office', 'exchange'];

/* ---------------------------------------------------------- the seed */

/**
 * Fixed-date holidays only. Anything whose date is decided by the lunar
 * calendar is left out on purpose — see the note above.
 */
const FIXED = [
  ['01-26', 'Republic Day', ['office', 'exchange']],
  ['05-01', 'Maharashtra Day', ['office']],
  ['08-15', 'Independence Day', ['office', 'exchange']],
  ['10-02', 'Gandhi Jayanti', ['office', 'exchange']],
  ['12-25', 'Christmas', ['office', 'exchange']],
];

/** The office is open Monday to Saturday; the exchange, Monday to Friday. */
const DEFAULTS = {
  office: { label: 'Bonanza office', open_hour: 9, close_hour: 19, week: [1, 2, 3, 4, 5, 6] },
  exchange: { label: 'NSE / BSE trading', open_hour: 9, close_hour: 16, week: [1, 2, 3, 4, 5] },
};

export function seedCalendars(year = new Date().getFullYear()) {
  return transact(() => {
    let added = 0;

    for (const [kind, def] of Object.entries(DEFAULTS)) {
      run(
        `INSERT INTO calendars (kind, label, open_hour, close_hour, week_days)
         VALUES (?,?,?,?,?)
         ON CONFLICT(kind) DO UPDATE SET label = excluded.label`,
        [kind, def.label, def.open_hour, def.close_hour, JSON.stringify(def.week)],
      );
    }

    for (const [md, name, kinds] of FIXED) {
      for (const kind of kinds) {
        const cal = one('SELECT id FROM calendars WHERE kind = ?', [kind]);
        const date = `${year}-${md}`;
        if (one('SELECT id FROM calendar_days WHERE calendar_id = ? AND on_date = ?', [cal.id, date])) continue;
        run(
          'INSERT INTO calendar_days (calendar_id, on_date, name, source) VALUES (?,?,?,?)',
          [cal.id, date, name, 'seed'],
        );
        added += 1;
      }
    }

    return { added, year };
  });
}

/* ------------------------------------------------------------ lookup */

/**
 * Cached, because `addBusinessMinutes` asks the same questions in a tight loop
 * and an SLA sweep runs it over every open case.
 */
let cache = null;

function load() {
  if (cache) return cache;
  cache = {};
  for (const c of all('SELECT * FROM calendars')) {
    cache[c.kind] = {
      ...c,
      week: JSON.parse(c.week_days || '[1,2,3,4,5,6]'),
      closed: new Set(
        all('SELECT on_date FROM calendar_days WHERE calendar_id = ? AND half_day = 0', [c.id])
          .map((d) => d.on_date),
      ),
      half: new Map(
        all('SELECT on_date, close_hour FROM calendar_days WHERE calendar_id = ? AND half_day = 1', [c.id])
          .map((d) => [d.on_date, d.close_hour]),
      ),
    };
  }
  return cache;
}

export const invalidate = () => { cache = null; };

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function calendarFor(kind = 'office') {
  const c = load()[kind];
  // A missing calendar must not silently make every day a working day.
  return c ?? { week: [1, 2, 3, 4, 5, 6], open_hour: 9, close_hour: 19, closed: new Set(), half: new Map() };
}

/** Is this a working day on this calendar? */
export function isWorkingDay(date, kind = 'office') {
  const cal = calendarFor(kind);
  const d = new Date(date);
  if (!cal.week.includes(d.getDay())) return false;
  return !cal.closed.has(iso(d));
}

/** When does this calendar close on this date? Half-days close early. */
export function closingHour(date, kind = 'office') {
  const cal = calendarFor(kind);
  return cal.half.get(iso(new Date(date))) ?? cal.close_hour;
}

export function isWorkingTime(date, kind = 'office') {
  const cal = calendarFor(kind);
  const d = new Date(date);
  if (!isWorkingDay(d, kind)) return false;
  return d.getHours() >= cal.open_hour && d.getHours() < closingHour(d, kind);
}

/**
 * The next moment this calendar is open.
 *
 * Walks forward a day at a time rather than computing, because holidays cluster
 * — Diwali can close three consecutive days — and arithmetic that assumes one
 * closed day at a time gets those wrong.
 */
export function nextWorkingTime(from, kind = 'office') {
  const cal = calendarFor(kind);
  const d = new Date(from);
  if (Number.isNaN(d.getTime())) return new Date();

  // A guard, not an expectation: a calendar closed every day of the week would
  // otherwise spin forever.
  for (let guard = 0; guard < 400; guard += 1) {
    if (!isWorkingDay(d, kind)) {
      d.setDate(d.getDate() + 1);
      d.setHours(cal.open_hour, 0, 0, 0);
      continue;
    }
    if (d.getHours() < cal.open_hour) {
      d.setHours(cal.open_hour, 0, 0, 0);
      return d;
    }
    if (d.getHours() >= closingHour(d, kind)) {
      d.setDate(d.getDate() + 1);
      d.setHours(cal.open_hour, 0, 0, 0);
      continue;
    }
    return d;
  }
  return d;
}

/**
 * Advance by `minutes` of working time.
 *
 * Used by the SLA clock, which is why it has to respect holidays: a case raised
 * at 18:00 the day before a three-day Diwali closure is not breaching at 10:00
 * the next morning, and reporting that it is destroys the metric.
 */
export function addWorkingMinutes(from, minutes, kind = 'office') {
  const cal = calendarFor(kind);
  let cursor = nextWorkingTime(from, kind);
  let remaining = Number(minutes) || 0;
  if (remaining <= 0) return cursor;

  /**
   * Consume a day at a time, not a five-minute slice at a time.
   *
   * The slice version was correct and unusably slow: the SLA sweep runs this
   * for every open case, and a four-day SLA is ~1,150 iterations each of which
   * re-walked the calendar. It hung the server on boot. Jumping whole days
   * makes an eight-week SLA about fifty iterations.
   */
  for (let guard = 0; guard < 2000; guard += 1) {
    const closes = new Date(cursor);
    closes.setHours(closingHour(cursor, kind), 0, 0, 0);

    const availableToday = Math.max(0, Math.round((closes - cursor) / 60_000));

    if (remaining <= availableToday) {
      return new Date(cursor.getTime() + remaining * 60_000);
    }

    remaining -= availableToday;

    // Move to the opening of the next working day.
    const nextDay = new Date(cursor);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(cal.open_hour, 0, 0, 0);
    cursor = nextWorkingTime(nextDay, kind);
  }
  return cursor;
}

/** Working days between two dates — for ageing that should not count holidays. */
export function workingDaysBetween(from, to, kind = 'office') {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;

  const sign = b >= a ? 1 : -1;
  const [start, end] = sign > 0 ? [a, b] : [b, a];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);

  let n = 0;
  for (let guard = 0; cursor < last && guard < 4000; guard += 1) {
    cursor.setDate(cursor.getDate() + 1);
    if (isWorkingDay(cursor, kind)) n += 1;
  }
  return n * sign;
}

/* ------------------------------------------------------------- admin */

export const listCalendars = () => all('SELECT * FROM calendars ORDER BY kind').map((c) => ({
  ...c,
  week: JSON.parse(c.week_days || '[]'),
  days: all('SELECT * FROM calendar_days WHERE calendar_id = ? ORDER BY on_date', [c.id]),
}));

export function addDay(kind, { on_date: onDate, name, half_day: halfDay = 0, close_hour: closeHour = null }) {
  const cal = one('SELECT id FROM calendars WHERE kind = ?', [kind]);
  if (!cal) return { ok: false, error: `No ${kind} calendar` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(onDate))) {
    return { ok: false, error: 'A date must look like 2026-10-21' };
  }
  if (one('SELECT id FROM calendar_days WHERE calendar_id = ? AND on_date = ?', [cal.id, onDate])) {
    return { ok: false, error: `${onDate} is already on the ${kind} calendar` };
  }

  run(
    'INSERT INTO calendar_days (calendar_id, on_date, name, half_day, close_hour, source) VALUES (?,?,?,?,?,?)',
    [cal.id, onDate, name?.trim() || 'Holiday', halfDay ? 1 : 0, halfDay ? closeHour : null, 'manual'],
  );
  invalidate();
  return { ok: true };
}

export function removeDay(id) {
  run('DELETE FROM calendar_days WHERE id = ?', [id]);
  invalidate();
  return { ok: true };
}

export function updateCalendar(kind, { open_hour: openHour, close_hour: closeHour, week }) {
  run(
    `UPDATE calendars SET open_hour = COALESCE(?, open_hour),
            close_hour = COALESCE(?, close_hour),
            week_days = COALESCE(?, week_days)
     WHERE kind = ?`,
    [openHour ?? null, closeHour ?? null, week ? JSON.stringify(week) : null, kind],
  );
  invalidate();
  return one('SELECT * FROM calendars WHERE kind = ?', [kind]);
}
