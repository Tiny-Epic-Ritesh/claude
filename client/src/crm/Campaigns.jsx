/**
 * Campaigns.
 *
 * The API already existed under /api/admin/campaigns, fully built — create,
 * edit, duplicate, pause, test-send, send, with the consent gate on the send
 * path. What was missing was anywhere to stand that was not the Setup screen,
 * which is the wrong home for a thing marketing does every week.
 *
 * So this is a surface over an existing API rather than a second implementation
 * of it. The Setup screen keeps working; it is simply no longer the only door.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal } from '../components/ui.jsx';

const STATUS_BADGE = {
  Draft: '', Scheduled: 'badge-blue', Sending: 'badge-amber',
  Sent: 'badge-green', Paused: 'badge-amber', Failed: 'badge-red',
};

export default function Campaigns({ session }) {
  const navigate = useNavigate();
  const [rows, { loading, error, reload }] = useApi('/admin/campaigns');
  const [lists] = useApi('/lists');
  const [templates] = useApi('/admin/templates');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(null);

  const may = session?.permissions?.includes('campaign.manage');

  const act = async (id, verb, label) => {
    setBusy(id); setProblem(null); setDone(null);
    try {
      const r = await api.post(`/admin/campaigns/${id}/${verb}`, {});
      setDone(r.note ?? `${label} done.`);
      reload();
    } catch (e) { setProblem(e.message); }
    finally { setBusy(null); }
  };

  if (loading && !rows) return <Loading label="Loading campaigns…" />;
  if (error) return <ErrorBanner error={error} />;

  const live = rows ?? [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p className="muted">
            Audience, channel, template, send — with consent checked on every
            recipient before anything leaves.
          </p>
        </div>
        {may && (
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="add" size={16} /> New campaign
          </button>
        )}
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {done && (
        <div className="notice notice-ok" style={{ marginBottom: 14 }}>
          <Icon name="check_circle" size={17} /> <span>{done}</span>
        </div>
      )}

      {live.length === 0 && (
        <Empty>No campaigns yet. Build a list first, then send to it.</Empty>
      )}

      <div className="grid-auto">
        {live.map((c) => {
          const sent = c.status === 'Sent';
          return (
            <div key={c.id} className="card">
              <div className="card-head">
                <h2 style={{ fontSize: 15 }}>{c.name}</h2>
                <span className={`badge ${STATUS_BADGE[c.status] ?? ''}`}>{c.status}</span>
              </div>
              <div className="card-body stack" style={{ gap: 9 }}>
                <div className="row wrap" style={{ gap: 5 }}>
                  <span className="badge">{c.channel}</span>
                  {c.template_name && <span className="badge">{c.template_name}</span>}
                  {c.list_name
                    ? <span className="badge badge-blue">{c.list_name} · {c.list_size}</span>
                    : <span className="badge badge-red">No audience</span>}
                </div>

                {sent && (
                  <div className="row wrap" style={{ gap: 12 }}>
                    <span className="tiny muted">Sent <strong>{c.sent}</strong></span>
                    <span className="tiny muted">Opened <strong>{c.opened}</strong></span>
                    <span className="tiny muted">Clicked <strong>{c.clicked}</strong></span>
                  </div>
                )}

                <span className="tiny muted">
                  {c.created_by_name || '—'} · {shortDate(c.created_at)}
                </span>

                {may && (
                  <div className="row wrap" style={{ gap: 6 }}>
                    {!sent && c.list_id && (
                      <button className="btn-sm" disabled={busy === c.id}
                        onClick={() => act(c.id, 'send', 'Send')}>
                        <Icon name="send" size={14} /> Send
                      </button>
                    )}
                    {!sent && (
                      <button className="btn-ghost btn-sm" disabled={busy === c.id}
                        title="Sends only to you, so you can see what lands"
                        onClick={() => act(c.id, 'test', 'Test send')}>
                        Test on me
                      </button>
                    )}
                    <button className="btn-ghost btn-sm" disabled={busy === c.id}
                      onClick={() => act(c.id, 'duplicate', 'Duplicated')}>
                      Duplicate
                    </button>
                    {c.list_id && (
                      <button className="btn-ghost btn-sm"
                        onClick={() => navigate(`/lists/${c.list_id}`)}>
                        Audience
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {creating && (
        <NewCampaign
          lists={lists ?? []}
          templates={(templates ?? []).filter((t) => t.approved)}
          onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); reload(); }}
          onError={(m) => { setCreating(false); setProblem(m); }}
        />
      )}
    </div>
  );
}

function NewCampaign({ lists, templates, onClose, onDone, onError }) {
  const [form, setForm] = useState({ name: '', channel: 'whatsapp', list_id: '', template_id: '' });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // A campaign may only send to a list whose membership holds still (Q-25).
  const eligible = lists.filter((l) => l.kind !== 'dynamic');
  const dynamicCount = lists.length - eligible.length;

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/admin/campaigns', {
        ...form,
        list_id: form.list_id || null,
        template_id: form.template_id || null,
      });
      onDone();
    } catch (err) { onError(err.message); }
  };

  return (
    <Modal title="New campaign" onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 13 }}>
        <div className="field">
          <label htmlFor="c-name">Name</label>
          <input id="c-name" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)}
            placeholder="SIP push — Mumbai, September" />
        </div>
        <div className="field">
          <label htmlFor="c-channel">Channel</label>
          <select id="c-channel" value={form.channel} onChange={(e) => set('channel', e.target.value)}>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="c-list">Audience</label>
          <select id="c-list" value={form.list_id} onChange={(e) => set('list_id', e.target.value)}>
            <option value="">Choose a list…</option>
            {eligible.map((l) => (
              <option key={l.id} value={l.id}>{l.name} · {l.member_count} · {l.kind_label}</option>
            ))}
          </select>
          <span className="tiny muted">
            {dynamicCount > 0
              ? `${dynamicCount} dynamic list${dynamicCount === 1 ? '' : 's'} not shown — membership shifts as it is read, so a send could not be evidenced afterwards.`
              : 'Static and refreshable lists only, so the audience holds still while it sends.'}
          </span>
        </div>
        <div className="field">
          <label htmlFor="c-template">Template</label>
          <select id="c-template" value={form.template_id} onChange={(e) => set('template_id', e.target.value)}>
            <option value="">Choose an approved template…</option>
            {templates.filter((t) => t.channel === form.channel).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <span className="tiny muted">Only approved templates can be sent to clients.</span>
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || !form.name.trim()}>
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
