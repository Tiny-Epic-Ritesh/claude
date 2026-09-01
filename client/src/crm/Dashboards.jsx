/**
 * Custom dashboards (P2-17b).
 *
 * WHAT THE SCREEN HAS TO MAKE OBVIOUS
 *
 * That sharing shares the QUESTION, not the answer. An administrator publishing
 * "pipeline by stage" to the desk needs to know that every RM will see their own
 * book — otherwise they will either not publish it, or publish it believing
 * they have shown everyone their numbers. The share control says so in words
 * rather than leaving it to be discovered.
 *
 * WHY THE BUILDER PREVIEWS
 *
 * A panel is a question, and the only way to tell whether you asked the one you
 * meant is to see the answer. The preview runs through the author's own scope,
 * like the saved panel will — a preview that ignored scope would show numbers
 * the author cannot otherwise see, and would disagree with the panel the moment
 * it was saved.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal, Spinner, Segmented } from '../components/ui.jsx';
import ChartPanel from '../components/ChartPanel.jsx';

export default function Dashboards() {
  const [list, { loading, error, reload }] = useApi('/dashboards');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState(null);

  if (loading || !list) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  if (open) {
    return <DashboardView id={open} onBack={() => { setOpen(null); reload(); }} onError={setProblem} />;
  }

  return (
    <section className="stack" style={{ gap: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Your dashboards</h2>
            <span className="tiny muted">
              Built from your own questions. A shared one shows every viewer their own data.
            </span>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Icon name="add" size={15} /> New dashboard
          </button>
        </div>

        {!list.dashboards.length && (
          <Empty>Nothing built yet. A dashboard is a set of saved questions about your own book.</Empty>
        )}

        {Boolean(list.dashboards.length) && (
          <table>
            <thead><tr><th>Name</th><th>Built by</th><th className="num">Panels</th><th>Shared with</th><th /></tr></thead>
            <tbody>
              {list.dashboards.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{d.name}</div>
                    {d.description && <div className="tiny muted">{d.description}</div>}
                  </td>
                  <td className="small">{d.mine ? 'You' : d.owner_name}</td>
                  <td className="num">{d.panel_count}</td>
                  <td className="small">
                    {d.shared_with?.length
                      ? d.shared_with.join(', ')
                      : <span className="muted">Just you</span>}
                  </td>
                  <td className="num">
                    <button className="btn-sm" onClick={() => setOpen(d.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <NewDashboard
          mayShare={list.may_share}
          roles={list.roles ?? []}
          onClose={() => setCreating(false)}
          onCreated={(d) => { setCreating(false); reload(); setOpen(d.id); }}
          onError={setProblem}
        />
      )}
    </section>
  );
}

/* ----------------------------------------------------------- one board */

function DashboardView({ id, onBack, onError }) {
  const [range, setRange] = useState('month');
  const [data, { loading, error, reload }] = useApi(`/dashboards/${id}?range=${range}`);
  const [adding, setAdding] = useState(false);

  if (loading || !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const d = data.dashboard;

  const saveKind = async (panelId, kind) => {
    try { await api.patch(`/dashboards/${id}/panels/${panelId}`, { kind }); reload(); }
    catch (err) { onError(err.message); }
  };

  const removePanel = async (panelId) => {
    try { await api.del(`/dashboards/${id}/panels/${panelId}`); reload(); }
    catch (err) { onError(err.message); }
  };

  return (
    <section className="stack" style={{ gap: 14 }}>
      <div className="detail-head">
        <button className="btn btn-ghost" onClick={onBack}>
          <Icon name="arrow_back" size={16} /> All dashboards
        </button>
        <div>
          <h2>{d.name}</h2>
          <span className="tiny muted">
            {d.mine ? 'Yours' : `Built by ${d.owner_name}`}
            {d.shared_with?.length ? ` · shared with ${d.shared_with.join(', ')}` : ''}
            {' · showing your own data'}
          </span>
        </div>
        {d.mine && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="add" size={15} /> Add panel
          </button>
        )}
      </div>

      <Segmented
        value={range}
        onChange={setRange}
        options={data.ranges.map((r) => ({ value: r.code, label: r.label }))}
      />

      {/* P2-17d's rule, applied here too: a panel that failed is named, because
          the person who can fix it is the person looking at it. */}
      {data.broken && (
        <div className="glass notice notice-warn">
          <Icon name="warning" size={16} />
          <div>These panels could not be calculated: <strong>{data.broken.join(', ')}</strong>.</div>
        </div>
      )}

      {!data.panels.length && (
        <Empty>No panels yet. Add one to ask a question about your book.</Empty>
      )}

      <div className="grid-auto">
        {data.panels.map((p) => (
          <div key={p.id} className="card" style={{ minWidth: 0 }}>
            <div className="card-head">
              <div>
                <h2 style={{ fontSize: '1rem' }}>{p.title}</h2>
                <span className="tiny muted">{p.source}</span>
              </div>
              {d.mine && (
                <button className="btn-ghost btn-sm" onClick={() => removePanel(p.id)} aria-label={`Remove ${p.title}`}>
                  <Icon name="close" size={15} />
                </button>
              )}
            </div>
            <PanelBody
              panel={p}
              /* The owner's choice is saved, because it is their panel. A
                 viewer of a shared one switches for themselves only. */
              onKindChange={d.mine ? (k) => saveKind(p.id, k) : undefined}
            />
          </div>
        ))}
      </div>

      {adding && (
        <PanelBuilder
          dashboardId={id}
          range={range}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); reload(); }}
          onError={onError}
        />
      )}
    </section>
  );
}

function PanelBody({ panel, onKindChange }) {
  if (panel.kind === 'error') {
    return <div className="tiny warn-text">{panel.error}</div>;
  }
  if (panel.kind === 'tile') {
    return <div className="stat-value" style={{ fontSize: '2rem' }}>{Number(panel.value).toLocaleString('en-IN')}</div>;
  }
  if (!panel.data?.length) return <Empty>Nothing in this window.</Empty>;

  return (
    <ChartPanel
      data={panel.data}
      kind={panel.kind}
      grain={panel.grain ?? panel.definition?.grain ?? null}
      groupBy={panel.definition?.group_by ?? null}
      measureFn={panel.definition?.measure?.fn ?? 'count'}
      format={(v) => Number(v).toLocaleString('en-IN')}
      onKindChange={onKindChange}
    />
  );
}

/* ---------------------------------------------------------- creating */

function NewDashboard({ mayShare, roles, onClose, onCreated, onError }) {
  const [form, setForm] = useState({ name: '', description: '', shared: false, roles: [] });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const create = async () => {
    setBusy(true);
    try {
      onCreated(await api.post('/dashboards', {
        name: form.name,
        description: form.description || null,
        shared_with: form.shared && form.roles.length ? form.roles : null,
      }));
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="New dashboard" onClose={onClose}>
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)}
            placeholder="Desk pipeline" maxLength={80} />
        </label>
        <label>
          <span>What it is for</span>
          <input value={form.description} onChange={(e) => set('description', e.target.value)} />
        </label>

        {mayShare && (
          <>
            <label className="check-one">
              <input type="checkbox" checked={form.shared} onChange={(e) => set('shared', e.target.checked)} />
              <span>
                Publish this to other people
                <em className="tiny muted"> — they see the same questions about their own records</em>
              </span>
            </label>

            {form.shared && (
              <label>
                <span>Which roles</span>
                <select
                  multiple
                  size={6}
                  value={form.roles}
                  onChange={(e) => set('roles', [...e.target.selectedOptions].map((o) => o.value))}
                >
                  {(roles ?? []).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                </select>
                {/* The thing an author most needs to know before publishing. */}
                <span className="tiny muted">
                  Everyone you publish to runs these questions against their own book — a Sales RM
                  sees their leads, a supervisor sees the team's. You are sharing the question,
                  not your numbers.
                </span>
              </label>
            )}
          </>
        )}

        {!mayShare && (
          <p className="tiny muted">
            This will be yours alone. Publishing a dashboard to other people needs reporting
            permission.
          </p>
        )}

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={create}>
            {busy ? <Spinner /> : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- builder */

function PanelBuilder({ dashboardId, range, onClose, onAdded, onError }) {
  const [cat] = useApi('/dashboards/catalogue');
  const [p, setP] = useState({
    title: '', source: 'lead', kind: 'bar', measure: { fn: 'count' },
    group_by: 'stage', filters: null, use_range: true, limit: 8,
  });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [clauses, setClauses] = useState([]);

  if (!cat) return <Modal title="Add a panel" onClose={onClose}><Loading /></Modal>;

  const source = cat.sources.find((s) => s.key === p.source);
  const measure = cat.measures.find((m) => m.fn === p.measure.fn);
  const set = (k, v) => { setP((x) => ({ ...x, [k]: v })); setPreview(null); };

  const definition = () => ({
    ...p,
    filters: clauses.filter((c) => c.field).length ? { all: clauses.filter((c) => c.field) } : null,
  });

  const run = async () => {
    try { setPreview(await api.post(`/dashboards/preview?range=${range}`, definition())); }
    catch (err) { setPreview({ error: err.message }); }
  };

  const save = async () => {
    setBusy(true);
    try { await api.post(`/dashboards/${dashboardId}/panels`, definition()); onAdded(); }
    catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="Add a panel" subtitle="A saved question about your own records" onClose={onClose} wide>
      <div className="stack" style={{ gap: 13 }}>
        <label>
          <span>Title</span>
          <input value={p.title} onChange={(e) => set('title', e.target.value)}
            placeholder="Warm leads by source" maxLength={80} />
        </label>

        <div className="grid grid-2" style={{ gap: 12 }}>
          <label>
            <span>Count what</span>
            <select value={p.source} onChange={(e) => { set('source', e.target.value); set('group_by', ''); setClauses([]); }}>
              {cat.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>

          <label>
            <span>Measure</span>
            <select value={p.measure.fn}
              onChange={(e) => set('measure', { fn: e.target.value, field: undefined })}>
              {cat.measures.map((m) => <option key={m.fn} value={m.fn}>{m.label}</option>)}
            </select>
          </label>
        </div>

        {measure?.needs_field && (
          <label>
            <span>Of which field</span>
            <select value={p.measure.field ?? ''}
              onChange={(e) => set('measure', { fn: p.measure.fn, field: e.target.value })}>
              <option value="">Choose…</option>
              {source.columns
                .filter((c) => !measure.numeric || c.numeric)
                .map((c) => <option key={c.api_name} value={c.api_name}>{c.label}</option>)}
            </select>
          </label>
        )}

        <div className="grid grid-2" style={{ gap: 12 }}>
          <label>
            <span>Broken down by</span>
            <select value={p.group_by ?? ''} onChange={(e) => {
              const g = e.target.value;
              setP((x) => ({ ...x, group_by: g, kind: g ? (x.kind === 'tile' ? 'bar' : x.kind) : 'tile' }));
              setPreview(null);
            }}>
              <option value="">Nothing — one number</option>
              {source.columns.filter((c) => c.groupable)
                .map((c) => <option key={c.api_name} value={c.api_name}>{c.label}</option>)}
            </select>
          </label>

          <label>
            <span>Shown as</span>
            <select value={p.kind} onChange={(e) => set('kind', e.target.value)}>
              {cat.kinds
                .filter((k) => (p.group_by ? k.kind !== 'tile' : k.kind === 'tile'))
                .map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </label>
        </div>

        <div className="field">
          <span className="field-label">Only count records where</span>
          <div className="stack" style={{ gap: 8 }}>
            {clauses.map((c, i) => {
              const op = cat.operators.find((o) => o.op === c.op);
              return (
                <div key={i} className="clause-row">
                  <select value={c.field} onChange={(e) => setClauses((cs) => cs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
                    <option value="">Choose a field…</option>
                    {source.columns.map((col) => <option key={col.api_name} value={col.api_name}>{col.label}</option>)}
                  </select>
                  <select value={c.op} onChange={(e) => setClauses((cs) => cs.map((x, j) => (j === i ? { ...x, op: e.target.value, value: '' } : x)))}>
                    {cat.operators.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                  </select>
                  {op?.takes_value
                    ? <input value={c.value ?? ''} onChange={(e) => setClauses((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="value" />
                    : <span className="tiny muted" style={{ alignSelf: 'center' }}>no value needed</span>}
                  <button className="btn-ghost btn-sm" onClick={() => setClauses((cs) => cs.filter((_, j) => j !== i))}>
                    <Icon name="close" size={15} />
                  </button>
                </div>
              );
            })}
          </div>
          <button className="btn-ghost btn-sm" style={{ marginTop: 8 }}
            onClick={() => setClauses((cs) => [...cs, { field: '', op: 'eq', value: '' }])}>
            <Icon name="add" size={14} /> Add a condition
          </button>
        </div>

        <label className="check-one">
          <input type="checkbox" checked={p.use_range} onChange={(e) => set('use_range', e.target.checked)} />
          <span>
            Limit to the selected window
            <em className="tiny muted"> — off for standing figures like "clients by segment"</em>
          </span>
        </label>

        {/* The only way to tell whether you asked the question you meant. */}
        <div className="card" style={{ background: 'var(--glass-2)' }}>
          <div className="card-head">
            <h2 style={{ fontSize: '0.95rem' }}>{p.title || 'Preview'}</h2>
            <button className="btn-ghost btn-sm" onClick={run}>
              <Icon name="play_arrow" size={15} /> Try it
            </button>
          </div>
          {preview?.error && <div className="tiny warn-text">{preview.error}</div>}
          {preview && !preview.error && <PanelBody panel={preview} />}
          {!preview && <p className="tiny muted" style={{ margin: 0 }}>Runs against your own records, exactly as the saved panel will.</p>}
        </div>

        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !p.title.trim()} onClick={save}>
            {busy ? <Spinner /> : 'Add panel'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
