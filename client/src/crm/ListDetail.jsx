/**
 * A list, and the things you can do to everyone in it.
 *
 * Bulk actions are the fastest way to do something regrettable to a few
 * thousand client records, so nothing here fires without first saying how many
 * records it will touch. For a send, that count is the *consent-filtered* one —
 * "412 of 500 will receive this, 88 suppressed" — because a send that silently
 * drops half its audience is indistinguishable from a broken integration.
 *
 * The three tools above the table — columns, export, import — are the round
 * trip the legacy audit found people making outside the product. They exported
 * to a spreadsheet because the table showed five fixed columns, filtered there,
 * and pasted the result back as another static list. Each of those steps now
 * exists here, which is what makes the export auditable and the import's misses
 * visible.
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, dateTime, shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal } from '../components/ui.jsx';
import BackLink from '../components/BackLink.jsx';

const KIND_BADGE = { static: 'badge-blue', refreshable: 'badge-green', dynamic: 'badge-amber' };

/* Rows per page. Fifty fills a screen without making the first paint wait on
   five hundred, and the server caps the request at five hundred regardless. */
const PAGE = 50;

const ACTIONS = [
  { code: 'reassign', label: 'Reassign owner', icon: 'person_pin', needs: 'lead.reassign' },
  { code: 'stage', label: 'Change stage', icon: 'trending_flat', needs: 'lead.stage.change' },
  { code: 'task', label: 'Create task for each', icon: 'add_task' },
  { code: 'message', label: 'Send a message', icon: 'send', needs: 'lead.contact' },
  { code: 'dialler', label: 'Push to dialler', icon: 'call', needs: 'lead.contact' },
  { code: 'field', label: 'Edit a field', icon: 'edit_note', needs: 'lead.edit' },
  { code: 'membership', label: 'Add to another list', icon: 'playlist_add' },
  /* Last, separated, and styled as the destructive thing it is. */
  { code: 'delete', label: 'Delete every member', icon: 'delete', needs: 'lead.delete', danger: true },
];

/* How each identifier can be matched on import. Mobile is last because it is
   the least reliable of the three — the same person appears under three
   formats — and first-listed reads as recommended. */
const MATCH_ON = [
  { code: 'client_code', label: 'Client code' },
  { code: 'pan', label: 'PAN' },
  { code: 'mobile', label: 'Mobile (last 10 digits)' },
];

/** Hand the browser a file without a round trip to the server for it. */
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * One field out of the query schema, by code.
 *
 * The bulk editor and the query builder read the same catalogue, so a field
 * with real picklist values offers them in both places rather than a free-text
 * box in one and a dropdown in the other.
 */
const fieldDef = (meta, code) => (meta?.schema?.fields ?? []).find((f) => f.code === code);

/** Render one cell. The table is driven by the list's own column choice. */
function cell(row, key) {
  const v = row[key];
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (key === 'stage') return <span className="badge">{v}</span>;
  if (key === 'marketing_opt_out') return v ? 'Opted out' : 'Yes';
  if (key === 'aum') return Number(v).toLocaleString('en-IN');
  if (key === 'created_at' || key === 'next_follow_up_at') return shortDate(v);
  return String(v);
}

export default function ListDetail({ session }) {
  const { id } = useParams();
  const navigate = useNavigate();

  /* Paging, sort and search live in the URL the table is fetched with, so the
     server does the work. The alternative — pull everything and sort in the
     browser — is what the old table effectively assumed, and it was only
     honest because it never fetched past the first hundred rows. */
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState(null);
  const [dir, setDir] = useState('desc');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');

  /* A request per keystroke would be a request per keystroke against a table
     of half a million leads. */
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (sort) { query.set('sort', sort); query.set('dir', dir); }
  if (q) query.set('q', q);
  const path = `/lists/${id}?${query}`;

  const [list, { loading, error, reload }] = useApi(path, [path]);
  /* Column labels come from the server's own catalogue rather than a second
     copy here — a column added to the API should not need this file edited to
     get a heading. */
  const [meta] = useApi('/lists/meta');
  const [action, setAction] = useState(null);
  const [tool, setTool] = useState(null);
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(null);

  const caps = new Set(session?.permissions ?? []);
  const allowed = ACTIONS.filter((a) => !a.needs || caps.has(a.needs));
  const columns = list?.columns?.length ? list.columns : ['name', 'mobile', 'stage', 'owner_name', 'city'];
  const columnLabel = Object.fromEntries((meta?.columns ?? []).map((c) => [c.key, c.label]));
  /* Which kinds are snapshots is the server's rule, and it is already stated in
     the metadata. Repeating `kind === 'static'` here would be a second copy of
     it that drifts the day a fourth kind is added. */
  const isSnapshot = Boolean((meta?.kinds ?? []).find((k) => k.code === list?.kind)?.snapshot);

  if (loading) return <Loading label="Loading list…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!list) return <Empty>That list does not exist, or has not been shared with you.</Empty>;

  return (
    <div>
      <div className="page-head">
        <div>
          <BackLink
            to="/lists"
            label="Lead Lists"
            className="btn-ghost btn-sm"
            icon={<Icon name="arrow_back" size={15} />}
          />
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
            {allowed.filter((a) => !a.danger).map((a) => (
              <button key={a.code} className="btn-sm" onClick={() => { setDone(null); setAction(a); }}>
                <Icon name={a.icon} size={15} /> {a.label}
              </button>
            ))}
            {/* The one action that cannot be walked back sits after a divider
                and does not look like the others. */}
            {allowed.some((a) => a.danger) && (
              <>
                <span className="spacer" style={{ flex: 1 }} />
                {allowed.filter((a) => a.danger).map((a) => (
                  <button key={a.code} className="btn-sm btn-danger-ghost"
                    onClick={() => { setDone(null); setAction(a); }}>
                    <Icon name={a.icon} size={15} /> {a.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Members</h2>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            {/* Finding one person in a list of thousands, without paging to
                them. It narrows what is displayed and nothing else — every
                bulk action below still applies to the whole list. */}
            <input
              className="input-sm"
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search this list…"
              aria-label="Search within this list"
              style={{ maxWidth: 200 }}
            />
            <span className="tiny muted">
              {q ? `${list.matched} of ${list.member_count}` : `${list.member_count} total`}
            </span>
            {/* The round trip, brought inside. */}
            <button className="btn-ghost btn-sm" onClick={() => { setDone(null); setTool('columns'); }}
              disabled={!list.may_edit}
              title={list.may_edit ? 'Choose which columns this list shows' : 'Only the owner of a list can change its columns'}>
              <Icon name="view_column" size={15} /> Columns
            </button>
            <button className="btn-ghost btn-sm" onClick={() => { setDone(null); setTool('export'); }}>
              <Icon name="download" size={15} /> Export
            </button>
            {/* Import only where it means something: a live list is defined by
                its filter, so pasting rows into one would make the filter a
                lie. Hidden rather than shown-and-refused. */}
            {list.may_edit && isSnapshot && (
              <button className="btn-ghost btn-sm" onClick={() => { setDone(null); setTool('import'); }}>
                <Icon name="upload" size={15} /> Import
              </button>
            )}
          </div>
        </div>
        {(list.members ?? []).length === 0 ? (
          <Empty>
            {q
              ? `Nobody in this list matches "${q}".`
              : list.kind === 'dynamic'
                ? 'Nothing matches this filter right now.'
                : 'This list is empty. Add leads from the Leads tab, or save a search as a list.'}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {columns.map((k) => (
                    /* aria-sort tells a screen reader which column the table is
                       ordered by, and is what the arrow's full-opacity state
                       hangs off in CSS. */
                    <th key={k} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {/* Every column sorts. Without this, "who in this list
                          holds the most" is a question you answer by exporting
                          — which is the habit the rest of this page exists to
                          end. */}
                      <button
                        type="button"
                        className="th-sort"
                        aria-label={`Sort by ${columnLabel[k] ?? k}`}
                        onClick={() => {
                          setDir(sort === k && dir === 'asc' ? 'desc' : 'asc');
                          setSort(k);
                          setOffset(0);
                        }}
                      >
                        {columnLabel[k] ?? k}
                        <Icon
                          name={sort !== k ? 'unfold_more' : dir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                          size={13}
                        />
                      </button>
                    </th>
                  ))}
                  <th>Contactable</th>
                </tr>
              </thead>
              <tbody>
                {list.members.map((m) => (
                  <tr key={m.id} className="row-link" onClick={() => navigate(`/leads/${m.id}`)}>
                    {columns.map((k) => <td key={k}>{cell(m, k)}</td>)}
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

        {/* Where you are in the list, and how to leave. A table that shows a
            hundred rows of twenty thousand and says nothing about the rest is
            how somebody concludes the CRM lost their leads. */}
        {list.matched > 0 && (list.matched > PAGE || offset > 0) && (
          <div className="card-foot row wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span className="tiny muted">
              {offset + 1}–{offset + list.shown} of {list.matched}
              {q && <> matching &ldquo;{q}&rdquo;</>}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn-ghost btn-sm" disabled={offset === 0}
                onClick={() => setOffset(Math.max(offset - PAGE, 0))}>
                <Icon name="chevron_left" size={15} /> Previous
              </button>
              <button className="btn-ghost btn-sm" disabled={!list.has_more}
                onClick={() => setOffset(offset + PAGE)}>
                Next <Icon name="chevron_right" size={15} />
              </button>
            </div>
          </div>
        )}
      </div>

      {action && (
        <BulkAction list={list} action={action}
          onClose={() => setAction(null)}
          onDone={(msg) => { setAction(null); setDone(msg); reload(); }}
          onError={(msg) => { setAction(null); setProblem(msg); }} />
      )}

      {tool === 'columns' && (
        <ColumnChooser list={list} chosen={columns}
          onClose={() => setTool(null)}
          onDone={(msg) => { setTool(null); setDone(msg); reload(); }}
          onError={(msg) => { setTool(null); setProblem(msg); }} />
      )}
      {tool === 'export' && (
        <ExportDialog list={list} chosen={columns} caps={caps}
          onClose={() => setTool(null)}
          onDone={(msg) => { setTool(null); setDone(msg); }}
          onError={(msg) => { setTool(null); setProblem(msg); }} />
      )}
      {tool === 'import' && (
        <ImportDialog list={list}
          onClose={() => setTool(null)}
          onDone={(msg) => { setTool(null); setDone(msg); reload(); }}
          onError={(msg) => { setTool(null); setProblem(msg); }} />
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
  // Only snapshots can receive members, so only snapshots are offered as targets.
  const [lists] = useApi(action.code === 'membership' ? '/lists' : null);
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState({
    owner_id: '', stage: '', title: '', channel: 'sms', body: '',
    field: '', value: '', target_id: '', member_action: 'add', confirm: '',
  });
  const [busy, setBusy] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  /* Same rule as the page above, from the same place. */
  const snapshotKinds = new Set((meta?.kinds ?? []).filter((k) => k.snapshot).map((k) => k.code));

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
      } else if (action.code === 'message') {
        const r = await api.post(`/lists/${list.id}/bulk/message`, { channel: form.channel, body: form.body });
        onDone(`Sent to ${r.sent} of ${r.total}.${r.suppressed ? ` ${r.suppressed} suppressed.` : ''}`);
      } else if (action.code === 'dialler') {
        const r = await api.post(`/lists/${list.id}/bulk/dialler`, {});
        const skipped = (r.skipped ?? []).map((sk) => `${sk.count} ${sk.reason}`).join(', ');
        onDone(`Pushed ${r.pushed} of ${r.requested} to the dialler.${skipped ? ` Skipped: ${skipped}.` : ''}${r.simulated ? ' (Dialler not configured — simulated.)' : ''}`);
      } else if (action.code === 'field') {
        const r = await api.post(`/lists/${list.id}/bulk/field`, { field: form.field, value: form.value });
        onDone(`Changed ${r.changed} lead${r.changed === 1 ? '' : 's'}.${r.unchanged ? ` ${r.unchanged} already had that value.` : ''}`);
      } else if (action.code === 'membership') {
        const r = await api.post(`/lists/${list.id}/bulk/membership`, {
          target_id: Number(form.target_id), action: form.member_action,
        });
        onDone(`${r.changed} lead${r.changed === 1 ? '' : 's'} ${r.action} ${form.member_action === 'remove' ? 'from' : 'to'} "${r.target}".`);
      } else {
        /* The count is sent back to the server, which refuses if the list has
           moved since it was drawn. */
        const r = await api.post(`/lists/${list.id}/bulk/delete`, { confirm_count: list.member_count });
        onDone(`Deleted ${r.deleted} lead${r.deleted === 1 ? '' : 's'}. They are recoverable.`);
      }
    } catch (e) {
      onError(e.message);
    }
  };

  const userList = Array.isArray(users) ? users : users?.rows ?? [];

  const ready = action.code === 'reassign' ? form.owner_id
    : action.code === 'stage' ? form.stage
      : action.code === 'task' ? form.title.trim()
        : action.code === 'dialler' ? true
          : action.code === 'field' ? (form.field && form.value !== '')
            : action.code === 'membership' ? form.target_id
              // Typing the count is the last check before something unrecoverable.
              : action.code === 'delete' ? Number(form.confirm) === list.member_count
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

        {action.code === 'dialler' && (
          <div className="notice notice-warn">
            <Icon name="info" size={17} />
            <span>
              Every member with a valid number and call consent is loaded into the
              dialler campaign. Members who opted out of calls are skipped and
              counted back to you.
            </span>
          </div>
        )}

        {action.code === 'field' && (
          <>
            <div className="field">
              <label htmlFor="bulk-field">Field</label>
              <select id="bulk-field" value={form.field}
                onChange={(e) => setForm((f) => ({ ...f, field: e.target.value, value: '' }))}>
                <option value="">Choose a field…</option>
                {(meta?.bulk_editable ?? []).map((code) => (
                  <option key={code} value={code}>{fieldDef(meta, code)?.label ?? code}</option>
                ))}
              </select>
              <span className="tiny muted">
                Identifiers are not on this list — a name or a mobile is what every
                other record is matched on.
              </span>
            </div>
            {form.field && (
              <div className="field">
                <label htmlFor="bulk-value">New value</label>
                {(fieldDef(meta, form.field)?.values ?? []).length ? (
                  <select id="bulk-value" value={form.value} onChange={(e) => set('value', e.target.value)}>
                    <option value="">Choose…</option>
                    {fieldDef(meta, form.field).values.map((v) => (
                      <option key={v.value} value={v.value}>{v.label ?? v.value}</option>
                    ))}
                  </select>
                ) : (
                  <input id="bulk-value" value={form.value} autoFocus
                    onChange={(e) => set('value', e.target.value)} />
                )}
              </div>
            )}
          </>
        )}

        {action.code === 'membership' && (
          <>
            <div className="field">
              <label htmlFor="bulk-target">List</label>
              <select id="bulk-target" value={form.target_id} onChange={(e) => set('target_id', e.target.value)}>
                <option value="">Choose a list…</option>
                {(Array.isArray(lists) ? lists : [])
                  .filter((l) => l.id !== list.id && snapshotKinds.has(l.kind))
                  .map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <span className="tiny muted">
                Only snapshots are listed — a live list gets its members from its filter.
              </span>
            </div>
            <div className="field">
              <label htmlFor="bulk-member-action">Do what</label>
              <select id="bulk-member-action" value={form.member_action}
                onChange={(e) => set('member_action', e.target.value)}>
                <option value="add">Add them to it</option>
                <option value="remove">Take them out of it</option>
              </select>
            </div>
          </>
        )}

        {action.code === 'delete' && (
          <>
            <div className="notice notice-danger">
              <Icon name="warning" size={17} />
              <span>
                This deletes <strong>every one of the {list.member_count} leads</strong> in
                this list, not the list itself. They are recoverable, and every
                deletion is recorded against your name.
              </span>
            </div>
            <div className="field">
              <label htmlFor="bulk-confirm">Type {list.member_count} to confirm</label>
              <input id="bulk-confirm" value={form.confirm} autoFocus inputMode="numeric"
                onChange={(e) => set('confirm', e.target.value)}
                placeholder={String(list.member_count)} />
              <span className="tiny muted">
                A mis-scoped list is the likeliest mistake here, so the count has
                to be read rather than clicked past.
              </span>
            </div>
          </>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className={action.danger ? 'btn-danger' : 'btn-primary'}
            disabled={busy || !ready} onClick={submit}>
            {busy ? 'Working…' : action.code === 'message'
              ? `Send to ${preview ? preview.will_apply : list.member_count}`
              : action.code === 'delete' ? `Delete ${list.member_count} leads`
                : action.code === 'dialler' ? `Push ${list.member_count} to the dialler`
                  : `Apply to ${list.member_count}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* =========================================================== the round trip */

/**
 * Choose which columns the list shows.
 *
 * The choice belongs to the list rather than to the person looking at it,
 * because a list is a shared object: whoever built "leads with no follow-up
 * date" wants the recipient to see the follow-up column without being told to
 * add it. Order is the order they are ticked, so the first column chosen is the
 * first column shown.
 */
function ColumnChooser({ list, chosen, onClose, onDone, onError }) {
  const [meta] = useApi('/lists/meta');
  const [picked, setPicked] = useState(chosen);
  const [busy, setBusy] = useState(false);

  const toggle = (key) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/lists/${list.id}/columns`, { columns: picked });
      onDone(`Showing ${picked.length} column${picked.length === 1 ? '' : 's'}.`);
    } catch (e) { onError(e.message); }
  };

  return (
    <Modal title="Columns" subtitle={`What "${list.name}" shows, for everyone it is shared with`} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="stack" style={{ gap: 2, maxHeight: '46vh', overflowY: 'auto' }}>
          {(meta?.columns ?? []).map((c) => {
            const on = picked.includes(c.key);
            return (
              <label key={c.key} className="row" style={{ gap: 8, padding: '6px 2px', cursor: 'pointer' }}>
                <input type="checkbox" checked={on} onChange={() => toggle(c.key)} />
                <span style={{ flex: 1 }}>{c.label}</span>
                {/* Marked here as well as on export, so the person choosing
                    knows which columns carry an identifier before they put one
                    on a screen somebody else can see. */}
                {c.pii && <span className="chip chip-muted tiny">Identifier</span>}
                {on && <span className="tiny muted">{picked.indexOf(c.key) + 1}</span>}
              </label>
            );
          })}
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !picked.length} onClick={save}>
            {busy ? 'Saving…' : 'Save columns'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Export the list as CSV.
 *
 * People were exporting anyway, outside the product, which is exactly why the
 * legacy trail went cold at the list. Doing it here records who took what, how
 * many rows, and whether identifiers were in the clear. Masked by default:
 * unmasking is a separate permission and is named in the audit row, so it is a
 * decision somebody made rather than a default nobody noticed.
 */
function ExportDialog({ list, chosen, caps, onClose, onDone, onError }) {
  const [meta] = useApi('/lists/meta');
  const [picked, setPicked] = useState(chosen);
  const [unmask, setUnmask] = useState(false);
  const [busy, setBusy] = useState(false);

  const mayUnmask = caps.has('pii.unmask');
  const toggle = (key) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const hasPii = picked.some((k) => (meta?.columns ?? []).find((c) => c.key === k)?.pii);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/lists/${list.id}/export`, { columns: picked, unmask });
      download(r.filename, r.csv);
      onDone(`Exported ${r.rows} row${r.rows === 1 ? '' : 's'}${r.unmasked ? ' with identifiers in the clear' : ''}.${r.truncated ? ' Capped — the list is larger than one export.' : ''}`);
    } catch (e) { onError(e.message); }
  };

  return (
    <Modal title="Export" subtitle={`${list.member_count} rows from "${list.name}"`} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="stack" style={{ gap: 2, maxHeight: '38vh', overflowY: 'auto' }}>
          {(meta?.columns ?? []).map((c) => (
            <label key={c.key} className="row" style={{ gap: 8, padding: '6px 2px', cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.includes(c.key)} onChange={() => toggle(c.key)} />
              <span style={{ flex: 1 }}>{c.label}</span>
              {c.pii && <span className="chip chip-muted tiny">Identifier</span>}
            </label>
          ))}
        </div>

        {hasPii && (
          mayUnmask ? (
            <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={unmask} onChange={(e) => setUnmask(e.target.checked)} />
              <span className="small">
                Include mobile and email in full.
                <span className="muted"> Recorded against your name in the audit log.</span>
              </span>
            </label>
          ) : (
            <div className="tiny muted">
              <Icon name="lock" size={13} /> Mobile and email leave masked — unmasking is a separate permission.
            </div>
          )
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !picked.length} onClick={run}>
            {busy ? 'Building…' : `Download ${list.member_count} rows`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Paste a column of identifiers and pull the leads behind them in.
 *
 * The other half of the round trip. What matters here is the report: "6
 * offered, 4 matched" without naming the two that did not is not something
 * anybody can act on, so the misses come back as values, ready to be copied
 * straight back out and chased.
 */
function ImportDialog({ list, onClose, onDone, onError }) {
  const [matchOn, setMatchOn] = useState('client_code');
  const [values, setValues] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const count = values.split(/[\r\n,;\t]+/).map((v) => v.trim()).filter(Boolean).length;

  const run = async () => {
    setBusy(true);
    try {
      setResult(await api.post(`/lists/${list.id}/import`, { match_on: matchOn, values }));
    } catch (e) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Import" subtitle={`Add leads to "${list.name}" by identifier`} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        {!result ? (
          <>
            <div className="field">
              <label htmlFor="imp-match">Match on</label>
              <select id="imp-match" value={matchOn} onChange={(e) => setMatchOn(e.target.value)}>
                {MATCH_ON.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="imp-values">Paste the column</label>
              <textarea id="imp-values" rows={8} value={values} autoFocus
                onChange={(e) => setValues(e.target.value)}
                placeholder={'BZ10021\nBZ10022\nBZ10023'} />
              <span className="tiny muted">
                One per line, or separated by commas or tabs — a column pasted out
                of a spreadsheet works as it is.
                {count > 0 && <> <strong>{count}</strong> value{count === 1 ? '' : 's'} so far.</>}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="notice notice-ok">
              <Icon name="check_circle" size={17} />
              <span>
                <strong>{result.added}</strong> added.
                {' '}{result.matched} of {result.offered} matched a lead you can see
                {result.already_present > 0 && <>, {result.already_present} were already in the list</>}.
              </span>
            </div>
            {result.missed_total > 0 && (
              <div className="field">
                <label htmlFor="imp-missed">{result.missed_total} did not match</label>
                {/* Given back as values, not a count, so they can be copied
                    straight into whatever they came from and chased. */}
                <textarea id="imp-missed" rows={6} readOnly value={result.missed.join('\n')} />
                <span className="tiny muted">
                  {result.missed_total > result.missed.length
                    ? `Showing the first ${result.missed.length}. ` : ''}
                  A value can miss because no lead carries it, or because the lead
                  it belongs to sits in a book you cannot see.
                </span>
              </div>
            )}
          </>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          {!result ? (
            <>
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={busy || !count} onClick={run}>
                {busy ? 'Matching…' : `Import ${count || ''}`.trim()}
              </button>
            </>
          ) : (
            <button className="btn-primary"
              onClick={() => onDone(`${result.added} lead${result.added === 1 ? '' : 's'} added.`)}>
              Done
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
