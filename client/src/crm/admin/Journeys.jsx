import { useState } from 'react';
import { api, dateTime } from '../../api.js';
import { useApi, Loading, ErrorBanner, Modal, Icon } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them.
 */

/* ------------------------------------------------------- KYC composer */

/**
 * KYC journeys, per product.
 *
 * QA-37: a journey is versioned and a change applies to new journeys only;
 * a step is retired, never deleted. Retiring saves the journey without it --
 * every journey already started keeps the steps it began with -- and a
 * retired step can be added back. Every change says why. While the Business
 * policy holds journey changes for Compliance (Ritesh, 14 Oct: off for now,
 * configurable), the change waits in Approvals instead of applying.
 */
export function Journeys({ session }) {
  const [data, { loading, error: loadError, reload }] = useApi('/admin/kyc/journeys');
  const [changing, setChanging] = useState(null);
  const [done, setDone] = useState(null);
  if (loadError) return <ErrorBanner error={loadError} />;
  if (loading || !data) return <Loading />;

  const mayEdit = session?.permissions?.includes('admin.kyc.journeys');
  const labelOf = (code) => data.master_steps.find((m) => m.code === code)?.label || code;

  return (
    <div className="stack">
      <div className="notice">
        The journey composer picks which of the {data.master_steps.length} master steps apply to each product, in what order,
        with per-step timers. Conditional steps (bank proof, income proof) only appear when the applicant's data triggers them.
        A change reaches journeys started after it; one already started keeps the steps it began with.
        {data.compliance_approval && ' Changes wait for a Compliance user to approve them (Business policies).'}
      </div>
      {done && <div className="notice notice-ok"><Icon name="check_circle" size={17} /> <span>{done}</span></div>}
      {data.journeys.map((j) => {
        const inJourney = new Set(j.steps.map((s) => s.step_code));
        const retired = data.master_steps.filter((m) => !inJourney.has(m.code));
        return (
          <section className="card" key={j.product.id}>
            <div className="card-head">
              <h2>{j.product.name}</h2>
              <span className="badge">{j.steps.length} steps</span>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {j.pending && (
                <div className="notice notice-warn">
                  <span className="small">
                    A change is waiting for Compliance, asked by {j.pending.requested_by_name ?? 'someone'} {dateTime(j.pending.created_at)}: {j.pending.reason}
                  </span>
                </div>
              )}
              <div className="row wrap" style={{ gap: 5 }}>
                {j.steps.map((s, i) => (
                  <span key={s.step_code} className={`badge ${s.conditional_on ? 'badge-amber' : ''}`} title={s.conditional_on ? `Conditional: ${s.conditional_on}` : ''}>
                    {i + 1}. {labelOf(s.step_code)}
                    {mayEdit && !j.pending && j.steps.length > 1 && (
                      <button type="button" className="btn-ghost btn-sm" style={{ marginLeft: 4 }}
                        onClick={() => setChanging({ journey: j, step: s.step_code, what: 'retiring' })}>Retire</button>
                    )}
                  </span>
                ))}
              </div>
              {mayEdit && !j.pending && retired.length > 0 && (
                <div className="row wrap" style={{ gap: 5 }}>
                  <span className="tiny muted">Not in this journey:</span>
                  {retired.map((m) => (
                    <button key={m.code} type="button" className="btn-ghost btn-sm"
                      onClick={() => setChanging({ journey: j, step: m.code, what: 'adding' })}>Add back {m.label}</button>
                  ))}
                </div>
              )}
            </div>
          </section>
        );
      })}
      {changing && (
        <StepChange change={changing} masterSteps={data.master_steps} labelOf={labelOf}
          onClose={() => setChanging(null)}
          onDone={(message) => { setChanging(null); setDone(message); reload(); }} />
      )}
    </div>
  );
}

/**
 * Retire a step from a journey, or add one back, with a reason. A step added
 * back takes its place in the master order rather than going to the end.
 */
function StepChange({ change, masterSteps, labelOf, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { journey, step, what } = change;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const order = (code) => masterSteps.findIndex((m) => m.code === code);
    const steps = what === 'retiring'
      ? journey.steps.filter((s) => s.step_code !== step)
      : [...journey.steps, { step_code: step }].sort((a, b) => order(a.step_code) - order(b.step_code));
    try {
      const out = await api.post(`/admin/kyc/journeys/${journey.product.id}`, {
        steps: steps.map(({ step_code: code, timer_override_s: timer, conditional_on: cond }) => ({
          step_code: code, timer_override_s: timer ?? null, conditional_on: cond ?? null,
        })),
        reason,
      });
      onDone(out.pending
        ? out.message
        : `${journey.product.name}: ${labelOf(step)} ${what === 'retiring' ? 'retired' : 'added back'}, as version ${out.version}. Journeys already started are unchanged.`);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title={`${what === 'retiring' ? 'Retire' : 'Add back'} ${labelOf(step)} — ${journey.product.name}`} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <ErrorBanner error={error} />
        <p className="small">
          {what === 'retiring'
            ? 'Applicants who start after this are not asked this step. Anyone already in a journey keeps it.'
            : 'Applicants who start after this are asked this step again. Journeys already started are unchanged.'}
        </p>
        <div className="field">
          <label htmlFor="journey-reason">Why</label>
          <input id="journey-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy || reason.trim().length < 5}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
