/**
 * The firm's nomination obligations, from SEBI's circular of 29 May 2026
 * (SEBI/HO/OIAE/OIAE_IAD-3/P/CIR/2026/12676, in force from 1 Sep 2026).
 * Ritesh, 15 Oct: build them in the CRM.
 *
 *   9.3   an acknowledgement to the investor for every nomination or change
 *         -- an opt-out included -- sent here by SMS and email, with a
 *         reference;
 *   10.1  the holding statement prints the nominees' names, or only whether
 *         a nomination was made, as the investor chose -- the CRM does not
 *         print statements, so it says what the line is, for the back office
 *         that does;
 *   10.2  every account without a nomination, opt-outs included, is nudged
 *         twice a year by SMS and email, and shown a pop-up on its first
 *         log-in of the day -- the platform the client logs into asks the CRM
 *         whether to show it. Neither reaches an account with a nomination.
 *   11    all of it applies to existing accounts too.
 *
 * A nomination is never edited. Each one -- made in an application or
 * recorded from a form in the CRM -- is its own row, and the one in force is
 * the latest not superseded. An account migrated with only a nominee's name
 * has a nomination: the circular keeps existing nominations valid.
 */

import { all, one, run, audit, SALES_ORGS } from '../db.js';
import { encryptField, decryptField } from '../security.js';
import { send } from '../integrations.js';
import { policy } from './policies.js';

const BUSINESS = (org) => one('SELECT name, support_phone, support_email FROM sales_orgs WHERE code = ?', [org])
  ?? { name: org === 'BIGUL' ? 'Bigul' : 'Bonanza', support_phone: null, support_email: null };

/** The day and the half-year in India. */
export const istDay = (now = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
export const halfYear = (now = new Date()) => {
  const d = istDay(now);
  return `${d.slice(0, 4)}-H${Number(d.slice(5, 7)) <= 6 ? 1 : 2}`;
};

const readNominees = (row) => {
  if (!row?.nominees) return [];
  try { return JSON.parse(decryptField(row.nominees)) ?? []; } catch { return []; }
};

/* ------------------------------------------------------------- 9.3 */

/**
 * Tell the investor their nomination was recorded: an SMS and an email, with
 * a reference they can quote. The count and the date, never the nominees'
 * names -- a message can be read by whoever holds the phone.
 */
function acknowledge(row, { mobile, email, name }) {
  const brand = BUSINESS(row.sales_org);
  const ref = `NOM-${row.sales_org === 'BIGUL' ? 'G' : 'B'}-${String(row.id).padStart(6, '0')}`;
  const when = new Date(`${row.recorded_at.replace(' ', 'T')}Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const what = row.kind === 'opted_out'
    ? 'your choice not to nominate anyone'
    : `your nomination of ${row.nominee_count} nominee${row.nominee_count === 1 ? '' : 's'}`;
  const help = brand.support_phone ? ` If you did not ask for this, call ${brand.support_phone}.` : '';
  const body = `${brand.name}: we have recorded ${what} on ${when}. Reference ${ref}.${help}`;

  const channels = [];
  if (mobile) { send('sms', { to: mobile, body }); channels.push('sms'); }
  if (email) {
    send('email', {
      to: email,
      subject: `${brand.name}: your nomination is recorded (${ref})`,
      body: `Dear ${name || 'investor'},\n\n${body}\n\nYou can change or cancel your nomination at any time.`,
    });
    channels.push('email');
  }
  run("UPDATE nominations SET ack_ref = ?, ack_sent_at = datetime('now'), ack_channels = ? WHERE id = ?",
    [ref, channels.join(',') || null, row.id]);
  return { ack_ref: ref, ack_channels: channels };
}

/**
 * Record a nomination, a change or an opt-out, supersede the one before it,
 * and acknowledge it.
 *
 * `nominees` is the list as validateNominees normalised it. For a client the
 * old nominee_name column is kept in step, so every screen and export that
 * reads it still tells the truth.
 */
export function recordNomination({
  clientId = null, journeyId = null, org, kind, nominees = [], statementShows = null,
  mode, source, evidence = null, userId = null, contact = {},
}) {
  const list = kind === 'nominated' ? nominees : [];
  const scope = clientId ? ['client_id = ?', clientId] : ['journey_id = ?', journeyId];
  run(`UPDATE nominations SET superseded_at = datetime('now') WHERE ${scope[0]} AND superseded_at IS NULL`, [scope[1]]);
  const id = Number(run(
    `INSERT INTO nominations (client_id, journey_id, sales_org, kind, nominees, nominee_count, statement_shows, mode, source, evidence, recorded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [clientId, journeyId, org, kind, list.length ? encryptField(JSON.stringify(list)) : null, list.length,
      kind === 'nominated' ? statementShows : null, mode, source, evidence, userId],
  ).lastInsertRowid);
  if (clientId) {
    run("UPDATE clients SET nominee_name = ?, updated_at = datetime('now') WHERE id = ?",
      [list.length ? list.map((n) => n.name).join(', ') : null, clientId]);
  }
  const row = one('SELECT * FROM nominations WHERE id = ?', [id]);
  const ack = acknowledge(row, contact);
  audit(userId, 'nomination_recorded', clientId ? 'client' : 'kyc_journey', clientId ?? journeyId,
    { kind, nominees: list.length, ack_ref: ack.ack_ref, source });
  return { ...one('SELECT * FROM nominations WHERE id = ?', [id]), ...ack };
}

/**
 * When an account opens, the nomination its application made becomes the
 * account's. Carried, not re-made: it was acknowledged when it was given.
 */
export function carryToClient(leadId, clientId) {
  if (one('SELECT id FROM nominations WHERE client_id = ?', [clientId])) return null;
  const made = one(
    `SELECT n.* FROM nominations n JOIN kyc_journeys j ON j.id = n.journey_id
      WHERE j.lead_id = ? AND n.superseded_at IS NULL ORDER BY n.id DESC LIMIT 1`,
    [leadId],
  );
  if (!made) return null;
  const id = Number(run(
    `INSERT INTO nominations (client_id, sales_org, kind, nominees, nominee_count, statement_shows, mode, source, evidence,
                              recorded_by, recorded_at, ack_ref, ack_sent_at, ack_channels)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [clientId, made.sales_org, made.kind, made.nominees, made.nominee_count, made.statement_shows, made.mode,
      made.source, `Made in application ${made.journey_id}`, made.recorded_by, made.recorded_at, made.ack_ref,
      made.ack_sent_at, made.ack_channels],
  ).lastInsertRowid);
  const names = readNominees(made).map((n) => n.name).join(', ');
  run('UPDATE clients SET nominee_name = ? WHERE id = ?', [names || null, clientId]);
  return id;
}

/* ------------------------------------------------------------- 10.1 */

/**
 * Where an account stands, and the line its holding statement prints.
 *
 * `legacy` is an account that came with only a nominee's name: a nomination
 * that stays valid, with no recorded choice of what the statement shows, so
 * the statement says only that there is one rather than printing names
 * nobody chose to print.
 */
export function nominationStatus(client) {
  const current = one(
    'SELECT * FROM nominations WHERE client_id = ? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1', [client.id],
  );
  if (current) {
    const nominees = readNominees(current);
    const nominated = current.kind === 'nominated';
    return {
      state: current.kind,
      current,
      nominees,
      statement_line: !nominated ? 'Nomination: No'
        : current.statement_shows === 'names' ? `Nominee${nominees.length === 1 ? '' : 's'}: ${nominees.map((n) => n.name).join(', ')}`
          : 'Nomination: Yes',
    };
  }
  if (String(client.nominee_name ?? '').trim()) {
    return { state: 'legacy', current: null, nominees: [{ name: client.nominee_name }], statement_line: 'Nomination: Yes' };
  }
  return { state: 'none', current: null, nominees: [], statement_line: 'Nomination: No' };
}

/** The same answer as nominationStatus's state, as SQL, for a list or a sweep. */
/* 'none' last, never NULL: `NOT (NULL = 'nominated')` is NULL, which a WHERE
   reads as false -- and an account with no nomination at all would never be
   reminded. */
export const hasNominationSql = (alias = 'c') => `(
  COALESCE((SELECT n.kind FROM nominations n WHERE n.client_id = ${alias}.id AND n.superseded_at IS NULL ORDER BY n.id DESC LIMIT 1),
           CASE WHEN TRIM(COALESCE(${alias}.nominee_name, '')) <> '' THEN 'nominated' END,
           'none') = 'nominated')`;

/** The statement line (10.1) as SQL, for the client list and export. Matches nominationStatus. */
export const statementLineSql = (alias = 'c') => `COALESCE(
  (SELECT CASE
     WHEN n.kind = 'nominated' AND n.statement_shows = 'names'
       THEN CASE WHEN n.nominee_count = 1 THEN 'Nominee: ' ELSE 'Nominees: ' END || COALESCE(${alias}.nominee_name, '')
     WHEN n.kind = 'nominated' THEN 'Nomination: Yes'
     ELSE 'Nomination: No' END
     FROM nominations n WHERE n.client_id = ${alias}.id AND n.superseded_at IS NULL ORDER BY n.id DESC LIMIT 1),
  CASE WHEN TRIM(COALESCE(${alias}.nominee_name, '')) <> '' THEN 'Nomination: Yes' ELSE 'Nomination: No' END)`;

export const historyFor = (clientId) => all(
  `SELECT n.id, n.kind, n.nominee_count, n.statement_shows, n.mode, n.source, n.evidence, n.recorded_at,
          n.ack_ref, n.ack_sent_at, n.ack_channels, n.superseded_at, u.name AS recorded_by_name
     FROM nominations n LEFT JOIN users u ON u.id = n.recorded_by
    WHERE n.client_id = ? ORDER BY n.id DESC`,
  [clientId],
);

/* ------------------------------------------------------------- 10.2 */

/**
 * The twice-yearly nudge. Every open account without a nomination -- an
 * opt-out included -- gets one SMS and one email each half-year, and no
 * more; one with a nomination gets none (the proviso to 10.2). Recorded on
 * the account, not on its lead's timeline: it is a notice the regulation
 * requires, not a conversation, and counting it as contact would make every
 * such account look worked.
 */
export function sweepNominationNudges({ now = new Date(), limit = 500 } = {}) {
  const period = halfYear(now);
  /* Only the businesses whose switch is on (Setup -> Business policies, off
     by default, Ritesh 15 Oct). An account of a business switched off is not
     marked as reminded either, so turning it on reminds it that half-year. */
  const books = SALES_ORGS.filter((org) => policy(`nomination_reminders.${org}`));
  if (!books.length) return { period, sent: 0, books };
  const due = all(
    `SELECT c.id, c.name, c.mobile, c.email, c.sales_org FROM clients c
      WHERE c.deleted_at IS NULL AND c.status <> 'Closed'
        AND c.sales_org IN (${books.map(() => '?').join(',')})
        AND NOT ${hasNominationSql('c')}
        AND NOT EXISTS (SELECT 1 FROM nomination_nudges x WHERE x.client_id = c.id AND x.period = ?)
      ORDER BY c.id LIMIT ?`,
    [...books, period, limit],
  );
  for (const c of due) {
    const brand = BUSINESS(c.sales_org);
    const body = `${brand.name}: your account has no nominee. A nominee lets your family receive your holdings quickly, `
      + `without court papers. Add one any time${brand.support_phone ? ` — call ${brand.support_phone}` : ''}.`;
    const channels = [];
    if (c.mobile) { send('sms', { to: c.mobile, body }); channels.push('sms'); }
    if (c.email) {
      send('email', {
        to: c.email,
        subject: `${brand.name}: add a nominee to your account`,
        body: `Dear ${c.name},\n\n${body}\n\nWithout a nomination, your legal heirs may need further documents, and holdings left unclaimed may go to the Investor Education and Protection Fund.`,
      });
      channels.push('email');
    }
    run('INSERT INTO nomination_nudges (client_id, period, channels) VALUES (?,?,?)', [c.id, period, channels.join(',') || null]);
  }
  return { period, sent: due.length, books };
}

/**
 * The first-log-in-of-the-day pop-up. The client's platform asks on each
 * log-in; the answer is yes once a day, for an account without a
 * nomination, and remembered so the next log-in that day is not asked again.
 */
export function nominationPrompt(client, { now = new Date() } = {}) {
  const status = nominationStatus(client);
  const needs = status.state === 'none' || status.state === 'opted_out';
  if (!needs) return { show: false, reason: 'has a nomination' };
  const day = istDay(now);
  const shown = run('INSERT OR IGNORE INTO nomination_prompts (client_id, day) VALUES (?,?)', [client.id, day]).changes;
  if (!shown) return { show: false, reason: 'already shown today' };
  return {
    show: true,
    title: 'Add a nominee',
    message: 'A nominee lets your family receive your holdings quickly, without court papers. '
      + 'Without one, holdings left unclaimed may go to the Investor Education and Protection Fund. You can add one at any time.',
  };
}
