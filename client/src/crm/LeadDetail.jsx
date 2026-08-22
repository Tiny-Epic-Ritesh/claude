import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, money, rupees, shortDate, dateTime, mins, STATE_LABEL, ROLE_LABEL } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Tabs, AgeBadge, PriorityBadge, Progress, CardDot, Icon } from '../components/ui.jsx';
import ActivityComposer from './ActivityComposer.jsx';
import InCall from './InCall.jsx';
import ProductCard from '../components/ProductCard.jsx';
import ActionMenu from '../components/ActionMenu.jsx';
import ActionModal from './ActionModals.jsx';
import { LeadMarketContext } from '../components/Market.jsx';
import { useLeadActions, CallNumber } from './leadActions.jsx';

/**
 * The lead record. Sections and the action bar vary by role (BRD §11) — the
 * header strip is identical for everyone.
 */
export default function LeadDetail({ session }) {
  const { id } = useParams();
  const [lead, { loading, error, reload }] = useApi(`/leads/${id}`);
  const [tab, setTab] = useState('cards');
  const [inCall, setInCall] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [nba, setNba] = useState(null);
  const [nbaBusy, setNbaBusy] = useState(false);

  // Declared after the setters it closes over — `const` bindings are in the
  // temporal dead zone until initialised, so hoisting this above them renders
  // a blank page rather than failing at build time.
  const actions = useLeadActions({
    session, reload, onError: setActionError, onNotice: setNotice,
  });

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const readOnly = lead.read_only;
  const can = (p) => session.permissions.includes(p);

  async function askNextAction() {
    setNbaBusy(true);
    try { setNba(await api.get(`/ai/leads/${id}/next-action`)); }
    catch (err) { setActionError(err.message); }
    finally { setNbaBusy(false); }
  }

  const tabs = [
    { key: 'cards', label: 'Product cards', count: lead.cards.length },
    { key: 'details', label: 'Details' },
    { key: 'market', label: 'Market' },
    { key: 'activity', label: 'Activity', count: lead.activities.length },
    { key: 'notes', label: 'Notes', count: lead.notes.length },
    { key: 'tasks', label: 'Tasks', count: lead.tasks.filter((t) => t.status === 'Open').length },
    { key: 'tickets', label: 'Tickets', count: lead.tickets.filter((t) => !['Resolved', 'Closed'].includes(t.status)).length },
    { key: 'kyc', label: 'KYC', count: lead.journeys.length },
  ];

  return (
    <>
      {/* Header strip — identical for every role */}
      <div className="page-head">
        <div>
          <Link to="/leads" className="small muted">← Leads</Link>
          <h1 style={{ marginTop: 5 }}>{lead.name}</h1>
          <div className="row wrap small muted" style={{ marginTop: 5 }}>
            {/* Click to dial. Goes through CUBE, not a tel: link, so the call is
                recorded and logged against this lead. */}
            <CallNumber
              lead={lead}
              permissions={session.permissions}
              onCall={(l) => actions.run('call', l)}
              dialling={actions.dialling === lead.id}
            />
            {lead.email && <span>· {lead.email}</span>}
            <span>· {lead.city || 'City unknown'}</span>
            <span>· {lead.language}</span>
            <span className="badge">{lead.stage}</span>
            <AgeBadge band={lead.age_band} days={lead.age_days} />
            <span className={`badge ${lead.kyc_status === 'Complete' ? 'badge-green' : ['Stalled', 'Abandoned'].includes(lead.kyc_status) ? 'badge-red' : ''}`}>
              KYC: {lead.kyc_status}
            </span>
            {lead.open_tickets > 0 && <span className="badge badge-red">{lead.open_tickets} open ticket</span>}
            <span className="row" style={{ gap: 3, marginLeft: 4 }}>
              {lead.cards.map((c) => <span key={c.id} className={`dot dot-${c.colour}`} title={`${c.product_name}: ${STATE_LABEL[c.state]}`} />)}
            </span>
          </div>
        </div>

        <div className="row wrap">
          {readOnly && <span className="badge badge-amber">Read-only for {ROLE_LABEL[session.role]}</span>}
          {can('lead.contact') && <button className="btn-accent" onClick={() => setInCall(true)}>Start call</button>}
          <button onClick={askNextAction} disabled={nbaBusy}>{nbaBusy ? <Spinner /> : 'Next best action'}</button>
          {!readOnly && (
            <ActionMenu
              lead={lead}
              permissions={session.permissions}
              onAction={(key, l) => (key === 'edit' ? setEditing(true) : actions.run(key, l))}
            />
          )}
        </div>
      </div>

      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between" style={{ marginBottom: 'var(--gap)' }}>
          <span><Icon name="check_circle" /> {notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {nba && (
        <section className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--accent)' }}>
          <div className="card-body">
            <div className="row-between">
              <h3>{nba.action}</h3>
              <div className="row">
                <span className="badge badge-accent">{nba.urgency}</span>
                <span className="badge">{nba.channel}</span>
                <button className="btn-ghost btn-sm" onClick={() => setNba(null)}>Dismiss</button>
              </div>
            </div>
            <p className="small" style={{ margin: '6px 0 4px' }}>{nba.reason}</p>
            <p className="small muted" style={{ margin: 0 }}><strong>Say:</strong> {nba.talking_point}</p>
          </div>
        </section>
      )}

      {/* Snapshot */}
      <div className="metrics">
        <Snap label="Lead score" value={lead.score} />
        <Snap label="AUM" value={lead.aum ? money(lead.aum) : '—'} sub={lead.aum_as_of ? `as of ${lead.aum_as_of}` : 'no active products'} />
        <Snap label="Owner" value={lead.owner_name || '—'} sub={lead.partner_name ? `sourced by ${lead.partner_name}` : lead.source} />
        <Snap label="Last contact" value={lead.days_since_contact == null ? 'never' : `${lead.days_since_contact}d ago`} sub={shortDate(lead.last_activity_at)} />
        <Snap label="Risk profile" value={lead.risk_profile || '—'} />
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'cards' && <Cards lead={lead} session={session} reload={reload} onError={setActionError} />}
      {tab === 'details' && <DetailsTab lead={lead} session={session} onEdit={() => setEditing(true)} />}
      {tab === 'market' && <LeadMarketContext leadId={lead.id} />}
      {tab === 'activity' && <ActivityTab lead={lead} session={session} reload={reload} />}
      {tab === 'notes' && <Notes lead={lead} session={session} reload={reload} />}
      {tab === 'tasks' && <TasksTab lead={lead} reload={reload} />}
      {tab === 'tickets' && <TicketsTab lead={lead} reload={reload} readOnly={readOnly} />}
      {tab === 'kyc' && <KycTab lead={lead} session={session} reload={reload} onError={setActionError} />}

      {inCall && <InCall lead={lead} session={session} onClose={() => { setInCall(false); reload(); }} />}
      <ActionModal
        state={actions.modal}
        session={session}
        onClose={() => actions.setModal(null)}
        onDone={() => { actions.setModal(null); reload(); }}
        onNotice={setNotice}
      />

      {editing && (
        <EditLead
          lead={lead}
          session={session}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); reload(); }}
        />
      )}
    </>
  );
}

const Snap = ({ label, value, sub }) => (
  <div className="card stat">
    <div className="stat-label">{label}</div>
    <div className="stat-value" style={{ fontSize: 18 }}>{value}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

/* --------------------------------------------------------- product cards */

/**
 * What the button on each card should say.
 *
 * "Open" tells a rep nothing. The state already implies the next move, so the
 * button names it — and the panel behind it still shows every legal transition,
 * because the obvious move is not always the right one.
 */
const NEXT_MOVE = {
  INACTIVE: 'Start engaging',
  EXPLORING: 'Mark warm',
  WARM: 'Move forward',
  PRODUCT_RM_ENGAGED: 'Update',
  ON_HOLD: 'Resume',
  ACTIVE: 'View',
  LOST: 'Review',
};

function Cards({ lead, session, reload, onError }) {
  const [open, setOpen] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const can = (p) => session.permissions.includes(p);

  /**
   * Engaged products first.
   *
   * A lead carries a card for every product, so eleven boxes appear and eight
   * of them say "Not engaged". Sorted by the catalogue's order, the three the
   * rep actually needs are scattered among them. Sorted by engagement, the
   * live work is at the top and the rest is still one scroll away.
   */
  const RANK = {
    AT_RISK: 0, WARM: 1, PRODUCT_RM_ENGAGED: 2, EXPLORING: 3,
    ACTIVE: 4, ON_HOLD: 5, LOST: 6, INACTIVE: 7,
  };
  const sorted = [...lead.cards].sort((a, b) =>
    (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const engaged = sorted.filter((c) => c.state !== 'INACTIVE');
  const dormant = sorted.filter((c) => c.state === 'INACTIVE');
  const ordered = showAll ? sorted : (engaged.length ? engaged : sorted);

  return (
    <>
      {/* Box per product, uniform grid, one action each. A row-per-product list
          made eleven products look like eleven rows to scroll; a card makes each
          one a thing with a state and a button. The button opens the same panel
          the whole card used to — over this page, never away from it. */}
      <div className="product-grid" style={{ marginBottom: 14 }}>
        {ordered.map((c) => (
          <ProductCard
            key={c.id}
            product={{ name: c.product_name, category: c.product_category ?? c.product_code, code: c.product_code }}
            state={c.state}
            facts={[
              { label: 'Value', value: c.value > 0 ? money(c.value) : '—' },
              ...(c.product_rm_name ? [{ label: 'Product RM', value: c.product_rm_name, small: true }] : []),
              ...(c.contact_flag ? [{ label: 'Contact', value: c.contact_flag, small: true }] : []),
            ]}
            actions={(
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(c)}>
                {NEXT_MOVE[c.state] ?? 'Open'}
              </button>
            )}
          />
        ))}
      </div>

      {/* The dormant products are not hidden, just folded — a rep who wants to
          pitch something new needs them one click away, not one screen away. */}
      {!showAll && engaged.length > 0 && dormant.length > 0 && (
        <button type="button" className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => setShowAll(true)}>
          <Icon name="expand_more" /> Show {dormant.length} product{dormant.length === 1 ? '' : 's'} not yet engaged
        </button>
      )}
      {showAll && engaged.length > 0 && dormant.length > 0 && (
        <button type="button" className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => setShowAll(false)}>
          <Icon name="expand_less" /> Show engaged products only
        </button>
      )}

      {open && (
        <CardPanel
          card={open}
          lead={lead}
          session={session}
          canWarm={can('card.mark.warm')}
          canExplore={can('card.mark.exploring')}
          canEngage={can('card.engage')}
          canRequest={can('card.request.productrm')}
          canKyc={can('kyc.manage')}
          onClose={() => setOpen(null)}
          onDone={() => { setOpen(null); reload(); }}
          onError={onError}
        />
      )}
    </>
  );
}

function CardPanel({ card, lead, session, canWarm, canExplore, canEngage, canRequest, canKyc, onClose, onDone, onError }) {
  const [product] = useApi(`/meta`);
  const [busy, setBusy] = useState(false);
  const [flag, setFlag] = useState('Direct Contact');
  const [note, setNote] = useState('');

  const def = (product?.products || []).find((p) => p.id === card.product_type_id);
  const pitch = def?.pitch_points ? JSON.parse(def.pitch_points) : [];
  const objections = def?.objections ? JSON.parse(def.objections) : [];

  async function setState(state, extra = {}) {
    setBusy(true);
    try {
      await api.post(`/cards/${card.id}/state`, { state, note: note || undefined, ...extra });
      onDone();
    } catch (err) { onError(err.message); setBusy(false); }
  }

  async function requestProductRm() {
    setBusy(true);
    try {
      await api.post(`/cards/${card.id}/request-product-rm`, { reason: note || 'Sales RM requested product expertise' });
      onDone();
    } catch (err) { onError(err.message); setBusy(false); }
  }

  async function startKyc() {
    setBusy(true);
    try {
      const j = await api.post('/kyc/journeys', { lead_id: lead.id, card_id: card.id });
      window.open(`/dkyc/resume/${j.resume_token}`, '_blank');
      onDone();
    } catch (err) { onError(err.message); setBusy(false); }
  }

  return (
    <Modal title={card.product_name} subtitle={`Current state: ${STATE_LABEL[card.state]}`} onClose={onClose} wide>
      <div className="grid grid-2">
        <div>
          <h3>Pitch — use this on the call</h3>
          <ul className="small" style={{ marginTop: 6, paddingLeft: 18 }}>
            {pitch.map((p, i) => <li key={i} style={{ marginBottom: 4 }}>{p}</li>)}
          </ul>
          {def && (
            <div className="row wrap small muted" style={{ marginTop: 8 }}>
              {def.min_investment > 0 && <span className="badge">Min {rupees(def.min_investment)}</span>}
              {def.lock_in && <span className="badge">Lock-in: {def.lock_in}</span>}
              {def.risk_category && <span className="badge">{def.risk_category} risk</span>}
            </div>
          )}
          {objections.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Common objections</h3>
              {objections.map((o, i) => (
                <details key={i} className="small" style={{ marginTop: 6 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 560 }}>{o.objection}</summary>
                  <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>{o.response}</p>
                </details>
              ))}
            </>
          )}
        </div>

        <div>
          <h3>Move this card</h3>
          <div className="field" style={{ marginTop: 6 }}>
            <label>Note (recorded in the card audit trail)</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did the lead say?" style={{ minHeight: 64 }} />
          </div>

          {canWarm && (
            <div className="field">
              <label>Contact flag (set when marking Warm)</label>
              <select value={flag} onChange={(e) => setFlag(e.target.value)}>
                {['Direct Contact', 'No Direct Contact', 'Schedule Joint Call'].map((f) => <option key={f}>{f}</option>)}
              </select>
            </div>
          )}

          <div className="row wrap" style={{ gap: 6 }}>
            {canExplore && card.state === 'INACTIVE' && <button onClick={() => setState('EXPLORING')} disabled={busy}>Mark Exploring</button>}
            {canWarm && ['INACTIVE', 'EXPLORING'].includes(card.state) && (
              <button className="btn-primary" onClick={() => setState('WARM', { contact_flag: flag })} disabled={busy}>Mark Warm</button>
            )}
            {canRequest && ['WARM', 'EXPLORING'].includes(card.state) && (
              <button onClick={requestProductRm} disabled={busy}>Request Product RM</button>
            )}
            {canEngage && card.state === 'WARM' && <button onClick={() => setState('PRODUCT_RM_ENGAGED')} disabled={busy}>Accept & engage</button>}
            {canKyc && ['WARM', 'PRODUCT_RM_ENGAGED'].includes(card.state) && (
              <button className="btn-accent" onClick={startKyc} disabled={busy}>Start KYC journey</button>
            )}
            {canWarm && !['INACTIVE', 'LOST', 'ACTIVE'].includes(card.state) && <button onClick={() => setState('ON_HOLD')} disabled={busy}>Put on hold</button>}
            {(canWarm || canEngage) && card.state !== 'LOST' && <button className="btn-danger" onClick={() => setState('LOST', { lost_reason: note })} disabled={busy}>Mark Lost</button>}
          </div>

          {!canExplore && !canWarm && !canEngage && (
            <p className="small muted" style={{ marginTop: 10 }}>
              Your role can view this card but not change its state.
            </p>
          )}

          <CardAudit cardId={card.id} />
        </div>
      </div>
    </Modal>
  );
}

function CardAudit({ cardId }) {
  const [rows] = useApi(`/cards/${cardId}/audit`);
  if (!rows?.length) return null;
  return (
    <>
      <h3 style={{ marginTop: 16 }}>Card audit trail</h3>
      <div className="stack small" style={{ marginTop: 6 }}>
        {rows.slice(0, 6).map((a) => (
          <div key={a.id} className="row-between">
            <span>{STATE_LABEL[a.from_state] || a.from_state} → <strong>{STATE_LABEL[a.to_state] || a.to_state}</strong>{a.note ? ` — ${a.note}` : ''}</span>
            <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{a.user_name || 'system'} · {shortDate(a.created_at)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- tabs */

/**
 * The activity tab: capture on the left, timeline on the right.
 *
 * Side by side rather than stacked, because logging a call and reading what
 * happened last time are the same moment of work — the rep is looking at the
 * history while they type the outcome.
 */
function ActivityTab({ lead, session, reload }) {
  const [rows, setRows] = useState(lead.activities ?? []);

  const refresh = () => {
    api.get(`/activities/lead/${lead.id}`).then(setRows).catch(() => {});
    reload();
  };

  const mayLog = session.permissions.includes('lead.contact');

  return (
    <div className="grid" style={{ gridTemplateColumns: mayLog ? 'minmax(340px, 420px) 1fr' : '1fr', gap: 14 }}>
      {mayLog && (
        <ActivityComposer lead={lead} cards={lead.cards ?? []} onLogged={refresh} />
      )}
      <Timeline rows={rows} />
    </div>
  );
}

const OUTCOME_TONE = {
  Connected: 'badge-green',
  'Not Connected': 'badge-amber',
  Other: '',
};

function Timeline({ rows }) {
  if (!rows.length) return <div className="card"><Empty>No activity logged yet.</Empty></div>;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Timeline</h2>
        <span className="tiny muted">{rows.length} entries, newest first</span>
      </div>
      <div className="card-body stack" style={{ gap: 0 }}>
        {rows.map((a) => (
          <div key={a.id} className="tl-item">
            <div className="tl-rail">
              <span className={`tl-dot ${a.outcome === 'Connected' ? 'tl-dot-ok' : a.outcome === 'Not Connected' ? 'tl-dot-warn' : ''}`} />
            </div>

            <div style={{ minWidth: 0, paddingBottom: 16 }}>
              <div className="row wrap" style={{ gap: 7 }}>
                <span className={`badge ${a.ai_generated ? 'badge-accent' : ''}`}>{a.type}</span>
                {a.sub_disposition && (
                  <span className={`badge ${OUTCOME_TONE[a.outcome] ?? ''}`}>{a.sub_disposition}</span>
                )}
                {a.duration_s > 0 && (
                  <span className="tiny muted">{Math.round(a.duration_s / 60)} min</span>
                )}
                <span className="tiny muted">· {dateTime(a.created_at)}</span>
                <span className="tiny muted">· {a.user_name || 'system'}</span>
              </div>

              {a.body && (
                <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{a.body}</div>
              )}
              {a.reason && (
                <div className="small tone-bad" style={{ marginTop: 3 }}>
                  <Icon name="info" size={13} /> {a.reason}
                </div>
              )}

              {/* The commitment this activity created — the link that makes the
                  automation visible rather than something that happened offstage. */}
              {a.follow_up_due && (
                <div className="tl-commit">
                  <Icon name="event_upcoming" size={15} style={{ color: 'var(--accent-dark)' }} />
                  <span className="tiny">
                    {a.follow_up_status === 'Done' ? 'Followed up' : 'Follow-up scheduled'}
                    {' · '}{dateTime(a.follow_up_due)}
                  </span>
                  {a.follow_up_status === 'Done'
                    ? <span className="badge badge-green">Done</span>
                    : <span className="badge badge-accent">Open</span>}
                </div>
              )}
              {a.meeting_at && (
                <div className="tl-commit">
                  <Icon name="groups" size={15} style={{ color: 'var(--accent-dark)' }} />
                  <span className="tiny">Meeting · {dateTime(a.meeting_at)}{a.meeting_mode ? ` · ${a.meeting_mode}` : ''}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Notes({ lead, session, reload }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try { await api.post('/notes', { lead_id: lead.id, body }); setBody(''); reload(); }
    finally { setBusy(false); }
  }

  const canWrite = session.role !== 'marketing_manager';

  return (
    <section className="card">
      <div className="card-body">
        {canWrite && (
          <form onSubmit={add} style={{ marginBottom: 14 }}>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note — everyone with access to this lead can see it." />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn-primary" disabled={busy || !body.trim()}>{busy ? <Spinner /> : 'Add note'}</button>
            </div>
          </form>
        )}

        {!lead.notes.length ? <Empty>No notes yet.</Empty> : (
          <div className="stack">
            {lead.notes.map((n) => (
              <div key={n.id} style={{ borderLeft: `2px solid ${n.pinned ? 'var(--accent)' : 'var(--border)'}`, paddingLeft: 12 }}>
                <div className="row-between">
                  <span className="tiny" style={{ fontWeight: 640 }}>
                    {n.user_name} · <span className="muted">{ROLE_LABEL[n.user_role] || n.user_role}</span> · <span className="muted">{dateTime(n.created_at)}</span>
                  </span>
                  {n.pinned ? <span className="badge badge-accent">Pinned</span> : null}
                </div>
                <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{n.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TasksTab({ lead, reload }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    if (!title.trim() || !due) return;
    setBusy(true);
    try { await api.post('/tasks', { title, lead_id: lead.id, due_at: due.replace('T', ' ') }); setTitle(''); setDue(''); reload(); }
    finally { setBusy(false); }
  }

  return (
    <section className="card">
      <div className="card-body">
        <form onSubmit={add} className="row wrap" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
          <div className="field" style={{ flex: '2 1 240px', marginBottom: 0 }}>
            <label>New task</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Send the brokerage comparison…" />
          </div>
          <div className="field" style={{ flex: '1 1 190px', marginBottom: 0 }}>
            <label>Due</label>
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
          <button className="btn-primary" disabled={busy || !title.trim() || !due}>{busy ? <Spinner /> : 'Add'}</button>
        </form>

        {!lead.tasks.length ? <Empty>No tasks on this lead.</Empty> : (
          <table>
            <tbody>
              {lead.tasks.map((t) => (
                <tr key={t.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={t.status === 'Completed'}
                      style={{ width: 16, height: 16 }}
                      onChange={async () => { await api.patch(`/tasks/${t.id}`, { status: t.status === 'Completed' ? 'Open' : 'Completed' }); reload(); }}
                    />
                  </td>
                  <td>
                    <div style={{ textDecoration: t.status === 'Completed' ? 'line-through' : 'none', opacity: t.status === 'Completed' ? 0.6 : 1 }}>{t.title}</div>
                    <div className="tiny muted">{t.assignee_name} · {t.priority}</div>
                  </td>
                  <td className="num"><span className={`badge ${new Date(t.due_at) < new Date() && t.status === 'Open' ? 'badge-red' : ''}`}>{shortDate(t.due_at)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function TicketsTab({ lead, reload, readOnly }) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Tickets</h2>
        {!readOnly && <button className="btn-sm btn-primary" onClick={() => setCreating(true)}>Raise ticket</button>}
      </div>
      {!lead.tickets.length ? <Empty>No tickets on this lead.</Empty> : (
        <table>
          <tbody>
            {lead.tickets.map((t) => (
              <tr key={t.id}>
                <td style={{ width: 110 }}>
                  <Link to={`/tickets/${t.id}`} style={{ color: 'var(--brand)', fontWeight: 600 }}>{t.ref}</Link>
                  <div className="tiny muted">{shortDate(t.created_at)}</div>
                </td>
                <td>
                  <div style={{ fontWeight: 545 }}>{t.subject}</div>
                  <div className="tiny muted" style={{ whiteSpace: 'pre-wrap' }}>{t.ai_summary}</div>
                </td>
                <td style={{ width: 100 }}><PriorityBadge priority={t.priority} /></td>
                <td style={{ width: 130 }}>
                  <span className={`badge ${t.breached ? 'badge-red' : ''}`}>{t.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <NewTicket lead={lead} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />}
    </section>
  );
}

function NewTicket({ lead, onClose, onCreated }) {
  const [meta] = useApi('/meta');
  const [form, setForm] = useState({ subject: '', description: '', priority: 'Medium', category_id: '', card_id: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/tickets', {
        ...form, lead_id: lead.id,
        category_id: form.category_id || undefined,
        card_id: form.card_id || undefined,
      });
      onCreated();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Raise a ticket" subtitle={`Linked to ${lead.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBanner error={error} />
        <div className="field"><label>Subject</label><input value={form.subject} onChange={set('subject')} required autoFocus /></div>
        <div className="field"><label>Description</label><textarea value={form.description} onChange={set('description')} /></div>
        <div className="field-row">
          <div className="field">
            <label>Priority</label>
            <select value={form.priority} onChange={set('priority')}>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}</select>
          </div>
          <div className="field">
            <label>Category</label>
            <select value={form.category_id} onChange={set('category_id')}>
              <option value="">Uncategorised</option>
              {(meta?.ticket_categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Link to a product card (optional — drives the SLA policy)</label>
          <select value={form.card_id} onChange={set('card_id')}>
            <option value="">Not product-specific</option>
            {lead.cards.map((c) => <option key={c.id} value={c.id}>{c.product_name}</option>)}
          </select>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !form.subject.trim()}>{busy ? <Spinner /> : 'Create ticket'}</button>
        </div>
      </form>
    </Modal>
  );
}

function KycTab({ lead, session, reload, onError }) {
  const [coach, setCoach] = useState(null);
  const [busy, setBusy] = useState(false);
  const canManage = session.permissions.includes('kyc.manage');

  if (!lead.journeys.length) {
    return <div className="card"><Empty>No KYC journey started for this lead.</Empty></div>;
  }

  return (
    <div className="stack">
      {lead.journeys.map((j) => <JourneyCard key={j.id} journey={j} canManage={canManage} onError={onError} reload={reload} setCoach={setCoach} busy={busy} setBusy={setBusy} />)}
      {coach && (
        <Modal title="Why they are stuck" onClose={() => setCoach(null)}>
          <p><strong>Likely cause.</strong> {coach.likely_cause}</p>
          <p><strong>What to say.</strong> {coach.what_to_say}</p>
          <div className="row">
            <span className="badge badge-blue">Best channel: {coach.recommended_channel}</span>
            {coach.escalate && <span className="badge badge-red">Escalate</span>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function JourneyCard({ journey, canManage, onError, reload, setCoach, busy, setBusy }) {
  const [full] = useApi(`/kyc/journeys/${journey.id}`);
  if (!full) return <div className="card"><Loading /></div>;

  async function coach() {
    setBusy(true);
    try { setCoach(await api.get(`/kyc/journeys/${journey.id}/coach`)); }
    catch (err) { onError(err.message); }
    finally { setBusy(false); }
  }

  async function assist() {
    setBusy(true);
    try { await api.post(`/kyc/journeys/${journey.id}/assist`); reload(); }
    catch (err) { onError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{full.product?.name} KYC</h2>
          <div className="tiny muted">
            {full.steps_done}/{full.steps_total} steps · elapsed {mins(full.elapsed_s)}
            {full.stall?.stalled && ` · stuck ${mins(full.stall.seconds_on_step)} on "${full.stall.step_label}"`}
          </div>
        </div>
        <div className="row">
          <span className={`badge ${full.status === 'Complete' ? 'badge-green' : ['Stalled', 'Abandoned'].includes(full.status) ? 'badge-red' : 'badge-blue'}`}>{full.status}</span>
          {['Stalled', 'Abandoned'].includes(full.status) && <button className="btn-sm" onClick={coach} disabled={busy}>Why stuck?</button>}
          {canManage && full.status === 'Abandoned' && <button className="btn-sm btn-primary" onClick={assist} disabled={busy}>Take over</button>}
          {full.resume_token && full.status !== 'Complete' && (
            <a className="btn btn-sm" href={`/dkyc/resume/${full.resume_token}`} target="_blank" rel="noreferrer">Open applicant link</a>
          )}
        </div>
      </div>

      <div className="card-body">
        <Progress pct={full.progress_pct} label="Journey progress" />
        <div className="rail" style={{ marginTop: 14 }}>
          {full.steps.filter((s) => s.applies).map((s) => (
            <div key={s.code} className="rail-step">
              <div className={`rail-dot ${s.status === 'done' ? 'done' : s.status === 'active' ? 'active' : s.status === 'stalled' ? 'stalled' : ''}`}>
                {s.status === 'done' ? '✓' : ''}
              </div>
              <div className="rail-label">{s.label}</div>
              {s.seconds_on_step > 0 && <div className="tiny muted">{mins(s.seconds_on_step)}</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ edit lead */

/**
 * Edit a lead.
 *
 * The form is not written by hand. It asks `/meta/fields/lead` what the fields
 * are and renders them — so a field an administrator adds in Setup appears here
 * with no deploy, and a field the caller may not read never arrives in the
 * browser at all.
 *
 * The two supervisor-gated fields, stage and owner, are shown but disabled for
 * roles that cannot change them, with the reason stated. A hidden control makes
 * people think the system is broken; a disabled one with a reason teaches them
 * how it works.
 */
function EditLead({ lead, session, onClose, onSaved }) {
  const [meta] = useApi('/meta/fields/lead');
  const [refs] = useApi('/meta');
  /**
   * The record is fetched again, unmasked, for the form only.
   *
   * The lead payload masks PII — `••••••0000` for the mobile. Seeding the form
   * from that is data corruption waiting to happen: the phone input strips
   * non-digits, so the first keystroke in a masked field would turn a client's
   * number into "0000" and save it.
   *
   * `?unmask=true` is refused unless the caller holds `pii.unmask`, and it
   * writes an audit row naming who revealed what. Revealing a client's PAN
   * should be a deliberate, recorded act — which is exactly what opening an
   * edit form on that client is.
   */
  const [full] = useApi(`/leads/${lead.id}?unmask=true`);
  const [form, setForm] = useState({});
  const [custom, setCustom] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const can = (p) => session.permissions.includes(p);

  // Seed from the record once the field list is known, so we send back exactly
  // the fields this user was offered and nothing else.
  const record = full ?? lead;

  useEffect(() => {
    if (!meta || !full) return;
    const seed = {};
    for (const f of meta.fields) {
      if (f.storage !== 'column' || f.derived) continue;
      seed[f.api_name] = full[f.api_name] ?? '';
    }
    setForm(seed);
    setCustom({ ...(full.custom ?? {}) });
  }, [meta, full]);

  if (!meta || !full) return <Modal title="Edit lead" onClose={onClose} wide><Loading /></Modal>;

  // Read-only on the record, not on the field: computed, system-owned, or
  // simply not editable from this screen.
  const NEVER_EDITABLE = new Set(['created_at', 'next_follow_up_at', 'client_code', 'sales_org']);

  const editable = meta.fields.filter((f) =>
    f.storage === 'column' && !f.derived && !NEVER_EDITABLE.has(f.api_name));
  const customFields = meta.fields.filter((f) => f.storage === 'value' && !f.derived);

  // Belt and braces: if a value came back still masked, the caller may not read
  // it, so they must not be able to overwrite it either.
  const isMasked = (v) => typeof v === 'string' && v.includes('•');

  const gate = (name) => {
    if (name === 'stage' && !can('lead.stage.change')) return 'Stage changes need a Sales Supervisor';
    if (name === 'owner_id' && !can('lead.reassign')) return 'Reassignment needs a Sales Supervisor';
    if (isMasked(record[name])) return 'Hidden for your role — ask an administrator to change it';
    return null;
  };

  // Picklist values come from the metadata layer, not from a copy kept here.
  // Add a campaign source in Setup and it appears in this dropdown.
  const options = (f) => (f.values?.length ? f.values : null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null); setFieldErrors({});
    try {
      const body = {};
      for (const f of editable) {
        if (gate(f.api_name)) continue;               // never send what we disabled
        const v = form[f.api_name];
        // A <select> yields a string even for a numeric id. Comparing the raw
        // values would mark every lookup as changed on every save.
        const before = record[f.api_name] ?? '';
        if (String(v ?? '') !== String(before)) body[f.api_name] = v;
      }
      if (customFields.length) body.custom = custom;

      if (!Object.keys(body).length) { onClose(); return; }
      await api.patch(`/leads/${lead.id}`, body);
      onSaved();
    } catch (err) {
      setError(err.message);
      if (err.payload?.fields) setFieldErrors(err.payload.fields);
      setBusy(false);
    }
  }

  const set = (name, v) => setForm((f) => ({ ...f, [name]: v }));

  const renderInput = (f, value, onChange, disabled) => {
    const opts = options(f);
    if (opts) {
      return (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">—</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    // Lookups are chosen from a list, never typed as a raw id. Getting
    // `partner_id` wrong routes someone else's commission.
    if (f.type === 'lookup') {
      const LOOKUPS = {
        owner_id: { rows: refs?.users ?? [], blank: 'Unassigned', label: (u) => u.name },
        product_rm_id: { rows: refs?.users ?? [], blank: 'None', label: (u) => u.name },
        partner_id: {
          rows: refs?.partners ?? [],
          blank: 'Direct — no partner',
          label: (p) => `${p.business_name || p.name}${p.partner_code ? ` · ${p.partner_code}` : ''}`,
        },
      };
      const cfg = LOOKUPS[f.api_name];
      if (!cfg) return <input value={value ?? ''} disabled readOnly />;
      return (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">{cfg.blank}</option>
          {cfg.rows.map((r) => <option key={r.id} value={r.id}>{cfg.label(r)}</option>)}
        </select>
      );
    }
    if (f.type === 'checkbox') {
      return (
        <label className="inline">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
          <span className="tiny muted">{f.help_text ?? 'Yes'}</span>
        </label>
      );
    }
    if (f.type === 'textarea' || f.type === 'richtext') {
      return <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} rows={3} />;
    }
    if (f.type === 'datetime' || f.type === 'date') {
      return <input type="date" value={(value ?? '').slice(0, 10)} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    }
    if (f.type === 'number' || f.type === 'currency' || f.type === 'percent') {
      return <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
    }
    if (f.type === 'phone') {
      return (
        <input
          value={value ?? ''} inputMode="numeric" disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
        />
      );
    }
    return (
      <input
        value={value ?? ''} disabled={disabled} maxLength={f.length ?? undefined}
        onChange={(e) => onChange(f.api_name === 'pan' ? e.target.value.toUpperCase() : e.target.value)}
      />
    );
  };

  return (
    <Modal title={`Edit ${record.name}`} subtitle="Fields come from Setup — what you see is what this record has." onClose={onClose} wide>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        {editable.map((f) => {
          const blocked = gate(f.api_name);
          const wide = ['name', 'email'].includes(f.api_name) || f.type === 'textarea';
          return (
            <label key={f.api_name} className={wide ? 'span-2' : ''}>
              <span>
                {f.label}
                {f.required && <span className="req"> *</span>}
                {f.encrypted && <span className="chip-lock"><span className="material-symbols-rounded">key</span>encrypted</span>}
              </span>
              {renderInput(f, form[f.api_name], (v) => set(f.api_name, v), Boolean(blocked))}
              {blocked && <small className="muted">{blocked}</small>}
              {!blocked && f.help_text && <small className="muted">{f.help_text}</small>}
            </label>
          );
        })}

        {customFields.length > 0 && (
          <>
            <div className="span-2 form-divider">
              <span>Added in Setup</span>
            </div>
            {customFields.map((f) => (
              <label key={f.api_name} className={f.type === 'textarea' ? 'span-2' : ''}>
                <span>{f.label}{f.required && <span className="req"> *</span>}</span>
                {renderInput(f, custom[f.api_name], (v) => setCustom((c) => ({ ...c, [f.api_name]: v })), false)}
                {fieldErrors[f.api_name]
                  ? <small className="err-text">{fieldErrors[f.api_name]}</small>
                  : f.help_text && <small className="muted">{f.help_text}</small>}
              </label>
            ))}
          </>
        )}

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------- details */

/**
 * Every field on the record, and everything that has changed on it.
 *
 * The field list is not written here — it comes from the metadata layer, so a
 * field an administrator adds in Setup appears on this tab straight away, in
 * the right group, with its own label. That is the whole point of building the
 * metadata layer rather than hard-coding forms.
 *
 * History sits alongside rather than on a separate screen, because "what is the
 * stage?" and "who changed it, and when?" are the same question asked one
 * second apart.
 */
function DetailsTab({ lead, session, onEdit }) {
  const [meta] = useApi('/meta/fields/lead');
  const can = (p) => session.permissions.includes(p);

  if (!meta) return <Loading />;

  const shown = meta.fields.filter((f) => !['name'].includes(f.api_name));
  const core = shown.filter((f) => !f.is_custom);
  const custom = shown.filter((f) => f.is_custom);

  const display = (f) => {
    const raw = f.storage === 'value' ? lead.custom?.[f.api_name] : lead[f.api_name];
    if (raw == null || raw === '') return <span className="muted">—</span>;
    if (f.type === 'checkbox') return raw ? 'Yes' : 'No';
    if (f.type === 'currency') return money(raw);
    if (f.type === 'datetime' || f.type === 'date') return shortDate(raw);
    if (f.api_name === 'owner_id') return lead.owner_name ?? raw;
    if (f.api_name === 'partner_id') return lead.partner_name ?? raw;
    return String(raw);
  };

  const Grid = ({ fields }) => (
    <dl className="detail-grid">
      {fields.map((f) => (
        <div key={f.api_name} className="detail-item">
          <dt>
            {f.label}
            {f.encrypted && <span className="chip-lock"><Icon name="key" />encrypted</span>}
          </dt>
          <dd>{display(f)}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div className="portal-grid is-split">
      <div className="card section-card">
        <div className="section-head">
          <div>
            <h2>Details</h2>
            <p>{shown.length} fields · defined in Setup, not in code</p>
          </div>
          {can('lead.edit') && !lead.read_only && (
            <button className="btn btn-primary btn-sm" onClick={onEdit}>
              <Icon name="edit" /> Edit
            </button>
          )}
        </div>

        <Grid fields={core} />

        {custom.length > 0 && (
          <>
            <div className="form-divider"><span>Added in Setup</span></div>
            <Grid fields={custom} />
          </>
        )}
      </div>

      <div className="card section-card">
        <div className="section-head">
          <div>
            <h2>Change history</h2>
            <p>Tracked fields only — set which in Setup</p>
          </div>
        </div>

        {!lead.field_history?.length ? (
          <Empty>Nothing has changed on a tracked field yet.</Empty>
        ) : (
          <ol className="history-list">
            {lead.field_history.map((h) => (
              <li key={h.id}>
                <span className="history-dot" />
                <div>
                  <div className="history-line">
                    <strong>{h.field_label ?? h.field}</strong>
                    <span className="muted">
                      {h.old_value ? <s>{h.old_value}</s> : <em>empty</em>}
                      {' → '}
                      <strong>{h.new_value ?? '—'}</strong>
                    </span>
                  </div>
                  <div className="tiny muted">
                    {h.actor_name ?? 'System'} · {dateTime(h.changed_at)}
                    {h.source !== 'ui' && <> · via {h.source}</>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
