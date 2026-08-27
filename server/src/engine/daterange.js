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
 * A SQL predicate for a column falling inside the range.
 *
 * Returned as a fragment plus params rather than an interpolated string,
 * because these are user-supplied dates on the custom range.
 */
export const inRange = (column, range) => ({
  sql: `${column} >= ? AND ${column} < ?`,
  params: [range.sqlFrom, range.sqlToExclusive],
});

export const inPrevRange = (column, range) => ({
  sql: `${column} >= ? AND ${column} < ?`,
  params: [range.prevFrom, range.prevToExclusive],
});

/** Percentage change, or null when the previous period had nothing to compare. */
export function delta(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}
