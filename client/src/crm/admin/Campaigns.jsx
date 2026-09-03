import { useEffect, useRef, useState } from 'react';
import { api, shortDate } from '../../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Icon, useDropUp } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

/* ------------------------------------------------------------ campaigns */

/**
 * Campaigns.
 *
 * This screen was read-only but for a Send button — no way to create a campaign
 * even though the API accepted one, and no edit at any layer. A Marketing
 * Manager holding `campaign.manage` could look at campaigns and send them, and
 * nothing else.
 *
 * The audience preview is the part worth arguing for. Consent rules that
 * silently drop recipients teach nobody anything; showing "412 excluded, 388 of
 * them opted out" before the send makes the rule visible at the moment it
 * matters, and stops a marketer wondering why the reach was short afterwards.
 */
/* Rows per page. The campaign list had no LIMIT on the route at all. */
const CAMPAIGN_PAGE = 50;

/**
 * A sortable column header for the campaign table.
 *
 * At module scope: a component declared inside a render body is a new type on
 * every render, which tears down and rebuilds the header row each time.
 */
function CampaignTh({ label, col, className, sort, dir, onSort }) {
  if (!col) return <th className={className}>{label}</th>;
  return (
    <th className={className} aria-sort={sort === col ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" aria-label={`Sort by ${label}`} onClick={() => onSort(col)}>
        {label}
        <Icon name={sort !== col ? 'unfold_more' : dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={13} />
      </button>
    </th>
  );
}

export function Campaigns() {
  const [sort, setSort] = useState(null);
  const [dir, setDir] = useState('desc');
  const [offset, setOffset] = useState(0);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);   // campaign | 'new'
  const [audience, setAudience] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  const params = new URLSearchParams({ limit: String(CAMPAIGN_PAGE), offset: String(offset) });
  if (sort) { params.set('sort', sort); params.set('dir', dir); }
  if (q) params.set('q', q);
  const query = `?${params}`;

  const [rows, { loading, reload, total }] = useApi(`/admin/campaigns${query}`, [query]);

  if (loading && !rows) return <Loading />;

  const list = rows ?? [];
  const count = total ?? list.length;
  const orderBy = (key) => {
    setDir(sort === key && dir === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setOffset(0);
  };

  const act = async (id, verb, fn) => {
    setBusy(`${id}:${verb}`);
    setError(null);
    try { const r = await fn(); if (r?.note) setNotice(r.note); reload(); }
    catch (err) { setError(err.message); }
    finally { setBusy(null); }
  };

  const STATUS_TONE = {
    Sent: 'badge-green', Scheduled: 'badge-accent', Paused: 'badge-amber', Draft: '',
  };

  return (
    <>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between" style={{ marginBottom: 'var(--gap)' }}>
          <span>{notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Campaigns</h2>
            <p className="tiny muted" style={{ margin: '2px 0 0' }}>
              {q ? `${count} matching` : `${count} active`} · every send respects marketing opt-outs
            </p>
          </div>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            {/* The list had no search: finding one campaign meant reading them. */}
            <input
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search name, list or template"
              aria-label="Search campaigns"
              style={{ maxWidth: 220 }}
            />
            {sort && (
              <button className="btn-ghost btn-sm" onClick={() => { setSort(null); setOffset(0); }}>
                <Icon name="close" size={14} /> Newest first
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              <Icon name="add" /> New campaign
            </button>
          </div>
        </div>

        {list.length === 0 ? (
          <Empty>
            {q ? `No campaign matches "${q}".` : 'No campaigns yet. Create one to reach a lead list.'}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <CampaignTh label="Campaign" col="name" sort={sort} dir={dir} onSort={orderBy} />
                  <CampaignTh label="Channel" col="channel" sort={sort} dir={dir} onSort={orderBy} />
                  <CampaignTh label="List" col="list_name" sort={sort} dir={dir} onSort={orderBy} />
                  <CampaignTh label="Status" col="status" sort={sort} dir={dir} onSort={orderBy} />
                  <CampaignTh label="Sent" col="sent" className="num" sort={sort} dir={dir} onSort={orderBy} />
                  <CampaignTh label="Opened" col="opened" className="num" sort={sort} dir={dir} onSort={orderBy} />
                  <CampaignTh label="Clicked" col="clicked" className="num" sort={sort} dir={dir} onSort={orderBy} />
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const sent = c.status === 'Sent';
                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 545 }}>{c.name}</div>
                        <div className="tiny muted">
                          {c.template_name || 'No template'}
                          {c.scheduled_at && ` · scheduled ${shortDate(c.scheduled_at)}`}
                          {c.created_by_name && ` · by ${c.created_by_name}`}
                        </div>
                      </td>
                      <td><span className="badge">{c.channel}</span></td>
                      <td className="small muted">
                        {c.list_name || '—'}
                        {c.list_size > 0 && <div className="tiny muted">{c.list_size} on the list</div>}
                      </td>
                      <td><span className={`badge ${STATUS_TONE[c.status] ?? ''}`}>{c.status}</span></td>
                      <td className="num">{c.sent}</td>
                      <td className="num">{c.opened}</td>
                      <td className="num">{c.clicked}</td>
                      <td className="col-actions">
                        <CampaignActions
                          campaign={c}
                          busy={busy}
                          onEdit={() => setEditing(c)}
                          onPreview={() => setAudience(c)}
                          onAct={act}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Where you are in the list. */}
        {count > 0 && (count > CAMPAIGN_PAGE || offset > 0) && (
          <div className="card-foot row wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span className="tiny muted">
              {offset + 1}–{offset + list.length} of {count.toLocaleString('en-IN')}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn-ghost btn-sm" disabled={offset === 0}
                onClick={() => setOffset(Math.max(offset - CAMPAIGN_PAGE, 0))}>
                <Icon name="chevron_left" size={15} /> Previous
              </button>
              <button className="btn-ghost btn-sm" disabled={offset + list.length >= count}
                onClick={() => setOffset(offset + CAMPAIGN_PAGE)}>
                Next <Icon name="chevron_right" size={15} />
              </button>
            </div>
          </div>
        )}
      </section>

      {editing && (
        <CampaignEditor
          campaign={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      {audience && (
        <AudiencePreview
          campaign={audience}
          onClose={() => setAudience(null)}
          onSend={async () => {
            const c = audience;
            setAudience(null);
            await act(c.id, 'send', () => api.post(`/admin/campaigns/${c.id}/send`));
          }}
        />
      )}
    </>
  );
}

/** Every action a campaign can take, in the state it is currently in. */
function CampaignActions({ campaign: c, busy, onEdit, onPreview, onAct }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const sent = c.status === 'Sent';
  const working = busy?.startsWith(`${c.id}:`);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  const items = [
    !sent && { key: 'edit', label: 'Edit', icon: 'edit', run: onEdit },
    { key: 'preview', label: 'Preview recipients', icon: 'group', run: onPreview },
    !sent && { key: 'test', label: 'Test send to me', icon: 'send_and_archive',
      run: () => onAct(c.id, 'test', () => api.post(`/admin/campaigns/${c.id}/test`)) },
    { key: 'duplicate', label: 'Duplicate', icon: 'content_copy',
      run: () => onAct(c.id, 'duplicate', () => api.post(`/admin/campaigns/${c.id}/duplicate`)) },
    c.status === 'Scheduled' && { key: 'pause', label: 'Pause', icon: 'pause',
      run: () => onAct(c.id, 'pause', () => api.post(`/admin/campaigns/${c.id}/pause`)) },
    c.status === 'Paused' && { key: 'resume', label: 'Resume', icon: 'play_arrow',
      run: () => onAct(c.id, 'resume', () => api.post(`/admin/campaigns/${c.id}/resume`)) },
    { key: 'delete', label: sent ? 'Archive' : 'Delete', icon: sent ? 'inventory_2' : 'delete', danger: !sent,
      run: () => onAct(c.id, 'delete', () => api.del(`/admin/campaigns/${c.id}`)) },
  ].filter(Boolean);

  const menuRef = useRef(null);
  const dropUp = useDropUp(open, wrap, menuRef, [items.length]);

  return (
    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
      {!sent && (
        <button
          className="btn-sm btn-primary"
          disabled={working}
          onClick={onPreview}
        >
          {working ? <Spinner /> : 'Send'}
        </button>
      )}

      <div className="action-menu" ref={wrap}>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Actions for ${c.name}`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="more_vert" />
        </button>
        {open && (
          /* P2-24: the row this sits on is often near the foot of the table,
             where a menu pinned below the trigger runs off the bottom of the
             window. Same hook as the record ActionMenu, so the two cannot
             drift apart again. */
          <div
            ref={menuRef}
            className={`popover action-popover align-end ${dropUp ? 'drop-up' : ''}`}
            role="menu"
          >
            {items.map((i) => (
              <button
                key={i.key}
                type="button"
                role="menuitem"
                className={`action-item ${i.danger ? 'is-danger' : ''}`}
                onClick={() => { setOpen(false); i.run(); }}
              >
                <Icon name={i.icon} />
                <span className="action-label">{i.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- editor */

function CampaignEditor({ campaign, onClose, onSaved }) {
  const [meta] = useApi('/meta');
  const [lists] = useApi('/lists');
  const [form, setForm] = useState({
    name: campaign?.name ?? '',
    channel: campaign?.channel ?? 'whatsapp',
    template_id: campaign?.template_id ?? '',
    list_id: campaign?.list_id ?? '',
    scheduled_at: campaign?.scheduled_at?.slice(0, 16).replace(' ', 'T') ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const templates = (meta?.templates ?? []).filter((t) => t.channel === form.channel);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = {
        ...form,
        template_id: form.template_id || null,
        scheduled_at: form.scheduled_at ? form.scheduled_at.replace('T', ' ') : null,
      };
      if (campaign) await api.patch(`/admin/campaigns/${campaign.id}`, body);
      else await api.post('/admin/campaigns', body);
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal
      title={campaign ? `Edit ${campaign.name}` : 'New campaign'}
      subtitle="Nothing sends until you choose to send it."
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <label className="span-2">
          <span>Campaign name</span>
          <input value={form.name} onChange={set('name')} required autoFocus
            placeholder="Diwali PMS push" />
        </label>

        <label>
          <span>Channel</span>
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value, template_id: '' })}>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
          <small className="muted">WhatsApp goes through Smartping.</small>
        </label>

        <label>
          <span>Send to</span>
          <select value={form.list_id} onChange={set('list_id')} required>
            <option value="">Choose a list…</option>
            {(lists ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.member_count != null ? ` (${l.member_count})` : ''}</option>
            ))}
          </select>
        </label>

        <label className="span-2">
          <span>Template <span className="muted">(optional)</span></span>
          <select value={form.template_id} onChange={set('template_id')}>
            <option value="">No template — a plain update</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {templates.length === 0 && (
            <small className="muted">No approved {form.channel} templates yet. Add one under Templates.</small>
          )}
        </label>

        <label className="span-2">
          <span>Schedule <span className="muted">(leave empty to keep it a draft)</span></span>
          <input type="datetime-local" value={form.scheduled_at} onChange={set('scheduled_at')} />
        </label>

        <div className="glass notice span-2">
          <Icon name="shield" />
          <div className="tiny">
            Anyone on the list who has opted out of marketing, has no contact details,
            or has a number flagged invalid will be skipped automatically. You can see
            exactly who before you send.
          </div>
        </div>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim() || !form.list_id}>
            {busy ? <Spinner /> : campaign ? 'Save changes' : 'Create campaign'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------- audience */

const EXCLUSION_LABEL = {
  opted_out: 'Opted out of marketing',
  invalid_destination: 'Mobile flagged invalid',
  no_destination: 'No contact details',
  unknown_channel: 'Channel unavailable',
};

function AudiencePreview({ campaign, onClose, onSend }) {
  const [data] = useApi(`/admin/campaigns/${campaign.id}/audience`);
  const sent = campaign.status === 'Sent';

  if (!data) return <Modal title="Who this reaches" onClose={onClose}><Loading /></Modal>;

  return (
    <Modal title="Who this reaches" subtitle={campaign.name} onClose={onClose} wide>
      <div className="stat-strip" style={{ marginBottom: 'var(--gap)' }}>
        <div className="glass stat-tile">
          <div className="stat-tile-label">On the list</div>
          <div className="stat-tile-value">{data.list_size}</div>
        </div>
        <div className="glass stat-tile tone-ok">
          <div className="stat-tile-label">Will receive it</div>
          <div className="stat-tile-value">{data.reachable}</div>
        </div>
        <div className={`glass stat-tile ${data.excluded ? 'tone-warn' : ''}`}>
          <div className="stat-tile-label">Skipped</div>
          <div className="stat-tile-value">{data.excluded}</div>
        </div>
      </div>

      {data.excluded > 0 && (
        <>
          <div className="form-divider"><span>Why they are skipped</span></div>
          <ul className="ctx-list" style={{ marginBottom: 'var(--gap)' }}>
            {Object.entries(data.excluded_by_reason).map(([code, n]) => (
              <li key={code}>
                <span className="state-pill state-risk">{n}</span>
                <div><strong>{EXCLUSION_LABEL[code] ?? code}</strong></div>
              </li>
            ))}
          </ul>
          <p className="tiny muted">
            These are enforced by the API, not by this screen — an import or an
            automation sending to the same list is refused in exactly the same way.
          </p>
        </>
      )}

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        {!sent && (
          <button type="button" className="btn btn-primary" onClick={onSend} disabled={data.reachable === 0}>
            {data.reachable === 0 ? 'Nobody to send to' : `Send to ${data.reachable}`}
          </button>
        )}
      </div>
    </Modal>
  );
}
