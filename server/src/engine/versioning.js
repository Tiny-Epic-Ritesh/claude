/**
 * Versioning for configurable artefacts.
 *
 * Finding 10 of the LeadSquared audit: nothing was versioned, so nothing was
 * ever retired. One capability — client profiling — ended up spread across five
 * forms, three processes and two activity types, with V3 and V4 both live and
 * the one marked "old" still enabled. Automations were named `…19Aug 2025V4-`
 * and `… - Clone`. The version history was the artefact names.
 *
 * The shape here is a snapshot table rather than version columns on each table.
 * The live row stays the current version — every existing query keeps working
 * untouched — and each save also writes a JSON snapshot here. That gives one
 * logical artefact, many versions, an explicit current pointer and a diff, for
 * four artefact types, without changing four schemas.
 *
 * HISTORY IS APPEND-ONLY. Rolling back does not delete the versions in between;
 * it writes the old payload forward as a new version. "What did this look like
 * in March, and who changed it since" has to stay answerable, and a rollback
 * that erased its own evidence would be the same failure in a new costume.
 */

import { run, all, one } from '../db.js';

/**
 * What can be versioned, and how a version is applied back to the live table.
 *
 * `restore` is what makes rollback real rather than decorative: without it a
 * version history is a list of things you can look at and not act on.
 */
export const ARTEFACTS = {
  rule: {
    label: 'Automation rule',
    load: (id) => one('SELECT * FROM rules WHERE id = ?', [id]),
    restore: (id, p) => run(
      `UPDATE rules SET name = ?, description = ?, conditions = ?, actions = ?,
                        schedule = ?, enabled = ?, priority = ? WHERE id = ?`,
      [p.name, p.description ?? null, p.conditions, p.actions, p.schedule ?? null,
        p.enabled ?? 0, p.priority ?? 100, id],
    ),
  },
  template: {
    label: 'Message template',
    load: (id) => one('SELECT * FROM templates WHERE id = ?', [id]),
    restore: (id, p) => run(
      `UPDATE templates SET name = ?, channel = ?, subject = ?, body = ?,
                            product_type_id = ?, approved = ? WHERE id = ?`,
      [p.name, p.channel, p.subject ?? null, p.body, p.product_type_id ?? null,
        p.approved ?? 0, id],
    ),
  },
  kyc_journey: {
    label: 'KYC journey',
    // Keyed by product type: the journey IS the ordered step list for a product.
    load: (productId) => ({
      product_type_id: Number(productId),
      steps: all(
        'SELECT step_code, sort_order, timer_override_s, conditional_on FROM kyc_journey_steps WHERE product_type_id = ? ORDER BY sort_order',
        [productId],
      ),
    }),
    restore: (productId, p) => {
      run('DELETE FROM kyc_journey_steps WHERE product_type_id = ?', [productId]);
      (p.steps ?? []).forEach((s, i) => run(
        `INSERT INTO kyc_journey_steps (product_type_id, step_code, sort_order, timer_override_s, conditional_on)
         VALUES (?,?,?,?,?)`,
        [productId, s.step_code, s.sort_order ?? i, s.timer_override_s ?? null, s.conditional_on ?? null],
      ));
    },
  },
  sla_policy: {
    label: 'SLA policy',
    // Keyed "productId:priority", because that pair is what the table is unique on.
    load: (key) => {
      const [productId, priority] = String(key).split(':');
      return one(
        'SELECT * FROM sla_policies WHERE product_type_id IS ? AND priority = ?',
        [productId === 'null' ? null : Number(productId), priority],
      );
    },
    restore: (key, p) => {
      const [productId, priority] = String(key).split(':');
      run(
        `INSERT INTO sla_policies (product_type_id, priority, response_mins, resolution_mins)
         VALUES (?,?,?,?)
         ON CONFLICT (product_type_id, priority) DO UPDATE SET
           response_mins = excluded.response_mins, resolution_mins = excluded.resolution_mins`,
        [productId === 'null' ? null : Number(productId), priority, p.response_mins, p.resolution_mins],
      );
    },
  },
};

const spec = (kind) => {
  const s = ARTEFACTS[kind];
  if (!s) throw new Error(`versioning: unknown artefact kind "${kind}"`);
  return s;
};

/**
 * Record the current state of an artefact as its next version.
 *
 * Called after the live table is written, so the snapshot is of what was
 * actually saved rather than of what was asked for — those differ whenever a
 * write applies a default or normalises a value, and the version history should
 * show what the system holds, not what somebody typed.
 */
export function snapshot(kind, logicalId, { note = null, userId = null } = {}) {
  const payload = spec(kind).load(logicalId);
  if (!payload) return null;

  const next = (one(
    'SELECT COALESCE(MAX(version), 0) v FROM artefact_versions WHERE kind = ? AND logical_id = ?',
    [kind, String(logicalId)],
  ).v) + 1;

  run('UPDATE artefact_versions SET is_current = 0 WHERE kind = ? AND logical_id = ?',
    [kind, String(logicalId)]);

  const r = run(
    `INSERT INTO artefact_versions (kind, logical_id, version, payload, note, is_current, created_by)
     VALUES (?,?,?,?,?,1,?)`,
    [kind, String(logicalId), next, JSON.stringify(payload), note, userId],
  );
  return byId(Number(r.lastInsertRowid));
}

const hydrate = (row) => (row
  ? { ...row, payload: JSON.parse(row.payload), is_current: Boolean(row.is_current) }
  : null);

export const byId = (id) => hydrate(one(
  `SELECT v.*, u.name AS created_by_name FROM artefact_versions v
   LEFT JOIN users u ON u.id = v.created_by WHERE v.id = ?`,
  [id],
));

export const versionsOf = (kind, logicalId) => all(
  `SELECT v.*, u.name AS created_by_name FROM artefact_versions v
   LEFT JOIN users u ON u.id = v.created_by
   WHERE v.kind = ? AND v.logical_id = ? ORDER BY v.version DESC`,
  [kind, String(logicalId)],
).map(hydrate);

export const currentOf = (kind, logicalId) => hydrate(one(
  'SELECT * FROM artefact_versions WHERE kind = ? AND logical_id = ? AND is_current = 1',
  [kind, String(logicalId)],
));

/**
 * What changed between two versions, field by field.
 *
 * Values are compared as JSON, so a reordered step list or a rewritten
 * condition tree reads as one changed field rather than as a wall of text.
 */
export function diff(aId, bId) {
  const a = byId(aId);
  const b = byId(bId);
  if (!a || !b) return null;
  if (a.kind !== b.kind || a.logical_id !== b.logical_id) {
    return { error: 'Those two versions are of different artefacts' };
  }

  const keys = [...new Set([...Object.keys(a.payload ?? {}), ...Object.keys(b.payload ?? {})])].sort();
  const changes = [];
  for (const key of keys) {
    const from = a.payload?.[key];
    const to = b.payload?.[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ field: key, from: from ?? null, to: to ?? null });
  }

  return {
    kind: a.kind,
    logical_id: a.logical_id,
    from: { id: a.id, version: a.version, at: a.created_at, by: a.created_by_name },
    to: { id: b.id, version: b.version, at: b.created_at, by: b.created_by_name },
    changes,
    identical: changes.length === 0,
  };
}

/**
 * Put an old version back, as a new one.
 *
 * The versions in between stay exactly where they are. A rollback that deleted
 * them would destroy the record of what was live last Tuesday, which is the
 * question an auditor actually asks.
 */
export function restore(versionId, { userId = null } = {}) {
  const v = byId(versionId);
  if (!v) return { ok: false, error: 'Version not found' };

  const s = spec(v.kind);
  s.restore(v.logical_id, v.payload);

  const created = snapshot(v.kind, v.logical_id, {
    note: `Restored version ${v.version}`,
    userId,
  });
  return { ok: true, restored_from: v.version, version: created };
}

/** Everything that has ever been versioned, newest first — the history index. */
export const recentVersions = ({ kind = null, limit = 100 } = {}) => all(
  `SELECT v.*, u.name AS created_by_name FROM artefact_versions v
   LEFT JOIN users u ON u.id = v.created_by
   ${kind ? 'WHERE v.kind = ?' : ''}
   ORDER BY v.created_at DESC, v.id DESC LIMIT ?`,
  kind ? [kind, Math.min(Number(limit) || 100, 500)] : [Math.min(Number(limit) || 100, 500)],
).map(hydrate);
