import { useEffect, useState } from 'react';
import { api, shortDate } from '../../api.js';
import { useApi, Loading, Empty, Icon, Modal, ErrorBanner, Spinner } from '../../components/ui.jsx';
import ConditionBuilder from '../../components/ConditionBuilder.jsx';

/**
 * The automation builder (P3-16).
 *
 * WHY THIS IS A LIST OF STEPS AND NOT A CANVAS, YET
 *
 * The ticket asks for a drag-and-drop builder and it should have one. But a
 * canvas is the presentation of a flow, not the flow — and the part that
 * decides whether an automation is safe is whether every card is wired, whether
 * it loops, and what happens to the leads standing inside it. Those are the
 * same whichever way the steps are drawn.
 *
 * So this is the working version: every card, in order, with its exits named
 * and its problems shown against it. It is honest about what a flow does. The
 * canvas is the next layer on the same API, and building it first would have
 * meant drawing something before knowing it ran.
 *
 * WHAT THE SCREEN REFUSES
 *
 * Activation. A draft can be as broken as you like; a live automation cannot,
 * because a card wired to nothing ends the flow there silently and a loop sends
 * a client the same message until somebody notices. The server validates and
 * this screen shows every problem against the card that has it.
 */
export function Automations() {
  const [rows, { loading, reload }] = useApi('/admin/automations');
  const [spec] = useApi('/admin/automations/spec');
  const [open, setOpen] = useState(null);
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState(null);

  if (loading || !spec) return <Loading />;

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
                  <td><button className="btn-sm" onClick={() => setOpen(a.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {making && (
        <NewAutomation
          spec={spec}
          onClose={() => setMaking(false)}
          onMade={(a) => { setMaking(false); reload(); setOpen(a.id); }}
          onError={setProblem}
        />
      )}
      {open && (
        <Builder
          id={open}
          spec={spec}
          onClose={() => { setOpen(null); reload(); }}
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
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

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

/* -------------------------------------------------------------- builder */

function Builder({ id, spec, onClose, onError }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    try { setData(await api.get(`/admin/automations/${id}`)); }
    catch (err) { onError(err.message); }
  };
  useEffect(() => { load(); }, [id]);

  if (!data) return <Modal title="Automation" onClose={onClose}><Loading /></Modal>;

  const problemsFor = (stepId) => data.problems.filter((p) => p.step_id === stepId);
  const general = data.problems.filter((p) => !p.step_id);

  /* Chained to the last card rather than dropped beside it. Adding three cards
     and getting three orphans plus four validation errors is not a builder --
     the common case is "and then this", so that is the default. */
  const addStep = async (kind) => {
    setBusy(true);
    const last = data.steps.length ? data.steps[data.steps.length - 1] : null;
    try {
      await api.post(`/admin/automations/${id}/steps`, {
        kind, config: {}, after: last && last.kind !== 'exit' ? last.id : undefined,
      });
      await load();
    } catch (err) { onError(err.message); }
    finally { setBusy(false); }
  };

  const setStatus = async (action) => {
    setBusy(true);
    try {
      await api.post(`/admin/automations/${id}/${action}`);
      await load();
    } catch (err) { onError(err.message); }
    finally { setBusy(false); }
  };

  const stepName = (sid) => {
    if (!sid) return 'nothing';
    const s = data.steps.find((x) => x.id === sid);
    return s ? (s.label || s.kind) : `#${sid} (missing)`;
  };

  return (
    <Modal title={data.name} subtitle={`${data.status} · ${data.sales_org}`} onClose={onClose} wide>
      {/* What is wrong with it, before anything else. Activation is refused
          until this list is empty, so it is the first thing to read. */}
      {data.problems.length > 0 && (
        <div className="notice notice-warn">
          <Icon name="warning" />
          <div>
            <strong>{data.problems.length} thing{data.problems.length === 1 ? '' : 's'} to fix before this can run.</strong>
            {general.map((p) => <div key={p.message} className="tiny">{p.message}</div>)}
          </div>
        </div>
      )}

      <div className="row-between" style={{ margin: '10px 0' }}>
        <span className="tiny muted">
          {data.report.entered} entered · {data.report.waiting} inside now · {data.report.completed} finished
          {data.report.failed ? ` · ${data.report.failed} failed` : ''}
        </span>
        <span className="row" style={{ gap: 6 }}>
          {data.status !== 'active' ? (
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || data.problems.length > 0}
              title={data.problems.length ? 'Fix the problems above first' : 'Start it'}
              onClick={() => setStatus('activate')}
            >
              Activate
            </button>
          ) : (
            <button className="btn btn-sm" disabled={busy} onClick={() => setStatus('pause')}>Pause</button>
          )}
        </span>
      </div>

      {/* ------------------------------------------------------ the steps */}
      <h4 className="muted">The flow</h4>

      {!data.steps.length ? (
        <Empty>No steps yet.</Empty>
      ) : (
        <div className="stack" style={{ gap: 1 }}>
          {data.steps.map((s) => {
            const problems = problemsFor(s.id);
            const first = data.first_step_id === s.id;
            return (
              <div key={s.id} className={`card ${problems.length ? 'is-warn' : ''}`} style={{ padding: 10 }}>
                <div className="row-between">
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <Icon name={ICON[s.kind] ?? 'help'} size={16} />
                    <strong>{s.label || spec.step_kinds.find((k) => k.kind === s.kind)?.label || s.kind}</strong>
                    {first && <span className="badge">starts here</span>}
                  </span>
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span className="tiny muted">{describe(s)}</span>
                    <button className="btn-sm" onClick={() => setEditing(s)}>Configure</button>
                  </span>
                </div>

                <div className="tiny muted" style={{ marginTop: 4 }}>
                  then → <strong>{stepName(s.next_step_id)}</strong>
                  {s.kind === 'branch' || s.kind === 'wait_activity'
                    ? <> · otherwise → <strong>{stepName(s.else_step_id)}</strong></>
                    : null}
                </div>

                {problems.map((p) => <p key={p.message} className="err-text">{p.message}</p>)}
              </div>
            );
          })}
        </div>
      )}

      <div className="row wrap" style={{ gap: 5, marginTop: 8 }}>
        <span className="tiny muted">Add:</span>
        {spec.step_kinds.map((k) => (
          <button key={k.kind} type="button" className="btn-sm" disabled={busy} onClick={() => addStep(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>

      {editing && (
        <StepEditor
          step={editing}
          steps={data.steps}
          spec={spec}
          automationId={id}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
          onError={onError}
        />
      )}

      {/* Where leads are standing. The report's most useful line, because
          "1,000 entered and 40 finished" says nothing about the other 960. */}
      {data.report.waiting_at?.length > 0 && (
        <>
          <h4 className="muted" style={{ marginTop: 12 }}>Waiting at</h4>
          <div className="stack" style={{ gap: 1 }}>
            {data.report.waiting_at.map((w) => (
              <div key={w.id} className="row-between tiny">
                <span>{w.label || w.kind}</span>
                <strong>{w.n}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

/* Every one of these is in client/icon-subset.txt. An icon outside the subset
   renders as its own ligature text — "alt_route" in the middle of the flow —
   so the names here are chosen from what is bundled rather than from what
   Material Symbols happens to offer. */
const ICON = {
  action: 'bolt',
  branch: 'route',
  wait: 'schedule',
  wait_activity: 'hourglass_empty',
  exit: 'flag',
};

/** A one-line description of what a card is configured to do. */
function describe(step) {
  let config = {};
  try { config = JSON.parse(step.config || '{}'); } catch { config = {}; }

  switch (step.kind) {
    case 'action': return config.type ? `does ${config.type}` : 'no action chosen';
    case 'wait': return config.hours || config.minutes
      ? `waits ${config.hours ? `${config.hours}h` : ''}${config.minutes ? ` ${config.minutes}m` : ''}`.trim()
      : 'no delay set';
    case 'wait_activity': return `waits up to ${config.timeout_hours ?? 72}h`;
    case 'branch': return config.conditions ? 'checks a condition' : 'no condition set';
    case 'exit': return config.reason ? `ends: ${config.reason}` : 'ends the flow';
    default: return '';
  }
}

/* --------------------------------------------------------- step editor */

/**
 * Configure one card, and say where it goes next.
 *
 * The wiring is here rather than on a canvas because it is the thing that
 * decides what the flow does: a card's exits are the flow. Drawing them is the
 * next layer; naming them is what makes the automation run.
 */
function StepEditor({ step, steps, spec, automationId, onClose, onSaved, onError }) {
  const initial = (() => {
    try { return JSON.parse(step.config || '{}'); } catch { return {}; }
  })();

  const [config, setConfig] = useState(initial);
  const [label, setLabel] = useState(step.label ?? '');
  const [next, setNext] = useState(step.next_step_id ?? '');
  const [els, setEls] = useState(step.else_step_id ?? '');
  const [busy, setBusy] = useState(false);

  const kind = spec.step_kinds.find((k) => k.kind === step.kind);
  const others = steps.filter((s) => s.id !== step.id);
  const action = spec.actions.find((a) => a.type === config.type);

  const save = async () => {
    setBusy(true);
    try {
      const body = { label: label || null, config };
      if (kind?.exits.includes('next')) body.next_step_id = next === '' ? null : Number(next);
      if (kind?.exits.includes('else')) body.else_step_id = els === '' ? null : Number(els);
      await api.patch(`/admin/automations/${automationId}/steps/${step.id}`, body);
      await onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  const set = (patch) => setConfig((c) => ({ ...c, ...patch }));

  return (
    <Modal title={kind?.label ?? step.kind} subtitle="What this step does, and what follows it" onClose={onClose}>
      <div className="field">
        <label>Name it</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind?.label} />
      </div>

      {step.kind === 'action' && (
        <>
          <div className="field">
            <label>Do what</label>
            <select value={config.type ?? ''} onChange={(e) => set({ type: e.target.value, params: {} })}>
              <option value="">Choose…</option>
              {spec.actions.map((a) => <option key={a.type} value={a.type}>{a.label}</option>)}
            </select>
          </div>

          {/* The parameters the server says this action takes -- read from the
              spec rather than listed here, so the two cannot drift. */}
          {action?.params?.map((param) => (
            <div className="field" key={param}>
              <label>{param.replace(/_/g, ' ')}</label>
              <input
                value={config.params?.[param] ?? ''}
                onChange={(e) => set({ params: { ...config.params, [param]: e.target.value } })}
              />
            </div>
          ))}
        </>
      )}

      {step.kind === 'wait' && (
        <div className="field-row">
          <div className="field">
            <label>Hours</label>
            <input type="number" min="0" value={config.hours ?? ''} onChange={(e) => set({ hours: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Minutes</label>
            <input type="number" min="0" value={config.minutes ?? ''} onChange={(e) => set({ minutes: Number(e.target.value) })} />
          </div>
        </div>
      )}

      {step.kind === 'wait_activity' && (
        <>
          <div className="field">
            <label>Wait for</label>
            <input
              value={config.activity_type ?? ''}
              onChange={(e) => set({ activity_type: e.target.value })}
              placeholder="Any activity"
            />
          </div>
          <div className="field">
            <label>Give up after (hours)</label>
            <input
              type="number" min="1"
              value={config.timeout_hours ?? 72}
              onChange={(e) => set({ timeout_hours: Number(e.target.value) })}
            />
            {/* Without a timeout a lead who never replies stays inside the
                automation for ever, and the report counts them as live work. */}
            <p className="hint">Every wait needs a giving-up point, or a lead who never replies never leaves.</p>
          </div>
        </>
      )}

      {step.kind === 'branch' && (
        <div className="field">
          <label>Carry on when</label>
          <ConditionBuilder
            value={config.conditions}
            schema={spec.conditions}
            onChange={(conditions) => set({ conditions })}
          />
        </div>
      )}

      {step.kind === 'exit' && (
        <div className="field">
          <label>Why it ends here</label>
          <input value={config.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} placeholder="Already a client" />
        </div>
      )}

      {/* ------------------------------------------------------ the wiring */}
      {kind?.exits.length > 0 && <h4 className="muted">Then</h4>}

      {kind?.exits.includes('next') && (
        <div className="field">
          <label>{step.kind === 'branch' ? 'If it matches, go to' : 'Next'}</label>
          <select value={next} onChange={(e) => setNext(e.target.value)}>
            <option value="">nothing — ends the flow here</option>
            {others.map((s) => <option key={s.id} value={s.id}>{s.label || s.kind}</option>)}
          </select>
        </div>
      )}

      {kind?.exits.includes('else') && (
        <div className="field">
          <label>{step.kind === 'branch' ? 'Otherwise, go to' : 'If it never happens, go to'}</label>
          <select value={els} onChange={(e) => setEls(e.target.value)}>
            <option value="">nothing — ends the flow here</option>
            {others.map((s) => <option key={s.id} value={s.id}>{s.label || s.kind}</option>)}
          </select>
        </div>
      )}

      <div className="row-between" style={{ marginTop: 12 }}>
        <span />
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? <Spinner /> : 'Save step'}
          </button>
        </span>
      </div>
    </Modal>
  );
}
