import { useState } from 'react';
import { api, ROLE_LABEL, dateTime } from '../../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Icon, announce } from '../../components/ui.jsx';
import { ArchiveOrDelete } from '../../components/Lifecycle.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

/* ---------------------------------------------------------------- rules */

export function Rules() {
  const [data, { loading, reload, error: loadError }] = useApi('/admin/rules');
  const [meta] = useApi('/meta');
  const [result, setResult] = useState(null);
  const [editing, setEditing] = useState(null);   // rule | 'new'
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(null);
  const [done, setDone] = useState(null);
  const [problem, setProblem] = useState(null);
  if (loadError) return <ErrorBanner error={loadError} />;
  if (loading || !data) return <Loading />;

  /* QA-37: archived rules are kept, read-only, out of the way. */
  const live = data.rules.filter((r) => !r.archived_at);
  const archived = data.rules.filter((r) => r.archived_at);
  const restore = async (r) => {
    setProblem(null);
    try { await api.post(`/admin/rules/${r.id}/restore`); setDone(`"${r.name}" is restored, switched off.`); reload(); }
    catch (err) { setProblem(err.message); }
  };

  const dryRun = async (id) => {
    setBusy(true);
    try { setResult(await api.post(`/admin/rules/${id}/run`, { dry_run: true })); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="notice">
        IF / AND / THEN automation. A rule acts on a lead once, when the lead starts to match, and again only after it has stopped matching — or on the interval you set.{' '}
        <strong>Dry-run</strong> evaluates every lead and reports what would happen without sending anything.
      </div>

      <div className="row-between" style={{ marginBottom: 'var(--gap)' }}>
        <span className="tiny muted">{live.length} rules · {live.filter((r) => r.enabled).length} enabled{archived.length ? ` · ${archived.length} archived` : ''}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
          <Icon name="add" /> New rule
        </button>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {done && <div className="notice notice-ok" style={{ marginBottom: 'var(--gap)' }}><Icon name="check_circle" size={17} /> <span>{done}</span></div>}

      <div className="stack">
        {live.map((r) => (
          <section className="card" key={r.id}>
            <div className="card-head">
              <div>
                <h2>{r.name}</h2>
                <div className="tiny muted">{r.description}</div>
              </div>
              <div className="row">
                <span className={`badge ${r.enabled ? 'badge-green' : ''}`}>{r.enabled ? 'Enabled' : 'Disabled'}</span>
                <span className="badge" title="Times this rule has acted on a lead">fired {r.fire_count}×</span>
                {r.open_firings > 0 && (
                  <span className="badge" title="Leads it has acted on that still match. It does not act on them again until they stop matching.">
                    holding {r.open_firings}
                  </span>
                )}
                <button className="btn-sm" disabled={busy} onClick={() => dryRun(r.id)}>Dry run</button>
                <button className="btn-sm" onClick={() => setEditing(r)}>Edit</button>
                <button className="btn-sm" onClick={async () => {
                  await api.post('/admin/rules', {
                    name: `${r.name} (copy)`, description: r.description,
                    conditions: r.conditions, actions: r.actions, schedule: r.schedule, enabled: 0, priority: r.priority,
                  });
                  // Part 4, item 8.4.
                  announce('Rule copied', [`"${r.name} (copy)" is made, switched off. Nothing runs until it is enabled.`]);
                  reload();
                }}>Duplicate</button>
                <button className="btn-sm" onClick={async () => {
                  await api.patch(`/admin/rules/${r.id}`, { enabled: r.enabled ? 0 : 1 });
                  announce(r.enabled ? 'Rule disabled' : 'Rule enabled', [r.enabled
                    ? `"${r.name}" acts on nothing until it is enabled again.`
                    : `"${r.name}" acts on leads that match it from now on.`]);
                  reload();
                }}>
                  {r.enabled ? 'Disable' : 'Enable'}
                </button>
                {/* QA-37: switched off, then archived; deleted only as a draft
                    that was never switched on. */}
                {!r.enabled && (r.first_enabled_at || r.fire_count > 0
                  ? <button className="btn-ghost btn-sm" onClick={() => setEnding({ rule: r, what: 'archiving' })}>Archive</button>
                  : <button className="btn-ghost btn-sm" onClick={() => setEnding({ rule: r, what: 'deleting' })}>Delete</button>)}
              </div>
            </div>
            <div className="card-body">
              <div className="small">
                <strong>IF</strong>{' '}
                {r.conditions.map((c, i) => (
                  <span key={i}>
                    {i > 0 && <em className="muted"> {c.join || 'AND'} </em>}
                    <code>{c.field}{c.product_code ? `(${c.product_code})` : ''} {c.op} {String(c.value)}</code>
                  </span>
                ))}
              </div>
              <div className="small" style={{ marginTop: 6 }}>
                <strong>THEN</strong>{' '}
                {r.actions.map((a, i) => (
                  <span key={i} className="badge badge-blue" style={{ marginRight: 4 }}>
                    {a.type}{Number(a.after_minutes) > 0 ? ` · after ${delayLabel(a.after_minutes)}` : ''}
                  </span>
                ))}
              </div>
              <div className="tiny muted" style={{ marginTop: 6 }}>{scheduleWords(r.schedule)}</div>
            </div>
          </section>
        ))}
      </div>

      {archived.length > 0 && (
        <details className="card" style={{ marginTop: 'var(--gap)', padding: '10px 14px' }}>
          <summary className="small">{archived.length} archived rule{archived.length === 1 ? '' : 's'}</summary>
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {archived.map((r) => (
              <div key={r.id} className="row-between">
                <div>
                  <strong className="small">{r.name}</strong>
                  <div className="tiny muted">
                    Archived {dateTime(r.archived_at)}{r.archive_reason ? ` — ${r.archive_reason}` : ''} · fired {r.fire_count}×
                  </div>
                </div>
                <button className="btn-ghost btn-sm" onClick={() => restore(r)}>Restore</button>
              </div>
            ))}
          </div>
        </details>
      )}

      {ending && (
        <ArchiveOrDelete
          confirmLabel="Type the rule’s name to confirm"
          name={ending.rule.name}
          what={ending.what}
          archivePath={`/admin/rules/${ending.rule.id}/archive`}
          deletePath={`/admin/rules/${ending.rule.id}`}
          archiveNote="It stays switched off and read-only, with its history, and leaves this list. It can be restored."
          deleteNote="This removes a draft that was never switched on. A rule that has run is kept as the record of what it did, and is archived instead."
          onSwitch={(what) => setEnding({ ...ending, what })}
          onClose={() => setEnding(null)}
          onDone={(message) => { setEnding(null); setDone(message); reload(); }}
        />
      )}

      {editing && (
        <RuleBuilder
          rule={editing === 'new' ? null : editing}
          fields={data.condition_fields}
          actionTypes={data.action_types}
          templates={meta?.templates ?? []}
          products={meta?.products ?? []}
          onClose={() => setEditing(null)}
          onSaved={(id, thenDryRun) => {
            setEditing(null);
            announce('Rule saved', [thenDryRun ? 'The dry run below shows what it would do. Nothing was sent.' : 'Saved as it stands; whether it runs is the Enable switch.']);
            reload();
            if (thenDryRun) dryRun(id);
          }}
        />
      )}

      {result && (
        <Modal
          title={`Dry run — ${result.rule}`}
          subtitle={`${result.matched_count} of ${result.evaluated} leads match. ${result.fired_count} would be acted on now, ${result.already_count} already have been, ${result.waiting_count} waiting. Nothing was sent.`}
          onClose={() => setResult(null)}
          wide
        >
          {!result.matched.length ? <Empty>No leads matched these conditions.</Empty> : (
            <table>
              <thead><tr><th>Lead</th><th>What would happen now</th></tr></thead>
              <tbody>
                {result.matched.map((m) => (
                  <tr key={m.lead_id}>
                    <td style={{ fontWeight: 545 }}>{m.lead_name}</td>
                    <td className="small">
                      {m.state === 'would_fire' && m.actions.map((a, i) => (
                        <div key={i}><span className="badge badge-blue">{a.action}</span> <span className="muted">{JSON.stringify(a.params).slice(0, 120)}</span></div>
                      ))}
                      {m.state === 'already_fired' && <span className="muted">Already acted on. Nothing more until this lead stops matching.</span>}
                      {m.state === 'scheduled' && <span className="muted">Already acted on; a later step is still to come.</span>}
                      {m.state === 'armed' && <span className="muted">Starts now; its first step is delayed.</span>}
                      {m.state === 'waiting' && <span className="muted">Waiting: {m.reason}.</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------- rule builder */

/**
 * Building an automation without writing JSON.
 *
 * The screen was read-only: you could see a rule, dry-run it and toggle it, but
 * the only way to create one was a POST by hand. That is the difference between
 * a platform an operations lead can change and one that needs a developer for
 * every "chase leads that went quiet".
 *
 * The vocabulary comes from the server — `condition_fields` and `action_types`
 * ride along on GET /admin/rules — so this form does not know what a rule means.
 * Adding a condition field or an action type on the server makes it appear here
 * with no change to this file.
 *
 * DRY RUN IS THE PRIMARY BUTTON, NOT SAVE
 * ---------------------------------------
 * A rule that fires on 495,118 leads is a rule you want to have tested first.
 * The builder makes dry-run the obvious path and creates every rule disabled,
 * so the sequence is always: build, see who it would hit, then enable. Nothing
 * a person types here can send a message until they deliberately turn it on.
 */

const OPS_BY_TYPE = {
  number: [['gt', 'is greater than'], ['gte', 'is at least'], ['lt', 'is less than'],
    ['lte', 'is at most'], ['eq', 'equals'], ['neq', 'does not equal']],
  text: [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains'], ['in', 'is any of']],
  enum: [['eq', 'is'], ['neq', 'is not'], ['in', 'is any of']],
  bool: [['eq', 'is']],
  card: [['eq', 'is'], ['neq', 'is not']],
};

const blankCondition = () => ({ field: '', op: 'eq', value: '', join: 'AND' });
const blankAction = () => ({ type: '', params: {} });

function RuleBuilder({ rule, fields, actionTypes, templates, products, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: rule?.name ?? '',
    description: rule?.description ?? '',
    priority: rule?.priority ?? 100,
  });
  const [conditions, setConditions] = useState(
    rule?.conditions?.length ? rule.conditions.map((c) => ({ ...c })) : [blankCondition()],
  );
  const [actions, setActions] = useState(
    rule?.actions?.length ? rule.actions.map((a) => ({ ...a, params: { ...a.params } })) : [blankAction()],
  );
  /* QA-02. The schedule was stored on every rule and read by nothing; the
     builder never showed it. It is now how a rule fires, so it is on screen. */
  const [schedule, setSchedule] = useState({
    business_hours: false, skip_weekends: false, max_per_day: '', repeat_hours: '',
    ...(rule?.schedule ?? {}),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fieldDef = (name) => fields.find((f) => f.field === name);

  const setCond = (i, patch) => setConditions((cs) =>
    cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const setAct = (i, patch) => setActions((as) =>
    as.map((a, n) => (n === i ? { ...a, ...patch } : a)));

  /** Complete enough to save? Reported inline rather than on submit. */
  const problems = [];
  if (!form.name.trim()) problems.push('Give the rule a name');
  conditions.forEach((c, i) => {
    if (!c.field) problems.push(`Condition ${i + 1} has no field`);
    else if (c.value === '' && c.op !== 'is_blank') problems.push(`Condition ${i + 1} has no value`);
  });
  actions.forEach((a, i) => {
    if (!a.type) problems.push(`Action ${i + 1} has no type`);
  });

  async function save(thenDryRun) {
    setBusy(true); setError(null);
    try {
      const body = {
        ...form,
        conditions,
        actions,
        schedule: {
          ...schedule,
          max_per_day: Number(schedule.max_per_day) > 0 ? Number(schedule.max_per_day) : null,
          repeat_hours: Number(schedule.repeat_hours) > 0 ? Number(schedule.repeat_hours) : null,
        },
        // Always created disabled. Enabling is a separate, deliberate click.
        enabled: rule?.enabled ?? 0,
      };
      const saved = rule
        ? (await api.patch(`/admin/rules/${rule.id}`, body), { id: rule.id })
        : await api.post('/admin/rules', body);
      onSaved(saved.id, thenDryRun);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal
      title={rule ? `Edit — ${rule.name}` : 'New automation rule'}
      subtitle="Nothing runs until you enable it. Dry-run first."
      onClose={onClose}
      wide
    >
      <div className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <label className="span-2">
          <span>What does this rule do?</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Chase leads that have gone quiet for a week" autoFocus />
        </label>

        <label className="span-2">
          <span>Notes <span className="muted">(optional)</span></span>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Why this exists, and who asked for it" />
        </label>

        {/* ---------------------------------------------------- IF */}
        <div className="span-2 rule-block">
          <div className="rule-block-head">
            <span className="rule-kw">IF</span>
            <span className="tiny muted">every condition must hold unless you set OR</span>
          </div>

          {conditions.map((c, i) => {
            const def = fieldDef(c.field);
            const ops = OPS_BY_TYPE[def?.type ?? 'text'] ?? OPS_BY_TYPE.text;
            return (
              <div key={i} className="rule-row">
                {i > 0 && (
                  <select
                    className="rule-join"
                    value={c.join ?? 'AND'}
                    onChange={(e) => setCond(i, { join: e.target.value })}
                  >
                    <option>AND</option>
                    <option>OR</option>
                  </select>
                )}
                {i === 0 && <span className="rule-join is-first">when</span>}

                <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value, value: '' })}>
                  <option value="">Choose a field…</option>
                  {fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
                </select>

                <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} disabled={!c.field}>
                  {ops.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>

                {/* The value control follows the field's type, so a picklist
                    never invites free text and a boolean never invites a date. */}
                {def?.type === 'enum' ? (
                  <select value={c.value} onChange={(e) => setCond(i, { value: e.target.value })}>
                    <option value="">Choose…</option>
                    {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : def?.type === 'bool' ? (
                  <select value={String(c.value)} onChange={(e) => setCond(i, { value: e.target.value === 'true' })}>
                    <option value="true">yes</option>
                    <option value="false">no</option>
                  </select>
                ) : def?.type === 'card' ? (
                  <>
                    <select value={c.product_code ?? ''} onChange={(e) => setCond(i, { product_code: e.target.value })}>
                      <option value="">any product</option>
                      {products.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                    </select>
                    <select value={c.value} onChange={(e) => setCond(i, { value: e.target.value })}>
                      <option value="">Choose a state…</option>
                      {['INACTIVE', 'EXPLORING', 'WARM', 'PRODUCT_RM_ENGAGED', 'ACTIVE', 'ON_HOLD', 'LOST']
                        .map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </>
                ) : (
                  <input
                    type={def?.type === 'number' ? 'number' : 'text'}
                    value={c.value}
                    onChange={(e) => setCond(i, { value: def?.type === 'number' ? Number(e.target.value) : e.target.value })}
                    placeholder={def?.type === 'number' ? '7' : 'value'}
                    disabled={!c.field}
                  />
                )}

                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Remove condition ${i + 1}`}
                  disabled={conditions.length === 1}
                  onClick={() => setConditions((cs) => cs.filter((_, n) => n !== i))}
                >
                  <Icon name="close" />
                </button>
              </div>
            );
          })}

          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => setConditions((cs) => [...cs, blankCondition()])}>
            <Icon name="add" /> Add condition
          </button>
        </div>

        {/* -------------------------------------------------- THEN */}
        <div className="span-2 rule-block">
          <div className="rule-block-head">
            <span className="rule-kw is-then">THEN</span>
            <span className="tiny muted">run these, in order, when a lead starts to match. A later step can wait, and runs only if the lead still matches by then.</span>
          </div>

          {actions.map((a, i) => {
            const def = actionTypes.find((t) => t.type === a.type);
            return (
              <div key={i} className="rule-row is-action">
                <select value={a.type} onChange={(e) => setAct(i, { type: e.target.value, params: {} })}>
                  <option value="">Choose an action…</option>
                  {actionTypes.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                </select>

                {i > 0 && (
                  <select
                    aria-label={`When action ${i + 1} runs`}
                    value={a.after_minutes ?? 0}
                    onChange={(e) => setAct(i, { after_minutes: Number(e.target.value) || undefined })}
                  >
                    {DELAYS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
                  </select>
                )}
                {(def?.params ?? []).map((p) => (
                  <ActionParam
                    key={p}
                    name={p}
                    value={a.params?.[p] ?? ''}
                    templates={templates}
                    actionType={a.type}
                    onChange={(v) => setAct(i, { params: { ...a.params, [p]: v } })}
                  />
                ))}

                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Remove action ${i + 1}`}
                  disabled={actions.length === 1}
                  onClick={() => setActions((as) => as.filter((_, n) => n !== i))}
                >
                  <Icon name="close" />
                </button>
              </div>
            );
          })}

          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => setActions((as) => [...as, blankAction()])}>
            <Icon name="add" /> Add action
          </button>
        </div>

        {/* ---------------------------------------------------- WHEN */}
        <div className="span-2 rule-block">
          <div className="rule-block-head">
            <span className="rule-kw">WHEN</span>
            <span className="tiny muted">how often it may act on the same lead</span>
          </div>
          <div className="rule-row">
            <select
              aria-label="Repeat"
              value={Number(schedule.repeat_hours) > 0 ? 'interval' : 'once'}
              onChange={(e) => setSchedule({ ...schedule, repeat_hours: e.target.value === 'interval' ? (Number(schedule.repeat_hours) || 24) : '' })}
            >
              <option value="once">Once each time a lead starts to match</option>
              <option value="interval">Again while it still matches, every…</option>
            </select>
            {Number(schedule.repeat_hours) > 0 && (
              <select aria-label="Repeat every" value={schedule.repeat_hours} onChange={(e) => setSchedule({ ...schedule, repeat_hours: Number(e.target.value) })}>
                {[4, 12, 24, 48, 72, 168].map((h) => <option key={h} value={h}>{h < 24 ? `${h} hours` : `${h / 24} day${h > 24 ? 's' : ''}`}</option>)}
              </select>
            )}
          </div>
          <div className="rule-row">
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={Boolean(schedule.business_hours)} onChange={(e) => setSchedule({ ...schedule, business_hours: e.target.checked })} />
              <span className="small">Only during office hours</span>
            </label>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={Boolean(schedule.skip_weekends)} onChange={(e) => setSchedule({ ...schedule, skip_weekends: e.target.checked })} />
              <span className="small">Not on Saturday or Sunday</span>
            </label>
            <label className="row" style={{ gap: 6 }}>
              <span className="small">At most</span>
              <input
                type="number" min="1" style={{ width: 70 }} value={schedule.max_per_day ?? ''}
                onChange={(e) => setSchedule({ ...schedule, max_per_day: e.target.value })}
                aria-label="At most this many times a day for one lead"
              />
              <span className="small">a day for one lead</span>
            </label>
          </div>
        </div>

        {problems.length > 0 && (
          <div className="glass notice notice-warn span-2">
            <Icon name="edit_note" />
            <div className="tiny">{problems.slice(0, 3).join(' · ')}</div>
          </div>
        )}

        <div className="glass notice span-2">
          <Icon name="shield" />
          <div className="tiny">
            Messaging actions still respect marketing opt-outs and invalid numbers.
            A rule cannot send to someone the CRM would otherwise refuse.
          </div>
        </div>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy || problems.length > 0}
            onClick={() => save(false)}>
            {busy ? <Spinner /> : 'Save as draft'}
          </button>
          {/* The primary action is to test, not to ship. */}
          <button type="button" className="btn btn-primary" disabled={busy || problems.length > 0}
            onClick={() => save(true)}>
            {busy ? <Spinner /> : 'Save and dry-run'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** How long a later step waits after the rule first acts (QA-02). */
const DELAYS = [[0, 'straight away'], [30, 'after 30 minutes'], [60, 'after 1 hour'], [240, 'after 4 hours'], [1440, 'after 1 day']];
const delayLabel = (m) => DELAYS.find(([v]) => v === Number(m))?.[1].replace('after ', '') ?? `${m} minutes`;

/** A rule's schedule, as a sentence. */
function scheduleWords(s) {
  const parts = [Number(s?.repeat_hours) > 0
    ? `Acts on a lead when it starts to match, and again every ${s.repeat_hours} hours while it still matches`
    : 'Acts on a lead once, when it starts to match'];
  if (s?.business_hours) parts.push('office hours only');
  if (s?.skip_weekends) parts.push('not at weekends');
  if (Number(s?.max_per_day) > 0) parts.push(`at most ${s.max_per_day} a day per lead`);
  return `${parts.join(' · ')}.`;
}

/** One action parameter, rendered by what it is rather than as raw text. */
function ActionParam({ name, value, templates, actionType, onChange }) {
  if (name === 'template_id') {
    const opts = templates.filter((t) => t.channel === actionType);
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a template…</option>
        {opts.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    );
  }
  if (name === 'due_in_hours') {
    return (
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {[1, 4, 24, 48, 72, 168].map((h) => (
          <option key={h} value={h}>{h < 24 ? `in ${h}h` : `in ${h / 24} day${h > 24 ? 's' : ''}`}</option>
        ))}
      </select>
    );
  }
  if (name === 'role_or_user' || name === 'assignee' || name === 'role') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        <option value="owner">the lead&apos;s owner</option>
        {name === 'assignee' && <option value="kyc_product_rm">the Product RM on the lead&apos;s KYC journey</option>}
        {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    );
  }
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={name.replace(/_/g, ' ')}
    />
  );
}
