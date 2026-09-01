/**
 * What in the configuration needs somebody's attention.
 *
 * The point of a Setup home page is not a wall of shortcuts — the sidebar
 * already is that. It is answering the question an administrator actually
 * arrives with: is anything wrong that I do not know about?
 *
 * Every check here is a real defect with a real consequence, and every one names
 * the screen that fixes it. Nothing is a nag: "you have not filled in the
 * optional description" is noise, and a home page full of noise gets ignored,
 * which costs you the one time it says something that mattered.
 *
 * Each finding carries a severity that means something specific:
 *
 *   warn  something is wrong now and somebody is affected
 *   info  something will bite later, or is worth knowing before it does
 *
 * There is deliberately no "error" level. A configuration problem severe enough
 * to stop the product would not wait for somebody to visit this page.
 */

import { all, one } from '../db.js';
import { vendorStatus } from '../vendors/config.js';

/** A finding, in the shape the home page renders. */
const finding = (severity, section, title, detail) => ({ severity, section, title, detail });

/**
 * Picklist values sitting on records that the picker no longer offers.
 *
 * The consequence of retiring a value without looking at the counts, which is
 * exactly what was possible until the values editor started showing them. Those
 * records display something that is not in the list, and reports group by it.
 */
function orphanedValues(orgs) {
  const out = [];
  const fields = all(
    `SELECT f.id, f.entity, f.api_name, f.label, e.table_name, e.label AS entity_label
       FROM field_def f JOIN entity_def e ON e.api_name = f.entity
      WHERE f.active = 1 AND f.storage = 'column' AND f.type IN ('picklist', 'multipicklist')
        AND e.active = 1`,
  );

  for (const f of fields) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(f.api_name) || !/^[a-z_][a-z0-9_]*$/i.test(f.table_name)) continue;

    const cols = new Set(all(`PRAGMA table_info(${f.table_name})`).map((c) => c.name));
    if (!cols.has(f.api_name)) continue;

    const where = [`${f.api_name} IS NOT NULL`, `${f.api_name} != ''`];
    const params = [];
    if (cols.has('deleted_at')) where.push('deleted_at IS NULL');
    if (orgs?.length && cols.has('sales_org')) {
      where.push(`sales_org IN (${orgs.map(() => '?').join(',')})`);
      params.push(...orgs);
    }

    const offered = new Set(
      all('SELECT value FROM picklist_value WHERE field_id = ? AND active = 1', [f.id]).map((v) => String(v.value)),
    );
    if (!offered.size) continue;

    const stray = all(
      `SELECT ${f.api_name} AS v, COUNT(*) AS n FROM ${f.table_name}
        WHERE ${where.join(' AND ')} GROUP BY ${f.api_name}`,
      params,
    ).filter((r) => !offered.has(String(r.v)));

    if (stray.length) {
      const records = stray.reduce((a, r) => a + r.n, 0);
      out.push(finding(
        'warn', 'objects',
        /* Named with its object. "Priority" alone sent somebody looking at
           Cases when the field was on Tasks — half a dozen objects have a
           Priority and a Status, and a finding you cannot locate is a finding
           nobody acts on. */
        `${f.entity_label} · ${f.label} holds ${stray.length === 1 ? 'a value' : `${stray.length} values`} it no longer offers`,
        `${records.toLocaleString('en-IN')} record(s) are set to `
        + `${stray.slice(0, 3).map((r) => `"${r.v}"`).join(', ')}`
        + `${stray.length > 3 ? ', and others' : ''}, which nobody can pick and no filter will match.`,
      ));
    }
  }
  return out;
}

/**
 * The whole configuration health check.
 *
 * `orgs` narrows every record count to the books this administrator works in,
 * for the same reason every other count is narrowed: a Bigul admin should not
 * be shown a number that silently includes Bonanza's records.
 */
export function checkSetup({ orgs = null } = {}) {
  const found = [];

  /* ------------------------------------------------------------- people */

  const roleless = all("SELECT id, name FROM users WHERE active = 1 AND (role IS NULL OR role = '')");
  if (roleless.length) {
    found.push(finding(
      'warn', 'users',
      `${roleless.length} active user(s) have no role`,
      `${roleless.slice(0, 3).map((u) => u.name).join(', ')} can sign in and will see nothing, because every permission comes from a role.`,
    ));
  }

  const orphanOwners = all(
    `SELECT u.id, u.name, COUNT(l.id) AS leads
       FROM users u JOIN leads l ON l.owner_id = u.id AND l.deleted_at IS NULL
      WHERE u.active = 0
      GROUP BY u.id, u.name`,
  );
  if (orphanOwners.length) {
    const leads = orphanOwners.reduce((a, u) => a + u.leads, 0);
    found.push(finding(
      'warn', 'users',
      `${leads.toLocaleString('en-IN')} lead(s) are owned by someone who has left`,
      `${orphanOwners.slice(0, 3).map((u) => u.name).join(', ')} are deactivated but still hold a book. Nobody is working those leads.`,
    ));
  }

  /* ------------------------------------------------------------ objects */

  const unowned = all(
    `SELECT entity, api_name FROM field_def
      WHERE is_custom = 1 AND active = 1
        AND (owner_user_id IS NULL OR purpose IS NULL OR trim(purpose) = '')`,
  );
  if (unowned.length) {
    found.push(finding(
      'warn', 'objects',
      `${unowned.length} custom field(s) have no owner or no stated purpose`,
      'The legacy CRM reached 289 of these in four years and nobody could say what any of them were for.',
    ));
  }

  const emptyPicklists = all(
    `SELECT f.entity, f.label FROM field_def f
      WHERE f.active = 1 AND f.type IN ('picklist', 'multipicklist')
        AND NOT EXISTS (SELECT 1 FROM picklist_value v WHERE v.field_id = f.id AND v.active = 1)`,
  );
  if (emptyPicklists.length) {
    found.push(finding(
      'warn', 'objects',
      `${emptyPicklists.length} picklist(s) have nothing to choose from`,
      `${emptyPicklists.slice(0, 3).map((f) => `${f.entity}.${f.label}`).join(', ')} promise a controlled list and show an empty dropdown.`,
    ));
  }

  found.push(...orphanedValues(orgs));

  /* ------------------------------------------------------- integrations */

  try {
    const v = vendorStatus();
    const simulated = Object.entries(v)
      .filter(([k, s]) => k !== 'forced_simulation' && s && typeof s === 'object' && /not configured/.test(s.state ?? ''))
      .map(([k]) => k);
    if (simulated.length) {
      found.push(finding(
        'info', 'integrations',
        `${simulated.length} integration(s) are still simulated`,
        `${simulated.join(', ')} have no credentials, so anything sent through them is recorded and never delivered.`,
      ));
    }
    if (v.forced_simulation) {
      found.push(finding(
        'warn', 'integrations',
        'Every integration is forced into simulation',
        'CRM_SIMULATE_INTEGRATIONS is on, so nothing reaches a real vendor whatever its credentials say.',
      ));
    }
  } catch { /* the status probe must never take the page down */ }

  /* --------------------------------------------------------- monitoring */

  const noRetention = all("SELECT kind FROM log_retention WHERE days IS NULL OR days = 0");
  if (noRetention.length) {
    found.push(finding(
      'warn', 'logs',
      `${noRetention.length} log(s) are kept forever`,
      `${noRetention.map((r) => r.kind).join(', ')} have no retention period. Under DPDP a period nobody set is worse than a short one.`,
    ));
  }

  /* Order is the reading order: what is wrong now, then what will bite. */
  const rank = { warn: 0, info: 1 };
  return found.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * The last few configuration changes, in words.
 *
 * "Recently changed" answers the other question an administrator arrives with,
 * which is usually "did somebody else already do this". The config audit has
 * recorded it since day one; nothing surfaced it anywhere they would look.
 */
export function recentChanges(limit = 8) {
  return all(
    `SELECT c.id, c.area, c.target, c.action, c.at, u.name AS who
       FROM config_audit c LEFT JOIN users u ON u.id = c.actor_id
      ORDER BY c.at DESC, c.id DESC
      LIMIT ?`,
    [limit],
  );
}

/** How many of each object exist, for the home page's sense of scale. */
export function counts(orgs = null) {
  const scoped = (table) => {
    const cols = new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name));
    const where = [];
    const params = [];
    if (cols.has('deleted_at')) where.push('deleted_at IS NULL');
    if (cols.has('active')) where.push('active = 1');
    if (orgs?.length && cols.has('sales_org')) {
      where.push(`sales_org IN (${orgs.map(() => '?').join(',')})`);
      params.push(...orgs);
    }
    return one(
      `SELECT COUNT(*) n FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
    ).n;
  };

  return {
    users: scoped('users'),
    roles: one('SELECT COUNT(*) n FROM roles').n,
    objects: one('SELECT COUNT(*) n FROM entity_def WHERE active = 1').n,
    fields: one('SELECT COUNT(*) n FROM field_def WHERE active = 1').n,
    rules: one('SELECT COUNT(*) n FROM rules WHERE enabled = 1').n,
  };
}
