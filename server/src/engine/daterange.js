/**
 * Date ranges for the dashboard (ENH-24a).
 *
 * Two decisions here are India-specific and both matter.
 *
 * The default is month-to-date, not "last 30 days". Broking sales targets run
 * monthly, and MTD is what an RM is actually judged on. A rolling 30-day window
 * does not align to a target period, so the dashboard would disagree with the
 * incentive statement — and the incentive statement always wins that argument.
 *
 * The financial year starts on 1 April. A dashboard that quietly used a January
 * year would be wrong on every FYTD figure in the business, and wrong in a way
 * that looks plausible until somebody reconciles it against the books.
 *
 * Everything is computed in IST. The server may sit anywhere, but "today" on a
 * trading floor in Mumbai is not a UTC day, and an RM opening the dashboard at
 * 09:00 IST must not see yesterday.
 */

export const IST_OFFSET_MIN = 5 * 60 + 30;

/** Now, shifted into IST, so getUTC* reads as IST wall-clock. */
export const istNow = (now = new Date()) =>
  new Date(now.getTime() + IST_OFFSET_MIN * 60_000);

const iso = (d) => d.toISOString().slice(0, 10);

/** The financial year a date falls in. April to March, named by its start. */
export function financialYearStart(d) {
  const y = d.getUTCFullYear();
  // Before April, the FY started in April of the previous calendar year.
  return d.getUTCMonth() < 3 ? new Date(Date.UTC(y - 1, 3, 1)) : new Date(Date.UTC(y, 3, 1));
}

export const RANGES = [
  { code: 'today', label: 'Today' },
  { code: 'mtd', label: 'Month to date' },
  { code: 'qtd', label: 'Quarter to date' },
  { code: 'fytd', label: 'Financial year to date' },
  { code: 'custom', label: 'Custom' },
];

export const DEFAULT_RANGE = 'mtd';

/**
 * Resolve a range code into { from, to } dates plus the comparable previous
 * period.
 *
 * The comparison period is the same *length* ending where the current one
 * began, not simply "last month". On the 5th of the month, comparing 5 days
 * against a full 30 would show a collapse that is an artefact of the calendar,
 * which is exactly the sort of number that starts a bad meeting.
 */
export function resolveRange(code = DEFAULT_RANGE, { from, to } = {}, now = new Date()) {
  const ist = istNow(now);
  const today = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const endExclusive = new Date(today.getTime() + 864e5);

  let start;
  let end = endExclusive;
  let label;

  switch (code) {
    case 'today':
      start = today;
      label = 'Today';
      break;

    case 'qtd': {
      // Financial quarters, since the year they sit in starts in April:
      // Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar.
      const fyStart = financialFYQuarterStart(today);
      start = fyStart;
      label = 'Quarter to date';
      break;
    }

    case 'fytd':
      start = financialYearStart(today);
      label = 'Financial year to date';
      break;

    case 'custom': {
      const f = from ? new Date(`${from}T00:00:00Z`) : null;
      const t = to ? new Date(`${to}T00:00:00Z`) : null;
      if (!f || Number.isNaN(f.getTime())) return resolveRange(DEFAULT_RANGE, {}, now);
      start = f;
      end = t && !Number.isNaN(t.getTime()) ? new Date(t.getTime() + 864e5) : endExclusive;
      label = `${iso(start)} to ${iso(new Date(end.getTime() - 864e5))}`;
      break;
    }

    case 'mtd':
    default:
      start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      label = 'Month to date';
      break;
  }

  const spanMs = end.getTime() - start.getTime();
  const prevEnd = start;
  const prevStart = new Date(start.getTime() - spanMs);

  return {
    code: RANGES.some((r) => r.code === code) ? code : DEFAULT_RANGE,
    label,
    from: iso(start),
    to: iso(new Date(end.getTime() - 864e5)),
    // Half-open [from, to) so a record created at 23:59 on the last day counts
    // exactly once and never twice.
    sqlFrom: iso(start),
    sqlToExclusive: iso(end),
    prevFrom: iso(prevStart),
    prevToExclusive: iso(prevEnd),
    days: Math.round(spanMs / 864e5),
  };
}

/** The start of the financial quarter containing `d`. */
export function financialFYQuarterStart(d) {
  const fy = financialYearStart(d);
  const monthsIn = (d.getUTCFullYear() - fy.getUTCFullYear()) * 12 + (d.getUTCMonth() - fy.getUTCMonth());
  const quarterIndex = Math.floor(monthsIn / 3);
  return new Date(Date.UTC(fy.getUTCFullYear(), fy.getUTCMonth() + quarterIndex * 3, 1));
}

/**
 * The moment an IST calendar day begins, written the way stored timestamps are:
 * UTC, 'YYYY-MM-DD HH:MM:SS' (OPS-24).
 *
 * Every timestamp in the database is UTC -- `datetime('now')` -- and every
 * range here is IST days. Comparing one with the other as bare dates moved the
 * start of each day to 05:30 IST, so anything recorded between midnight and
 * 05:30 counted on the day before. A date-only value still compares the right
 * way round: '2026-10-13' sorts after '2026-10-12 18:30:00'.
 *
 * The filters elsewhere that compare whole days -- a list opened from a tile, a
 * log filtered by date, a "today" count -- use SQLite's
 * `date(x, '+330 minutes')`, the IST date of a UTC timestamp, which leaves a
 * date-only value as it is.
 */
/**
 * The display format (QA-17, ruled 15 Oct): 15-10-2026, and 15-10-2026 14:30
 * IST with a time -- for the messages the server writes for people to read.
 * A bare day ("2026-10-15") is printed as that day.
 */
const two = (n) => String(n).padStart(2, '0');
export function dmy(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.split('-').reverse().join('-');
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw.replace(' ', 'T') : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return raw;
  const t = istNow(d);
  return `${two(t.getUTCDate())}-${two(t.getUTCMonth() + 1)}-${t.getUTCFullYear()}`;
}
export function dmyTime(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return dmy(raw);
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw.replace(' ', 'T') : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return raw;
  const t = istNow(d);
  return `${dmy(raw)} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())} IST`;
}

export const istDayStartUtc = (day) => new Date(new Date(`${day}T00:00:00Z`).getTime() - IST_OFFSET_MIN * 60_000)
  .toISOString().slice(0, 19).replace('T', ' ');

/**
 * A SQL predicate for a column falling inside the range.
 *
 * Returned as a fragment plus params rather than an interpolated string,
 * because these are user-supplied dates on the custom range. The bounds are
 * instants rather than an expression on the column, so an index on it still
 * serves the query.
 */
export const inRange = (column, range) => ({
  sql: `${column} >= ? AND ${column} < ?`,
  params: [istDayStartUtc(range.sqlFrom), istDayStartUtc(range.sqlToExclusive)],
});

export const inPrevRange = (column, range) => ({
  sql: `${column} >= ? AND ${column} < ?`,
  params: [istDayStartUtc(range.prevFrom), istDayStartUtc(range.prevToExclusive)],
});

/** Percentage change, or null when the previous period had nothing to compare. */
export function delta(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}
