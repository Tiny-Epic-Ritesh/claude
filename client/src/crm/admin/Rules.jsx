import { useState } from 'react';
import { api, ROLE_LABEL } from '../../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Icon } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Rules() {
  const [data, { loading, reload }] = useApi('/admin/rules');
  const [meta] = useApi('/meta');
  const [result, setResult] = useState(null);
  const [editing, setEditing] = useState(null);   // rule | 'new'
  const [busy, setBusy] = useState(false);
  if (loading || !data) return <Loading />;

  const dryRun = async (id) => {
    setBusy(true);
    try { setResult(await api.post(`/admin/rules/${id}/run`, { dry_run: true })); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="notice">
        IF / AND / THEN automation. <strong>Dry-run</strong> evaluates every lead and reports what would happen without sending anything.
      </div>

      <div className="row-between" style={{ marginBottom: 'var(--gap)' }}>
        <span className="tiny muted">{data.rules.length} rules · {data.rules.filter((r) => r.enabled).length} enabled</span>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
          <Icon name="add" /> New rule
        </button>
      </div>

      <div className="stack">
        {data.rules.map((r) => (
          <section className="card" key={r.id}>
            <div className="card-head">
              <div>
                <h2>{r.name}</h2>
                <div className="tiny muted">{r.description}</div>
              </div>
              <div className="row">
                <span className={`badge ${r.enabled ? 'badge-green' : ''}`}>{r.enabled ? 'Enabled' : 'Disabled'}</span>
                <span className="badge">fired {r.fire_count}×</span>
                <button className="btn-sm" disabled={busy} onClick={() => dryRun(r.id)}>Dry run</button>
                <button className="btn-sm" onClick={() => setEditing(r)}>Edit</button>
                <button className="btn-sm" onClick={async () => {
                  await api.post('/admin/rules', {
                    name: `${r.name} (copy)`, description: r.description,
                    conditions: r.conditions, actions: r.actions, enabled: 0, priority: r.priority,
                  });
                  reload();
                }}>Duplicate</button>
                <button className="btn-sm" onClick={async () => { await api.patch(`/admin/rules/${r.id}`, { enabled: r.enabled ? 0 : 1 }); reload(); }}>
                  {r.enabled ? 'Disable' : 'Enable'}
                </button>
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
                {r.actions.map((a, i) => <span key={i} className="badge badge-blue" style={{ marginRight: 4 }}>{a.type}</span>)}
              </div>
            </div>
          </section>
        ))}
      </div>

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
            reload();
            if (thenDryRun) dryRun(id);
          }}
        />
      )}

      {result && (
        <Modal title={`Dry run — ${result.rule}`} subtitle={`${result.matched_count} of ${result.evaluated} leads matched. Nothing was sent.`} onClose={() => setResult(null)} wide>
          {!result.matched.length ? <Empty>No leads matched these conditions.</Empty> : (
            <table>
              <thead><tr><th>Lead</th><th>Actions that would run</th></tr></thead>
              <tbody>
                {result.matched.map((m) => (
                  <tr key={m.lead_id}>
                    <td style={{ fontWeight: 545 }}>{m.lead_name}</td>
                    <td className="small">
                      {m.actions.map((a, i) => (
                        <div key={i}><span className="badge badge-blue">{a.action}</span> <span className="muted">{JSON.stringify(a.params).slice(0, 120)}</span></div>
                      ))}
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

/* ------------------------------------------------------------------ SLA */

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
            <span className="tiny muted">run these, in order, for every lead that matched</span>
          </div>

          {actions.map((a, i) => {
            const def = actionTypes.find((t) => t.type === a.type);
            return (
              <div key={i} className="rule-row is-action">
                <select value={a.type} onChange={(e) => setAct(i, { type: e.target.value, params: {} })}>
                  <option value="">Choose an action…</option>
                  {actionTypes.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                </select>

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
