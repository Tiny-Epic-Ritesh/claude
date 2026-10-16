import { useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, Loading, Empty, Icon, Modal, ErrorBanner, Spinner, announce } from '../../components/ui.jsx';
import FlowBuilder from './FlowBuilder.jsx';
import { ArchiveOrDelete } from '../../components/Lifecycle.jsx';

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
  const [ending, setEnding] = useState(null);
  const [done, setDone] = useState(null);
  const navigate = useNavigate();

  if (loading || !spec) return <Loading />;

  const open = (autoId) => navigate(`/setup/automations/${autoId}`);
  /* QA-37: archived flows are kept, read-only, out of the way. */
  const archived = (rows ?? []).filter((a) => a.archived_at);
  const restore = async (a) => {
    setProblem(null);
    try { await api.post(`/admin/automations/${a.id}/restore`); setDone(`"${a.name}" is restored, paused.`); reload(); }
    catch (err) { setProblem(err.message); }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      {problem && <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />}
      {done && <div className="notice notice-ok"><Icon name="check_circle" size={17} /> <span>{done}</span></div>}

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

      {!rows?.filter((a) => !a.archived_at).length ? (
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
              {rows.filter((a) => !a.archived_at).map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.name}</strong>
                    {a.description && <div className="tiny muted">{a.description}</div>}
                    <div className="tiny muted">
                      {a.sales_org} · priority {a.priority}
                      {/* QA-37: a flow that has run changes by new versions. */}
                      {a.first_activated_at ? ` · version ${a.version}` : ' · draft, never switched on'}
                    </div>
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
                  <td>
                    <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button className="btn-sm" onClick={() => open(a.id)}>Open</button>
                      {/* QA-37: switched off, then archived once it has run;
                          deleted only as a draft never switched on. */}
                      {a.status !== 'active' && (a.first_activated_at || a.entered > 0
                        ? <button className="btn-ghost btn-sm" onClick={() => setEnding({ auto: a, what: 'archiving' })}>Archive</button>
                        : <button className="btn-ghost btn-sm" onClick={() => setEnding({ auto: a, what: 'deleting' })}>Delete</button>)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {archived.length > 0 && (
        <details className="card" style={{ padding: '10px 14px' }}>
          <summary className="small">{archived.length} archived automation{archived.length === 1 ? '' : 's'}</summary>
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {archived.map((a) => (
              <div key={a.id} className="row-between">
                <div>
                  <strong className="small">{a.name}</strong>
                  <div className="tiny muted">
                    Archived{a.archive_reason ? ` — ${a.archive_reason}` : ''} · version {a.version} · {a.entered} entered
                  </div>
                </div>
                <span className="row" style={{ gap: 4 }}>
                  <button className="btn-ghost btn-sm" onClick={() => open(a.id)}>Open</button>
                  <button className="btn-ghost btn-sm" onClick={() => restore(a)}>Restore</button>
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {ending && (
        <ArchiveOrDelete
          confirmLabel="Type the automation’s name to confirm"
          name={ending.auto.name}
          what={ending.what}
          archivePath={`/admin/automations/${ending.auto.id}/archive`}
          deletePath={`/admin/automations/${ending.auto.id}`}
          archiveNote="It stays paused and read-only, with every version and every lead that went through it, and leaves this list. It can be restored."
          deleteNote="This removes a draft that was never switched on. An automation that has run is kept as the record of what it did, and is archived instead."
          onSwitch={(what) => setEnding({ ...ending, what })}
          onClose={() => setEnding(null)}
          onDone={(message) => { setEnding(null); setDone(message); reload(); }}
        />
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
      const made = await api.post(`/admin/automations/migration/${r.rule.id}`, { every_hours: r.every_hours });
      // Part 4, item 8.4.
      announce(`"${r.rule.name}" converted`, [
        `It is now a draft automation with ${made.steps} step${made.steps === 1 ? '' : 's'}. Nothing runs until it is activated.`,
        made.warnings?.length ? `Check before activating: ${made.warnings.join(' ')}` : null,
      ], made.warnings?.length ? 'warn' : 'ok');
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
