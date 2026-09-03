/**
 * Calendar.
 *
 * One timeline, two sources, and they are not the same kind of thing:
 *
 *   Outlook meetings   somebody else's system of record, cached here and shown
 *                      read-only. The CRM does not get to move your diary.
 *   CRM due work       callbacks, tasks and SLA deadlines, which live in their
 *                      own tables and are unioned at read time rather than
 *                      copied in — the same rule as the client timeline.
 *
 * Keeping them visually distinct matters. An RM looking at Thursday needs to
 * know which entries other people can see and which are only a promise the CRM
 * is holding them to.
 */

import { Router } from 'express';
import { all, one, run } from '../db.js';
import { requireUser, leadScope, activeOrg } from '../auth.js';
import * as outlook from '../vendors/outlook.js';
import { outlook as cfg } from '../vendors/config.js';
import { wrap } from '../asyncroute.js';

const router = Router();
router.use(requireUser);

const iso = (d) => d.toISOString().slice(0, 19);
const day = (d) => d.toISOString().slice(0, 10);

/**
 * Pull this user's Outlook window into the cache.
 *
 * Upsert on (provider, external_id) so a meeting that moves updates in place
 * rather than appearing twice. Anything in the window that Graph no longer
 * reports is marked cancelled rather than deleted — a meeting that vanished is
 * information, and silently removing it leaves an RM wondering whether they
 * imagined it.
 */
export async function syncOutlook(user, days = cfg.windowDays) {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + days * 864e5);

  const { events, simulated } = await outlook.eventsFor(user, `${iso(from)}Z`, `${iso(to)}Z`);
  const seen = new Set();

  for (const e of events) {
    seen.add(e.external_id);

    /**
     * Match the meeting to a lead by attendee address, never by subject.
     * "Call with Sharma" matches four clients; an email address matches one.
     */
    let leadId = null;
    try {
      for (const a of JSON.parse(e.attendees || '[]')) {
        if (!a.email) continue;
        const hit = one('SELECT id FROM leads WHERE email = ? AND deleted_at IS NULL', [a.email]);
        if (hit) { leadId = hit.id; break; }
      }
    } catch { leadId = null; }

    run(
      `INSERT INTO calendar_events
         (provider, external_id, etag, user_id, subject, body_preview, location,
          starts_at, ends_at, all_day, organiser, attendees, online_url, status,
          lead_id, cancelled_at, last_synced_at)
       VALUES ('outlook',?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,datetime('now'))
       ON CONFLICT(provider, external_id) DO UPDATE SET
         etag = excluded.etag, subject = excluded.subject,
         body_preview = excluded.body_preview, location = excluded.location,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         all_day = excluded.all_day, organiser = excluded.organiser,
         attendees = excluded.attendees, online_url = excluded.online_url,
         status = excluded.status, lead_id = excluded.lead_id,
         cancelled_at = NULL, last_synced_at = datetime('now')`,
      [e.external_id, e.etag, user.id, e.subject, e.body_preview, e.location,
        e.starts_at, e.ends_at, e.all_day, e.organiser, e.attendees,
        e.online_url, e.status, leadId],
    );
  }

  const stale = all(
    `SELECT external_id FROM calendar_events
      WHERE user_id = ? AND provider = 'outlook' AND cancelled_at IS NULL
        AND starts_at >= ? AND starts_at < ?`,
    [user.id, `${day(from)} 00:00:00`, `${day(to)} 00:00:00`],
  ).filter((r) => !seen.has(r.external_id));

  for (const r of stale) {
    run("UPDATE calendar_events SET cancelled_at = datetime('now') WHERE provider = 'outlook' AND external_id = ?",
      [r.external_id]);
  }

  return { pulled: events.length, withdrawn: stale.length, simulated };
}

/* ----------------------------------------------------------------- read */

router.get('/', wrap(async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
    const from = new Date(req.query.from ? `${req.query.from}T00:00:00Z` : Date.now());
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + days * 864e5);

    // Refresh on read when the cache has gone cold. A calendar that is a day
    // behind is worse than a slow one.
    let sync = null;
    const freshest = one(
      "SELECT MAX(last_synced_at) t FROM calendar_events WHERE user_id = ? AND provider = 'outlook'",
      [req.user.id],
    ).t;
    const cold = !freshest || (Date.now() - new Date(`${freshest}Z`).getTime()) > 10 * 60_000;
    if (cold) {
      try { sync = await syncOutlook(req.user); }
      catch (e) { sync = { error: e.message }; }
    }

    const meetings = all(
      `SELECT ce.*, l.name AS lead_name
         FROM calendar_events ce
         LEFT JOIN leads l ON l.id = ce.lead_id
        WHERE ce.user_id = ? AND ce.starts_at >= ? AND ce.starts_at < ?
        ORDER BY ce.starts_at`,
      [req.user.id, `${day(from)} 00:00:00`, `${day(to)} 00:00:00`],
    ).map((m) => {
      let attendees = [];
      try { attendees = JSON.parse(m.attendees || '[]'); } catch { attendees = []; }
      return { ...m, attendees, kind: 'meeting', cancelled: Boolean(m.cancelled_at) };
    });

    const scope = leadScope(req.user, 'l', activeOrg(req));

    const tasks = all(
      `SELECT t.id, t.title, t.due_at, t.priority, t.status, t.lead_id, l.name AS lead_name
         FROM tasks t
         LEFT JOIN leads l ON l.id = t.lead_id
        WHERE t.assignee_id = ? AND t.status = 'Open'
          AND t.due_at >= ? AND t.due_at < ?
        ORDER BY t.due_at`,
      [req.user.id, `${day(from)} 00:00:00`, `${day(to)} 00:00:00`],
    ).map((t) => ({ ...t, kind: 'task', starts_at: t.due_at }));

    const callbacks = all(
      `SELECT l.id AS lead_id, l.name AS lead_name, l.callback_at
         FROM leads l
        WHERE l.deleted_at IS NULL AND ${scope.sql}
          AND l.callback_at IS NOT NULL
          AND l.callback_at >= ? AND l.callback_at < ?
        ORDER BY l.callback_at`,
      [...scope.params, `${day(from)} 00:00:00`, `${day(to)} 00:00:00`],
    ).map((c) => ({
      kind: 'callback',
      lead_id: c.lead_id,
      lead_name: c.lead_name,
      starts_at: c.callback_at,
      title: `Call back ${c.lead_name}`,
    }));

    /* Grouped by day on the server, because every client would otherwise do the
       same bucketing and one of them would get the timezone wrong. */
    const byDay = new Map();
    for (const item of [...meetings, ...tasks, ...callbacks]) {
      const d = String(item.starts_at).slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(item);
    }

    const dayList = [];
    for (let d = new Date(from); d < to; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = day(d);
      dayList.push({
        date: key,
        items: (byDay.get(key) ?? []).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at))),
      });
    }

    res.json({
      from: day(from),
      to: day(new Date(to.getTime() - 864e5)),
      days: dayList,
      source: outlook.status(),
      synced_at: freshest ?? null,
      sync,
      counts: {
        meetings: meetings.filter((m) => !m.cancelled).length,
        tasks: tasks.length,
        callbacks: callbacks.length,
      },
    });
  } catch (err) { next(err); }
}));

/** Pull now, for the Refresh button. */
router.post('/sync', wrap(async (req, res, next) => {
  try { res.json(await syncOutlook(req.user)); }
  catch (err) { next(err); }
}));

export default router;
