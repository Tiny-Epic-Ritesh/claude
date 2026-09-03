/**
 * Promoting configuration from one environment to another.
 *
 * P2-03. Ritesh settled the ambiguity on 3 Sep 2026: what gets promoted is
 * *configuration*, not code. Code promotion is CI/CD and belongs to whoever
 * runs the pipeline. Configuration promotion is a product feature, because the
 * people who build a rule in UAT and want it in Production are not engineers
 * and should not be filing a deployment ticket to move a template.
 *
 * Almost all of the machinery already existed. `engine/versioning.js` snapshots
 * rules, templates, KYC journeys and SLA policies with diff and rollback, and
 * every artefact there already knows how to load itself and how to write itself
 * back. What was missing is only the envelope: choosing a set, packaging it,
 * carrying it across, and keeping a record of what went where.
 *
 * THE PART THAT IS NOT BOOKKEEPING
 * --------------------------------
 * A bundle cannot carry database ids, and this is the whole difficulty.
 *
 * `versioning.js` keys artefacts by `logical_id`, which for a rule or a
 * template is its primary key. Those keys are assigned by whichever environment
 * happened to insert the row first, so rule 4 in UAT and rule 4 in Production
 * are different rules that share a number. Promoting by id would take the rule
 * the user chose and write it over an unrelated one -- an UPDATE that matches a
 * row, succeeds, reports success, and corrupts the target. Nothing downstream
 * would notice, because at every layer it looks like a rule being saved.
 *
 * So a bundle carries an **identity** instead: something stable and meaningful
 * to a person. A rule is its name. A template is its name and channel. A KYC
 * journey and an SLA policy are keyed by product, and a product travels as its
 * `code`, which is the one column in this schema that is both unique and
 * assigned by us rather than by the database.
 *
 * Applying resolves each identity against the target and creates what is not
 * there yet. That makes promotion work into an empty environment, which is what
 * a first promotion into new Production infrastructure actually is.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 * ----------------------------------
 * It does not promote data -- no leads, no clients, no users. The residency and
 * consent rules that govern those are not weaker because the mechanism is
 * convenient, and an "environment sync" that quietly carried client records is
 * exactly the incident we are already holding a report about.
 *
 * It does not delete. A bundle says what should exist, never what should not.
 * Deleting configuration in Production is a decision that deserves to be made
 * in Production, by somebody looking at what depends on it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { run, all, one, transact } from '../db.js';
import { ARTEFACTS, snapshot } from './versioning.js';

/** Promotions kept, oldest pruned. Ten, per the P2-03 requirement. */
export const KEEP = 10;

/** Bundle format version, so a future change can refuse an old bundle loudly. */
export const FORMAT = 1;

/**
 * Which environment this is.
 *
 * Unset means development. It is deliberately not inferred from NODE_ENV: a
 * UAT box and a Production box both run with NODE_ENV=production, and the whole
 * point of the label is to tell those two apart in the audit record.
 */
export const environment = () => process.env.CRM_ENVIRONMENT || 'development';

/* ------------------------------------------------------------- portability */

const productCodeOf = (id) => (id == null
  ? null
  : one('SELECT code FROM product_types WHERE id = ?', [id])?.code ?? null);

const productIdOf = (code) => (code == null
  ? null
  : one('SELECT id FROM product_types WHERE code = ?', [code])?.id ?? null);

/** Columns that belong to a row rather than to the artefact it represents. */
const LOCAL_COLUMNS = ['id', 'created_at', 'updated_at', 'product_type_id'];

const withoutLocalColumns = (payload) => Object.fromEntries(
  Object.entries(payload ?? {}).filter(([k]) => !LOCAL_COLUMNS.includes(k)),
);

/**
 * How each artefact kind crosses an environment boundary.
 *
 * `identity` is what a person would use to say which artefact they mean.
 * `resolve` finds it here and returns null if it is absent; `create` makes it
 * and returns the local logical id. Kinds whose `restore` already inserts --
 * KYC journeys rebuild their step list, SLA policies upsert -- have no `create`
 * of their own and say so with a null.
 */
const PORTABLE = {
  rule: {
    identity: (payload) => ({ name: payload.name }),
    identifiable: (id) => Boolean(id.name),
    describe: (id) => 'rule "' + id.name + '"',
    resolve: (id) => one('SELECT id FROM rules WHERE name = ?', [id.name])?.id ?? null,
    create: (id, payload) => Number(run(
      `INSERT INTO rules (name, description, conditions, actions, schedule, enabled, priority)
       VALUES (?,?,?,?,?,?,?)`,
      [id.name, payload.description ?? null, payload.conditions, payload.actions,
        payload.schedule ?? null, payload.enabled ?? 0, payload.priority ?? 100],
    ).lastInsertRowid),
    toPortable: (payload) => withoutLocalColumns(payload),
    toLocal: (payload) => payload,
  },

  template: {
    /* Name alone is not enough: the same message exists as an email and as a
       WhatsApp template, and they are different artefacts with different
       bodies. Channel is part of the identity for that reason. */
    identity: (payload) => ({ name: payload.name, channel: payload.channel }),
    /* A null product_code is fine here: a template need not belong to one. */
    identifiable: (id) => Boolean(id.name && id.channel),
    describe: (id) => id.channel + ' template "' + id.name + '"',
    resolve: (id) => one(
      'SELECT id FROM templates WHERE name = ? AND channel = ?', [id.name, id.channel],
    )?.id ?? null,
    create: (id, payload) => Number(run(
      `INSERT INTO templates (name, channel, subject, body, product_type_id, approved)
       VALUES (?,?,?,?,?,?)`,
      [id.name, id.channel, payload.subject ?? null, payload.body,
        payload.product_type_id ?? null, payload.approved ?? 0],
    ).lastInsertRowid),
    toPortable: (payload) => ({
      ...withoutLocalColumns(payload),
      product_code: productCodeOf(payload.product_type_id),
    }),
    toLocal: (payload) => {
      const { product_code: code, ...rest } = payload;
      return { ...rest, product_type_id: productIdOf(code) };
    },
  },

  kyc_journey: {
    /* The logical id IS the product, so the identity is the product's code and
       resolving it is resolving the product. A journey for a product the target
       does not have is refused rather than invented: creating the product would
       be promoting something nobody selected. */
    identity: (payload) => ({ product_code: productCodeOf(payload.product_type_id) }),
    /* No product code means the product was deleted here between the snapshot
       and the packaging. The journey cannot name what it is a journey for. */
    identifiable: (id) => Boolean(id.product_code),
    describe: (id) => 'KYC journey for product ' + id.product_code,
    resolve: (id) => productIdOf(id.product_code),
    create: null,
    toPortable: (payload) => ({ steps: payload.steps ?? [] }),
    toLocal: (payload) => payload,
  },

  sla_policy: {
    /* Keyed by product and priority, and the product may be null -- that is the
       policy that applies when nothing more specific does. A null product is
       portable as it stands; there is nothing to translate. */
    identity: (payload, logicalId) => {
      const [productId, priority] = String(logicalId).split(':');
      return {
        product_code: productId === 'null' ? null : productCodeOf(Number(productId)),
        priority,
      };
    },
    /* A null product_code is meaningful here rather than missing: it is the
       policy that applies when no product-specific one does. Only the priority
       is required. */
    identifiable: (id) => Boolean(id.priority),
    describe: (id) => 'SLA policy for ' + (id.product_code ?? 'any product') + ' / ' + id.priority,
    resolve: (id) => {
      if (id.product_code === null) return `null:${id.priority}`;
      const productId = productIdOf(id.product_code);
      return productId === null ? null : `${productId}:${id.priority}`;
    },
    create: null,
    toPortable: (payload) => withoutLocalColumns(payload),
    toLocal: (payload) => payload,
  },
};

const portable = (kind) => {
  const p = PORTABLE[kind];
  if (!p) throw new Error(`promotion: "${kind}" cannot cross an environment boundary`);
  return p;
};

/** Kinds a bundle may contain, for the UI and for validation messages. */
export const PROMOTABLE = Object.keys(PORTABLE).map((kind) => ({
  kind, label: ARTEFACTS[kind]?.label ?? kind,
}));

/* ---------------------------------------------------------------- checksum */

/** Key order must not change the checksum, so sort on the way in. */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/**
 * A checksum over the entries only.
 *
 * Not over the whole bundle: the metadata carries a note and a timestamp, and a
 * bundle whose checksum changed when somebody corrected a typo in its
 * description would train people to ignore checksum failures.
 */
export const checksumOf = (entries) => createHash('sha256')
  .update(canonical(entries)).digest('hex');

/* ------------------------------------------------------------------ export */

/**
 * Package a chosen set of artefacts into a bundle.
 *
 * `selection` is a list of `{ kind, logical_id }` -- what the operator ticked.
 * Anything unknown, unpromotable or missing is refused before a bundle is
 * produced, so a half-built bundle never exists to be carried somewhere.
 */
export function packageBundle({ selection = [], note = null, userId = null } = {}) {
  if (!Array.isArray(selection) || selection.length === 0) {
    return { ok: false, error: 'Nothing was selected to promote' };
  }

  const entries = [];
  const problems = [];

  for (const item of selection) {
    const kind = item?.kind;
    const logicalId = item?.logical_id ?? item?.logicalId;

    if (!ARTEFACTS[kind] || !PORTABLE[kind]) {
      problems.push(`"${kind}" is not something that can be promoted`);
      continue;
    }

    const live = ARTEFACTS[kind].load(logicalId);
    if (!live) {
      problems.push(`${kind} ${logicalId} no longer exists here`);
      continue;
    }

    const p = portable(kind);
    const identity = p.identity(live, logicalId);

    /* An artefact that cannot name itself portably would arrive at the far end
       as a null and resolve to nothing, or worse to something else. Each kind
       decides what "identifiable" means for it, because a null product code is
       a deleted product for a KYC journey and a deliberate default for an SLA
       policy. */
    if (!p.identifiable(identity)) {
      problems.push(`${p.describe(identity)} cannot be identified portably, so it cannot travel`);
      continue;
    }

    entries.push({ kind, identity, payload: p.toPortable(live) });
  }

  if (problems.length > 0) return { ok: false, error: problems.join('; '), problems };

  const bundle = {
    format: FORMAT,
    bundle_id: randomUUID(),
    source_env: environment(),
    created_at: new Date().toISOString(),
    note,
    checksum: checksumOf(entries),
    entries,
  };

  record({
    bundleId: bundle.bundle_id,
    direction: 'exported',
    sourceEnv: bundle.source_env,
    targetEnv: null,
    checksum: bundle.checksum,
    entryCount: entries.length,
    payload: bundle,
    note,
    userId,
  });

  return { ok: true, bundle };
}

/* -------------------------------------------------------------- validation */

/** Structural checks, run before anything is read out of a bundle. */
export function validate(bundle) {
  if (!bundle || typeof bundle !== 'object') return 'That is not a bundle';
  if (bundle.format !== FORMAT) {
    return `This bundle is format ${bundle.format ?? 'unknown'}, and this CRM reads format ${FORMAT}`;
  }
  if (!Array.isArray(bundle.entries) || bundle.entries.length === 0) {
    return 'The bundle contains nothing to apply';
  }
  if (checksumOf(bundle.entries) !== bundle.checksum) {
    return 'The bundle has been altered since it was packaged - its checksum does not match';
  }
  for (const entry of bundle.entries) {
    if (!ARTEFACTS[entry?.kind] || !PORTABLE[entry?.kind]) {
      return `The bundle contains "${entry?.kind}", which this CRM cannot apply`;
    }
  }
  return null;
}

/* ----------------------------------------------------------------- inspect */

/**
 * What applying this bundle would do, without doing any of it.
 *
 * Promotion into Production is the kind of action where the answer to "what is
 * about to change" must be available before rather than after, so this is not
 * an optional extra -- `apply` runs it first and refuses on anything blocked.
 */
export function inspect(bundle) {
  const invalid = validate(bundle);
  if (invalid) return { ok: false, error: invalid };

  const items = bundle.entries.map((entry) => {
    const p = portable(entry.kind);
    const localId = p.resolve(entry.identity);
    const describes = p.describe(entry.identity);

    if (localId === null || localId === undefined) {
      return p.create
        ? { kind: entry.kind, describes, status: 'create', changes: [] }
        : {
          kind: entry.kind,
          describes,
          status: 'blocked',
          reason: `${describes} refers to something this environment does not have`,
          changes: [],
        };
    }

    const live = ARTEFACTS[entry.kind].load(localId);
    if (!live) return { kind: entry.kind, describes, status: 'create', changes: [] };

    const here = p.toPortable(live);
    const there = entry.payload;
    const keys = [...new Set([...Object.keys(here), ...Object.keys(there)])].sort();
    const changes = keys
      .filter((k) => canonical(here[k]) !== canonical(there[k]))
      .map((field) => ({ field, from: here[field] ?? null, to: there[field] ?? null }));

    return {
      kind: entry.kind,
      describes,
      status: changes.length === 0 ? 'identical' : 'update',
      changes,
    };
  });

  const count = (status) => items.filter((i) => i.status === status).length;

  return {
    ok: true,
    bundle_id: bundle.bundle_id,
    source_env: bundle.source_env,
    target_env: environment(),
    note: bundle.note ?? null,
    items,
    summary: {
      create: count('create'),
      update: count('update'),
      identical: count('identical'),
      blocked: count('blocked'),
    },
    /* Blocked entries stop the whole apply: a partly-applied bundle leaves the
       target in a state nobody designed, and nobody can tell which half. */
    appliable: count('blocked') === 0,
  };
}

/* ------------------------------------------------------------------- apply */

/**
 * Apply a bundle to this environment.
 *
 * All of it or none of it. Configuration is interdependent -- a rule referring
 * to a template, a journey to a policy -- so applying half a bundle produces a
 * combination that was never tested anywhere.
 */
export function apply(bundle, { userId = null, note = null } = {}) {
  const preview = inspect(bundle);
  if (!preview.ok) return preview;
  if (!preview.appliable) {
    const blocked = preview.items.filter((i) => i.status === 'blocked');
    return {
      ok: false,
      error: `${blocked.length} item${blocked.length === 1 ? '' : 's'} cannot be applied here`,
      blocked,
    };
  }

  const applied = transact(() => {
    const done = [];
    for (const entry of bundle.entries) {
      const p = portable(entry.kind);
      const local = p.toLocal(entry.payload);

      let logicalId = p.resolve(entry.identity);
      let created = false;
      if (logicalId === null || logicalId === undefined) {
        logicalId = p.create(entry.identity, local);
        created = true;
      }

      ARTEFACTS[entry.kind].restore(logicalId, local);

      /* Snapshot into the TARGET's own history, so a version here reads
         "arrived from UAT in bundle x" rather than appearing as an edit nobody
         remembers making. */
      snapshot(entry.kind, logicalId, {
        note: `Promoted from ${bundle.source_env} (bundle ${String(bundle.bundle_id).slice(0, 8)})`,
        userId,
      });

      done.push({ kind: entry.kind, describes: p.describe(entry.identity), created });
    }

    record({
      bundleId: bundle.bundle_id,
      direction: 'applied',
      sourceEnv: bundle.source_env,
      targetEnv: environment(),
      checksum: bundle.checksum,
      entryCount: bundle.entries.length,
      payload: bundle,
      note: note ?? bundle.note ?? null,
      userId,
    });

    return done;
  });

  return {
    ok: true,
    bundle_id: bundle.bundle_id,
    source_env: bundle.source_env,
    target_env: environment(),
    applied,
    created: applied.filter((a) => a.created).length,
    updated: applied.filter((a) => !a.created).length,
  };
}

/* ----------------------------------------------------------------- history */

function record({
  bundleId, direction, sourceEnv, targetEnv, checksum, entryCount, payload, note, userId,
}) {
  run(
    `INSERT INTO config_promotions
       (bundle_id, direction, source_env, target_env, checksum, entry_count, payload, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [bundleId, direction, sourceEnv, targetEnv, checksum, entryCount,
      JSON.stringify(payload), note, userId],
  );
  prune();
}

/**
 * Keep the last ten, per the requirement.
 *
 * Counted over both directions together: ten promotions, not ten of each. On a
 * box that only ever exports, ten exports is the history; on Production, which
 * only ever applies, ten applies is.
 */
function prune() {
  run(
    `DELETE FROM config_promotions WHERE id NOT IN (
       SELECT id FROM config_promotions ORDER BY created_at DESC, id DESC LIMIT ?)`,
    [KEEP],
  );
}

const hydrate = (row) => (row ? { ...row, payload: JSON.parse(row.payload) } : null);

/** The promotion log, newest first. Payload included: these are small. */
export const recent = ({ limit = KEEP } = {}) => all(
  `SELECT p.*, u.name AS created_by_name FROM config_promotions p
   LEFT JOIN users u ON u.id = p.created_by
   ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
  [Math.min(Number(limit) || KEEP, KEEP)],
).map(hydrate);

export const promotionById = (id) => hydrate(one(
  `SELECT p.*, u.name AS created_by_name FROM config_promotions p
   LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`,
  [id],
));
