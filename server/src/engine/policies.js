/**
 * Business policies: decisions the business makes and an administrator
 * changes in Setup, without a deploy (QA-13, QA-06).
 *
 * Each is a question the business answered in its own words, and the answer
 * can change -- "a Bonanza partner cannot refer Bigul products today, but we
 * want to be able to allow it" (Ritesh, 13 Oct 2026). A constant in the code
 * would make the next answer a release; a row here makes it a click, and the
 * configuration audit records who changed it and from what.
 *
 * Only Admins and Superadmins hold `admin.policies`. A policy nobody has set
 * reads as its default, and the screen says which ones are defaults.
 */

import { all, one, run } from '../db.js';

const BOOK_NAME = { BONANZA: 'Bonanza', BIGUL: 'Bigul' };
const OTHER = { BONANZA: 'BIGUL', BIGUL: 'BONANZA' };

export const POLICIES = [
  {
    key: 'partner_referral_cross_book.BONANZA',
    area: 'Partners',
    label: 'Bonanza partners may refer Bigul products',
    help: 'Off: a Bonanza partner sees and refers Bonanza products only. On: Bigul products are offered too, '
      + 'labelled as Bigul, and a referral for one becomes a Bigul lead attributed to the partner.',
    type: 'bool',
    default: false,
  },
  {
    key: 'partner_referral_cross_book.BIGUL',
    area: 'Partners',
    label: 'Bigul partners may refer Bonanza products',
    help: 'Off: a Bigul partner sees and refers Bigul products only. On: Bonanza products are offered too, '
      + 'labelled as Bonanza, and a referral for one becomes a Bonanza lead attributed to the partner.',
    type: 'bool',
    default: false,
  },
  {
    /* QA-06 (Ritesh, 13 Oct): Marketing may export unmasked PII, and an Admin or
       Superadmin may hold its exports masked from here. */
    key: 'export_pii.marketing_manager',
    area: 'Exports',
    label: 'Marketing\'s exports carry personal data',
    help: 'Unmasked: a Marketing Manager may export mobile numbers, emails and PAN in the clear, as they see them on screen. '
      + 'Masked: their exported files are masked whatever they see on screen. Every unmasked export is audited.',
    type: 'choice',
    options: [{ value: 'unmasked', label: 'Unmasked' }, { value: 'masked', label: 'Masked' }],
    default: 'unmasked',
  },
  {
    /* QA-24. Off, because nothing records an account opening until the
       account-opening feed reaches the CRM, and the RM's own Won is the only
       signal there is. */
    key: 'lead_won_requires_account',
    area: 'Leads',
    label: 'A lead is marked Won only once its account is opened',
    help: 'On: nobody can set a lead to Won until it carries its UCC; an account opening sets Won by itself either way. '
      + 'Switch this on once the account-opening feed reaches the CRM. Until then RMs mark Won by hand.',
    type: 'bool',
    default: false,
  },
];

export const policyDef = (key) => POLICIES.find((p) => p.key === key) ?? null;

/** The value in force: what an administrator set, or the default. */
export function policy(key) {
  const def = policyDef(key);
  if (!def) throw new Error(`policy: no policy "${key}"`);
  const row = one('SELECT value FROM business_policy WHERE key = ?', [key]);
  if (!row) return def.default;
  try { return JSON.parse(row.value); } catch { return def.default; }
}

/** Why a value is not one this policy accepts, or null. */
export function policyRefusal(key, value) {
  const def = policyDef(key);
  if (!def) return `There is no policy called ${key}`;
  if (def.type === 'bool' && typeof value !== 'boolean') return `${def.label}: choose on or off`;
  if (def.type === 'choice' && !def.options.some((o) => o.value === value)) {
    return `${def.label}: choose one of ${def.options.map((o) => o.label).join(', ')}`;
  }
  return null;
}

export function setPolicy(key, value, actorId) {
  const refusal = policyRefusal(key, value);
  if (refusal) return { error: refusal };
  const before = policy(key);
  run(
    `INSERT INTO business_policy (key, value, updated_by, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), actorId],
  );
  /* The configuration audit, written here rather than through metadata.js so
     auth.js can read a policy without an import cycle. */
  run(
    'INSERT INTO config_audit (area, target, action, before_json, after_json, actor_id) VALUES (?,?,?,?,?,?)',
    ['policy', key, 'update', JSON.stringify({ value: before }), JSON.stringify({ value }), actorId],
  );
  return { key, value };
}

/** Every policy, with what is in force and who last changed it. */
export function listPolicies() {
  const set = new Map(all(
    `SELECT b.key, b.value, b.updated_at, u.name AS updated_by_name
       FROM business_policy b LEFT JOIN users u ON u.id = b.updated_by`,
  ).map((r) => [r.key, r]));
  return POLICIES.map((def) => ({
    ...def,
    value: policy(def.key),
    is_default: !set.has(def.key),
    updated_at: set.get(def.key)?.updated_at ?? null,
    updated_by_name: set.get(def.key)?.updated_by_name ?? null,
  }));
}

/* ------------------------------------------------------------ QA-13 */

/**
 * The businesses whose products a partner of this business may refer: always
 * their own, and the other one only while the policy for their book says so.
 */
export function referrableBooks(org) {
  const books = [org];
  if (OTHER[org] && policy(`partner_referral_cross_book.${org}`)) books.push(OTHER[org]);
  return books;
}

export const bookName = (org) => BOOK_NAME[org] ?? org;

/* ------------------------------------------------------------ QA-24 */

/**
 * Why these leads may not be set to Won, or null.
 *
 * Won means the account was opened. While the policy is on, a lead without its
 * UCC cannot be Won by anybody's hand; a bulk change carrying any such lead is
 * refused whole, naming how many, as a refused value is.
 */
export function wonRefusal(stage, leadIds) {
  if (stage !== 'Won' || !policy('lead_won_requires_account') || !leadIds.length) return null;
  const without = one(
    `SELECT COUNT(*) n FROM leads WHERE id IN (${leadIds.map(() => '?').join(',')})
       AND (client_code IS NULL OR TRIM(client_code) = '')`,
    leadIds,
  ).n;
  if (!without) return null;
  return without === 1 && leadIds.length === 1
    ? 'This lead has no account yet. A lead is Won when its account is opened, which records its UCC.'
    : `${without} of these leads have no account yet. A lead is Won when its account is opened, which records its UCC.`;
}

/* ------------------------------------------------------------ QA-06 */

/**
 * Why this role's export may not carry identifiers in the clear, or null.
 *
 * Asked by every export after its own unmask check: holding `pii.unmask` is
 * still required, and a policy can only take the clear export away.
 */
export function exportHeldMasked(role) {
  const key = `export_pii.${role}`;
  if (!policyDef(key) || policy(key) !== 'masked') return null;
  return 'Exports for your role are masked by a business policy (Setup → Business policies)';
}
