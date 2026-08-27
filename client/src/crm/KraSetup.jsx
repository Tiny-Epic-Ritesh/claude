/**
 * Setup → Targets & incentives.
 *
 * Two things a business revises and a developer should not own: what each role
 * is measured on, and what that earns.
 *
 * The weight total is shown per role and flagged when it is not 100, because a
 * scorecard weighted to 85 still produces a number — it is just a number that
 * means something slightly different from what everyone assumes.
 *
 * Incentive bands are checked before they save. A gap pays nothing on the
 * production inside it and an overlap pays twice, and neither shows up until
 * payday — so the screen refuses the save and names the boundary, and the
 * preview lets somebody try a figure through the bands before committing.
 */

import { useMemo, useState } from 'react';
import { api, rupees, rupeesCompact } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal, Tabs } from '../components/ui.jsx';

const UNITS = ['count', 'rupees', 'percent', 'days'];
const BASES = [
  ['brokerage', 'Brokerage share', 'percent'],
  ['accounts', 'Accounts opened', 'flat'],
  ['aum', 'Assets under management', 'bps'],
];
const RATE_KINDS = [['percent', '% of the band'], ['flat', '₹ per unit'], ['bps', 'basis points']];

export default function KraSetup() {
  const [data, { loading, error, reload }] = useApi('/kra/config');
  const [tab, setTab] = useState('metrics');
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(null);

  if (loading && !data) return <Loading label="Loading targets…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="notice notice-warn">
        <Icon name="info" size={17} />
        <span>{data.note}</span>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {done && (
        <div className="notice notice-ok">
          <Icon name="check_circle" size={17} /> <span>{done}</span>
        </div>
      )}

      <Tabs
        tabs={[{ key: 'metrics', label: 'KRA measures' }, { key: 'plans', label: 'Incentive plans' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'metrics'
        ? <Metrics data={data} reload={reload} onError={setProblem} onDone={setDone} />
        : <Plans data={data} reload={reload} onError={setProblem} onDone={setDone} />}
    </div>
  );
}

/* --------------------------------------------------------------- KRA */

function Metrics({ data, reload, onError, onDone }) {
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(null);

  const byRole = useMemo(() => {
    const m = new Map();
    for (const x of data.metrics) {
      if (!m.has(x.role_code)) m.set(x.role_code, []);
      m.get(x.role_code).push(x);
    }
    return m;
  }, [data]);

  const retire = async (metric) => {
    try {
      await api.del(`/kra/config/metrics/${metric.id}`);
      onDone(`"${metric.label}" retired. Scorecards already issued keep it.`);
      reload();
    } catch (e) { onError(e.message); }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      {[...byRole].map(([role, metrics]) => {
        const active = metrics.filter((m) => m.active);
        const weight = active.reduce((s, m) => s + m.weight, 0);
        const roleName = data.roles.find((r) => r.code === role)?.name ?? role;

        return (
          <div key={role} className="card">
            <div className="card-head">
              <h2 style={{ fontSize: 15 }}>{roleName}</h2>
              <div className="row" style={{ gap: 8 }}>
                {/* A scorecard weighted to 85 still produces a number. It is
                    just not the number anyone thinks it is. */}
                <span className={`badge ${weight === 100 ? 'badge-green' : 'badge-amber'}`}
                  title={weight === 100 ? 'Weights sum to 100' : 'Weights should sum to 100 for the score to read as a percentage'}>
                  {weight} points
                </span>
                <button className="btn-sm" onClick={() => setAdding(role)}>
                  <Icon name="add" size={14} /> Add
                </button>
              </div>
            </div>

            {active.length === 0 ? <Empty>No measures for this role.</Empty> : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Measure</th><th>Source</th>
                      <th className="num">Target</th><th className="num">Weight</th>
                      <th>Direction</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map((m) => (
                      <tr key={m.id} className={m.active ? '' : 'is-retired'}>
                        <td>
                          <div className="row wrap" style={{ gap: 6 }}>
                            <strong>{m.label}</strong>
                            {m.edited_at && <span className="badge badge-amber">Yours</span>}
                            {!m.active && <span className="badge">Retired</span>}
                          </div>
                          <div className="small muted">{m.description}</div>
                        </td>
                        <td>
                          {m.source
                            ? <span className="mono small">{m.source}</span>
                            : <span className="tiny muted">not measured</span>}
                        </td>
                        <td className="num">{m.unit === 'rupees' ? rupeesCompact(m.target) : m.target}</td>
                        <td className="num">{m.weight}</td>
                        <td>
                          <span className="badge">{m.direction === 'lower' ? 'lower is better' : 'higher is better'}</span>
                        </td>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn-sm" onClick={() => setEditing(m)}>Edit</button>
                            {m.active && (
                              <button className="btn-ghost btn-sm" onClick={() => retire(m)}>Retire</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {editing && (
        <MetricModal metric={editing} sources={[...new Set(data.metrics.map((m) => m.source).filter(Boolean))]}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onDone('Saved.'); reload(); }}
          onError={(m) => { setEditing(null); onError(m); }} />
      )}
      {adding && (
        <MetricModal role={adding} sources={[...new Set(data.metrics.map((m) => m.source).filter(Boolean))]}
          onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); onDone('Added.'); reload(); }}
          onError={(m) => { setAdding(null); onError(m); }} />
      )}
    </div>
  );
}

function MetricModal({ metric, role, sources, onClose, onSaved, onError }) {
  const isNew = !metric;
  const [f, setF] = useState({
    code: metric?.code ?? '',
    label: metric?.label ?? '',
    description: metric?.description ?? '',
    source: metric?.source ?? '',
    unit: metric?.unit ?? 'count',
    target: metric?.target ?? 0,
    weight: metric?.weight ?? 10,
    direction: metric?.direction ?? 'higher',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { ...f, target: Number(f.target), weight: Number(f.weight), source: f.source || null };
      if (isNew) await api.post('/kra/config/metrics', { ...body, role_code: role });
      else await api.patch(`/kra/config/metrics/${metric.id}`, body);
      onSaved();
    } catch (err) { onError(err.message); }
  };

  return (
    <Modal title={isNew ? 'New measure' : metric.label} subtitle={isNew ? role : metric.code} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        {isNew && (
          <div className="field">
            <label htmlFor="k-code">Code</label>
            <input id="k-code" className="mono" value={f.code}
              onChange={(e) => set('code', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
          </div>
        )}
        <div className="field">
          <label htmlFor="k-label">Label</label>
          <input id="k-label" autoFocus={!isNew} value={f.label} onChange={(e) => set('label', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="k-desc">What it means</label>
          <input id="k-desc" value={f.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="k-source">Measured from</label>
          <select id="k-source" value={f.source} onChange={(e) => set('source', e.target.value)}>
            <option value="">Not measured automatically</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="tiny muted">
            A measure with no source still appears on the scorecard, marked as
            unmeasured rather than scored zero.
          </span>
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="k-target">Target</label>
            <input id="k-target" type="number" value={f.target} onChange={(e) => set('target', e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="k-unit">Unit</label>
            <select id="k-unit" value={f.unit} onChange={(e) => set('unit', e.target.value)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="k-weight">Weight</label>
            <input id="k-weight" type="number" min="0" max="100" value={f.weight}
              onChange={(e) => set('weight', e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="k-dir">Direction</label>
          <select id="k-dir" value={f.direction} onChange={(e) => set('direction', e.target.value)}>
            <option value="higher">Higher is better</option>
            <option value="lower">Lower is better</option>
          </select>
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || !f.label.trim() || (isNew && !f.code.trim())}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------- incentives */

function Plans({ data, reload, onError, onDone }) {
  const [editing, setEditing] = useState(null);

  return (
    <div className="stack" style={{ gap: 14 }}>
      {data.plans.length === 0 && <Empty>No incentive plans configured.</Empty>}
      {data.plans.map((p) => {
        const roleName = data.roles.find((r) => r.code === p.role_code)?.name ?? p.role_code;
        return (
          <div key={p.id} className="card">
            <div className="card-head">
              <h2 style={{ fontSize: 15 }}>{p.name}</h2>
              <div className="row" style={{ gap: 8 }}>
                <span className="badge">{roleName}</span>
                {p.edited_at && <span className="badge badge-amber">Yours</span>}
                <button className="btn-sm" onClick={() => setEditing(p)}>Edit bands</button>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 9 }}>
              <p className="small muted" style={{ margin: 0 }}>{p.description}</p>
              <span className="tiny muted">Clawback after {p.clawback_months} months without a trade.</span>
              <div className="stack" style={{ gap: 6 }}>
                {BASES.filter(([b]) => p.slabs.some((s) => s.basis === b)).map(([basis, label]) => (
                  <div key={basis} className="row wrap" style={{ gap: 6 }}>
                    <span className="tiny muted" style={{ minWidth: 170 }}>{label}</span>
                    {p.slabs.filter((s) => s.basis === basis).map((s) => (
                      <span key={s.id} className="chip chip-muted">
                        {s.from_value.toLocaleString('en-IN')}
                        {s.to_value == null ? '+' : `–${s.to_value.toLocaleString('en-IN')}`}
                        {' · '}
                        {s.rate_kind === 'percent' ? `${s.rate}%` : s.rate_kind === 'bps' ? `${s.rate}bps` : rupees(s.rate)}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}

      {editing && (
        <PlanModal plan={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onDone('Bands saved.'); reload(); }}
          onError={(m) => { setEditing(null); onError(m); }} />
      )}
    </div>
  );
}

function PlanModal({ plan, onClose, onSaved, onError }) {
  const [slabs, setSlabs] = useState(plan.slabs.map((s) => ({ ...s })));
  const [clawback, setClawback] = useState(plan.clawback_months);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [testValue, setTestValue] = useState(250000);
  const [testBasis, setTestBasis] = useState('brokerage');
  const [problems, setProblems] = useState([]);

  const setSlab = (i, k, v) => setSlabs((p) => p.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const addSlab = (basis) => setSlabs((p) => [...p, {
    basis, from_value: 0, to_value: null, rate: 0,
    rate_kind: BASES.find(([b]) => b === basis)?.[2] ?? 'percent',
  }]);
  const removeSlab = (i) => setSlabs((p) => p.filter((_, j) => j !== i));

  const runPreview = async () => {
    try {
      const r = await api.post('/kra/config/preview', { slabs, value: Number(testValue), basis: testBasis });
      setPreview(r);
      setProblems(r.problems ?? []);
    } catch (e) { onError(e.message); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setProblems([]);
    try {
      await api.patch(`/kra/config/plans/${plan.id}`, { slabs, clawback_months: Number(clawback) });
      onSaved();
    } catch (err) {
      // The server names the boundary. Show it here rather than as a banner
      // behind the dialog somebody is still editing.
      setProblems([err.message]);
      setSaving(false);
    }
  };

  return (
    <Modal title={plan.name} subtitle="Bands are marginal — each pays its own rate on the portion inside it" onClose={onClose} wide>
      <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
        {problems.length > 0 && (
          <div className="notice notice-warn">
            <Icon name="warning" size={17} />
            <span>{problems.join(' · ')}</span>
          </div>
        )}

        {BASES.map(([basis, label, defaultKind]) => {
          const rows = slabs.map((s, i) => ({ s, i })).filter(({ s }) => s.basis === basis);
          return (
            <div key={basis} className="card">
              <div className="card-head">
                <h3 style={{ fontSize: 14, margin: 0 }}>{label}</h3>
                <button type="button" className="btn-sm" onClick={() => addSlab(basis)}>
                  <Icon name="add" size={14} /> Band
                </button>
              </div>
              {rows.length === 0 ? (
                <div className="card-body"><span className="tiny muted">Not paid on this basis.</span></div>
              ) : (
                <div className="card-body stack" style={{ gap: 7 }}>
                  {rows.map(({ s, i }) => (
                    <div key={i} className="row wrap" style={{ gap: 7, alignItems: 'center' }}>
                      <input type="number" style={{ width: 110 }} value={s.from_value}
                        aria-label="Band starts at"
                        onChange={(e) => setSlab(i, 'from_value', e.target.value)} />
                      <span className="tiny muted">to</span>
                      <input type="number" style={{ width: 110 }}
                        value={s.to_value ?? ''} placeholder="no limit"
                        aria-label="Band ends at"
                        onChange={(e) => setSlab(i, 'to_value', e.target.value === '' ? null : e.target.value)} />
                      <input type="number" step="0.01" style={{ width: 90 }} value={s.rate}
                        aria-label="Rate"
                        onChange={(e) => setSlab(i, 'rate', e.target.value)} />
                      <select style={{ width: 130 }} value={s.rate_kind ?? defaultKind}
                        aria-label="Rate type"
                        onChange={(e) => setSlab(i, 'rate_kind', e.target.value)}>
                        {RATE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                      <button type="button" className="btn-ghost btn-icon btn-sm"
                        aria-label="Remove band" onClick={() => removeSlab(i)}>
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                  ))}
                  <span className="tiny muted">
                    Leave the top band&apos;s upper limit empty, or production above it earns nothing.
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {/* Try a figure through the bands before committing to them. */}
        <div className="card">
          <div className="card-head"><h3 style={{ fontSize: 14, margin: 0 }}>Try a figure</h3></div>
          <div className="card-body stack" style={{ gap: 9 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
              <div className="field">
                <label htmlFor="pv-basis">Basis</label>
                <select id="pv-basis" value={testBasis} onChange={(e) => setTestBasis(e.target.value)}>
                  {BASES.map(([b, l]) => <option key={b} value={b}>{l}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pv-value">Production</label>
                <input id="pv-value" type="number" value={testValue} onChange={(e) => setTestValue(e.target.value)} />
              </div>
              <button type="button" className="btn-sm" onClick={runPreview}>Work it out</button>
            </div>
            {preview && (
              <div className="stack" style={{ gap: 4 }}>
                <strong>{rupees(preview.total)}</strong>
                {preview.lines.map((l, i) => (
                  <span key={i} className="small muted">
                    {l.rate}{l.rate_kind === 'percent' ? '%' : l.rate_kind === 'bps' ? ' bps' : '₹'} on{' '}
                    {Number(l.portion).toLocaleString('en-IN')} = {rupees(l.amount)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="pl-claw">Clawback window, in months</label>
          <input id="pl-claw" type="number" min="0" value={clawback}
            onChange={(e) => setClawback(e.target.value)} />
          <span className="tiny muted">
            An account that has not traded within this window has its acquisition fee reversed.
          </span>
        </div>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save bands'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
