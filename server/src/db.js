/**
 * Bonanza CRM — schema and data-access helpers.
 *
 * One SQLite file backs all three surfaces (CRM, DKYC portal, Partner portal).
 * node:sqlite is built into Node 24, so there is no native module to compile.
 */

import { DatabaseSync } from 'node:sqlite';
import { actingActor } from './engine/reqcontext.js';
import { hashPassword } from './security.js';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'bonanza.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * Write durability.
 *
 * SQLite defaults to `synchronous = FULL`, which fsyncs on every commit. On this
 * machine that measured at **36ms per single-row write** — so every lead
 * created, every activity logged and every metric rebuilt paid a disk flush.
 *
 * WAL + NORMAL is the standard production pairing: the database is never
 * corrupted, and the only exposure is losing transactions committed since the
 * last checkpoint if the OS or the machine dies. An application crash loses
 * nothing. That is the right trade for a CRM, and it is stated here rather than
 * buried because it IS a durability decision.
 *
 * Postgres at pilot makes this moot — it is the equivalent of leaving
 * `synchronous_commit` at its default `on`.
 */
db.exec('PRAGMA synchronous = NORMAL');

/** Batch writes into one transaction. One fsync instead of N. */
export function transact(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------------------------------------------------ schema */

db.exec(`
/* ---- Identity ------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,            -- scrypt hash: scrypt$N$r$p$salt$hash
  role        TEXT NOT NULL,            -- one of the 11 CRM roles
  product_type_id INTEGER,              -- Product RM / Supervisor: which product they own
  manager_id  INTEGER REFERENCES users(id),
  phone       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ---- Configuration -------------------------------------------------- */

CREATE TABLE IF NOT EXISTS product_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  category     TEXT,                    -- Broking / Investment / Advisory / Protection
  min_investment REAL,
  lock_in      TEXT,
  risk_category TEXT,
  pitch_points TEXT,                    -- JSON array of selling points
  objections   TEXT,                    -- JSON array of {objection, response}
  brochure_url TEXT,
  apply_url    TEXT,
  requires_kyc INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ticket_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  auto_assign_role TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);

/* SLA is configured per product type + priority (BRD OD-08). */
CREATE TABLE IF NOT EXISTS sla_policies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type_id  INTEGER REFERENCES product_types(id) ON DELETE CASCADE,
  priority         TEXT NOT NULL,       -- Critical / High / Medium / Low
  response_mins    INTEGER NOT NULL,
  resolution_mins  INTEGER NOT NULL,
  UNIQUE (product_type_id, priority)
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  channel    TEXT NOT NULL,             -- whatsapp / sms / email
  subject    TEXT,
  body       TEXT NOT NULL,
  product_type_id INTEGER REFERENCES product_types(id) ON DELETE SET NULL,
  approved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,            -- PDF / Video / Link / PPT
  url         TEXT,
  product_type_id INTEGER REFERENCES product_types(id) ON DELETE SET NULL,
  kyc_step_code TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  expiry_date TEXT,
  owner_role  TEXT,                     -- BRD OD-07 category ownership
  status      TEXT NOT NULL DEFAULT 'active',
  send_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ---- Lead core ------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  mobile        TEXT,
  email         TEXT,
  pan           TEXT,
  alt_contact   TEXT,
  city          TEXT,
  state         TEXT,
  language      TEXT DEFAULT 'English',
  risk_profile  TEXT,                   -- Conservative / Moderate / Aggressive
  source        TEXT,
  stage         TEXT NOT NULL DEFAULT 'New',
  score         INTEGER NOT NULL DEFAULT 0,
  owner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  partner_id    INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  -- kyc_status used to live here. It mirrored the journey status, had four
  -- writers and every reader, and had already drifted on two of the six seeded
  -- leads that have a journey at all. It is derived now (engine/kycstatus.js)
  -- and the column is gone, so nothing can read a stale one by accident.
  -- kyc_portal_stage is added by the migration list below.
  aum           REAL DEFAULT 0,         -- nightly batch from trading DB (BRD OD-06)
  aum_as_of     TEXT,
  callback_at   TEXT,
  deleted_at    TEXT,                   -- recycle bin
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

/* A permanent card per product type per lead — never created on demand. */
CREATE TABLE IF NOT EXISTS product_cards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'INACTIVE',
  contact_flag    TEXT,                 -- Direct / No Direct / Joint Call
  product_rm_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  value           REAL DEFAULT 0,
  lost_reason     TEXT,
  last_state_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lead_id, product_type_id)
);

CREATE TABLE IF NOT EXISTS card_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    INTEGER NOT NULL REFERENCES product_cards(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ------------------------------------------------------------- clients
 *
 * A client is not a lead with a flag on it.
 *
 * The legacy tenant modelled it that way and the cost is visible in
 * docs/legacy-leadsquared/lead-fields.md: roughly forty trading and financial
 * attributes — mx_Equity_active, mx_Brokerage_Amount, mx_Ledger_Balance,
 * mx_Last_Traded_Date and the rest — hang off the Lead object, describing an
 * account that exists rather than a prospect that might. Three consequences,
 * each of which we inherit if we copy the shape:
 *
 *   1. Retention. A client record must survive years past account closure; a
 *      prospect can be erased on request. One row cannot honour both.
 *   2. Cardinality. The same PAN may enquire twice, and one enquiry may open
 *      equity and commodity, or an account on Bonanza *and* on Bigul. A status
 *      column cannot express that; a linked row can.
 *   3. Hygiene. While a converted client is still a lead row it keeps matching
 *      prospecting segments — which is how a firm mails acquisition offers to
 *      its own customers.
 *
 * Conversion fires when the account activates and the UCC exists, not when KYC
 * starts: a KYC in progress is not yet a customer.
 *
 * converted_from_lead_id is attribution, not ownership. It keeps the partner
 * and campaign that sourced the account answerable long after the lead stops
 * being worked, and it is what lets the client timeline reach back to the
 * pre-conversion conversation without copying a single activity row.
 */
CREATE TABLE IF NOT EXISTS clients (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_code     TEXT NOT NULL,          -- UCC
  name            TEXT NOT NULL,
  pan             TEXT,                   -- encrypted at rest, as on leads
  mobile          TEXT,
  email           TEXT,
  demat_id        TEXT,                   -- DP ID
  sales_org       TEXT NOT NULL DEFAULT 'BONANZA',
  owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  partner_id      INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  converted_from_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'Active',  -- Active / Dormant / Suspended / Closed
  risk_profile    TEXT,
  nominee_name    TEXT,
  activated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  first_traded_at TEXT,
  last_traded_at  TEXT,
  trades_last_year INTEGER NOT NULL DEFAULT 0,
  brokerage_ytd   REAL NOT NULL DEFAULT 0,
  ledger_balance  REAL NOT NULL DEFAULT 0,
  holding_value   REAL NOT NULL DEFAULT 0,
  margin_available REAL NOT NULL DEFAULT 0,
  closed_at       TEXT,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- A UCC is unique within a broking entity, not across the group. Bonanza and
  -- Bigul are separate registrations and may legitimately issue the same code.
  UNIQUE (client_code, sales_org)
);

/* One row per segment the client is enabled for.
 *
 * The legacy shape was a column per segment — mx_Equity_active,
 * mx_Derivatives_active, mx_FO_Currency_Active, mx_MF_active, mx_GI_active,
 * each with its own activation-date twin. Adding a segment there is a schema
 * migration and a form change. Here it is an INSERT. */
CREATE TABLE IF NOT EXISTS client_segments (
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  segment      TEXT NOT NULL,             -- Equity / Derivatives / Commodity / Currency / Mutual Fund / Global
  active       INTEGER NOT NULL DEFAULT 1,
  activated_at TEXT,
  PRIMARY KEY (client_id, segment)
);

CREATE TABLE IF NOT EXISTS activities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  card_id    INTEGER REFERENCES product_cards(id) ON DELETE CASCADE,
  partner_id INTEGER REFERENCES partners(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,             -- Call / AI Call Summary / WhatsApp / Email / SMS / Note / Ticket Event / Partner Activity / Meeting / KYC Event
  direction  TEXT,                      -- inbound / outbound / system
  subject    TEXT,
  body       TEXT,
  outcome    TEXT,
  duration_s INTEGER,
  ai_generated INTEGER NOT NULL DEFAULT 0,
  score_delta INTEGER NOT NULL DEFAULT 0,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  card_id     INTEGER REFERENCES product_cards(id) ON DELETE CASCADE,
  ticket_id   INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  partner_id  INTEGER REFERENCES partners(id) ON DELETE CASCADE,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_at      TEXT NOT NULL,
  priority    TEXT NOT NULL DEFAULT 'Normal',
  status      TEXT NOT NULL DEFAULT 'Open',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Notes are a shared threaded message list — no private notes (BRD §9). */
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  partner_id  INTEGER REFERENCES partners(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  mentions    TEXT,                     -- JSON array of user ids
  pinned      INTEGER NOT NULL DEFAULT 0,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ---- Tickets -------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref            TEXT UNIQUE,
  subject        TEXT NOT NULL,
  description    TEXT,
  priority       TEXT NOT NULL DEFAULT 'Medium',
  category_id    INTEGER REFERENCES ticket_categories(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'Open',
  channel        TEXT DEFAULT 'CRM',    -- CRM / WhatsApp / Email / Chat / Phone / Portal
  lead_id        INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  card_id        INTEGER REFERENCES product_cards(id) ON DELETE SET NULL,
  partner_id     INTEGER REFERENCES partners(id) ON DELETE CASCADE,
  assignee_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ai_summary     TEXT,
  response_due   TEXT,
  resolution_due TEXT,
  first_response_at TEXT,
  resolved_at    TEXT,
  closed_at      TEXT,
  sla_paused_at  TEXT,                  -- set when status = Waiting on Client
  sla_paused_ms  INTEGER NOT NULL DEFAULT 0,
  breached       INTEGER NOT NULL DEFAULT 0,
  merged_into    INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  csat           INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'agent',  -- agent / client / partner / system
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  internal   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ---- Partners ------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS partners (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_code    TEXT UNIQUE,
  name            TEXT NOT NULL,
  business_name   TEXT,
  partner_model   TEXT,                 -- Remisier / Agent / Trainee Entrepreneur / Associate / Authorised Person
  state_code      TEXT NOT NULL DEFAULT 'PROSPECT',
  mobile          TEXT,
  email           TEXT,
  city            TEXT,
  state           TEXT,
  pan             TEXT,
  sebi_reg_no     TEXT,
  language        TEXT DEFAULT 'English',
  bank_account    TEXT,
  bank_ifsc       TEXT,
  owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- Partner RM
  commission_pct  REAL DEFAULT 0,
  portal_password TEXT,                 -- partner portal login (separate surface)
  onboarded_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partner_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id  INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending / active / done
  completed_at TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS partner_lms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id  INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  module      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'Not Started',
  score       INTEGER,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS commissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id  INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  product_type_id INTEGER REFERENCES product_types(id) ON DELETE SET NULL,
  period      TEXT NOT NULL,            -- YYYY-MM
  gross       REAL NOT NULL DEFAULT 0,
  payout      REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'Accrued',  -- Accrued / Approved / Paid
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ---- KYC ------------------------------------------------------------ */

/* Compliance-managed master catalogue (BRD §7.6). */
CREATE TABLE IF NOT EXISTS kyc_steps_master (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  description TEXT,
  owner_type  TEXT NOT NULL DEFAULT 'Lead',   -- Lead / RM / System
  default_timer_s INTEGER NOT NULL DEFAULT 180,
  input_schema TEXT,                    -- JSON: fields the DKYC portal renders
  sort_order  INTEGER NOT NULL DEFAULT 0
);

/* Journey Composer output: which steps apply to which product type. */
CREATE TABLE IF NOT EXISTS kyc_journey_steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  step_code       TEXT NOT NULL REFERENCES kyc_steps_master(code),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  timer_override_s INTEGER,
  conditional_on  TEXT,                 -- e.g. income_gt_10L | segment_fno
  UNIQUE (product_type_id, step_code)
);

/* One journey per lead per product. Drives both the DKYC portal and the CRM rail. */
CREATE TABLE IF NOT EXISTS kyc_journeys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  card_id         INTEGER REFERENCES product_cards(id) ON DELETE CASCADE,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id),
  applicant_mobile TEXT,
  applicant_email TEXT,
  resume_token    TEXT UNIQUE,          -- lets the applicant resume the DKYC journey
  status          TEXT NOT NULL DEFAULT 'Not Started', -- Not Started / In Progress / Stalled / Abandoned / Complete
  current_step    TEXT,
  segments        TEXT,                 -- JSON: chosen trading segments
  form_data       TEXT,                 -- JSON: everything captured so far
  started_at      TEXT,
  completed_at    TEXT,
  abandoned_at    TEXT,
  stalled_at      TEXT,
  elapsed_s       INTEGER NOT NULL DEFAULT 0,
  assisted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kyc_journey_progress (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id  INTEGER NOT NULL REFERENCES kyc_journeys(id) ON DELETE CASCADE,
  step_code   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending / active / done / stalled / skipped
  entered_at  TEXT,
  completed_at TEXT,
  seconds_on_step INTEGER NOT NULL DEFAULT 0,
  payload     TEXT,                     -- JSON captured for this step
  UNIQUE (journey_id, step_code)
);

/* ---- Automation, lists, audit --------------------------------------- */

CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  conditions  TEXT NOT NULL,            -- JSON [{field, op, value, join}]
  actions     TEXT NOT NULL,            -- JSON [{type, params}]
  schedule    TEXT,                     -- JSON {mode, delay_h, business_hours, skip_weekends}
  enabled     INTEGER NOT NULL DEFAULT 0,
  priority    INTEGER NOT NULL DEFAULT 100,
  fire_count  INTEGER NOT NULL DEFAULT 0,
  last_fired  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rule_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  lead_id    INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  dry_run    INTEGER NOT NULL DEFAULT 0,
  matched    INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'static',   -- static / dynamic / newsletter
  criteria    TEXT,                     -- JSON filter for dynamic lists
  owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  shared_with TEXT,                     -- JSON array of role names or user ids
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_list_members (
  list_id INTEGER NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, lead_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  channel     TEXT NOT NULL,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  list_id     INTEGER REFERENCES lead_lists(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'Draft',
  sent        INTEGER NOT NULL DEFAULT 0,
  opened      INTEGER NOT NULL DEFAULT 0,
  clicked     INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/**
 * Dialler campaigns — the queues CUBE knows about.
 *
 * DELIBERATELY NOT THE campaigns TABLE ABOVE. That one is a marketing send:
 * a template, a list, and open/click counts. This one is a CUBE queue
 * identifier that a call is placed into. They share an English word and
 * nothing else, and merging them would be exactly the one-name-two-meanings
 * mistake the legacy audit spent ten findings on.
 *
 * They exist as rows because CUBE has no endpoint that lists its campaigns —
 * the values cannot be discovered, only configured. Without this table the
 * whole product shares the single campaign in an environment variable, which
 * makes the cross-campaign requirement (P2-04a) unbuildable: a call carries a
 * campaign per request precisely so different desks can use different queues.
 */
CREATE TABLE IF NOT EXISTS dialler_campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The CampaignId string as CUBE knows it. Not our label, and not editable
  -- once calls have been placed against it.
  cube_campaign_id TEXT NOT NULL,
  label           TEXT NOT NULL,
  -- Which book it serves. A Bigul desk must not dial from a Bonanza queue.
  sales_org       TEXT NOT NULL DEFAULT 'BONANZA',
  -- Optional: the desk/product this queue is for. NULL means it serves the
  -- whole book, which is what is_default then picks.
  product_type_id INTEGER REFERENCES product_types(id) ON DELETE SET NULL,
  is_default      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cube_campaign_id, sales_org)
);

/*
 * Validation rules — a save the business refuses.
 *
 * The condition describes what is WRONG, and the save is refused when it
 * matches. "Refuse when stage is Won and PAN is blank" rather than "require PAN
 * when stage is Won": both say the same thing, and the first is the one that
 * reads correctly off the screen without being inverted in your head.
 *
 * message is not optional and is not generated. A refusal that says
 * "validation failed on rule 7" tells the person saving nothing they can act
 * on, and the rule's author is the only one who knows what they meant.
 *
 * sales_org NULL means the rule applies to both books. A rule scoped to one is
 * how Bigul gets a requirement Bonanza does not have without either of them
 * getting a second copy of the object.
 */
CREATE TABLE IF NOT EXISTS validation_rule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  -- { all: [ { field, op, value } ] } or { any: [...] }. One level, no nesting.
  condition   TEXT NOT NULL,
  -- What the person saving reads when it fires.
  message     TEXT NOT NULL,
  sales_org   TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_validation_entity ON validation_rule (entity, active);

/*
 * Integration log — every call out to a vendor, and every callback in.
 *
 * This replaces an in-memory array capped at 200 entries. Everything the
 * product had ever sent vanished on restart, which made "show me the telephony
 * logs" (P2-15a) unanswerable at exactly the moment it is asked: after
 * something went wrong and the process was bounced.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Bodies. A WhatsApp message is the client's own words, a call payload carries
 * their mobile, a KYC callback carries their PAN. The log records that a thing
 * happened, to which record, through which vendor, and whether it worked —
 * never what was said. A log that quietly becomes a second copy of the client
 * database is a breach waiting for someone to grant read access to support.
 *
 * reference is the vendor's own id where there is one — a callID, a message
 * id — because that is what a vendor asks for when you telephone them about a
 * failure, and hunting for it afterwards is the whole problem.
 */
CREATE TABLE IF NOT EXISTS integration_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- telephony | whatsapp | email | sms | webhook | payment | kyc | api | autodialler
  kind        TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'out',   -- out = we called them, in = they called us
  vendor      TEXT,
  endpoint    TEXT,
  status      TEXT NOT NULL DEFAULT 'ok',    -- ok | failed | refused | queued | simulated
  http_status INTEGER,
  duration_ms INTEGER,
  simulated   INTEGER NOT NULL DEFAULT 0,
  -- What it was about, so a failure can be traced back to a person.
  lead_id     INTEGER,
  partner_id  INTEGER,
  user_id     INTEGER,
  sales_org   TEXT,
  reference   TEXT,
  -- One line, safe to read: "Click2Call placed", "refused: number is on DND".
  summary     TEXT,
  error       TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_intlog_kind ON integration_log (kind, at DESC);
CREATE INDEX IF NOT EXISTS idx_intlog_lead ON integration_log (lead_id, at DESC);

/*
 * How long each kind of log is kept.
 *
 * Configuration rather than constants, so Compliance can set the real number
 * without a deploy and the number they set is visible and auditable. The
 * seeded values are recommendations, not law — the payment period in
 * particular is an assumption from general practice and is flagged for
 * Compliance to confirm.
 */
CREATE TABLE IF NOT EXISTS log_retention (
  kind        TEXT PRIMARY KEY,
  days        INTEGER NOT NULL,
  note        TEXT,
  updated_at  TEXT,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

/*
 * API credentials (P2-02).
 *
 * Each is bound to a user and authenticates AS that user, so an API caller is
 * scoped by exactly the machinery that scopes a person -- the book boundary,
 * the field masking and the capability checks all apply unchanged. A separate
 * authorization model for machines would need a second implementation of all
 * three, and the second one is the one that gets it wrong.
 *
 * secret_hash is SHA-256 of a 32-byte random secret, not scrypt. The secret is
 * high-entropy, so a work factor buys nothing against an offline attack and
 * costs 50-100ms on every API request. See engine/apikeys.js.
 *
 * scopes NARROW. A caller gets the intersection of this list with what its user
 * could already do, so issuing a key can never be an escalation.
 */
CREATE TABLE IF NOT EXISTS api_credential (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id       TEXT NOT NULL UNIQUE,
  secret_hash  TEXT NOT NULL,
  label        TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- JSON array of capabilities, or NULL for everything the user has.
  scopes       TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  rotated_at   TEXT,
  revoked_at   TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
 * Single-use password reset links (P2-04).
 *
 * Not emailed from the server: SMTP is configured per environment and a link
 * that silently fails to send is worse than one the administrator can see they
 * are holding. One per user at a time -- issuing a second invalidates the
 * first, so a link forwarded twice cannot be used twice.
 */
CREATE TABLE IF NOT EXISTS password_reset (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
 * One database-size sample a day, taken at start-up (P2-19).
 *
 * Growth rate needs history, and there is no history without keeping some. A
 * sample is four numbers, so a decade of them is smaller than a single lead.
 */
CREATE TABLE IF NOT EXISTS db_size_sample (
  day               TEXT PRIMARY KEY,
  total_bytes       INTEGER NOT NULL,
  reclaimable_bytes INTEGER NOT NULL DEFAULT 0,
  lead_count        INTEGER NOT NULL DEFAULT 0,
  at                TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
 * Custom dashboards (P2-17b).
 *
 * The DEFINITION is stored, never the result. That is the whole design: a
 * shared dashboard runs each viewer's own scope, so a supervisor sharing "my
 * pipeline by stage" gives every RM the same question about their own book
 * rather than a picture of the supervisor's. Storing rendered numbers would
 * turn sharing a dashboard into sharing the rows behind it.
 *
 * shared_with is a JSON array of role codes. NULL means personal -- Q-13: a rep
 * arranging their own view harms nobody, a rep publishing one to the desk is a
 * different act and needs the capability.
 */
CREATE TABLE IF NOT EXISTS custom_dashboard (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- JSON array of role codes this is published to, or NULL for personal.
  shared_with TEXT,
  sales_org   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

/*
 * One panel: a saved question.
 *
 * source + measure + group_by + filters compile to SQL in engine/panels.js.
 * Field names are checked against field_def before they reach a query, which is
 * the entire injection defence -- a grouping is a column name and cannot be a
 * bound parameter.
 */
CREATE TABLE IF NOT EXISTS dashboard_panel (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_id  INTEGER NOT NULL REFERENCES custom_dashboard(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'bar',
  -- { fn: 'count' } or { fn: 'sum', field: 'aum' }
  measure       TEXT NOT NULL DEFAULT '{\"fn\":\"count\"}',
  group_by      TEXT,
  -- 'day' | 'week' | 'month' when the panel groups by time instead of a field.
  grain         TEXT,
  -- { all: [ { field, op, value } ] }, same shape as a validation rule.
  filters       TEXT,
  use_range     INTEGER NOT NULL DEFAULT 1,
  point_limit   INTEGER NOT NULL DEFAULT 8,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_panel_dashboard ON dashboard_panel (dashboard_id, sort_order);

/*
 * Content libraries (P2-20 + P2-22 -- one screen, since /content is the
 * Marketing Hub).
 *
 * A library is a named collection owned by a role and readable by named roles.
 * Q-15: a rep arranging their own view harms nobody, but collateral is
 * different -- an out-of-date brochure quoting last year's brokerage is a
 * compliance problem, not stale content.
 *
 * requires_approval is per library rather than global. Regulatory documents
 * need a second pair of eyes; an internal battlecard does not, and forcing
 * approval on both is how approval becomes a rubber stamp.
 *
 * default_expiry_days is what stops the real failure: nobody sets an expiry,
 * and four years later the library is full of documents nobody has checked.
 * A default means the question is answered by omission rather than skipped.
 */
/*
 * Who we dialled, so an inbound result can be matched back to a person.
 *
 * CUBE's AuthCallLog does not return ClientId, though both dialling endpoints
 * accept it, so the only join from a call record back to a lead is the phone
 * number -- which is ambiguous for family accounts sharing one mobile, common
 * in Indian broking. Recording the intent at dial time makes an outbound call
 * exact instead of inferred: we know who we rang because we rang them.
 *
 * It does nothing for genuinely inbound calls. Those stay ambiguous when a
 * number matches several leads, and are reported as ambiguous rather than
 * attributed to whichever record happens to sort first.
 */
/*
 * What one person prefers, as opposed to what the firm has configured.
 *
 * Kept on the server rather than in localStorage on purpose. An administrator
 * who pins six screens on the office machine should find them pinned on the
 * laptop; a preference that lives in a browser is one the person has to set
 * again every time they move, which is how a convenience becomes an annoyance.
 *
 * Deliberately NOT where configuration goes. Nothing here changes what anybody
 * may do or see -- it is pins, density and which groups are folded shut. That
 * is why it is unaudited and why anyone may write their own without a
 * capability: a wrong value costs the person who set it a click.
 */
CREATE TABLE IF NOT EXISTS user_pref (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS call_intent (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Last 10 digits only: vendors are inconsistent about the 91 prefix.
  msisdn10    TEXT NOT NULL,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  call_id     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_call_intent_lookup ON call_intent (msisdn10, created_at);
CREATE INDEX IF NOT EXISTS idx_call_intent_callid ON call_intent (call_id);

CREATE TABLE IF NOT EXISTS content_library (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  description         TEXT,
  owner_role          TEXT NOT NULL,
  -- JSON array of role codes that may read it. NULL means every role.
  shared_with         TEXT,
  sales_org           TEXT,
  requires_approval   INTEGER NOT NULL DEFAULT 0,
  default_expiry_days INTEGER,
  active              INTEGER NOT NULL DEFAULT 1,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor      TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* In-flight work keeps the version it started under.
 *
 * An applicant who began a sixteen-step journey finishes those sixteen steps
 * even if somebody edits the definition halfway through, and a ticket keeps the
 * SLA it was raised under. The alternative -- everything follows the current
 * definition -- means an applicant can gain or lose steps mid-journey and a
 * promised deadline can move after it was promised, neither of which is
 * explainable to a client or to an auditor.
 *
 * Nullable: rows created before versioning existed have no pin, and are read as
 * "whatever is current", which is what they have always done. */
CREATE TABLE IF NOT EXISTS artefact_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  version    INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  note       TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, logical_id, version)
);

CREATE INDEX IF NOT EXISTS idx_artefact_versions_current
  ON artefact_versions(kind, logical_id, is_current);

CREATE TABLE IF NOT EXISTS request_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role        TEXT,
  sales_org   TEXT,
  partner_id  INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INTEGER NOT NULL,
  duration_ms INTEGER,
  ip          TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_request_log_at   ON request_log(at);
CREATE INDEX IF NOT EXISTS idx_request_log_user ON request_log(user_id, at);
CREATE INDEX IF NOT EXISTS idx_request_log_path ON request_log(path, at);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  partner_id   INTEGER REFERENCES partners(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'crm',   -- crm / partner
  expires_at   TEXT,                          -- absolute expiry
  last_seen_at TEXT,                          -- drives the idle timeout
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_owner   ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage   ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_cards_lead    ON product_cards(lead_id);
CREATE INDEX IF NOT EXISTS idx_cards_state   ON product_cards(state);
CREATE INDEX IF NOT EXISTS idx_cards_product ON product_cards(product_type_id);
CREATE INDEX IF NOT EXISTS idx_act_lead      ON activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_journeys_status  ON kyc_journeys(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee   ON tasks(assignee_id);
`);

/* ---------------------------------------------------------- migrations */

/**
 * Additive column migrations.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so each is guarded by a lookup and
 * ignored when already present. Additive only, by policy: a migration that drops
 * or retypes a column is a data-loss event and belongs in a reviewed script, not
 * in a function that runs on every boot.
 *
 * These columns exist because of the vendor integrations — QuickCall needs an
 * agent extension to ring, its Save Call callback returns a recording URL and a
 * call id worth de-duplicating on, and the eKYC portal attributes by shortcode.
 */
const COLUMNS = [
  ['users', 'phone_extension', 'TEXT'],        // QuickCall rings this first
  ['users', 'cti_agent_id', 'TEXT'],           // agent id as known to QuickCall
  ['users', 'kyc_shortcode', 'TEXT'],          // RM attribution on the eKYC portal
  ['partners', 'kyc_shortcode', 'TEXT'],       // partner attribution, drives commission
  ['content_items', 'created_by', 'INTEGER'],   // so the reviewer cannot be the author
  ['content_items', 'library_id', 'INTEGER'],   // which library it lives in
  ['content_items', 'submitted_at', 'TEXT'],    // when it was sent for approval
  ['content_items', 'approved_by', 'INTEGER'],  // who approved it
  ['content_items', 'approved_at', 'TEXT'],
  ['content_items', 'rejected_reason', 'TEXT'], // why it was sent back
  ['dashboard_panel', 'grain', 'TEXT'],        // group by time instead of a field
  ['dashboard_panel', 'split_by', 'TEXT'],     // a second dimension, drawn as series
  ['sessions', 'ghost_of', 'INTEGER'],         // the admin behind a ghost session
  ['request_log', 'ghost_of', 'INTEGER'],      // and who they were really
  ['request_log', 'api_credential_id', 'INTEGER'],  // which API key made the call, if any
  ['activities', 'external_id', 'TEXT'],       // vendor call/message id, for de-duplication
  ['activities', 'recording_url', 'TEXT'],     // QuickCall voice-logger file
  /* An interaction logged against the account after conversion. The lead's own
     activities stay on the lead — the client timeline unions the two rather
     than copying, per non-negotiable #1. */
  ['activities', 'client_id', 'INTEGER'],
  ['leads', 'client_code', 'TEXT'],            // UCC once the account is opened
  ['leads', 'kyc_external_ref', 'TEXT'],       // our correlation id echoed by the portal
  ['leads', 'kyc_portal_stage', 'TEXT'],       // raw stage reported by the eKYC portal

  /* Per-channel consent.
   *
   * `marketing_opt_out` alone cannot represent what the legacy tenant already
   * holds: DoNotCall, DoNotEmail, DoNotSMS and DoNotTrack are four independent
   * withdrawals, and collapsing them into one boolean either over-blocks —
   * losing contactability the client never withdrew — or under-blocks, which
   * under TRAI DND rules is the one with a penalty attached.
   *
   * `marketing_opt_out` stays as the blanket withdrawal. These narrow it. */
  ['leads', 'no_call', 'INTEGER NOT NULL DEFAULT 0'],
  ['leads', 'no_sms', 'INTEGER NOT NULL DEFAULT 0'],
  ['leads', 'no_email', 'INTEGER NOT NULL DEFAULT 0'],
  ['leads', 'no_whatsapp', 'INTEGER NOT NULL DEFAULT 0'],
  /* Provenance: when consent was last recorded and where it came from. A
   * withdrawal a regulator asks about needs a date and a source, not a flag. */
  ['leads', 'consent_updated_at', 'TEXT'],
  ['leads', 'consent_source', 'TEXT'],
  ['leads', 'wa_last_inbound_at', 'TEXT'],     // opens the WhatsApp 24-hour window

  // Sales org. Every owned record carries the business it belongs to, so one
  // database serves both Bonanza and Bigul without either seeing the other's
  // book unless the user is entitled to both.
  ["users", "sales_org", "TEXT NOT NULL DEFAULT 'BONANZA'"],
  ['users', 'org_access', 'TEXT'],             // JSON array; null means their own org only
  ['users', 'employee_code', 'TEXT'],          // ADM0001 / MUM-0447 — staff sign in by this
  ['users', 'branch', 'TEXT'],                 // Mumbai / Delhi / Bengaluru
  ['users', 'avatar_hue', 'INTEGER'],          // stable colour for the initials avatar
  ["leads", "sales_org", "TEXT NOT NULL DEFAULT 'BONANZA'"],
  ["partners", "sales_org", "TEXT NOT NULL DEFAULT 'BONANZA'"],
  ["product_types", "sales_org", "TEXT NOT NULL DEFAULT 'BONANZA'"],
  ["tickets", "sales_org", "TEXT NOT NULL DEFAULT 'BONANZA'"],
  ["campaigns", "sales_org", "TEXT NOT NULL DEFAULT 'BONANZA'"],
  ["lead_lists", "sales_org", "TEXT NOT NULL DEFAULT 'BONANZA'"],

  /* Lead Lists (BUG-25).
   *
   * `description` and `created_by` were already being written by the
   * save-a-search route and had never existed, so that endpoint answered 500
   * every time anyone used it. Adding the columns is the fix, not a feature.
   *
   * A refreshable list is only trustworthy if it says when it last ran, so
   * `last_refreshed_at` is shown on screen rather than kept for diagnostics.
   * `refresh_error` exists because a refresh that fails silently is worse
   * than one that fails loudly -- the list simply looks stale and nobody
   * knows why. */
  /* Dispositions an administrator has edited (ENH-21c).
   *
   * seedDispositions() runs on every boot and previously overwrote every
   * column from the code matrix, so anything changed in Setup would revert at
   * the next restart -- which would have made the whole screen a lie. These
   * mark a row as owned by the business, and the seeder leaves those alone. */
  ["dispositions", "edited_at", "TEXT"],
  ["dispositions", "edited_by", "INTEGER"],
  ["dispositions", "is_custom", "INTEGER NOT NULL DEFAULT 0"],
  /* A searchable fingerprint of the PAN.
   *
   * PAN is encrypted at rest, and ciphertext cannot be compared -- the same
   * PAN encrypts differently every time, so an equality search finds nothing.
   * A blind index is a deterministic keyed hash of the value: it matches
   * exactly, reveals nothing on its own, and is what makes the duplicate check
   * in the Common Client Master possible at all.
   *
   * Backfilled on boot for rows that predate it. */
  ["leads", "pan_bidx", "TEXT"],
  ["lead_lists", "description", "TEXT"],
  ["lead_lists", "created_by", "INTEGER"],
  ["lead_lists", "last_refreshed_at", "TEXT"],
  ["lead_lists", "last_refreshed_by", "INTEGER"],
  ["lead_lists", "refresh_error", "TEXT"],
  ["lead_lists", "updated_at", "TEXT"],
  ["content_items", "sales_org", "TEXT NOT NULL DEFAULT 'BONANZA'"],

  // The disposition loop. `follow_up_at` is what turns a logged call into a
  // scheduled commitment, and `follow_up_task_id` is the link back, so the
  // activity and the task it created stay connected in both directions.
  ['activities', 'disposition', 'TEXT'],
  ['activities', 'sub_disposition', 'TEXT'],
  ['activities', 'follow_up_at', 'TEXT'],
  ['activities', 'follow_up_task_id', 'INTEGER'],
  ['activities', 'meeting_at', 'TEXT'],
  ['activities', 'meeting_mode', 'TEXT'],          // Physical / Virtual / Branch
  ['activities', 'meeting_location', 'TEXT'],
  ['activities', 'reason', 'TEXT'],                // required on negative outcomes
  ['activities', 'sentiment', 'TEXT'],

  /* Where an in-person meeting was logged from (P2-01). Personal data about a
     member of staff, so: captured only for physical meetings, never mandatory,
     and cleared after twelve months by engine/geolocation.js purge(). The
     accuracy radius is stored because a 2 km cell-tower fix presented as a
     street address is evidence that will not survive being challenged.
     `geo_status` carries declined and unavailable as values in their own right
     -- a refusal is a fact worth keeping, and NULL means the question never
     arose. */
  /* Lead list governance.
   *
   * The legacy tenant reached 4,810 lists against 495,118 leads, and the audit
   * calls it "the single clearest governance failure in the tenant": somebody
   * exports a CSV, re-imports it as a static list, uses it once, and never
   * deletes it. Names like `All Active Clients 210826.csv` show it was a daily
   * habit.
   *
   * A snapshot is now an explicit, expiring, audited artefact. It has to say
   * why it is frozen, and it lapses on its own -- which is the only thing that
   * stops four thousand of them accumulating. Live queries have no expiry
   * because they cannot rot. */
  ['lead_lists', 'snapshot_reason', 'TEXT'],
  ['lead_lists', 'expires_at', 'TEXT'],
  ['lead_lists', 'archived_at', 'TEXT'],
  ['lead_lists', 'columns', 'TEXT'],

  ['activities', 'geo_status', 'TEXT'],            // captured / declined / unavailable / expired
  ['activities', 'geo_lat', 'REAL'],
  ['activities', 'geo_lng', 'REAL'],
  ['activities', 'geo_accuracy_m', 'INTEGER'],
  ['activities', 'geo_address', 'TEXT'],
  ['activities', 'geo_captured_at', 'TEXT'],

  // Routing and reachability, set by dispositions rather than typed by hand.
  ['leads', 'mobile_invalid', 'INTEGER NOT NULL DEFAULT 0'],
  ['leads', 'marketing_opt_out', 'INTEGER NOT NULL DEFAULT 0'],
  // The id the source system knows this lead by — a Meta leadgen id, a
  // Messenger sender id. Dedupes retries and matches inbound DMs back to a
  // person we already have.
  ['leads', 'external_id', 'TEXT'],
  // The other half of a polymorphic owner. Exactly one of owner_id and
  // owner_queue_id is set; two nullable keys rather than a type+ref pair so
  // referential integrity survives and existing queries keep working.
  ['leads', 'owner_queue_id', 'INTEGER REFERENCES queues(id) ON DELETE SET NULL'],
  ['leads', 'assigned_at', 'TEXT'],
  ['leads', 'assigned_by_rule', 'INTEGER'],
  ['leads', 'first_response_at', 'TEXT'],          // speed-to-first-contact
  ['leads', 'next_follow_up_at', 'TEXT'],          // denormalised for the work list

  // Tasks gain a kind so a follow-up is distinguishable from an ad-hoc to-do.
  ['tasks', 'kind', 'TEXT'],                       // follow_up / meeting / retry / manual
  ['tasks', 'activity_id', 'INTEGER'],
  ['tasks', 'auto_created', 'INTEGER NOT NULL DEFAULT 0'],
  ['tasks', 'updated_at', 'TEXT'],                 // stamped on reschedule / completion

  // Reachability for reminders sent to staff.
  ['users', 'whatsapp', 'TEXT'],

  /* Who a template belongs to, and how far it reaches (P2-09).
   *
   * A personal template is one RM's own wording and needs no approval — it is
   * their writing, sent under their name, and asking an admin to sign off on
   * "thanks, speak tomorrow" is how a template library stops being used.
   *
   * An org template is firm-wide client-facing copy. For a SEBI-regulated firm
   * that carries content obligations, so promoting one needs admin.templates
   * and only approved org templates may be used for a campaign or a bulk send.
   *
   * Null scope on rows that predate this reads as 'org', which is what the
   * seeded templates are. */
  ['templates', 'scope', "TEXT NOT NULL DEFAULT 'org'"],
  ['templates', 'owner_id', 'INTEGER'],

  /* The artefact version in-flight work started under.
   *
   * An applicant who began a sixteen-step journey finishes those sixteen steps
   * even if the definition is edited halfway through, and a ticket keeps the
   * SLA it was raised under. Letting both follow the current definition instead
   * means an applicant can gain or lose steps mid-journey and a promised
   * deadline can move after it was promised — neither explainable to a client
   * or to an auditor.
   *
   * Null on rows that predate versioning, which read as "whatever is current",
   * exactly as they always have. */
  ['kyc_journeys', 'journey_version_id', 'INTEGER'],
  ['tickets', 'sla_version_id', 'INTEGER'],
];

for (const [table, column, type] of COLUMNS) {
  const exists = db.prepare(`SELECT COUNT(*) n FROM pragma_table_info(?) WHERE name = ?`).get(table, column);
  if (!exists.n) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_activities_external ON activities(external_id);
CREATE INDEX IF NOT EXISTS idx_leads_client_code ON leads(client_code);
CREATE INDEX IF NOT EXISTS idx_leads_kyc_ref ON leads(kyc_external_ref);
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(sales_org);
CREATE INDEX IF NOT EXISTS idx_leads_pan_bidx ON leads(pan_bidx) WHERE pan_bidx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partners_org ON partners(sales_org);
CREATE INDEX IF NOT EXISTS idx_products_org ON product_types(sales_org);
CREATE INDEX IF NOT EXISTS idx_tickets_org ON tickets(sales_org);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_empcode ON users(employee_code) WHERE employee_code IS NOT NULL;

/* ------------------------------------------------------- tab visibility
 *
 * ENH-08. Which tabs a role sees, and the per-user exceptions on top.
 *
 * One table rather than two, keyed by scope: a role row is the default, a
 * user row is the override, and the override wins. Two tables would mean two
 * shapes to query, two to audit and two to keep in step.
 *
 * A row is only written when someone makes a decision -- absence means "use
 * the shipped default". That is what lets the shipped matrix change in a
 * later release without silently overwriting what an administrator chose.
 */
CREATE TABLE IF NOT EXISTS tab_visibility (
  scope_type TEXT NOT NULL,             -- 'role' | 'user'
  scope_key  TEXT NOT NULL,             -- role code, or user id as text
  tab_id     TEXT NOT NULL,
  visible    INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_type, scope_key, tab_id)
);
CREATE INDEX IF NOT EXISTS idx_tabvis_scope ON tab_visibility(scope_type, scope_key);

/* ---------------------------------------------------- calendar events
 *
 * Outlook is the calendar. This table is a CACHE of it, never the source.
 *
 * That distinction decides the whole design. The firm already runs Outlook,
 * people already accept meetings there, and a CRM that kept its own parallel
 * diary would be a second place to look and a second thing to be wrong. So
 * every row here arrives from Microsoft Graph and carries the identifiers
 * needed to recognise it again -- external_id to match, etag to know whether
 * it changed, and last_synced_at to know how stale the answer is.
 *
 * Nothing writes a meeting here that Outlook does not already know about.
 * Callbacks, tasks and SLA deadlines are CRM-native and live in their own
 * tables; the calendar view unions them at read time rather than copying them
 * in, for the same reason the client timeline does.
 */
CREATE TABLE IF NOT EXISTS calendar_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT NOT NULL DEFAULT 'outlook',
  external_id  TEXT NOT NULL,
  etag         TEXT,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  body_preview TEXT,
  location     TEXT,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT,
  all_day      INTEGER NOT NULL DEFAULT 0,
  organiser    TEXT,
  attendees    TEXT,                  -- JSON array of {name, email, response}
  online_url   TEXT,                  -- Teams join link, when there is one
  status       TEXT DEFAULT 'confirmed',
  /* Best-effort link back to a CRM record, matched on attendee address. Never
     guessed from the subject line: "Call with Sharma" matches four clients. */
  lead_id      INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  cancelled_at TEXT,
  last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_user_start ON calendar_events(user_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_lead ON calendar_events(lead_id);

/* -------------------------------------------------- KRA and incentives
 *
 * Both are configuration, not code. The numbers below ship as a working
 * example so the screens have something to show, and every one of them is
 * editable -- because what a Sales RM is measured on, and what that earns, is
 * a decision the business makes and revises, not one a developer encodes.
 *
 * A KRA metric names what is measured, the target, and how much it counts
 * toward the score. source is the key the engine uses to compute the actual
 * from live data; a metric whose source it does not recognise still shows, with
 * the actual left blank rather than silently zero. Zero and "not measured yet"
 * look identical on a scorecard and mean opposite things.
 */
CREATE TABLE IF NOT EXISTS kra_metrics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role_code  TEXT NOT NULL,
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  description TEXT,
  source     TEXT,                    -- what the engine computes it from
  unit       TEXT NOT NULL DEFAULT 'count',   -- count / rupees / percent / days
  target     REAL NOT NULL DEFAULT 0,
  weight     REAL NOT NULL DEFAULT 1,         -- share of the overall score
  direction  TEXT NOT NULL DEFAULT 'higher',  -- higher / lower is better
  period     TEXT NOT NULL DEFAULT 'month',
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  sales_org  TEXT NOT NULL DEFAULT 'BONANZA',
  edited_at  TEXT,
  edited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (role_code, code, sales_org)
);

/* An incentive plan is a set of slabs against a basis.
 *
 * Shaped on how Indian retail brokers actually pay: a share of the brokerage
 * the book generates, banded so the rate rises with production; a flat amount
 * per account activated; and a trail in basis points on assets under
 * management. Clawback exists because an account that closes inside six months
 * was never really won, and paying for it twice is how acquisition targets get
 * gamed.
 *
 * Slabs are marginal, not cliff -- each band pays its own rate on the portion
 * of production inside it. A cliff structure means one rupee of extra
 * brokerage can change the whole payout, which is both unfair and an incentive
 * to hold business back until next month.
 */
CREATE TABLE IF NOT EXISTS incentive_plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  role_code   TEXT NOT NULL,
  description TEXT,
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  effective_to   TEXT,
  clawback_months INTEGER NOT NULL DEFAULT 6,
  active      INTEGER NOT NULL DEFAULT 1,
  sales_org   TEXT NOT NULL DEFAULT 'BONANZA',
  edited_at   TEXT,
  edited_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS incentive_slabs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id   INTEGER NOT NULL REFERENCES incentive_plans(id) ON DELETE CASCADE,
  basis     TEXT NOT NULL,            -- brokerage / accounts / aum
  from_value REAL NOT NULL DEFAULT 0,
  to_value   REAL,                    -- NULL means no upper bound
  rate      REAL NOT NULL,            -- percent for brokerage, rupees for accounts, bps for aum
  rate_kind TEXT NOT NULL DEFAULT 'percent',  -- percent / flat / bps
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_slabs_plan ON incentive_slabs(plan_id, basis, from_value);

/* ------------------------------------------------------- field masking
 *
 * ENH-16. Which PII fields are obscured, for which roles.
 *
 * Distinct from pii.unmask, which is the audited act of revealing ONE record
 * to someone whose role is otherwise masked. This table decides the standing
 * state; that capability decides the exception. Both exist because "show me
 * this number" and "show me every number" should not cost the same.
 *
 * A row exists only where an administrator has decided something, so absence
 * means "use the shipped default".
 */
CREATE TABLE IF NOT EXISTS field_masking (
  role_code  TEXT NOT NULL,
  field      TEXT NOT NULL,
  masked     INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (role_code, field)
);
CREATE INDEX IF NOT EXISTS idx_clients_org ON clients(sales_org);
CREATE INDEX IF NOT EXISTS idx_clients_owner ON clients(owner_id);
CREATE INDEX IF NOT EXISTS idx_clients_code ON clients(client_code);
CREATE INDEX IF NOT EXISTS idx_clients_lead ON clients(converted_from_lead_id);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
CREATE INDEX IF NOT EXISTS idx_activities_client ON activities(client_id);
`);

/* ------------------------------------------------------- sales orgs */

/**
 * Bonanza and Bigul are two businesses on one platform.
 *
 * They are NOT separate tenants with separate databases. A single relationship
 * manager can hold leads in both and earns a combined KRA scorecard across
 * them — the scorecard already mixes "New Client — Bigul" with "Offline
 * Broking" in one total. Hard isolation would break that, so the model is a
 * shared database with `sales_org` on every owned record and scoping applied
 * at query time, exactly like the role scoping alongside it.
 *
 * The two businesses are genuinely different, which is why products, targets
 * and KRA metrics all carry the org rather than being shared:
 *
 *   BONANZA  RM-led full-service wealth — PMS, AIF, Insurance, Bonds,
 *            advisory. High-touch, HNI and Ultra-HNI.
 *   BIGUL    Self-serve digital broking — flat ₹18 brokerage, Algos, API,
 *            Stock Baskets, Global Investing. Mass retail, partner-driven.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS sales_orgs (
  code        TEXT PRIMARY KEY,          -- BONANZA / BIGUL
  name        TEXT NOT NULL,
  legal_name  TEXT,
  tagline     TEXT,
  accent      TEXT NOT NULL,             -- brand colour, drives per-org theming
  accent_dark TEXT,
  model       TEXT,                      -- 'full_service' / 'discount_digital'
  kyc_url     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
`);

const SEED_ORGS = [
  {
    code: 'BONANZA',
    name: 'Bonanza',
    legal_name: 'Bonanza Portfolio Ltd.',
    tagline: 'RM-led wealth & advisory',
    accent: '#81c141',
    accent_dark: '#5f9a2c',
    model: 'full_service',
    kyc_url: 'https://kyc.bonanzaonline.com',
    sort_order: 1,
  },
  {
    code: 'BIGUL',
    name: 'Bigul',
    legal_name: 'Bonanza Portfolio Ltd. (Bigul)',
    tagline: 'Self-serve digital broking',
    accent: '#2f6fed',
    accent_dark: '#1f52c0',
    model: 'discount_digital',
    kyc_url: 'https://kyc.bigul.co',
    sort_order: 2,
  },
];

for (const o of SEED_ORGS) {
  db.prepare(
    `INSERT INTO sales_orgs (code, name, legal_name, tagline, accent, accent_dark, model, kyc_url, sort_order)
     VALUES (@code, @name, @legal_name, @tagline, @accent, @accent_dark, @model, @kyc_url, @sort_order)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, legal_name = excluded.legal_name, tagline = excluded.tagline,
       accent = excluded.accent, accent_dark = excluded.accent_dark, model = excluded.model,
       kyc_url = excluded.kyc_url, sort_order = excluded.sort_order`,
  ).run(o);
}

/* ------------------------------------------------- sales execution */

/**
 * The activity → disposition → follow-up loop.
 *
 * This is the part of a CRM a sales desk actually lives in, and the part that
 * decides whether the pipeline is real. The shape follows how the work happens:
 *
 *   1. The RM calls. They log a PHONE CALL activity.
 *   2. They pick a disposition (Connected / Not Connected) and a
 *      sub-disposition (Pitch Done, Callback Requested, Ringing…).
 *   3. The sub-disposition decides what must happen next — and the system
 *      creates that next step rather than trusting anyone to remember it.
 *
 * Step 3 is the whole point. A follow-up date typed into a notes field is a
 * promise nobody is holding; a follow-up date that creates a dated, owned,
 * reminded task is a commitment the system can chase.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS dispositions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_type TEXT NOT NULL,           -- Call / Meeting / WhatsApp / Email / Visit
  outcome       TEXT NOT NULL,           -- Connected / Not Connected / Other
  code          TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,

  -- What this outcome obliges the RM to do next.
  next_step     TEXT,                    -- follow_up / meeting / none / retry
  follow_up_hours REAL,                  -- auto-scheduled retry offset, when fixed
  requires_datetime INTEGER NOT NULL DEFAULT 0,  -- RM must pick a date/time
  requires_reason INTEGER NOT NULL DEFAULT 0,    -- RM must say why

  -- Side effects on the record.
  sets_card_state TEXT,                  -- e.g. LOST on Not Interested
  flags_mobile_invalid INTEGER NOT NULL DEFAULT 0,
  suppress_marketing INTEGER NOT NULL DEFAULT 0,
  score_delta   INTEGER NOT NULL DEFAULT 0,

  hint          TEXT,                    -- shown under the picker in the UI
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);

/**
 * Teams are the unit automations assign to.
 *
 * A rule that names an individual breaks the moment that person is on leave,
 * so routing targets a team and a strategy decides the person. A team of one
 * is still a team, which keeps named routing in the same mechanism instead of
 * a special case beside it.
 */
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  strategy    TEXT NOT NULL DEFAULT 'round_robin',  -- round_robin / least_loaded / named
  manager_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Where round-robin got to last time, so rotation survives a restart.
  rr_cursor   INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  sales_org   TEXT NOT NULL DEFAULT 'BONANZA',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- An RM on leave stays in the team but stops receiving new work.
  accepting INTEGER NOT NULL DEFAULT 1,
  weight    INTEGER NOT NULL DEFAULT 1,      -- round-robin share
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, user_id)
);

/**
 * Assignment rules — "leads from Facebook Lead Ads go to the Digital desk".
 *
 * Separate from the general automation rules because routing has to be
 * synchronous. A lead that sits unowned for five minutes while a sweep catches
 * up is five minutes of a prospect waiting, and speed-to-first-call is the
 * single strongest predictor of conversion on an inbound enquiry.
 */
CREATE TABLE IF NOT EXISTS assignment_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  conditions  TEXT NOT NULL,             -- JSON [{field, op, value}]
  strategy    TEXT NOT NULL,             -- team / named / least_loaded / territory / product
  team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- territory/product routing: JSON map of value → team_id or user_id
  routing_map TEXT,
  fallback_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  priority    INTEGER NOT NULL DEFAULT 100,   -- lowest number wins
  enabled     INTEGER NOT NULL DEFAULT 1,
  fire_count  INTEGER NOT NULL DEFAULT 0,
  last_fired  TEXT,
  sales_org   TEXT NOT NULL DEFAULT 'BONANZA',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/**
 * Reminders. One row per thing somebody must be told about, per channel.
 *
 * Modelled as rows rather than fired-and-forgotten so that "did the RM
 * actually get chased?" is answerable after the fact — which is the question a
 * sales manager asks when a follow-up was missed.
 */
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,             -- bell / email / whatsapp / manager
  due_at      TEXT NOT NULL,
  sent_at     TEXT,
  status      TEXT NOT NULL DEFAULT 'Pending',  -- Pending / Sent / Failed / Cancelled
  escalated   INTEGER NOT NULL DEFAULT 0,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(sales_org);
CREATE INDEX IF NOT EXISTS idx_dispositions_type ON dispositions(activity_type, active);
`);

/* --------------------------------------------------- access control */

/**
 * Roles, capabilities and permission sets.
 *
 * THE FAILURE THIS REPLACES
 * -------------------------
 * The legacy tenant has FOUR overlapping mechanisms — Role (fixed at 4, not
 * extensible), Permission Template (12+), Team (16) and Sales Group (9). A user
 * carries one of the first, N of the second, one of the third and N of the
 * fourth, and no screen in the product answers "what can this person actually
 * see?" (audit Part 4.1).
 *
 * Because only four roles existed, every real persona — dealer, telecaller,
 * supervisor, post-sales, partner RM, B2B manager — had to be smuggled in as a
 * Permission Template. That is the whole reason the second mechanism exists.
 *
 * TWO MECHANISMS, NOT FOUR
 * ------------------------
 *   ROLE            what this persona can do, and how much data it sees.
 *                   Extensible: an administrator creates the twelfth role
 *                   without a developer.
 *   PERMISSION SET  additive grants on top, for the exceptions. "This one
 *                   supervisor may also unmask PII."
 *
 * Team and manager stay, but they answer a different question. The audit found
 * `Bigul Dealer Team` with 12 managers and 1 sales user — the manager slot being
 * used to grant visibility rather than express reporting (Part 4.4). So here,
 * MANAGES is `users.manager_id`, and CAN SEE is `roles.data_scope`. They are
 * never the same field.
 *
 * Effective capability = role's capabilities ∪ every granted set's capabilities.
 * There is no deny list: subtraction makes effective access impossible to reason
 * about, which is the failure being replaced.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS capabilities (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT,
  -- Capabilities that expose client identifiers or move money are marked so the
  -- Setup UI can warn before granting them.
  sensitive   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS roles (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  /**
   * How much data this role sees. Previously a switch statement inside
   * leadScope(); as a column an administrator can create "Regional Supervisor"
   * with team scope without touching code.
   *   own      records they own
   *   team     their own plus their reports' (via manager_id)
   *   product  every record carrying their product (Product RM)
   *   org      everything in their sales org
   */
  data_scope  TEXT NOT NULL DEFAULT 'own',
  -- A system role is one the product depends on; it may be edited but not deleted.
  is_system   INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_capabilities (
  role_code  TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  capability TEXT NOT NULL REFERENCES capabilities(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, capability)
);

CREATE TABLE IF NOT EXISTS permission_sets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  sales_org   TEXT,                      -- null = available to every org
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permission_set_capabilities (
  set_id     INTEGER NOT NULL REFERENCES permission_sets(id) ON DELETE CASCADE,
  capability TEXT NOT NULL REFERENCES capabilities(code) ON DELETE CASCADE,
  PRIMARY KEY (set_id, capability)
);

/**
 * Grants are dated and attributed. "Who gave this person the ability to unmask
 * client PII, and when?" is an audit question, and the answer has to survive
 * the grant being revoked.
 */
CREATE TABLE IF NOT EXISTS user_permission_sets (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_id     INTEGER NOT NULL REFERENCES permission_sets(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason     TEXT,
  PRIMARY KEY (user_id, set_id)
);

CREATE INDEX IF NOT EXISTS idx_role_caps ON role_capabilities(role_code);
CREATE INDEX IF NOT EXISTS idx_set_caps ON permission_set_capabilities(set_id);
CREATE INDEX IF NOT EXISTS idx_user_sets ON user_permission_sets(user_id);
`);

/* ------------------------------------------------ computed metrics */

/**
 * Signals and score as a rebuildable projection, never a stamped counter.
 *
 * `lead_metrics` is a cache: every row can be reproduced from `activities` and
 * `product_cards` alone, and `rebuild()` is its only writer. `score_models`
 * holds the formula as versioned data so a reweighting produces a new version
 * rather than silently rewriting what past scores meant — which is exactly what
 * an incrementing counter cannot promise, and why the audit lists the legacy
 * `Activity Score` automation (8,023,974 triggers) as a failure mode.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS score_models (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     INTEGER NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  weights     TEXT NOT NULL,             -- JSON, the whole formula
  active      INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_metrics (
  lead_id             INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  days_since_contact  INTEGER,
  call_attempts       INTEGER,
  call_connects       INTEGER,
  connect_rate        INTEGER,           -- null until there is enough evidence
  activity_count      INTEGER,
  products_held       INTEGER,
  untapped_products   INTEGER,
  open_cases          INTEGER,
  aum                 REAL,
  furthest_state      TEXT,
  score               INTEGER,
  score_components    TEXT,              -- JSON, so "why 62?" is answerable
  score_model_version INTEGER,
  computed_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_score ON lead_metrics(score DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_stale ON lead_metrics(computed_at);
`);

/* --------------------------------------------------- metadata layer */

/**
 * Entities and fields as data.
 *
 * THE IDEA, AND WHY IT IS THE ARCHITECTURE
 * ----------------------------------------
 * Part 1 item 1 of the Salesforce reference: every object exposes the same
 * configuration contract, so an admin who learns one object can configure any
 * object, and the configuration UI is built once rather than per entity.
 *
 * Before this, adding a field meant a migration, an INSERT column, a SELECT
 * column, a validator, a form control and a test — six edits in five files, by a
 * developer. That is the difference between a product an administrator can shape
 * and one that needs an engineer for every business change.
 *
 * HYBRID STORAGE, DELIBERATELY
 * ----------------------------
 * Core fields stay real SQL columns on `leads`, `partners` and the rest: fast to
 * query, indexable, and the thing 495,118 rows will actually be filtered by.
 * Custom fields land in `field_value`, one row per (record, field). That costs a
 * join and is the right trade — the alternative, everything generic, is the
 * purest form of the idea and the slowest to report on at this scale.
 *
 * `field_def.storage` records which side a field lives on, so the rest of the
 * system never has to guess.
 *
 * LABEL IS NOT API NAME
 * ---------------------
 * Two identifiers, from the start. `api_name` is immutable and is what
 * integrations bind to; `label` is what business users see and may rename freely.
 * The legacy tenant has `mx_Subscription_End_dtae` and
 * `mx_Presales_Initial_Margin_Commitmnt` permanently in its schema because it
 * conflates the two. That cannot happen here.
 *
 * No `__c` suffix, though — encoding "custom" into the name is Salesforce's own
 * historical debt, and Part 7 of that reference warns against inheriting exactly
 * this kind of thing. `is_custom` is a column.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS entity_def (
  api_name     TEXT PRIMARY KEY,          -- immutable; integrations bind to this
  label        TEXT NOT NULL,             -- renameable, never load-bearing
  label_plural TEXT NOT NULL,
  description  TEXT,
  table_name   TEXT,                      -- physical table for core storage
  is_custom    INTEGER NOT NULL DEFAULT 0,
  owner_type   TEXT NOT NULL DEFAULT 'user',   -- user | user_or_queue | none
  icon         TEXT,

  -- Feature toggles, mirroring the reference's per-object "Details" surface.
  has_history      INTEGER NOT NULL DEFAULT 1,
  has_activities   INTEGER NOT NULL DEFAULT 0,
  has_record_types INTEGER NOT NULL DEFAULT 0,
  has_approvals    INTEGER NOT NULL DEFAULT 0,

  sales_org    TEXT,                      -- null = shared by both businesses
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS field_def (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity       TEXT NOT NULL REFERENCES entity_def(api_name) ON DELETE CASCADE,
  api_name     TEXT NOT NULL,             -- immutable
  label        TEXT NOT NULL,             -- renameable
  type         TEXT NOT NULL,             -- see the palette in engine/metadata.js
  storage      TEXT NOT NULL DEFAULT 'value',   -- column | value | derived

  -- Precision is part of the declared type: text(120), currency(16,2).
  length       INTEGER,
  precision    INTEGER,
  scale        INTEGER,

  required     INTEGER NOT NULL DEFAULT 0,
  is_unique    INTEGER NOT NULL DEFAULT 0,
  external_id  INTEGER NOT NULL DEFAULT 0,
  indexed      INTEGER NOT NULL DEFAULT 0,

  default_value TEXT,
  help_text     TEXT,
  description   TEXT,

  -- Cascading picklists. The child's allowed values depend on the parent's
  -- value, and it is enforced at the API — most writes arrive from automation
  -- and integrations, which never see a UI.
  controlling_field INTEGER REFERENCES field_def(id) ON DELETE SET NULL,

  -- Derived types. A formula recomputes from an expression; a rollup aggregates
  -- a child list. Both are read-only and neither is maintained by automation —
  -- which is what deletes the legacy tenant's two busiest jobs.
  formula      TEXT,
  rollup       TEXT,                      -- JSON {child_entity, fk, agg, field, filter}

  -- Encryption as a schema decision rather than a call-site one. A route that
  -- forgets to call encryptField() cannot leak a field declared encrypted.
  encrypted    INTEGER NOT NULL DEFAULT 0,
  -- Field-level security: who may read the VALUE, as opposed to the record.
  -- This is what makes "metadata open, content restricted" expressible.
  read_scope   TEXT NOT NULL DEFAULT 'record',  -- record | owner_or_manager | capability
  read_capability TEXT,

  history_tracked INTEGER NOT NULL DEFAULT 0,

  -- The governance gate the audit says is missing: 289 custom fields, 8+
  -- duplicate pairs, 4 test fields live in production.
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purpose       TEXT,
  retire_at     TEXT,

  is_custom    INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (entity, api_name)
);

CREATE TABLE IF NOT EXISTS picklist_value (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  field_id    INTEGER NOT NULL REFERENCES field_def(id) ON DELETE CASCADE,
  value       TEXT NOT NULL,
  label       TEXT NOT NULL,
  -- Which parent value permits this child. Null means always available.
  controlling_value TEXT,
  colour      TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (field_id, value)
);

/**
 * Custom field storage. One row per (record, field).
 *
 * Typed columns rather than one TEXT blob, so the query planner and the
 * condition compiler can both work with real types instead of casting strings.
 */
CREATE TABLE IF NOT EXISTS field_value (
  entity     TEXT NOT NULL,
  record_id  INTEGER NOT NULL,
  field_id   INTEGER NOT NULL REFERENCES field_def(id) ON DELETE CASCADE,
  text_value TEXT,
  num_value  REAL,
  date_value TEXT,
  bool_value INTEGER,
  PRIMARY KEY (entity, record_id, field_id)
);

/**
 * Field history. First-class and queryable, which deletes the six legacy
 * automations that exist only to stamp a date into an mx_ field.
 */
CREATE TABLE IF NOT EXISTS field_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,
  record_id  INTEGER NOT NULL,
  field      TEXT NOT NULL,               -- api_name
  old_value  TEXT,
  new_value  TEXT,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source     TEXT NOT NULL DEFAULT 'ui',  -- ui | api | automation | import | vendor
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/**
 * Configuration audit. Separate from the data audit log on purpose: "who changed
 * the schema?" and "who changed this lead?" are different questions with
 * different retention and different readers.
 *
 * Its absence in the legacy tenant is why admins encode deploy dates into
 * automation names.
 */
CREATE TABLE IF NOT EXISTS config_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  area       TEXT NOT NULL,               -- entity | field | role | rule | layout | org
  target     TEXT NOT NULL,
  action     TEXT NOT NULL,               -- created | updated | deleted | activated
  before_json TEXT,
  after_json  TEXT,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_field_entity ON field_def(entity, active);
CREATE INDEX IF NOT EXISTS idx_fieldvalue_record ON field_value(entity, record_id);
CREATE INDEX IF NOT EXISTS idx_fieldvalue_field ON field_value(field_id);
CREATE INDEX IF NOT EXISTS idx_history_record ON field_history(entity, record_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_field ON field_history(entity, field, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_config_audit_at ON config_audit(at DESC);
`);

db.exec(`
/**
 * A saved search is a query, never a membership list.
 *
 * Non-negotiable 10. "At-risk leads" saved in August and opened in March must
 * answer March's question — a stored set of ids would answer August's, and be
 * quietly wrong for seven months.
 */
CREATE TABLE IF NOT EXISTS saved_searches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  entity     TEXT NOT NULL,
  tree       TEXT NOT NULL,
  described  TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sales_org  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_saved_entity ON saved_searches(entity, sales_org);
`);

/**
 * Drop the `kyc_status` mirror from databases created before it was derived.
 *
 * Guarded rather than unconditional: `DROP COLUMN` fails on a column that is
 * not there, and this file runs on every boot.
 */
// `db` directly rather than the `all` helper: this runs at module load, before
// the helpers below are initialised.
if (db.prepare("SELECT name FROM pragma_table_info('leads')").all().some((c) => c.name === 'kyc_status')) {
  try {
    db.exec('ALTER TABLE leads DROP COLUMN kyc_status');
    console.log('[db] dropped the leads.kyc_status mirror — it is derived now');
  } catch (err) {
    console.warn('[db] could not drop leads.kyc_status:', err.message);
  }
}

/**
 * Drop `dispositions.sales_org`, which promised something the table cannot do.
 *
 * The column said each business had its own call outcomes. Nothing read it —
 * every query is `WHERE active = 1 AND activity_type = ?` — nothing wrote
 * anything but the default, and `code TEXT NOT NULL UNIQUE` makes the per-book
 * version impossible anyway: there cannot be a Bonanza and a Bigul row for the
 * same code. So all 23 shipped outcomes were labelled 'BONANZA' and shown to
 * both businesses, and a custom outcome added by either was shown to both.
 *
 * Dropped rather than filtered. Filtering the reads would have left a Bigul
 * caller with no dispositions at all, and making it real means a different
 * unique key, a row per business, and a Setup screen that says which one — a
 * feature nobody has asked for. If per-business call outcomes are ever wanted,
 * this comment is the place to start; until then a column that misdescribes the
 * data is worse than no column, because it is what the next person reads.
 */
if (db.prepare("SELECT name FROM pragma_table_info('dispositions')").all().some((c) => c.name === 'sales_org')) {
  try {
    db.exec('ALTER TABLE dispositions DROP COLUMN sales_org');
    console.log('[db] dropped dispositions.sales_org — call outcomes are firm-wide');
  } catch (err) {
    console.warn('[db] could not drop dispositions.sales_org:', err.message);
  }
}

/**
 * Hash any credential still stored as cleartext.
 *
 * `POST /api/admin/users` and its PATCH wrote `req.body.password` straight into
 * the column: admin.js predated the hashing work and never imported
 * `hashPassword`, so every account created or given a new password through
 * Admin -> Users was readable in the database file. Every other write path
 * hashed correctly.
 *
 * `verifyPassword` accepts a cleartext match so a legacy row can be upgraded on
 * its owner's next sign-in, which is what kept those accounts working. It is
 * also what made the exposure complete: a stored value that compares equal
 * needs no cracking. Waiting for each owner to sign in is no fix for the rows
 * that exist now, so they are hashed here instead -- the plaintext is sitting
 * in the column, so it can be hashed directly with nobody re-entering anything.
 *
 * A no-op on every start after the first.
 */
for (const [table, column] of [['users', 'password'], ['partners', 'portal_password']]) {
  const stale = db.prepare(
    `SELECT id, "${column}" AS secret FROM "${table}"
      WHERE "${column}" IS NOT NULL AND "${column}" != '' AND "${column}" NOT LIKE 'scrypt$%'`,
  ).all();
  if (!stale.length) continue;
  const write = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE id = ?`);
  for (const row of stale) write.run(hashPassword(String(row.secret)), row.id);
  console.log(`[db] hashed ${stale.length} cleartext ${table}.${column} value(s)`);
}

db.exec(`
/**
 * Working calendars. Two of them: when the office is open, and when the
 * exchange trades. They are different weeks and they diverge often.
 */
CREATE TABLE IF NOT EXISTS calendars (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL UNIQUE,          -- office | exchange
  label      TEXT NOT NULL,
  open_hour  INTEGER NOT NULL DEFAULT 9,
  close_hour INTEGER NOT NULL DEFAULT 19,
  week_days  TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendar_days (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  on_date     TEXT NOT NULL,                -- YYYY-MM-DD
  name        TEXT NOT NULL,
  -- Muhurat trading is an hour on a day the exchange is otherwise shut, so a
  -- closed day and a short day are not the same thing.
  half_day    INTEGER NOT NULL DEFAULT 0,
  close_hour  INTEGER,
  source      TEXT NOT NULL DEFAULT 'manual',
  UNIQUE (calendar_id, on_date)
);
CREATE INDEX IF NOT EXISTS idx_caldays ON calendar_days(calendar_id, on_date);
`);

db.exec(`
/**
 * Queues — an owner that is not a person.
 *
 * Non-negotiable 8. Without this, work with no obvious owner either sits at
 * NULL (belonging to nobody, on nobody's list) or gets parked on a placeholder
 * human, which is how the legacy tenant ended up with shared logins and
 * unattributable activity.
 */
CREATE TABLE IF NOT EXISTS queues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  entity      TEXT NOT NULL DEFAULT 'lead',
  sales_org   TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/**
 * Membership by role, not by person: a queue outlives the people in it, and a
 * list of names is wrong the first time somebody changes desks.
 */
CREATE TABLE IF NOT EXISTS queue_members (
  queue_id  INTEGER NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL,
  PRIMARY KEY (queue_id, role_code)
);
`);

db.exec(`
/**
 * Approvals. One table, four scopes — see engine/approvals.js for why a generic
 * engine rather than four bespoke flows.
 *
 * A Pending row is also a lock: the record it names cannot be changed while it
 * waits, so an approver never signs off a number that has since moved.
 */
CREATE TABLE IF NOT EXISTS approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scope           TEXT NOT NULL,
  entity          TEXT NOT NULL,
  entity_id       INTEGER NOT NULL,
  subject_name    TEXT,
  payload         TEXT,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'Pending',   -- Pending|Approved|Rejected|Withdrawn
  requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_reason TEXT,
  decided_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(entity, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_scope ON approvals(scope, status);
`);

db.exec(`
/**
 * The automation failure queue — non-negotiable 12.
 *
 * An action that throws is recorded here instead of aborting the run, so a
 * dead number on lead 40 does not silently skip leads 41 to 500. Rows stay
 * until somebody resolves them, because a failure nobody sees is the same as
 * one that never happened.
 */
CREATE TABLE IF NOT EXISTS rule_failures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     INTEGER REFERENCES rules(id) ON DELETE CASCADE,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  error       TEXT NOT NULL,
  payload     TEXT,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rule_failures ON rule_failures(resolved_at, created_at DESC);
`);

export const SALES_ORGS = SEED_ORGS.map((o) => o.code);
export const DEFAULT_ORG = 'BONANZA';


/* ---------------------------------------------------- domain constants */

export const ROLES = [
  'superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor',
  'partner_rm', 'product_rm', 'product_supervisor', 'customer_care', 'marketing_manager',
];

export const ROLE_LABELS = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  caller: 'Caller',
  dealer: 'Dealer',
  sales_rm: 'Sales RM',
  sales_supervisor: 'Sales Supervisor',
  partner_rm: 'Partner RM',
  product_rm: 'Product RM',
  product_supervisor: 'Product Supervisor',
  customer_care: 'Customer Care Agent',
  marketing_manager: 'Marketing Manager',
};

export const CARD_STATES = [
  'INACTIVE', 'EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED',
  'KYC_IN_PROGRESS', 'ACTIVE', 'ON_HOLD', 'LOST',
];

/* Grey = untouched · Yellow = engaged · Green = won · Red = lost (BRD OD-01) */
export const CARD_COLOUR = {
  INACTIVE: 'grey',
  EXPLORING: 'yellow',
  WARM: 'yellow',
  PRODUCT_RM_ENGAGED: 'yellow',
  KYC_IN_PROGRESS: 'yellow',
  ON_HOLD: 'yellow',
  ACTIVE: 'green',
  LOST: 'red',
};

export const LEAD_STAGES = ['New', 'Contacted', 'Qualified', 'In Progress', 'Won', 'Lost'];

export const PARTNER_STATES = ['PROSPECT', 'QUALIFYING', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'];

export const AGE_BANDS = [
  { code: 'Fresh', min: 0, max: 7 },
  { code: 'Active', min: 8, max: 30 },
  { code: 'Ageing', min: 31, max: 60 },
  { code: 'At Risk', min: 61, max: 90 },
  { code: 'Cold', min: 91, max: Infinity },
];

export const ageBand = (days) => AGE_BANDS.find((b) => days >= b.min && days <= b.max)?.code ?? 'Fresh';

/* ------------------------------------------------------------ helpers */

export const all = (sql, params = []) => db.prepare(sql).all(...params);
export const one = (sql, params = []) => db.prepare(sql).get(...params);
export const run = (sql, params = []) => db.prepare(sql).run(...params);

export const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export const daysSince = (iso) =>
  iso ? Math.floor((Date.now() - new Date(`${iso.replace(' ', 'T')}Z`).getTime()) / 86_400_000) : null;

export function audit(userId, action, entity, entityId, detail) {
  /* `actor` carries the real human when a ghost session means user_id is
     somebody else — "Kavita Nair acting as Sneha Kulkarni". Read from the
     request context rather than passed in, because this is called from 132
     places and threading a second argument through all of them would guarantee
     some were missed, which is the same failure as not doing it. */
  run('INSERT INTO audit_log (user_id, action, entity, entity_id, detail, actor) VALUES (?,?,?,?,?,?)', [
    userId ?? null, action, entity ?? null, entityId ?? null,
    typeof detail === 'string' ? detail : JSON.stringify(detail ?? null),
    actingActor(),
  ]);
}

export function notify(userId, title, body, link) {
  if (!userId) return;
  run('INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)', [userId, title, body ?? null, link ?? null]);
}
