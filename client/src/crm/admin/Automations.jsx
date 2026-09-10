import { useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, Loading, Empty, Icon, Modal, ErrorBanner, Spinner } from '../../components/ui.jsx';
import FlowBuilder from './FlowBuilder.jsx';

/**
 * Automations (P3-16): the list, and the door to the builder.
 *
 * WHY THE BUILDER IS A PAGE AND NOT A DIALOG
 *
 * It used to open in a modal, which is right for a form and wrong for a canvas:
 * a flow of fifteen cards does not fit in 1,180 pixels, and the one screen in
 * this product that genuinely needs the window was the one screen boxed into a
 * dialog. It is a route now — `/setup/automations/:id` — so it gets the page,
 * keeps a back button that means something, and can be linked to in a message
 * to a colleague.
 *
 * Still inside the Setup shell rather than at the top level, because
 * non-negotiable #6 is uniform configuration surfaces: this is a settings
 * screen and it should be reached, permissioned and navigated like every other
 * settings screen.
 */
export function Automations() {
  return (
    <Routes>
      <Route index element={<AutomationList />} />
      <Route path=":autoId" element={<BuilderRoute />} />
    </Routes>
  );
}

function BuilderRoute() {
  const { autoId } = useParams();
  const navigate = useNavigate();
  const [spec] = useApi('/admin/automations/spec');

  if (!spec) return <Loading />;
  return <FlowBuilder id={Number(autoId)} spec={spec} onBack={() => navigate('/setup/automations')} />;
}

/* ------------------------------------------------------------- the list */

function AutomationList() {
  const [rows, { loading, reload }] = useApi('/admin/automations');
  const [spec] = useApi('/admin/automations/spec');
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState(null);
  const navigate = useNavigate();

  if (loading || !spec) return <Loading />;

  const open = (autoId) => navigate(`/setup/automations/${autoId}`);

  return (
    <div className="stack" style={{ gap: 14 }}>
      {problem && <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />}

      <div className="row-between">
        <div>
          <h2>Automations</h2>
          <p className="tiny muted">
            A flow a lead walks through. Unlike a rule, a lead can be inside one for days.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setMaking(true)}>
          <Icon name="add" size={16} /> New automation
        </button>
      </div>

      {!rows?.length ? (
        <Empty>Nothing built yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Automation</th><th>Starts on</th><th>Status</th>
                <th className="num">Steps</th><th className="num">Entered</th><th className="num">Inside now</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.name}</strong>
                    {a.description && <div className="tiny muted">{a.description}</div>}
                    <div className="tiny muted">{a.sales_org} · priority {a.priority}</div>
                  </td>
                  <td className="small">
                    {spec.triggers.find((t) => t.key === a.trigger_type)?.label ?? a.trigger_type}
                  </td>
                  <td>
                    <span className={`state-pill ${
                      a.status === 'active' ? 'state-active' : a.status === 'paused' ? 'state-risk' : 'state-exploring'
                    }`}
                    >
                      {a.status}
                    </span>
                  </td>
                  <td className="num">{a.step_count}</td>
                  <td className="num">{a.entered}</td>
                  {/* The number that matters when something is wrong: people
                      partway through, who have had the first message. */}
                  <td className="num">{a.waiting || '—'}</td>
                  <td><button className="btn-sm" onClick={() => open(a.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RuleMigration onConverted={reload} onError={setProblem} />

      {making && (
        <NewAutomation
          spec={spec}
          onClose={() => setMaking(false)}
          onMade={(a) => { setMaking(false); open(a.id); }}
          onError={setProblem}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- creating */

function NewAutomation({ spec, onClose, onMade, onError }) {
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('');
  const [busy, setBusy] = useState(false);

  const families = [...new Set(spec.triggers.map((t) => t.family))];
  const chosen = spec.triggers.find((t) => t.key === trigger);

  const create = async () => {
    setBusy(true);
    try { onMade(await api.post('/admin/automations', { name: name.trim(), trigger_type: trigger })); }
    catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="New automation" subtitle="It starts as a draft" onClose={onClose}>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Chase a stalled KYC" autoFocus />
      </div>

      <div className="field">
        <label>What starts it</label>
        <select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
          <option value="">Choose…</option>
          {families.map((f) => (
            <optgroup key={f} label={f}>
              {spec.triggers.filter((t) => t.family === f).map((t) => (
                /* Still offered, and still marked. Hiding it would leave
                   somebody hunting for a trigger they have used elsewhere and
                   finding no explanation. */
                <option key={t.key} value={t.key}>
                  {t.label}{t.unwired ? ' — not available yet' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {chosen?.note && <p className="hint">{chosen.note}</p>}

      {chosen?.unwired && (
        <p className="hint">
          <strong>Nothing fires this yet.</strong> {chosen.unwired} A flow built on it can be saved
          as a draft, but it cannot be activated — which is better than one that looks live and
          never runs.
        </p>
      )}

      {chosen?.needs_fields && (
        <p className="hint">
          You will need to name the fields this watches before it can go live. A trigger that
          watches every field fires on every change to every lead.
        </p>
      )}

      <div className="row-between" style={{ marginTop: 12 }}>
        <span />
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || !trigger} onClick={create}>
            {busy ? <Spinner /> : 'Create draft'}
          </button>
        </span>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------- rule migration */

/**
 * What the rule builder still holds, and whether each rule can become a flow.
 *
 * Beside the flow list rather than on a screen of its own, because "should this
 * still be a rule?" is a question you ask while looking at the flows. Collapsed
 * by default: it matters during the changeover and then stops mattering.
 *
 * It leads with the refusals. A rule whose conditions do not survive
 * translation would convert into a flow with no conditions at all, which is
 * true for every lead in the book — so the converter refuses, and this says
 * which rules and why, in the words somebody can act on.
 */
function RuleMigration({ onConverted, onError }) {
  const [data, { loading, reload }] = useApi('/admin/automations/migration');
  const [busy, setBusy] = useState(null);

  if (loading || !data?.rules?.length) return null;

  const ready = data.rules.filter((r) => r.convertible);
  const needsHand = data.rules.filter((r) => !r.convertible);

  const convert = async (r) => {
    setBusy(r.rule.id);
    try {
      await api.post(`/admin/automations/migration/${r.rule.id}`, { every_hours: r.every_hours });
      reload();
      onConverted();
    } catch (err) { onError(err.message); }
    setBusy(null);
  };

  return (
    <details className="card">
      <summary>
        <strong>From the rule builder</strong>{' '}
        <span className="tiny muted">
          {data.rules.length} {data.rules.length === 1 ? 'rule' : 'rules'} —{' '}
          {ready.length} convert cleanly, {needsHand.length} need rebuilding by hand
        </span>
      </summary>

      <p className="tiny muted">
        A rule is a filter: conditions, actions, one pass. A flow is a process a lead is inside.
        Converting copies the conditions and actions across and leaves the rule running — turning
        the rule off is a separate decision, for whoever checks the flow.
      </p>
      {/* True of every conversion, so it belongs here rather than repeated
          against each rule as though it were six separate problems. */}
      <p className="tiny muted">{data.rules[0].book_note}</p>

      <table className="table small">
        <thead>
          <tr><th>Rule</th><th>What still needs a person</th><th /></tr>
        </thead>
        <tbody>
          {data.rules.map((r) => (
            <tr key={r.rule.id}>
              <td>
                <strong>{r.rule.name}</strong>
                <div className="tiny muted">
                  {r.steps.length} {r.steps.length === 1 ? 'action' : 'actions'}
                  {r.rule.enabled ? ' · running' : ' · disabled'}
                </div>
              </td>
              <td className="tiny">
                {r.warnings.length
                  ? <ul style={{ margin: 0, paddingLeft: 16 }}>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  : <span className="muted">Nothing — it converts as it stands.</span>}
              </td>
              <td>
                {r.convertible ? (
                  <button className="btn-sm" disabled={busy === r.rule.id} onClick={() => convert(r)}>
                    {busy === r.rule.id ? 'Converting…' : 'Convert to a flow'}
                  </button>
                ) : (
                  <span className="tiny muted">Rebuild by hand</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
