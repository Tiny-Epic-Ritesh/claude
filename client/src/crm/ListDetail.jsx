/**
 * A list, and the things you can do to everyone in it.
 *
 * Bulk actions are the fastest way to do something regrettable to a few
 * thousand client records, so nothing here fires without first saying how many
 * records it will touch. For a send, that count is the *consent-filtered* one —
 * "412 of 500 will receive this, 88 suppressed" — because a send that silently
 * drops half its audience is indistinguishable from a broken integration.
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, dateTime, shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal } from '../components/ui.jsx';

const KIND_BADGE = { static: 'badge-blue', refreshable: 'badge-green', dynamic: 'badge-amber' };

const ACTIONS = [
  { code: 'reassign', label: 'Reassign owner', icon: 'person_pin', needs: 'lead.reassign' },
  { code: 'stage', label: 'Change stage', icon: 'trending_flat', needs: 'lead.stage.change' },
  { code: 'task', label: 'Create task for each', icon: 'add_task' },
  { code: 'message', label: 'Send a message', icon: 'send', needs: 'lead.contact' },
];

export default function ListDetail({ session }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [list, { loading, error, reload }] = useApi(`/lists/${id}`, [id]);
  const [action, setAction] = useState(null);
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(null);

  const caps = new Set(session?.permissions ?? []);
  const allowed = ACTIONS.filter((a) => !a.needs || caps.has(a.needs));

  if (loading) return <Loading label="Loading list…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!list) return <Empty>That list does not exist, or has not been shared with you.</Empty>;

  return (
    <div>
      <div className="page-head">
        <div>
          <button className="btn-ghost btn-sm" onClick={() => navigate('/lists')}>
            <Icon name="arrow_back" size={15} /> Lead Lists
          </button>
          <h1 style={{ marginTop: 6 }}>{list.name}</h1>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className={`badge ${KIND_BADGE[list.kind] || ''}`}>{list.kind_label}</span>
            <span className="tiny muted">{list.member_count} lead{list.member_count === 1 ? '' : 's'} you can see</span>
            {list.kind === 'refreshable' && (
              <span className="tiny muted">
                · {list.last_refreshed_at ? `refreshed ${dateTime(list.last_refreshed_at)}` : 'never refreshed'}
              </span>
            )}
          </div>
        </div>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {done && (
        <div className="notice notice-ok" style={{ marginBottom: 14 }}>
          <Icon name="check_circle" size={17} /> <span>{done}</span>
        </div>
      )}

      {/* What this list is, in English. A saved filter nobody can read is a
          saved filter nobody trusts. */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body stack" style={{ gap: 8 }}>
          <div className="small">{list.kind_help}</div>
          {list.criteria_text && (
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="tiny muted">Matching</span>
              <span className="chip chip-muted">{list.criteria_text}</span>
            </div>
          )}
          {!list.campaign_safe && (
            <div className="tiny muted">
              <Icon name="block" size={13} /> A campaign cannot send to this list — convert it to Refreshable first.
            </div>
          )}
          {list.refresh_error && (
            <div className="small" style={{ color: 'var(--danger)' }}>
              <Icon name="warning" size={14} /> {list.refresh_error}
            </div>
          )}
        </div>
      </div>

      {/* Bulk bar */}
      {list.member_count > 0 && allowed.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body row wrap" style={{ gap: 8 }}>
            <span className="tiny muted">Apply to all {list.member_count}</span>
            {allowed.map((a) => (
              <button key={a.code} className="btn-sm" onClick={() => { setDone(null); setAction(a); }}>
                <Icon name={a.icon} size={15} /> {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Members</h2>
          <span className="tiny muted">{list.member_count} total</span>
        </div>
        {(list.members ?? []).length === 0 ? (
          <Empty>
            {list.kind === 'dynamic'
              ? 'Nothing matches this filter right now.'
              : 'This list is empty. Add leads from the Leads tab, or save a search as a list.'}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Lead</th><th>Stage</th><th>Source</th><th>Owner</th><th>Contactable</th></tr>
              </thead>
              <tbody>
                {list.members.map((m) => (
                  <tr key={m.id} className="row-link" onClick={() => navigate(`/leads/${m.id}`)}>
                    <td>
                      <div>{m.name}</div>
                      <div className="small muted">{m.mobile}</div>
                    </td>
                    <td><span className="badge">{m.stage}</span></td>
                    <td className="muted">{m.source || '—'}</td>
                    <td className="muted">{m.owner_name || '—'}</td>
                    <td>
                      {/* Consent, visible per row — so it is obvious before a
                          send why the count will be lower than the total. */}
                      <div className="row wrap" style={{ gap: 4 }}>
                        {m.marketing_opt_out ? <span className="badge badge-red">Opted out</span> : null}
                        {m.mobile_invalid ? <span className="badge badge-amber">Bad number</span> : null}
                        {m.no_call ? <span className="badge badge-amber">No call</span> : null}
                        {m.no_sms ? <span className="badge badge-amber">No SMS</span> : null}
                        {m.no_email ? <span className="badge badge-amber">No email</span> : null}
                        {m.no_whatsapp ? <span className="badge badge-amber">No WhatsApp</span> : null}
                        {!m.marketing_opt_out && !m.mobile_invalid && !m.no_call
                          && !m.no_sms && !m.no_email && !m.no_whatsapp
                          && <span className="tiny muted">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {action && (
        <BulkAction list={list} action={action}
          onClose={() => setAction(null)}
          onDone={(msg) => { setAction(null); setDone(msg); reload(); }}
          onError={(msg) => { setAction(null); setProblem(msg); }} />
      )}
    </div>
  );
}

/**
 * One dialog for every bulk action, because the shape is always the same:
 * say what it will do, to how many, then let them commit.
 */
function BulkAction({ list, action, onClose, onDone, onError }) {
  const [meta] = useApi('/lists/meta');
  const [users] = useApi(action.code === 'reassign' ? '/admin/users' : null);
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState({ owner_id: '', stage: '', title: '', channel: 'sms', body: '' });
  const [busy, setBusy] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  /**
   * For a send, the honest count is the consent-filtered one.
   *
   * Fetched as soon as the dialog opens rather than when a field happens to be
   * focused: someone should see "36 of 40" before they start writing, not
   * discover it after. The submit button carries the same number, so the last
   * thing they read before committing is what will actually happen.
   */
  const runPreview = async (channel) => {
    try {
      setPreview(await api.post(`/lists/${list.id}/preview`, { action: 'message', channel }));
    } catch { setPreview(null); }
  };

  useEffect(() => {
    if (action.code === 'message') runPreview(form.channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.code, form.channel]);

  const submit = async () => {
    setBusy(true);
    try {
      if (action.code === 'reassign') {
        const r = await api.post(`/lists/${list.id}/bulk/reassign`, { owner_id: Number(form.owner_id) });
        onDone(`Moved ${r.moved} lead${r.moved === 1 ? '' : 's'}.${r.skipped ? ` ${r.skipped} skipped — different sales org.` : ''}`);
      } else if (action.code === 'stage') {
        const r = await api.post(`/lists/${list.id}/bulk/stage`, { stage: form.stage });
        onDone(`${r.applied} lead${r.applied === 1 ? '' : 's'} moved to ${r.stage}.`);
      } else if (action.code === 'task') {
        const r = await api.post(`/lists/${list.id}/bulk/task`, { title: form.title });
        onDone(`Created ${r.created} task${r.created === 1 ? '' : 's'}.`);
      } else {
        const r = await api.post(`/lists/${list.id}/bulk/message`, { channel: form.channel, body: form.body });
        onDone(`Sent to ${r.sent} of ${r.total}.${r.suppressed ? ` ${r.suppressed} suppressed.` : ''}`);
      }
    } catch (e) {
      onError(e.message);
    }
  };

  const userList = Array.isArray(users) ? users : users?.rows ?? [];

  const ready = action.code === 'reassign' ? form.owner_id
    : action.code === 'stage' ? form.stage
      : action.code === 'task' ? form.title.trim()
        : form.body.trim();

  return (
    <Modal title={action.label} subtitle={`Applies to all ${list.member_count} leads in "${list.name}"`} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        {action.code === 'reassign' && (
          <div className="field">
            <label htmlFor="bulk-owner">New owner</label>
            <select id="bulk-owner" value={form.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
              <option value="">Choose a user…</option>
              {userList.filter((u) => u.active).map((u) => (
                <option key={u.id} value={u.id}>{u.name} — {u.sales_org}</option>
              ))}
            </select>
            <span className="tiny muted">Leads in a different sales org to the new owner are skipped.</span>
          </div>
        )}

        {action.code === 'stage' && (
          <div className="field">
            <label htmlFor="bulk-stage">Move to stage</label>
            <select id="bulk-stage" value={form.stage} onChange={(e) => set('stage', e.target.value)}>
              <option value="">Choose a stage…</option>
              {(meta?.stages ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        {action.code === 'task' && (
          <div className="field">
            <label htmlFor="bulk-task">Task title</label>
            <input id="bulk-task" value={form.title} autoFocus
              onChange={(e) => set('title', e.target.value)}
              placeholder="Call about the new brokerage plan" />
            <span className="tiny muted">Due tomorrow, assigned to each lead's owner.</span>
          </div>
        )}

        {action.code === 'message' && (
          <>
            <div className="field">
              <label htmlFor="bulk-channel">Channel</label>
              <select id="bulk-channel" value={form.channel}
                onChange={(e) => set('channel', e.target.value)}>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="bulk-body">Message</label>
              <textarea id="bulk-body" rows={4} value={form.body}
                onChange={(e) => set('body', e.target.value)} />
            </div>

            {/* The honest number. */}
            {preview && (
              <div className="notice notice-warn">
                <Icon name="info" size={17} />
                <span>
                  <strong>{preview.will_apply} of {preview.total}</strong> will receive this.
                  {preview.suppressed > 0 && (
                    <> {preview.suppressed} suppressed — {preview.reasons.map((r) => `${r.count} ${r.reason}`).join(', ')}.</>
                  )}
                </span>
              </div>
            )}
          </>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !ready} onClick={submit}>
            {busy ? 'Working…' : action.code === 'message'
              ? `Send to ${preview ? preview.will_apply : list.member_count}`
              : `Apply to ${list.member_count}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
