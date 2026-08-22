import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, mins, shortDate } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Progress, Tabs } from '../components/ui.jsx';

/**
 * Internal KYC console (BRD §7.6, P3).
 *
 * The customer-facing journey lives on the DKYC portal; this is the RM/Supervisor
 * side — health across all journeys, stall alerts, assisted completion, override.
 */
export default function KycConsole({ session }) {
  const [journeys, { loading, error, reload }] = useApi('/kyc/health');
  const [filter, setFilter] = useState('live');
  const [open, setOpen] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const buckets = {
    live: journeys.filter((j) => j.status === 'In Progress'),
    stuck: journeys.filter((j) => ['Stalled', 'Abandoned'].includes(j.status)),
    done: journeys.filter((j) => j.status === 'Complete'),
    all: journeys,
  };
  const rows = buckets[filter];

  const completed = buckets.done.filter((j) => j.elapsed_s);
  const avg = completed.length ? Math.round(completed.reduce((s, j) => s + j.elapsed_s, 0) / completed.length) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>KYC console</h1>
          <p>
            Bonanza's 16-step DIY journey. A step past its timer is Stalled; an hour stalled becomes Abandoned
            and self-service stops — the Product RM must take over.
          </p>
        </div>
        <div className="row">
          <button onClick={async () => { await api.post('/kyc/sweep'); reload(); }}>Run stall sweep</button>
          <a className="btn btn-primary" href="/dkyc" target="_blank" rel="noreferrer">Open DKYC portal</a>
        </div>
      </div>

      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />

      <div className="metrics">
        <div className="card stat"><div className="stat-label">In progress</div><div className="stat-value">{buckets.live.length}</div></div>
        <div className="card stat tone-danger"><div className="stat-label">Stalled / abandoned</div><div className="stat-value">{buckets.stuck.length}</div><div className="stat-sub">assisted completion needed</div></div>
        <div className="card stat tone-good"><div className="stat-label">Completed</div><div className="stat-value">{buckets.done.length}</div></div>
        <div className="card stat"><div className="stat-label">Avg completion</div><div className="stat-value" style={{ fontSize: 19 }}>{avg ? mins(avg) : '—'}</div><div className="stat-sub">target 15–20 min</div></div>
      </div>

      <Tabs
        tabs={[
          { key: 'live', label: 'In progress', count: buckets.live.length },
          { key: 'stuck', label: 'Needs help', count: buckets.stuck.length },
          { key: 'done', label: 'Completed', count: buckets.done.length },
          { key: 'all', label: 'All', count: journeys.length },
        ]}
        active={filter}
        onChange={setFilter}
      />

      <section className="card">
        {!rows.length ? <Empty>Nothing in this bucket.</Empty> : (
          <table>
            <thead>
              <tr><th>Applicant</th><th>Product</th><th>Status</th><th>Current step</th><th style={{ width: 140 }}>Progress</th><th className="num">On step</th><th className="num">Elapsed</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id}>
                  <td>
                    {j.lead_id
                      ? <Link to={`/leads/${j.lead_id}`} style={{ color: 'var(--brand)', fontWeight: 570 }}>{j.lead_name}</Link>
                      : <span className="muted">Walk-in applicant</span>}
                    <div className="tiny muted">{j.product_rm_name ? `RM: ${j.product_rm_name}` : 'No Product RM assigned'}</div>
                  </td>
                  <td className="small">{j.product_name}</td>
                  <td>
                    <span className={`badge ${j.status === 'Complete' ? 'badge-green' : ['Stalled', 'Abandoned'].includes(j.status) ? 'badge-red' : 'badge-blue'}`}>{j.status}</span>
                  </td>
                  <td className="small">{j.current_step_label || '—'}</td>
                  <td><Progress pct={j.progress_pct} /></td>
                  <td className="num small">{j.seconds_on_step ? mins(j.seconds_on_step) : '—'}</td>
                  <td className="num small muted">{mins(j.elapsed_s)}</td>
                  <td className="num"><button className="btn-sm" onClick={() => setOpen(j)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {open && <JourneyModal journey={open} session={session} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} onError={setActionError} />}
    </>
  );
}

function JourneyModal({ journey, session, onClose, onChanged, onError }) {
  const [full, { reload }] = useApi(`/kyc/journeys/${journey.id}`);
  const [coach, setCoach] = useState(null);
  const [busy, setBusy] = useState(false);

  const canManage = session.permissions.includes('kyc.manage');
  const canOverride = session.permissions.includes('kyc.override');

  async function act(fn) {
    setBusy(true);
    try { await fn(); reload(); }
    catch (err) { onError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal
      title={`${journey.product_name} KYC`}
      subtitle={journey.lead_name || 'Walk-in applicant'}
      onClose={onClose}
      wide
    >
      {!full ? <Loading /> : (
        <>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div className="row wrap">
              <span className={`badge ${full.status === 'Complete' ? 'badge-green' : ['Stalled', 'Abandoned'].includes(full.status) ? 'badge-red' : 'badge-blue'}`}>{full.status}</span>
              <span className="badge">{full.steps_done}/{full.steps_total} steps</span>
              <span className="badge">Elapsed {mins(full.elapsed_s)}</span>
              {full.stall?.stalled && <span className="badge badge-red">Stuck {mins(full.stall.seconds_on_step)} on “{full.stall.step_label}”</span>}
            </div>
            <div className="row">
              {['Stalled', 'Abandoned'].includes(full.status) && (
                <button className="btn-sm" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try { setCoach(await api.get(`/kyc/journeys/${journey.id}/coach`)); }
                  catch (err) { onError(err.message); }
                  finally { setBusy(false); }
                }}>Why stuck?</button>
              )}
              {canManage && full.status === 'Abandoned' && (
                <button className="btn-sm btn-primary" disabled={busy} onClick={() => act(() => api.post(`/kyc/journeys/${journey.id}/assist`))}>Take over</button>
              )}
              {full.resume_token && full.status !== 'Complete' && (
                <a className="btn btn-sm" href={`/dkyc/resume/${full.resume_token}`} target="_blank" rel="noreferrer">Applicant link</a>
              )}
            </div>
          </div>

          {coach && (
            <div className="warnbox" style={{ marginBottom: 12 }}>
              <div><strong>Likely cause.</strong> {coach.likely_cause}</div>
              <div style={{ marginTop: 4 }}><strong>What to say.</strong> {coach.what_to_say}</div>
              <div className="tiny" style={{ marginTop: 4 }}>Best channel: {coach.recommended_channel}{coach.escalate ? ' · escalate' : ''}</div>
            </div>
          )}

          <Progress pct={full.progress_pct} label="Journey progress" />

          <table style={{ marginTop: 14 }}>
            <thead><tr><th>Step</th><th>Owner</th><th>Status</th><th className="num">Time on step</th><th className="num">Timer</th><th /></tr></thead>
            <tbody>
              {full.steps.filter((s) => s.applies).map((s) => (
                <tr key={s.code}>
                  <td>
                    <div style={{ fontWeight: 545 }}>{s.label}</div>
                    <div className="tiny muted">{s.group}</div>
                  </td>
                  <td className="small muted">{s.owner_type}</td>
                  <td>
                    <span className={`badge ${s.status === 'done' ? 'badge-green' : s.status === 'stalled' ? 'badge-red' : s.status === 'active' ? 'badge-blue' : ''}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="num small">{s.seconds_on_step ? mins(s.seconds_on_step) : '—'}</td>
                  <td className="num tiny muted">{mins(s.timer_s || s.timer)}</td>
                  <td className="num">
                    {canOverride && s.status !== 'done' && (
                      <button className="btn-sm" disabled={busy} onClick={() => act(() => api.post(`/kyc/journeys/${journey.id}/override`, { step_code: s.code, action: 'complete' }))}>
                        Force complete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {Object.keys(full.form || {}).length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>Captured so far</h3>
              <div className="grid grid-3" style={{ marginTop: 6 }}>
                {Object.entries(full.form).filter(([, v]) => typeof v !== 'object').slice(0, 15).map(([k, v]) => (
                  <div key={k} className="small"><span className="muted">{k.replace(/_/g, ' ')}: </span>{String(v)}</div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
