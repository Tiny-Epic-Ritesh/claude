/**
 * Outlook calendar, through Microsoft Graph.
 *
 * Outlook is the calendar the firm actually uses, which makes it the system of
 * record and this a reader. The CRM caches what Graph reports so a day view is
 * one local query rather than a round trip per user, and so the calendar still
 * renders when Graph is unreachable — with an honest "as of" stamp rather than
 * an empty page.
 *
 * Live when the credentials are present, simulated when they are not, like
 * every other adapter here. The simulated feed is deliberately plausible rather
 * than tidy: meetings land on working hours, some are Teams calls, some have
 * attendees who have not replied — because a calendar of identical clean events
 * demonstrates nothing.
 */

import { outlook as cfg, FORCE_SIMULATION } from './config.js';
import { vendorFetch } from './http.js';

export const isLive = () => Boolean(cfg.tenantId && cfg.clientId && cfg.clientSecret) && !FORCE_SIMULATION;

export const status = () => ({
  live: isLive(),
  configured: Boolean(cfg.tenantId && cfg.clientId && cfg.clientSecret),
  mode: isLive() ? 'graph' : 'simulated',
  needs: [
    !cfg.tenantId && 'OUTLOOK_TENANT_ID',
    !cfg.clientId && 'OUTLOOK_CLIENT_ID',
    !cfg.clientSecret && 'OUTLOOK_CLIENT_SECRET',
  ].filter(Boolean),
  /**
   * Said plainly because it is the question a compliance officer asks first.
   * Graph is Microsoft-hosted; whether that satisfies the residency rule
   * depends on the tenant's own region, which is the tenant's decision and not
   * something this adapter can assert.
   */
  residency_note:
    'Calendar data is read from the firm\'s own Microsoft 365 tenant. No client identifier is sent to Graph — only the signed-in user\'s calendar is requested.',
});

/* --------------------------------------------------------------- token */

let cached = { token: null, expires: 0 };

async function token() {
  if (cached.token && Date.now() < cached.expires - 60_000) return cached.token;

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await vendorFetch('outlook', `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json();
  if (!json.access_token) throw new Error(json.error_description || 'Outlook refused the credentials');
  cached = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/* ---------------------------------------------------------- simulation */

const SIM = [
  ['Portfolio review — Aarav Malhotra', 'Teams', 9, 45, true],
  ['New account walkthrough', 'Branch — Andheri', 11, 30, false],
  ['SIP top-up discussion', 'Teams', 14, 30, true],
  ['Weekly desk sync', 'Conference Room 2', 16, 60, false],
  ['Compliance refresher', 'Teams', 10, 90, true],
];

/**
 * A fortnight of plausible meetings.
 *
 * Deterministic on the user id, so the same person sees the same diary across
 * reloads — a demo where the calendar reshuffles on every refresh is a demo
 * nobody trusts.
 */
function simulate(userId, fromISO, toISO) {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const out = [];

  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;                    // no weekend diary

    // One or two meetings a day, varying by user and date rather than at random.
    const seed = (userId * 7 + d.getUTCDate() * 3 + dow) % SIM.length;
    const count = ((userId + d.getUTCDate()) % 3 === 0) ? 2 : 1;

    for (let i = 0; i < count; i += 1) {
      const [subject, location, hour, mins, online] = SIM[(seed + i) % SIM.length];
      /**
       * Stored as IST wall-clock, matching how every other dated row in this
       * database is written (datetime('now') is local, not UTC). Converting to
       * UTC here would put a 9am meeting at 3:30am on the day view, which is
       * exactly what the first version did.
       */
      const starts = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0));
      const ends = new Date(starts.getTime() + mins * 60_000);
      out.push({
        external_id: `sim-${userId}-${d.toISOString().slice(0, 10)}-${i}`,
        etag: 'sim',
        subject,
        body_preview: null,
        location,
        starts_at: starts.toISOString().slice(0, 19).replace('T', ' '),
        ends_at: ends.toISOString().slice(0, 19).replace('T', ' '),
        all_day: 0,
        organiser: 'you',
        attendees: JSON.stringify(i === 0
          ? [{ name: 'Client', email: null, response: 'accepted' }]
          : [{ name: 'Colleague', email: null, response: 'none' }]),
        online_url: online ? 'https://teams.microsoft.com/l/meetup-join/simulated' : null,
        status: 'confirmed',
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------- fetching */

/**
 * Events for one mailbox in a window.
 *
 * calendarView rather than /events, because it expands recurring series --
 * /events returns the master and leaves the caller to work out the occurrences,
 * which is how a weekly desk sync shows up once a year.
 */
export async function eventsFor(user, fromISO, toISO) {
  if (!isLive()) return { events: simulate(user.id, fromISO, toISO), simulated: true };
  if (!user.email) return { events: [], simulated: false };

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user.email)}`
    + `/calendarView?startDateTime=${fromISO}&endDateTime=${toISO}`
    + '&$select=id,subject,bodyPreview,location,start,end,isAllDay,organizer,attendees,onlineMeeting,showAs,isCancelled'
    + '&$orderby=start/dateTime&$top=200';

  const res = await vendorFetch('outlook', url, {
    headers: {
      authorization: `Bearer ${await token()}`,
      // Without this Graph returns times in UTC with no zone, and a 3pm meeting
      // in Mumbai renders at 9:30am.
      Prefer: 'outlook.timezone="India Standard Time"',
    },
  });

  const json = await res.json();
  const rows = json.value ?? [];

  return {
    simulated: false,
    events: rows.map((e) => ({
      external_id: e.id,
      etag: e['@odata.etag'] ?? null,
      subject: e.subject || '(no subject)',
      body_preview: e.bodyPreview ?? null,
      location: e.location?.displayName ?? null,
      starts_at: String(e.start?.dateTime ?? '').slice(0, 19).replace('T', ' '),
      ends_at: String(e.end?.dateTime ?? '').slice(0, 19).replace('T', ' '),
      all_day: e.isAllDay ? 1 : 0,
      organiser: e.organizer?.emailAddress?.name ?? null,
      attendees: JSON.stringify((e.attendees ?? []).map((a) => ({
        name: a.emailAddress?.name ?? null,
        email: a.emailAddress?.address ?? null,
        response: a.status?.response ?? 'none',
      }))),
      online_url: e.onlineMeeting?.joinUrl ?? null,
      status: e.isCancelled ? 'cancelled' : 'confirmed',
    })).filter((e) => e.starts_at),
  };
}
