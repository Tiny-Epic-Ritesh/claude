/**
 * The automation builder's API (P3-16).
 *
 * Its own file rather than another two hundred lines in admin.js, which is
 * already the largest route module in the project. The Salesforce reference
 * makes the same separation — automation gets its own app, described there as
 * "your central hub for all Salesforce Automation" — and this module will keep
 * growing: versions, the canvas, migration from the rules engine.
 *
 * Two rules hold throughout:
 *
 *   Nothing goes live unvalidated. A card wired to nothing ends a flow
 *   silently, and a loop sends a client the same message until somebody
 *   notices. Both look fine on a canvas, so `validate` gates activation.
 *
 *   An automation belongs to one book. It carries client-facing copy and it
 *   routes work, so a Bigul automation must not fire on Bonanza's leads — the
 *   same boundary as every other object here.
 */

import { Router } from 'express';
import { all, one, run, audit, transact } from '../db.js';
import { requireUser, requirePermission, orgsFor, activeOrg, mayUseOrg } from '../auth.js';
import {
  TRIGGERS, STEP_KINDS, isTrigger, validate, report, whatRunsOn, enter,
} from '../engine/automation.js';
import { ACTION_TYPES } from '../engine/rules.js';
import { conditionSchema } from '../engine/conditions.js';
import { previewAll, previewRule, convertRule } from '../engine/rulemigration.js';

const router = Router();
router.use(requireUser);

/** The automation, if this person's books include it. */
function reachable(req, res, id) {
  const auto = one('SELECT * FROM automation WHERE id = ?', [id]);
  if (!auto) { res.status(404).json({ error: 'That automation does not exist' }); return null; }
  if (!mayUseOrg(req.user, auto.sales_org)) {
    res.status(403).json({ error: 'That automation belongs to another book' });
    return null;
  }
  return auto;
}

/**
 * What a flow can be built from.
 *
 * Served rather than hardcoded in the client so the vocabulary the screen
 * offers is the vocabulary the engine runs — the same reason the template
 * builder reads its limits from the server.
 */
router.get('/spec', requirePermission('admin.rules'), (req, res) => {
  const orgs = orgsFor(req.user);
  const marks = orgs.map(() => '?').join(',') || "''";

  res.json({
    triggers: TRIGGERS,
    step_kinds: STEP_KINDS,
    actions: ACTION_TYPES,
    conditions: conditionSchema(),

    /* What each id-shaped parameter can be set to.
     *
     * Without these the builder shows a text box for `template_id` and asks
     * somebody to type a number. P3-17's acceptance clause is explicit that
     * templates must be selectable from automation actions, and the same holds
     * for a list, a sub-automation and a webhook endpoint: a mistyped id is a
     * card that sends the wrong message to a client, and it looks correct on
     * the canvas.
     *
     * Scoped to this person's books, so the screen cannot offer them the other
     * business's templates. */
    pickers: {
      templates: all(
        `SELECT id, name, channel FROM templates
          WHERE (sales_org IN (${marks}) OR sales_org IS NULL) AND approved = 1
          ORDER BY channel, name`,
        orgs,
      ),
      /* Static lists only. A refreshable or dynamic list is a live query and
         its membership cannot be set by hand -- offering one would be offering
         a card that refuses at run time. */
      lists: all(
        `SELECT id, name FROM lead_lists
          WHERE kind = 'static' AND archived_at IS NULL AND sales_org IN (${marks})
          ORDER BY name`,
        orgs,
      ),
      endpoints: all(
        `SELECT id, name, url FROM webhook_endpoint
          WHERE active = 1 AND sales_org IN (${marks}) ORDER BY name`,
        orgs,
      ),
      automations: all(
        `SELECT id, name, status FROM automation
          WHERE sales_org IN (${marks}) ORDER BY name`,
        orgs,
      ),
    },
  });
});

/**
 * Everything that fires on one trigger, in the order it would run.
 *
 * The Salesforce reference calls this a Flow Trigger Explorer and names its
 * absence as the reason nobody can see what touches a field in the legacy
 * tenant, where three "Lead Updated" automations race on overlapping
 * populations. It is the screen somebody opens when an automation surprises
 * them.
 */
router.get('/explorer/:trigger', requirePermission('admin.rules'), (req, res) => {
  if (!isTrigger(req.params.trigger)) return res.status(400).json({ error: 'Not a trigger' });
  const orgs = orgsFor(req.user);
  return res.json(whatRunsOn(req.params.trigger).filter((a) => orgs.includes(a.sales_org ?? 'BONANZA')));
});

/* -------------------------------------------------- migrating the rules */

/**
 * What the rule builder holds, and what converting each would produce.
 *
 * Shipped with the engine for the reason Salesforce ships *Migrate to Flow*:
 * so the old engine can be switched off on a date rather than by attrition,
 * and so nothing is retyped by hand into a screen that sends client messages.
 */
router.get('/migration', requirePermission('admin.rules'), (_req, res) => {
  res.json({ rules: previewAll() });
});

router.get('/migration/:ruleId', requirePermission('admin.rules'), (req, res) => {
  const preview = previewRule(Number(req.params.ruleId));
  if (preview.error) return res.status(404).json(preview);
  return res.json(preview);
});

router.post('/migration/:ruleId', requirePermission('admin.rules'), (req, res) => {
  const org = req.body?.sales_org ?? activeOrg(req) ?? req.user.sales_org;
  if (!mayUseOrg(req.user, org)) return res.status(403).json({ error: 'That book is not yours' });

  const out = convertRule(Number(req.params.ruleId), {
    salesOrg: org,
    userId: req.user.id,
    everyHours: Number(req.body?.every_hours) || 24,
  });
  if (out.error) return res.status(400).json(out);
  return res.status(201).json(out);
});

/* ------------------------------------------------------------- the list */

router.get('/', requirePermission('admin.rules'), (req, res) => {
  const orgs = orgsFor(req.user);
  if (!orgs.length) return res.json([]);

  return res.json(all(
    `SELECT a.*, u.name AS created_by_name,
            (SELECT COUNT(*) FROM automation_step s WHERE s.automation_id = a.id) AS step_count,
            (SELECT COUNT(*) FROM automation_run r WHERE r.automation_id = a.id) AS entered,
            (SELECT COUNT(*) FROM automation_run r WHERE r.automation_id = a.id AND r.status = 'waiting') AS waiting
       FROM automation a
       LEFT JOIN users u ON u.id = a.created_by
      WHERE a.sales_org IN (${orgs.map(() => '?').join(',')})
      ORDER BY a.priority, a.id`,
    orgs,
  ));
});

router.get('/:id', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  return res.json({
    ...auto,
    steps: all('SELECT * FROM automation_step WHERE automation_id = ? ORDER BY sort_order, id', [auto.id]),
    problems: validate(auto.id),
    report: report(auto.id),
  });
});

/* ------------------------------------------------------------- writing */

router.post('/', requirePermission('admin.rules'), (req, res) => {
  const { name, description, trigger_type: trigger, trigger_config: config } = req.body ?? {};
  if (!String(name ?? '').trim()) return res.status(400).json({ error: 'Give the automation a name', field: 'name' });
  if (!isTrigger(trigger)) return res.status(400).json({ error: 'Choose what starts it', field: 'trigger_type' });

  /* Named on the insert rather than left to the column default — the mistake
     POST /admin/users made, where every user created anywhere became a Bonanza
     user. */
  const org = activeOrg(req) ?? req.user.sales_org;
  if (!mayUseOrg(req.user, org)) {
    return res.status(403).json({ error: `You cannot create automations in ${org ?? 'that business'}` });
  }

  const info = run(
    `INSERT INTO automation (name, description, sales_org, trigger_type, trigger_config, status, created_by)
     VALUES (?,?,?,?,?, 'draft', ?)`,
    [name.trim(), description ?? null, org, trigger, config ? JSON.stringify(config) : null, req.user.id],
  );
  const id = Number(info.lastInsertRowid);
  audit(req.user.id, 'automation_created', 'automation', id, { name, trigger });
  return res.status(201).json(one('SELECT * FROM automation WHERE id = ?', [id]));
});

router.patch('/:id', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const sets = [];
  const params = [];
  for (const [column, value] of [
    ['name', req.body.name],
    ['description', req.body.description],
    ['priority', req.body.priority],
    ['trigger_type', req.body.trigger_type],
  ]) {
    if (value !== undefined) { sets.push(`${column} = ?`); params.push(value); }
  }
  for (const [column, value] of [
    ['trigger_config', req.body.trigger_config],
    ['entry_conditions', req.body.entry_conditions],
  ]) {
    if (value !== undefined) { sets.push(`${column} = ?`); params.push(value ? JSON.stringify(value) : null); }
  }
  if (req.body.first_step_id !== undefined) {
    /* It has to be a card on this automation.
     *
     * Unchecked, a flow could be pointed at another flow's card -- or another
     * book's -- and `advance` would fail on the first lead with "step 412 no
     * longer exists". The canvas makes this reachable by ordinary use: the
     * start connector is a thing you drag, and a drag can land anywhere. */
    const target = req.body.first_step_id;
    if (target !== null) {
      const owned = one('SELECT id FROM automation_step WHERE id = ? AND automation_id = ?', [target, auto.id]);
      if (!owned) return res.status(400).json({ error: 'That is not a step on this automation', field: 'first_step_id' });
    }
    sets.push('first_step_id = ?');
    params.push(target);
  }

  if (req.body.trigger_type !== undefined && !isTrigger(req.body.trigger_type)) {
    return res.status(400).json({ error: 'Not a trigger', field: 'trigger_type' });
  }
  if (!sets.length) return res.json(auto);

  params.push(auto.id);
  run(`UPDATE automation SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, params);
  audit(req.user.id, 'automation_updated', 'automation', auto.id, req.body);
  return res.json(one('SELECT * FROM automation WHERE id = ?', [auto.id]));
});

/**
 * Delete it — but not while leads are standing inside it.
 *
 * Removing an automation with live runs strands those leads mid-flow: the rows
 * cascade away and nothing ever finishes what it started. Pause it, let them
 * drain, then delete.
 */
router.delete('/:id', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const live = one(
    "SELECT COUNT(*) n FROM automation_run WHERE automation_id = ? AND status IN ('running','waiting')",
    [auto.id],
  ).n;
  if (live) {
    return res.status(409).json({
      error: `${live} lead${live === 1 ? ' is' : 's are'} still inside this automation. Pause it and let them finish first.`,
      live,
    });
  }

  run('DELETE FROM automation WHERE id = ?', [auto.id]);
  audit(req.user.id, 'automation_deleted', 'automation', auto.id, { name: auto.name });
  return res.json({ ok: true });
});

/* --------------------------------------------------------------- steps */

router.post('/:id/steps', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const {
    kind, config, label, after,
    pos_x: posX, pos_y: posY,
    /* Dragged out of a card's exit and dropped on empty canvas: the new card is
       made and that exit is pointed at it in one go. Without this the gesture
       takes three steps -- add a card, open it, choose what precedes it -- which
       is the list all over again with a drawing on top. */
    from, exit,
  } = req.body ?? {};

  if (!STEP_KINDS.some((k) => k.kind === kind)) {
    return res.status(400).json({ error: `"${kind}" is not a kind of step`, field: 'kind' });
  }

  const order = one('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM automation_step WHERE automation_id = ?', [auto.id]).n;
  const info = run(
    'INSERT INTO automation_step (automation_id, kind, config, label, sort_order, pos_x, pos_y) VALUES (?,?,?,?,?,?,?)',
    [
      auto.id, kind, config ? JSON.stringify(config) : '{}', label ?? null, order,
      Number.isFinite(Number(posX)) ? Math.round(Number(posX)) : null,
      Number.isFinite(Number(posY)) ? Math.round(Number(posY)) : null,
    ],
  );
  const stepId = Number(info.lastInsertRowid);

  /* Inserted into the chain rather than appended to a list: a flow is a graph,
     and a card added after another has to take over that card's exit. */
  if (after) {
    const prev = one('SELECT * FROM automation_step WHERE id = ? AND automation_id = ?', [after, auto.id]);
    if (prev) {
      run('UPDATE automation_step SET next_step_id = ? WHERE id = ?', [prev.next_step_id, stepId]);
      run('UPDATE automation_step SET next_step_id = ? WHERE id = ?', [stepId, prev.id]);
    }
  } else if (from === 'flow-start') {
    /* The canvas's sentinel for "the flow begins here". Checked before the
       general case below, or it would be looked up as a step id and quietly
       wire nothing. */
    run('UPDATE automation SET first_step_id = ? WHERE id = ?', [stepId, auto.id]);
  } else if (from) {
    /* Point that one exit at the new card. Unlike `after`, the new card does
       not take over what the exit used to lead to: dragging an exit somewhere
       is how you re-route it, so it means "this now" rather than "this first,
       then what was there". */
    const source = one('SELECT * FROM automation_step WHERE id = ? AND automation_id = ?', [from, auto.id]);
    const column = exit === 'else' ? 'else_step_id' : 'next_step_id';
    if (source) run(`UPDATE automation_step SET ${column} = ? WHERE id = ?`, [stepId, source.id]);
  }

  if (!auto.first_step_id && !after && !from) {
    run('UPDATE automation SET first_step_id = ? WHERE id = ?', [stepId, auto.id]);
  }

  return res.status(201).json(one('SELECT * FROM automation_step WHERE id = ?', [stepId]));
});

router.patch('/:id/steps/:stepId', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const step = one('SELECT * FROM automation_step WHERE id = ? AND automation_id = ?', [req.params.stepId, auto.id]);
  if (!step) return res.status(404).json({ error: 'No such step on this automation' });

  const sets = [];
  const params = [];
  if (req.body.label !== undefined) { sets.push('label = ?'); params.push(req.body.label); }
  if (req.body.config !== undefined) { sets.push('config = ?'); params.push(JSON.stringify(req.body.config ?? {})); }
  for (const [column, value] of [['next_step_id', req.body.next_step_id], ['else_step_id', req.body.else_step_id]]) {
    if (value === undefined) continue;
    /* A card may not point at itself. That is the shortest possible loop and
       the step budget would catch it at run time — but refusing it here means
       nobody has to see a failed run to learn it. */
    if (value === step.id) return res.status(400).json({ error: 'A step cannot follow itself' });
    sets.push(`${column} = ?`);
    params.push(value ?? null);
  }
  if (!sets.length) return res.json(step);

  params.push(step.id);
  run(`UPDATE automation_step SET ${sets.join(', ')} WHERE id = ?`, params);
  return res.json(one('SELECT * FROM automation_step WHERE id = ?', [step.id]));
});

/**
 * Remove a step, and close the gap behind it.
 *
 * Anything pointing at it is repointed at whatever followed it. Deleting a card
 * and leaving its neighbours aimed at nothing would end the flow there for
 * every lead that arrives afterwards, silently.
 */
router.delete('/:id/steps/:stepId', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const step = one('SELECT * FROM automation_step WHERE id = ? AND automation_id = ?', [req.params.stepId, auto.id]);
  if (!step) return res.status(404).json({ error: 'No such step on this automation' });

  run('UPDATE automation_step SET next_step_id = ? WHERE next_step_id = ? AND automation_id = ?', [step.next_step_id, step.id, auto.id]);
  run('UPDATE automation_step SET else_step_id = ? WHERE else_step_id = ? AND automation_id = ?', [step.next_step_id, step.id, auto.id]);
  if (auto.first_step_id === step.id) {
    run('UPDATE automation SET first_step_id = ? WHERE id = ?', [step.next_step_id, auto.id]);
  }

  run('DELETE FROM automation_step WHERE id = ?', [step.id]);
  return res.json({ ok: true });
});

/**
 * Where every card sits, saved in one go.
 *
 * One request rather than one per card, because the first drag on a flow built
 * before the canvas existed saves the whole computed layout at once — a dozen
 * PATCHes for one gesture, any of which could half-fail and leave the picture
 * disagreeing with itself.
 *
 * Not audited. A card moved two inches left is not a configuration change, and
 * an audit log that fills with them is an audit log nobody reads.
 */
router.patch('/:id/layout', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const positions = Array.isArray(req.body?.positions) ? req.body.positions : null;
  if (!positions) return res.status(400).json({ error: 'Send a list of positions' });
  if (positions.length > 500) return res.status(400).json({ error: 'That is more cards than an automation can have' });

  const mine = new Set(
    all('SELECT id FROM automation_step WHERE automation_id = ?', [auto.id]).map((s) => s.id),
  );

  transact(() => {
    for (const p of positions) {
      /* Silently skipping a card that is not ours rather than failing the whole
         save: the client sends what it has drawn, and a card deleted in another
         tab should not lose somebody the rest of their layout. */
      if (!mine.has(Number(p.id))) continue;
      if (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) continue;
      run('UPDATE automation_step SET pos_x = ?, pos_y = ? WHERE id = ?', [
        Math.round(Number(p.x)), Math.round(Number(p.y)), Number(p.id),
      ]);
    }
  });

  return res.json({ ok: true, saved: positions.filter((p) => mine.has(Number(p.id))).length });
});

/* ------------------------------------------------------ going live */

router.post('/:id/activate', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const problems = validate(auto.id);
  if (problems.length) {
    return res.status(400).json({ error: 'This automation is not ready to run', problems });
  }

  run("UPDATE automation SET status = 'active', updated_at = datetime('now') WHERE id = ?", [auto.id]);
  audit(req.user.id, 'automation_activated', 'automation', auto.id, { name: auto.name });
  return res.json(one('SELECT * FROM automation WHERE id = ?', [auto.id]));
});

/**
 * Pause it.
 *
 * Leads already inside keep going. Pausing stops new arrivals; it does not
 * abandon people mid-flow, which would leave them having had the first message
 * and never the second.
 */
router.post('/:id/pause', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  run("UPDATE automation SET status = 'paused', updated_at = datetime('now') WHERE id = ?", [auto.id]);
  audit(req.user.id, 'automation_paused', 'automation', auto.id, { name: auto.name });

  const live = one("SELECT COUNT(*) n FROM automation_run WHERE automation_id = ? AND status IN ('running','waiting')", [auto.id]).n;
  return res.json({
    ...one('SELECT * FROM automation WHERE id = ?', [auto.id]),
    note: live ? `${live} lead${live === 1 ? '' : 's'} already inside will finish. No new leads will enter.` : null,
  });
});

/* ------------------------------------------------------ what happened */

router.get('/:id/report', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;
  return res.json(report(auto.id));
});

router.get('/:id/runs', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  return res.json(all(
    `SELECT r.*, l.name AS lead_name, s.label AS step_label, s.kind AS step_kind
       FROM automation_run r
       LEFT JOIN leads l ON l.id = r.lead_id
       LEFT JOIN automation_step s ON s.id = r.step_id
      WHERE r.automation_id = ?
      ORDER BY r.entered_at DESC, r.id DESC LIMIT 50`,
    [auto.id],
  ));
});

router.get('/:id/runs/:runId', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const r = one('SELECT * FROM automation_run WHERE id = ? AND automation_id = ?', [req.params.runId, auto.id]);
  if (!r) return res.status(404).json({ error: 'No such run' });

  return res.json({
    ...r,
    steps: all(
      `SELECT rs.*, s.label, s.kind FROM automation_run_step rs
         LEFT JOIN automation_step s ON s.id = rs.step_id
        WHERE rs.run_id = ? ORDER BY rs.id`,
      [r.id],
    ),
  });
});

/**
 * Put one lead through it now, whatever its status.
 *
 * The way to find out what a flow does before turning it on for everybody. It
 * really runs — the actions are real — so the screen says so plainly rather
 * than calling it a preview.
 */
router.post('/:id/test', requirePermission('admin.rules'), (req, res) => {
  const auto = reachable(req, res, req.params.id);
  if (!auto) return undefined;

  const leadId = Number(req.body?.lead_id);
  if (!leadId) return res.status(400).json({ error: 'Which lead?', field: 'lead_id' });

  const lead = one('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL', [leadId]);
  if (!lead) return res.status(404).json({ error: 'That lead does not exist' });
  if (!mayUseOrg(req.user, lead.sales_org)) {
    return res.status(403).json({ error: 'That lead is in a book you do not hold' });
  }

  const out = enter(auto.id, leadId, { force: true });
  if (!out) {
    return res.status(409).json({
      error: 'The lead did not enter — it may already be inside, or it fails the entry conditions.',
    });
  }

  audit(req.user.id, 'automation_tested', 'automation', auto.id, { lead_id: leadId, run: out.id });
  return res.json(out);
});

export default router;
