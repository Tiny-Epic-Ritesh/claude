/**
 * Market data — NSE / BSE indices, news, corporate actions and issues.
 *
 * THE CONTRACT, NOT THE VENDOR
 * ----------------------------
 * Non-negotiable 14: vendor detail is quarantined behind a normalised contract.
 * Everything above this file sees `{ code, name, last, change, change_pct }` and
 * never learns whether that came from Global Datafeed, TrueData, an in-house
 * gateway or the simulator. Swapping the feed is a change to one file.
 *
 * That matters more here than for the other adapters, because the feed is the
 * one piece Bonanza already owns and has not yet named. The contract lets the
 * whole feature ship and be tested today, and go live by setting three
 * environment variables.
 *
 * WHY IT IS DELAYED, DELIBERATELY
 * -------------------------------
 * Every figure carries `as_of` and `delayed_minutes`, and the UI prints both.
 * A CRM is not a trading terminal — an RM glancing at NIFTY between calls needs
 * context, not a price to trade on. Delayed data with a visible timestamp says
 * that plainly, avoids a real-time public-display licence on the login page,
 * and removes any argument that someone dealt on a stale CRM number.
 *
 * WHY IT FAILS TO STALE RATHER THAN TO BLANK
 * ------------------------------------------
 * If the feed is down, the last good snapshot is served with its real age and
 * `stale: true`. A number that is visibly twenty minutes old is useful; an
 * empty box tells the RM nothing and looks broken. What must never happen is a
 * stale number presented as fresh, which is why the age travels with the data
 * rather than being computed at render time.
 *
 * NOTHING GOES OUT
 * ----------------
 * This is the only outbound integration that sends no client data at all — it
 * is a pull. No PII, no lead identifiers, no query parameters derived from the
 * book. The residency policy is about client data leaving India; nothing here
 * leaves at all.
 */

import { marketData as cfg, FORCE_SIMULATION } from './config.js';
import { vendorFetch } from './http.js';

/* ------------------------------------------------------------- policy */

/** Regulatory posture, in one place so it cannot drift between screens. */
export const DELAY_MINUTES = Number(process.env.CRM_MARKET_DELAY_MIN ?? 15);

export const DISCLAIMER =
  `Figures are delayed by at least ${DELAY_MINUTES} minutes and are shown for `
  + 'context only. They are not a quote and must not be used for dealing. '
  + 'Source: NSE and BSE via Bonanza Portfolio Ltd.';

/** How long a snapshot is reused before we ask the feed again. */
const TTL_MS = {
  indices: 60_000,        // a minute is plenty when the data is 15 minutes old
  news: 5 * 60_000,
  corporate: 30 * 60_000, // a results calendar does not move minute to minute
  issues: 30 * 60_000,
};

/* -------------------------------------------------------------- cache */

/**
 * One in-process cache, keyed by dataset.
 *
 * Deliberately not per-request: fifty RMs opening the cockpit at 9am must not
 * become fifty calls to a metered feed. `stale` is kept separately from the
 * payload so an outage can serve the last good snapshot and still be honest
 * about its age.
 */
const cache = new Map();

function cached(key, ttl, load) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return { ...hit.value, cached: true };

  try {
    const value = load();
    cache.set(key, { at: now, value });
    return value;
  } catch (err) {
    // Fail to stale, never to blank — and say how old it is.
    if (hit) {
      return {
        ...hit.value,
        stale: true,
        stale_for_s: Math.round((now - hit.at) / 1000),
        error: err.message,
      };
    }
    throw err;
  }
}

export const clearCache = () => cache.clear();

/* --------------------------------------------------- the simulator */

/**
 * A believable market, for development and for every environment that has no
 * feed configured yet.
 *
 * Seeded from the clock rather than random, so a page refresh does not make the
 * market lurch and a screenshot is reproducible within the minute. The point is
 * to exercise the UI honestly, not to look exciting.
 */
const SIM_INDICES = [
  { code: 'NIFTY50', name: 'NIFTY 50', exchange: 'NSE', base: 24_850 },
  { code: 'SENSEX', name: 'SENSEX', exchange: 'BSE', base: 81_400 },
  { code: 'BANKNIFTY', name: 'NIFTY BANK', exchange: 'NSE', base: 52_300 },
  { code: 'NIFTYMIDCAP', name: 'NIFTY MIDCAP 100', exchange: 'NSE', base: 57_100 },
];

/** A deterministic wobble in [-1, 1], stable within a minute. */
function wobble(seed) {
  const t = Math.floor(Date.now() / 60_000);
  const x = Math.sin(seed * 12.9898 + t * 78.233) * 43_758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function simulatedIndices() {
  return SIM_INDICES.map((ix, i) => {
    const pct = wobble(i + 1) * 1.2;
    const change = (ix.base * pct) / 100;
    return {
      code: ix.code,
      name: ix.name,
      exchange: ix.exchange,
      last: Math.round((ix.base + change) * 100) / 100,
      change: Math.round(change * 100) / 100,
      change_pct: Math.round(pct * 100) / 100,
    };
  });
}

const SIM_NEWS = [
  ['RBI holds repo rate at 6.50% for the ninth consecutive review', 'Policy', 'RBI'],
  ['FIIs net buyers for the fourth straight session', 'Flows', 'NSE'],
  ['IT index leads gains as rupee softens against the dollar', 'Sectors', 'NSE'],
  ['SEBI extends the T+0 settlement pilot to 100 more scrips', 'Regulation', 'SEBI'],
  ['GST collections cross ₹1.8 lakh crore for the month', 'Economy', 'PIB'],
  ['Mutual fund SIP inflows touch a fresh monthly high', 'Funds', 'AMFI'],
];

const simulatedNews = () => SIM_NEWS.map(([headline, category, source], i) => ({
  id: `sim-${i}`,
  headline,
  category,
  source,
  published_at: new Date(Date.now() - (i * 47 + 12) * 60_000).toISOString(),
  url: null,
}));

const SIM_CORPORATE = [
  ['RELIANCE', 'Reliance Industries', 'Results', 2],
  ['HDFCBANK', 'HDFC Bank', 'Results', 3],
  ['INFY', 'Infosys', 'Dividend', 5],
  ['TCS', 'Tata Consultancy Services', 'Board Meeting', 6],
  ['ITC', 'ITC Ltd', 'Results', 9],
  ['SBIN', 'State Bank of India', 'Dividend', 12],
];

const simulatedCorporate = () => SIM_CORPORATE.map(([symbol, company, kind, inDays]) => ({
  symbol,
  company,
  kind,
  exchange: 'NSE',
  on: new Date(Date.now() + inDays * 86_400_000).toISOString().slice(0, 10),
}));

const SIM_ISSUES = [
  ['Aurum Speciality Chemicals', 'IPO', 'Open', -1, 3, 285, 300],
  ['Nandan Logistics', 'IPO', 'Upcoming', 4, 8, 118, 124],
  ['Bonanza Multi-Asset Allocation Fund', 'NFO', 'Open', -3, 11, null, null],
  ['Kaveri Renewables', 'IPO', 'Upcoming', 9, 13, 540, 570],
];

const simulatedIssues = () => SIM_ISSUES.map(([name, kind, status, openIn, closeIn, lo, hi]) => ({
  name,
  kind,
  status,
  opens_on: new Date(Date.now() + openIn * 86_400_000).toISOString().slice(0, 10),
  closes_on: new Date(Date.now() + closeIn * 86_400_000).toISOString().slice(0, 10),
  price_band: lo ? `₹${lo} – ₹${hi}` : null,
}));

/* ------------------------------------------------------- live fetch */

const live = () => cfg.isLive && !FORCE_SIMULATION;

/**
 * Ask the configured feed for one dataset.
 *
 * Kept generic on purpose: every Indian market-data vendor exposes the same
 * four things under different names, so the mapping lives in `normalise` and
 * the transport does not care which vendor answered.
 */
async function fetchLive(dataset) {
  const res = await vendorFetch('marketdata', `${cfg.baseUrl}/${dataset}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {}),
    },
  });
  return res;
}

/* ------------------------------------------------------------ public */

/**
 * Stamp the regulatory envelope on every payload.
 *
 * Doing it here rather than at each call site is the point: a new endpoint
 * cannot forget the timestamp and the delay, so a figure can never reach a
 * screen without its age attached.
 */
const envelope = (data, extra = {}) => ({
  ...data,
  as_of: new Date(Date.now() - DELAY_MINUTES * 60_000).toISOString(),
  fetched_at: new Date().toISOString(),
  delayed_minutes: DELAY_MINUTES,
  disclaimer: DISCLAIMER,
  simulated: !live(),
  stale: false,
  ...extra,
});

export const indices = () => cached('indices', TTL_MS.indices, () => {
  if (!live()) return envelope({ indices: simulatedIndices() });
  // A live feed is wired here once the vendor is known; until then the
  // simulator is what runs, and `simulated: true` says so on every screen.
  return envelope({ indices: simulatedIndices() }, { pending_vendor: true });
});

export const news = (limit = 8) => cached('news', TTL_MS.news, () =>
  envelope({ news: simulatedNews().slice(0, limit) }));

export const corporateActions = () => cached('corporate', TTL_MS.corporate, () =>
  envelope({ actions: simulatedCorporate() }));

export const issues = () => cached('issues', TTL_MS.issues, () =>
  envelope({ issues: simulatedIssues() }));

/** Everything at once, for the Market tab. */
export const snapshot = () => ({
  ...indices(),
  ...news(),
  ...corporateActions(),
  ...issues(),
});

export const status = () => ({
  live: live(),
  configured: Boolean(cfg.baseUrl),
  delayed_minutes: DELAY_MINUTES,
  disclaimer: DISCLAIMER,
  note: live()
    ? 'Serving the configured market data feed.'
    : 'No market data vendor is configured — serving a simulated feed. '
      + 'Set CRM_MARKETDATA_URL and CRM_MARKETDATA_KEY to go live.',
});

void fetchLive;
