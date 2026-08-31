/**
 * Validation rules for one object.
 *
 * A rule refuses a save when its condition MATCHES. The condition describes
 * what is wrong, not what is required — "refuse when Stage is Won and PAN is
 * empty" rather than "require PAN when Stage is Won". Both say the same thing,
 * and only the first can be read off the screen without inverting it.
 *
 * The screen leans on that hard: the heading of the condition block is
 * "Refuse the save when", so the sentence reads straight through into the
 * clauses beneath it. Getting this backwards is the single most common way a
 * validation feature ends up switched off.
 *
 * Every rule shows how many stored records it would already refuse. That is
 * almost never zero and almost always a surprise, and it matters more than it
 * looks: a rule refusing four hundred existing records blocks every edit to all
 * of them, including the edit that would fix them.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Modal, Spinner, Empty } from '../components/ui.jsx';

export default function ValidationRules({ entity }) {
  const [data, { loading, error, reload }] = useApi(`/setup/objects/${entity}/validation-rules`);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState(null);

  if (loading || !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const close = () => { setEditing(null); setAdding(false); reload(); };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      <div className="card-head">
        <div>
          <h2>Validation rules</h2>
          <span className="tiny muted">
            Refused at the API, on every write — imports and automation included, not
            just this form.
          </span>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          <Icon name="add" size={15} /> New rule
        </button>
      </div>

      {!data.rules.length && (
        <Empty>No rules. Every save of this object is accepted as long as its fields are the right shape.</Empty>
      )}

      {Boolean(data.rules.length) && (
        <table>
          <thead>
            <tr><th>Rule</th><th>Refuses when</th><th>Applies to</th><th /><th /></tr>
          </thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r.id} style={r.active ? undefined : { opacity: 0.55 }}>
                <td>
                  <div style={{ fontWeight: 550 }}>{r.name}</div>
                  <div className="tiny muted">{r.message}</div>
                </td>
                <td className="small">{describe(r.condition, data)}</td>
                <td className="small">{r.sales_org || 'Both businesses'}</td>
                <td>{!r.active && <span className="badge badge-amber">Off</span>}</td>
                <td className="num">
                  <button className="btn-sm" onClick={() => setEditing(r)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(adding || editing) && (
        <RuleEditor
          entity={entity}
          rule={editing}
          meta={data}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSaved={close}
          onError={setProblem}
        />
      )}
    </div>
  );
}

/** The condition as a sentence, using labels rather than api names. */
function describe(condition, meta) {
  if (!condition) return <em className="muted">unreadable</em>;
  const mode = Array.isArray(condition.any) ? 'any' : 'all';
  const clauses = condition[mode] ?? [];
  const label = (n) => meta.fields.find((f) => f.api_name === n)?.label ?? n;
  const opLabel = (o) => meta.operators.find((x) => x.op === o)?.label ?? o;

  return clauses.map((c, i) => (
    <span key={`${c.field}-${i}`}>
      {i > 0 && <em className="muted"> {mode === 'any' ? 'or' : 'and'} </em>}
      <strong>{label(c.field)}</strong> {opLabel(c.op)}
      {c.value !== undefined && c.value !== '' && <> “{String(c.value)}”</>}
    </span>
  ));
}

/* --------------------------------------------------------------- editor */

const BLANK = { field: '', op: 'is_blank', value: '' };

function RuleEditor({ entity, rule, meta, onClose, onSaved, onError }) {
  const isNew = !rule;
  const [form, setForm] = useState({
    name: rule?.name ?? '',
    message: rule?.message ?? '',
    mode: Array.isArray(rule?.condition?.any) ? 'any' : 'all',
    clauses: (rule?.condition?.any ?? rule?.condition?.all ?? [{ ...BLANK }]).map((c) => ({ ...c })),
    active: rule ? Boolean(rule.active) : true,
  });
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setClause = (i, patch) => setForm((f) => ({
    ...f,
    clauses: f.clauses.map((c, j) => (j === i ? { ...c, ...patch } : c)),
  }));

  const condition = () => ({ [form.mode]: form.clauses.filter((c) => c.field) });

  const complete = form.name.trim() && form.message.trim() && form.clauses.some((c) => c.field);

  const preview = async () => {
    setImpact(null);
    try {
      const r = await api.post(`/setup/objects/${entity}/validation-rules/preview`, { condition: condition() });
      setImpact(r);
    } catch (err) { onError(err.message); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: form.name, message: form.message, condition: condition() };
      if (isNew) await api.post(`/setup/objects/${entity}/validation-rules`, body);
      else await api.patch(`/setup/validation-rules/${rule.id}`, { ...body, active: form.active ? 1 : 0 });
      onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await api.del(`/setup/validation-rules/${rule.id}`); onSaved(); }
    catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'New validation rule' : rule.name} onClose={onClose} wide>
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)}
            placeholder="PAN before Won" maxLength={80} />
          <span className="tiny muted">For administrators. Nobody saving a record sees this.</span>
        </label>

        <div className="field">
          <span className="field-label">Refuse the save when</span>
          {/* The heading and the clauses are one sentence. A rule reads
              forwards or it gets written backwards. */}
          {form.clauses.length > 1 && (
            <div className="scope-options" style={{ marginBottom: 8 }}>
              {[['all', 'All of these are true'], ['any', 'Any of these is true']].map(([v, l]) => (
                <button key={v} type="button"
                  className={`scope-opt ${form.mode === v ? 'is-on' : ''}`}
                  onClick={() => set('mode', v)}>
                  <strong>{l}</strong>
                </button>
              ))}
            </div>
          )}

          <div className="stack" style={{ gap: 8 }}>
            {form.clauses.map((c, i) => {
              const field = meta.fields.find((f) => f.api_name === c.field);
              const op = meta.operators.find((o) => o.op === c.op);
              return (
                <div key={i} className="clause-row">
                  <select value={c.field} onChange={(e) => setClause(i, { field: e.target.value })}>
                    <option value="">Choose a field…</option>
                    {meta.fields.map((f) => (
                      <option key={f.api_name} value={f.api_name}>{f.label}</option>
                    ))}
                  </select>

                  <select value={c.op} onChange={(e) => setClause(i, { op: e.target.value, value: '' })}>
                    {meta.operators.map((o) => (
                      <option key={o.op} value={o.op}>{o.label}</option>
                    ))}
                  </select>

                  {op?.takes_value ? (
                    field?.values?.length && !op.numeric ? (
                      <select value={c.value ?? ''} onChange={(e) => setClause(i, { value: e.target.value })}>
                        <option value="">Choose…</option>
                        {field.values.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    ) : (
                      <input
                        value={c.value ?? ''}
                        onChange={(e) => setClause(i, { value: e.target.value })}
                        placeholder={op.numeric ? 'a number' : op.list ? 'comma, separated, values' : 'value'}
                      />
                    )
                  ) : <span className="tiny muted" style={{ alignSelf: 'center' }}>no value needed</span>}

                  <button className="btn-ghost btn-sm" disabled={form.clauses.length === 1}
                    onClick={() => set('clauses', form.clauses.filter((_, j) => j !== i))}
                    aria-label="Remove this condition">
                    <Icon name="close" size={15} />
                  </button>
                </div>
              );
            })}
          </div>

          <button className="btn-ghost btn-sm" style={{ marginTop: 8 }}
            onClick={() => set('clauses', [...form.clauses, { ...BLANK }])}>
            <Icon name="add" size={14} /> Add a condition
          </button>
        </div>

        <label>
          <span>What the person saving reads</span>
          <input value={form.message} onChange={(e) => set('message', e.target.value)}
            placeholder="A lead cannot be marked Won without a PAN — the account cannot be opened without one."
            maxLength={300} />
          <span className="tiny muted">
            Say what is wrong and what to do about it. This is the whole of what they see.
          </span>
        </label>

        {/* Almost never zero, and worth knowing before rather than after. */}
        <div className="row-between" style={{ alignItems: 'center' }}>
          <button className="btn-ghost btn-sm" disabled={!form.clauses.some((c) => c.field)} onClick={preview}>
            <Icon name="fact_check" size={15} /> How many records would this refuse?
          </button>
          {impact && (
            <span className={`tiny ${impact.failing ? 'warn-text' : 'muted'}`}>
              {impact.failing === 0
                ? `None of the ${impact.checked} checked.`
                : `${impact.failing} of ${impact.checked} stored records already fail this`
                  + `${impact.capped ? ' (first 500 checked)' : ''} — every edit to them will be refused until they are fixed.`}
            </span>
          )}
        </div>

        {!isNew && (
          <label className="check-one">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
            <span>Active<em className="tiny muted"> — switched off, the rule refuses nothing</em></span>
          </label>
        )}

        <div className="modal-actions">
          {!isNew && (
            <button className="btn-ghost btn-sm is-danger" disabled={busy} onClick={remove}>Delete</button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !complete} onClick={save}>
            {busy ? <Spinner /> : (isNew ? 'Create rule' : 'Save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
