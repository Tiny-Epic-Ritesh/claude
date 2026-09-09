/**
 * Meta's other three capabilities: ads, audiences, and DMs (P3-18).
 *
 * The routes for all three existed and none of them had a screen, which meant
 * publishing an ad campaign left no record that a CRM button had committed a
 * budget, a Custom Audience push left only an audit line for the one capability
 * that breaks this firm's own data-residency rule, and Messenger messages were
 * dropped entirely. This module is the bookkeeping the screens read.
 *
 * WHY THE DMs WERE BEING DROPPED
 *
 * `recordMetaMessage` looked the sender up with
 *
 *     SELECT id FROM leads WHERE external_id = ?   -- msg.from
 *
 * and `leads.external_id` holds a Meta *leadgen* id. A page-scoped sender id is
 * never equal to one, so the lookup failed every time and the message was
 * discarded — a connector reporting zero messages forever, which reads exactly
 * like nobody having messaged.
 *
 * There is no automatic fix, because Meta does not give a phone number or an
 * email with a DM: a page-scoped id identifies nobody on its own, and that is
 * deliberate on Meta's part. So messages are kept whether or not we know who
 * sent them, and `meta_contact` records the link a person makes by hand once
 * they recognise the conversation. Anything from that sender afterwards lands
 * on the right timeline on its own.
 */

import { all, one, run } from '../db.js';

/* ------------------------------------------------------------- ad campaigns */

/**
 * Keep what was published.
 *
 * Meta owns the campaign; this row is our record that we created it, who did,
 * and for which book. Without it there is no list to pull spend against and no
 * answer to "who started this".
 */
export function recordCampaign({ metaId, name, objective, dailyBudget, status, salesOrg, simulated, userId }) {
  run(
    `INSERT INTO meta_ad_campaign (meta_id, name, objective, daily_budget, status, sales_org, simulated, created_by)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(meta_id) DO UPDATE SET name = excluded.name, status = excluded.status`,
    [String(metaId), name, objective ?? null, dailyBudget ?? null, status ?? null,
      salesOrg, simulated ? 1 : 0, userId ?? null],
  );
  return one('SELECT * FROM meta_ad_campaign WHERE meta_id = ?', [String(metaId)]);
}

/** The campaigns this user's books have published, newest first. */
export const listCampaigns = (orgs) => all(
  `SELECT c.*, u.name AS created_by_name
     FROM meta_ad_campaign c
     LEFT JOIN users u ON u.id = c.created_by
    WHERE c.sales_org IN (${orgs.map(() => '?').join(',') || 'NULL'})
    ORDER BY c.created_at DESC`,
  orgs,
).map((c) => ({
  ...c,
  insights: (() => { try { return c.insights ? JSON.parse(c.insights) : null; } catch { return null; } })(),
}));

/** Store what Meta last said about spend and results. */
export const saveInsights = (metaId, insights) => run(
  "UPDATE meta_ad_campaign SET insights = ?, insights_at = datetime('now') WHERE meta_id = ?",
  [JSON.stringify(insights ?? {}), String(metaId)],
);

/* --------------------------------------------------------------- audiences */

/**
 * Record a push, including one that sent nothing.
 *
 * Three counts rather than one, because the gaps carry the meaning: how many
 * were on the list, how many survived the opt-out check, and how many Meta
 * said it could match. A push where those numbers diverge sharply is worth
 * somebody looking at before the next one.
 */
export const recordPush = ({ name, listId, salesOrg, considered, sent, matched, userId }) => run(
  `INSERT INTO meta_audience_push (name, list_id, sales_org, considered, sent, matched, pushed_by)
   VALUES (?,?,?,?,?,?,?)`,
  [name, listId ?? null, salesOrg ?? null, considered ?? 0, sent ?? 0,
    matched === undefined ? null : matched, userId ?? null],
);

/** Every push, so what left the country is answerable from one screen. */
export const listPushes = (orgs) => all(
  `SELECT p.*, u.name AS pushed_by_name, l.name AS list_name
     FROM meta_audience_push p
     LEFT JOIN users u ON u.id = p.pushed_by
     LEFT JOIN lead_lists l ON l.id = p.list_id
    WHERE p.sales_org IS NULL OR p.sales_org IN (${orgs.map(() => '?').join(',') || 'NULL'})
    ORDER BY p.at DESC LIMIT 50`,
  orgs,
);

/* -------------------------------------------------------------------- DMs */

/** The lead a sender is known to be, if anybody has said so. */
export const leadForPsid = (psid) => (psid
  ? one('SELECT lead_id FROM meta_contact WHERE psid = ?', [psid])?.lead_id ?? null
  : null);

/**
 * Keep a message whether or not we know who sent it.
 *
 * Returns false only for a message we already have — Meta retries, and a retry
 * is not a new message.
 */
export function saveMessage({ externalId, psid, platform, body, attachments, at }) {
  if (externalId && one('SELECT id FROM meta_message WHERE external_id = ?', [externalId])) return null;

  const leadId = leadForPsid(psid);
  run(
    `INSERT INTO meta_message (external_id, psid, platform, body, attachments, lead_id, at)
     VALUES (?,?,?,?,?,?,?)`,
    [externalId ?? null, psid ?? null, platform, body ?? '', attachments ?? 0, leadId, at],
  );

  return { id: Number(one('SELECT MAX(id) AS id FROM meta_message').id), leadId };
}

/**
 * Say who a sender is.
 *
 * The link is by sender id, not by message, so everything that person has
 * already sent and everything they send next belongs to the same lead. The
 * messages already received are attached to the timeline at the same time —
 * a link that only worked going forwards would leave the conversation that
 * prompted it stranded.
 */
export function linkSender(psid, leadId, userId) {
  run(
    `INSERT INTO meta_contact (psid, lead_id, linked_by) VALUES (?,?,?)
     ON CONFLICT(psid) DO UPDATE SET lead_id = excluded.lead_id, linked_by = excluded.linked_by,
                                     linked_at = datetime('now')`,
    [psid, leadId, userId ?? null],
  );

  /* Oldest first, with id breaking the tie: Meta's timestamp is only to the
     second, so a burst of messages would otherwise reach the timeline in an
     arbitrary order and read as a conversation nobody had. */
  const waiting = all('SELECT * FROM meta_message WHERE psid = ? AND lead_id IS NULL ORDER BY at, id', [psid]);
  for (const m of waiting) {
    run(
      `INSERT INTO activities (lead_id, type, direction, subject, body, external_id, user_id, created_at)
       VALUES (?, 'Messenger', 'inbound', ?, ?, ?, NULL, ?)`,
      [leadId, `${m.platform} message`, m.body || `(${m.attachments} attachment(s))`,
        m.external_id, m.at],
    );
  }
  run('UPDATE meta_message SET lead_id = ? WHERE psid = ? AND lead_id IS NULL', [leadId, psid]);

  return waiting.length;
}

/**
 * The conversations, unmatched ones first.
 *
 * Grouped by sender rather than listed as messages, because the job on this
 * screen is deciding who somebody is, and that is a judgement about a
 * conversation rather than about one line of it.
 */
export function conversations(limit = 30) {
  const rows = all(
    `SELECT m.psid, m.platform, m.lead_id, l.name AS lead_name,
            COUNT(*) AS messages, MAX(m.at) AS last_at,
            -- The timestamp comes from Meta to the second, and two messages in
            -- the same second is ordinary in a chat. Ordering by it alone ties
            -- and SQLite then picks either, so id breaks the tie.
            (SELECT body FROM meta_message x WHERE x.psid = m.psid
              ORDER BY x.at DESC, x.id DESC LIMIT 1) AS last_body
       FROM meta_message m
       LEFT JOIN leads l ON l.id = m.lead_id
      GROUP BY m.psid, m.platform
      ORDER BY (m.lead_id IS NOT NULL), MAX(m.at) DESC
      LIMIT ?`,
    [limit],
  );

  return {
    rows,
    unmatched: rows.filter((r) => !r.lead_id).length,
  };
}
