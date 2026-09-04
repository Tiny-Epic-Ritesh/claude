/**
 * Clients — the account book.
 *
 * Deliberately not a second Leads screen. A lead list answers "who should I
 * call next"; this answers "how is this account doing" — so the columns are
 * UCC, segments, holdings and last trade, and the tile that matters most is
 * Dormant. A dormant account is revenue already won and quietly leaving, and
 * it is the number nobody notices until something puts it in front of them.
 *
 * Every tile is a link into this same list, filtered (Q-05).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, rupeesCompact, shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Stat, Modal } from '../components/ui.jsx';
import AdvancedSearch from '../components/AdvancedSearch.jsx';

/* Rows per page. The tab used to ask for two hundred and render whatever came
   back, so an account book larger than that showed a fraction of itself while
   the Accounts tile overhead stated the true total — two numbers on one screen
   that disagreed, with nothing to explain the difference. */
const PAGE = 50;

/** Which of the seven columns can be ordered by, and how each one is read. */
const COLUMNS = [
  {
    key: 'name',
    label: 'Client',
    render: (c) => (
      <>
        <div>{c.name}</div>
        <div className="small muted">{c.mobile}</div>
      </>
    ),
  },
  { key: 'client_code', label: 'UCC', cls: 'mono', render: (c) => c.client_code },
  {
    key: 'holding_value',
    label: 'Holdings',
    num: true,
    cls: 'num',
    render: (c) => rupeesCompact(c.holding_value),
  },
  {
    key: 'brokerage_ytd',
    label: 'Brokerage YTD',
    num: true,
    cls: 'num',
    render: (c) => rupeesCompact(c.brokerage_ytd),
  },
  {
    key: 'last_traded_at',
    label: 'Last trade',
    /* Dormant is derived by the list query; a search row carries the date and
       nothing to colour it with. */
    render: (c, { searching }) => (!searching && c.activity_status === 'Dormant' ? (
      <span className="badge badge-amber" title={`${c.days_since_trade} days since last trade`}>
        Dormant · {c.days_since_trade}d
      </span>
    ) : (
      <span className="muted">{shortDate(c.last_traded_at)}</span>
    )),
  },
  { key: 'owner_name', label: 'Owner', cls: 'muted', render: (c) => c.owner_name || '—' },
];

/**
 * Choose which columns this book shows.
 *
 * The choice is a preference and nothing more: the field is still returned by
 * the API and still masked by whatever applies to the person asking, so ticking
 * one back on grants nothing. Hiding a column is tidying, the same way hiding a
 * tab is — which is why this needs no permission and is not audited.
 *
 * It resolves server-side through role default then personal override, so an
 * administrator can set a sensible starting set for a role and anybody can
 * still disagree with it for themselves.
 */
function ColumnChooser({ columns, onToggle, onReset, hasOwnChoice }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hidden = columns.filter((c) => !c.visible).length;

  return (
    <div className="action-menu" ref={wrapRef}>
      <button
        type="button"
        className="btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="view_column" size={15} /> Columns
        {hidden > 0 && <span className="muted"> · {hidden} hidden</span>}
      </button>

      {open && (
        <div className="menu" role="menu" style={{ padding: 8, minWidth: 210 }}>
          {columns.map((col) => (
            <label
              key={col.key}
              className="tiny"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 6px',
                cursor: col.always ? 'default' : 'pointer',
                opacity: col.always ? 0.6 : 1,
              }}
              title={col.always ? 'Every row needs something to identify it by' : undefined}
            >
              <input
                type="checkbox"
                checked={col.visible}
                disabled={col.always}
                onChange={() => onToggle(col.key, !col.visible)}
              />
              <span style={{ fontWeight: 545 }}>{col.label}</span>
              {col.source === 'role' && <span className="muted">· from your role</span>}
            </label>
          ))}

          {/* Only offered when there is something to go back to: "same as my
              role" and "I ticked all six" are different states. */}
          {hasOwnChoice && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              style={{ marginTop: 6, width: '100%' }}
              onClick={() => { onReset(); setOpen(false); }}
            >
              Back to my role&rsquo;s default
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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

/** Stable colours so the eye learns a segment across rows. */
const SEGMENT_BADGE = {
  Equity: 'badge-blue',
  Derivatives: 'badge-amber',
  Commodity: 'badge-red',
  Currency: 'badge-accent',
  'Mutual Fund': 'badge-green',
  Global: 'badge-accent',
};

export default function Clients({ session }) {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();

  // Filters live in the URL, so a drill-through arrives already filtered and
  // the filtered view stays shareable and survives a refresh.
  const filters = useMemo(() => ({
    q: search.get('q') ?? '',
    status: search.get('status') ?? '',
    segment: search.get('segment') ?? '',
    dormant: search.get('dormant') ?? '',
  }), [search]);

  /* Order and position join the filters in the URL rather than in local state,
     for the reason the filters are already there: a colleague sent "the ten
     largest dormant accounts" should open on the ten largest dormant accounts,
     and a refresh should not lose the reader's place. */
  const sort = search.get('sort') ?? '';
  const dir = search.get('dir') === 'asc' ? 'asc' : 'desc';
  const offset = Math.max(Number(search.get('offset')) || 0, 0);

  // The search box needs to keep up with typing without refetching per key.
  const [typed, setTyped] = useState(filters.q);
  useEffect(() => { setTyped(filters.q); }, [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (typed === filters.q) return;
      const next = new URLSearchParams(search);
      if (typed) next.set('q', typed); else next.delete('q');
      setSearch(next, { replace: true });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    if (sort) { p.set('sort', sort); p.set('dir', dir); }
    p.set('limit', String(PAGE));
    p.set('offset', String(offset));
    return p.toString();
  }, [filters, sort, dir, offset]);

  const [rows, { loading, error, total }] = useApi(`/clients?${query}`, [query]);
  const [exporting, setExporting] = useState(false);
  /* The three boxes above answer "which segment, which status, is it dormant".
     Anything with an or in it — "Derivatives or Commodity, opened this year,
     no trade in sixty days" — needs the builder, which the account book had no
     way to reach because clients were not a searchable object at all. */
  const [advanced, setAdvanced] = useState(false);
  const [found, setFound] = useState(null);

  // The unpaged count, which the route has always sent and nothing has read.
  const count = total ?? rows?.length ?? 0;

  /* A search answers with the columns the search engine selects, which is not
     quite the list's shape: segments come from a side table the list queries
     separately, and Dormant is derived. Rather than render those blank, the two
     columns step out while a search is showing — a result table and a list
     table answering different questions is normal, a column of em-dashes is
     not. */
  const shown = found ? found.rows : rows;
  const searching = Boolean(found);
  const [summary] = useApi('/clients/summary');
  const [meta] = useApi('/clients/meta');

  /* Column choice, resolved server-side: role default, then this person's own
     override on top. Held in state so a tick redraws the table at once rather
     than after a round trip. */
  const [cols, { reload: reloadCols }] = useApi('/setup/columns/client');
  const [colOverride, setColOverride] = useState(null);
  const columns = colOverride ?? cols?.columns ?? [];
  const visible = columns.length
    ? COLUMNS.filter((c) => columns.find((r) => r.key === c.key)?.visible !== false)
    : COLUMNS;

  /* Bulk selection.
   *
   * Held as a Set of explicit ids, never as "the current filter". A filter is
   * evaluated when the action runs, so between reading a count and pressing the
   * button the set can change -- and an approver cannot be shown what they are
   * agreeing to. Select all matching resolves the filter to ids once, and those
   * ids are what moves. */
  const [picked, setPicked] = useState(() => new Set());
  const [reassigning, setReassigning] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [allMatching, setAllMatching] = useState(null);

  // A changed filter invalidates a selection made against the previous one.
  useEffect(() => { setPicked(new Set()); setAllMatching(null); }, [query]);

  const togglePick = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const out = await api.get(`/clients/ids?${query}`);
      setPicked(new Set(out.ids));
      setAllMatching(out);
    } catch {
      setAllMatching(null);
    } finally {
      setSelectingAll(false);
    }
  };

  const toggleColumn = (key, next) => {
    // Optimistic: the list redraws immediately, and the save follows.
    setColOverride(columns.map((c) => (c.key === key ? { ...c, visible: next, source: 'user' } : c)));
    api.put('/setup/columns/client', { columns: { [key]: next } })
      .then(() => reloadCols())
      .catch(() => { setColOverride(null); reloadCols(); });
  };

  const resetColumns = () => {
    setColOverride(null);
    api.del('/setup/columns/client').then(() => reloadCols()).catch(() => reloadCols());
  };

  const setFilter = (key, value) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value); else next.delete(key);
    // Narrowing the list invalidates the page number: page 4 of a filter that
    // now matches nine accounts is an empty screen that reads as a bug.
    next.delete('offset');
    setSearch(next, { replace: true });
  };

  const setSort = (key) => {
    const next = new URLSearchParams(search);
    next.set('sort', key);
    next.set('dir', sort === key && dir === 'asc' ? 'desc' : 'asc');
    next.delete('offset');
    setSearch(next, { replace: true });
  };

  const setPage = (nextOffset) => {
    const next = new URLSearchParams(search);
    if (nextOffset > 0) next.set('offset', String(nextOffset)); else next.delete('offset');
    setSearch(next, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const applied = Object.entries(filters).filter(([, v]) => v);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Clients</h1>
          <p className="muted">
            Live accounts — a UCC, a ledger and a trading history. Prospects live in Leads.
          </p>
        </div>
      </div>

      {summary && (
        <div className="grid-auto" style={{ marginBottom: 18 }}>
          <Stat label="Accounts" value={summary.total ?? 0} to="/clients"
            sub={`${summary.opened_this_month ?? 0} opened this month`} />
          <Stat label="Trading" value={summary.active ?? 0} tone="good" to="/clients"
            sub="Traded in the last 90 days" />
          <Stat label="Dormant" value={summary.dormant ?? 0} tone="warn"
            to="/clients?dormant=true" sub="No trade in 90 days — worth a call" />
          <Stat label="Holdings" value={rupeesCompact(summary.holding_value)}
            sub={`${rupeesCompact(summary.brokerage_ytd)} brokerage YTD`} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 240px' }}>
            <label htmlFor="client-q">Search</label>
            <input id="client-q" placeholder="Name, UCC, mobile or email"
              value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="client-segment">Segment</label>
            <select id="client-segment" value={filters.segment}
              onChange={(e) => setFilter('segment', e.target.value)}>
              <option value="">All segments</option>
              {(meta?.segments ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="client-status">Status</label>
            <select id="client-status" value={filters.status}
              onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Any status</option>
              {(meta?.statuses ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className="card-body row wrap" style={{ gap: 8, paddingTop: 0 }}>
          <button type="button"
            className={advanced ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
            onClick={() => { setAdvanced((v) => !v); if (advanced) setFound(null); }}>
            <Icon name="filter_alt" size={16} /> {advanced ? 'Hide advanced search' : 'Advanced search'}
          </button>
        </div>

        {/* The applied filter is always visible and always removable. A list
            that is silently filtered reads as a bug — "where did my other
            accounts go?" (Q-05). */}
        {applied.length > 0 && (
          <div className="card-body row wrap" style={{ gap: 6, paddingTop: 0 }}>
            <span className="tiny muted">Filtered by</span>
            {applied.map(([k, v]) => (
              <button key={k} type="button" className="chip chip-active"
                onClick={() => setFilter(k, '')}
                title="Remove this filter">
                {k === 'dormant' ? 'No trade in 90 days' : `${k}: ${v}`}
                <Icon name="close" size={13} />
              </button>
            ))}
          </div>
        )}
      </div>

      {advanced && (
        <AdvancedSearch
          entity="client"
          session={session}
          onResults={setFound}
          onClose={() => { setAdvanced(false); setFound(null); }}
        />
      )}

      {found && (
        <div className="result-bar">
          <span className="described">
            <strong>{found.total.toLocaleString('en-IN')}</strong> matched — {found.described}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setFound(null)}>
            <Icon name="close" size={15} /> Clear
          </button>
        </div>
      )}

      <ErrorBanner error={error} />
      {loading && <Loading label="Loading accounts…" />}

      {!loading && shown && shown.length === 0 && (
        <Empty>
          {applied.length
            ? 'No accounts match these filters. Try removing one above.'
            : 'No accounts yet. A client appears here once a lead converts and a UCC is issued.'}
        </Empty>
      )}

      {!loading && shown && shown.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>
              {searching
                ? `${found.rows.length} of ${found.total.toLocaleString('en-IN')} matched`
                : `${count.toLocaleString('en-IN')} account${count === 1 ? '' : 's'}`}
              {!searching && applied.length > 0 && <span className="muted"> matching</span>}
            </h2>
            {/* Clients were the one object with no export at all — leads,
                cases, tasks and partners all had one. The account book is the
                revenue, so the absence meant the most valuable table here was
                the one people copied out by hand. */}
            <ColumnChooser
              columns={columns}
              hasOwnChoice={Boolean(cols?.has_own_choice) || Boolean(colOverride)}
              onToggle={toggleColumn}
              onReset={resetColumns}
            />
            {meta?.may_export && (
              <button className="btn-ghost btn-sm" onClick={() => setExporting(true)}>
                <Icon name="download" size={15} /> Export
              </button>
            )}
          </div>
          {/* The selection bar. It exists to make two things impossible to miss:
              how many accounts are actually selected, and that "everything
              matching" is a real, counted set rather than a filter that will be
              re-evaluated later. */}
          {meta?.may_reassign && picked.size > 0 && (
            <div
              className="row wrap"
              style={{
                gap: 10, alignItems: 'center', padding: '10px 14px',
                borderTop: '1px solid var(--line)', background: 'var(--surface-2, transparent)',
              }}
            >
              <strong>{picked.size.toLocaleString('en-IN')} selected</strong>

              {!searching && picked.size < count && (
                <button type="button" className="btn-ghost btn-sm"
                  disabled={selectingAll} onClick={selectAllMatching}>
                  {selectingAll ? 'Selecting…' : `Select all ${count.toLocaleString('en-IN')} matching`}
                </button>
              )}

              {allMatching?.capped && (
                <span className="tiny muted">
                  Capped at {allMatching.cap.toLocaleString('en-IN')} of{' '}
                  {allMatching.total.toLocaleString('en-IN')} — narrow the filter to move the rest.
                </span>
              )}

              {picked.size >= (meta?.bulk_threshold ?? 25) && (
                <span className="badge badge-amber">
                  Needs approval over {meta.bulk_threshold}
                </span>
              )}

              <span style={{ flex: 1 }} />

              <button type="button" className="btn btn-primary btn-sm"
                onClick={() => setReassigning(true)}>
                <Icon name="swap_horiz" size={15} /> Reassign
              </button>
              <button type="button" className="btn-ghost btn-sm"
                onClick={() => { setPicked(new Set()); setAllMatching(null); }}>
                Clear
              </button>
            </div>
          )}

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {meta?.may_reassign && (
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        aria-label="Select every account on this page"
                        checked={shown.length > 0 && shown.every((c) => picked.has(c.id))}
                        onChange={(e) => setPicked((prev) => {
                          const next = new Set(prev);
                          shown.forEach((c) => (e.target.checked ? next.add(c.id) : next.delete(c.id)));
                          return next;
                        })}
                      />
                    </th>
                  )}
                  {visible.map((col) => (
                    <th key={col.key} className={col.num ? 'num' : undefined}
                      aria-sort={sort === col.key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {/* "Who are my largest clients" is the question this book
                          exists to answer, and the only way to ask it used to be
                          to export the table and sort it somewhere else. */}
                      <button type="button" className="th-sort"
                        aria-label={`Sort by ${col.label}`} onClick={() => setSort(col.key)}>
                        {col.label}
                        <Icon
                          name={sort !== col.key ? 'unfold_more' : dir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                          size={13} />
                      </button>
                    </th>
                  ))}
                  {/* Segments come from a side table per row, so there is no
                      single column to order by — and a search does not fetch
                      them at all. */}
                  {!searching && <th>Segments</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className="row-link" onClick={() => navigate(`/clients/${c.id}`)}>
                    {meta?.may_reassign && (
                      // stopPropagation, or ticking a row opens it.
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.name}`}
                          checked={picked.has(c.id)}
                          onChange={() => togglePick(c.id)}
                        />
                      </td>
                    )}
                    {/* Body and header walk the same filtered list, so a
                        hidden column cannot leave the two out of step -- which
                        is what positional cells would have done the first time
                        somebody hid one. */}
                    {visible.map((col) => (
                      <td key={col.key} className={col.cls}>{col.render(c, { searching })}</td>
                    ))}
                    {!searching && (
                      <td>
                        <div className="row wrap" style={{ gap: 4 }}>
                          {(c.segments ?? []).map((s) => (
                            <span key={s} className={`badge ${SEGMENT_BADGE[s] || ''}`}>{s}</span>
                          ))}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Where you are in the book, and how to leave. Without this the tab
              showed a page and called it the whole thing. */}
          {!searching && (count > PAGE || offset > 0) && (
            <div className="card-foot row wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
              <span className="tiny muted">
                {offset + 1}–{offset + rows.length} of {count.toLocaleString('en-IN')}
              </span>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn-ghost btn-sm" disabled={offset === 0}
                  onClick={() => setPage(Math.max(offset - PAGE, 0))}>
                  <Icon name="chevron_left" size={15} /> Previous
                </button>
                <button className="btn-ghost btn-sm" disabled={offset + rows.length >= count}
                  onClick={() => setPage(offset + PAGE)}>
                  Next <Icon name="chevron_right" size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {reassigning && (
        <ReassignDialog
          meta={meta}
          ids={[...picked]}
          onClose={() => setReassigning(false)}
          onDone={(result) => {
            setReassigning(false);
            setPicked(new Set());
            setAllMatching(null);
            if (!result?.approval_required) window.location.reload();
          }}
        />
      )}
      {exporting && (
        <ExportDialog meta={meta} count={count} query={query}
          onClose={() => setExporting(false)} />
      )}
    </div>
  );
}

/**
 * Move a set of accounts to a new owner.
 *
 * Takes the ids it was handed and shows the count back, because the number that
 * moves must be the number the person read. Over the threshold this stops being
 * a change and becomes a request -- so the dialog asks for a reason, which is
 * what an approver needs and what the route refuses to proceed without.
 */
function ReassignDialog({ meta, ids, onClose, onDone }) {
  const [ownerId, setOwnerId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  const threshold = meta?.bulk_threshold ?? 25;
  const needsApproval = ids.length >= threshold;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.post('/clients/bulk/reassign', {
        client_ids: ids,
        owner_id: Number(ownerId),
        reason: reason || undefined,
      });
      if (out.approval_required) { setSent(out); return; }
      onDone(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Modal title="Waiting for approval" onClose={() => onDone(sent)}>
        <p>{sent.message}</p>
        <p className="tiny muted">
          Nothing has moved yet. It is on the Approvals queue for somebody who can decide it.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => onDone(sent)}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Reassign ${ids.length.toLocaleString('en-IN')} account${ids.length === 1 ? '' : 's'}`}
      subtitle={needsApproval
        ? `Over ${threshold}, so this will be sent for approval rather than applied`
        : 'Applies immediately'}
      onClose={onClose}
    >
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      <label className="field">
        <span>New owner</span>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <option value="">Choose someone…</option>
          {(meta?.owners ?? []).map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        {/* Only people in this book are listed: an account cannot move to
            somebody who does not work in its business, so offering them would
            be offering a choice the server refuses. */}
        <span className="tiny muted">Only people in this business can own these accounts.</span>
      </label>

      {needsApproval && (
        <label className="field">
          <span>Why</span>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="An approver deciding without a reason is rubber-stamping."
          />
        </label>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ownerId || busy || (needsApproval && !reason.trim())}
          onClick={submit}
        >
          {busy ? 'Working…' : needsApproval ? 'Send for approval' : 'Reassign'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Export the book, as filtered.
 *
 * The filters go to the server as the same query string the table was drawn
 * with, so what leaves is what was on screen. Rebuilding the conditions here
 * would have let the two drift, and "which accounts were actually in that
 * file" is precisely the question asked afterwards.
 */
function ExportDialog({ meta, count, query, onClose }) {
  const columns = meta?.columns ?? [];
  const [picked, setPicked] = useState(
    ['name', 'client_code', 'status', 'holding_value', 'brokerage_ytd', 'last_traded_at', 'owner_name'],
  );
  const [unmask, setUnmask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const toggle = (key) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const hasPii = picked.some((k) => columns.find((c) => c.key === k)?.pii);
  const capped = count > (meta?.export_cap ?? 5000);

  const run = async () => {
    setBusy(true); setProblem(null);
    try {
      // The table's own query string, so the export cannot describe a
      // different set of accounts than the one it was taken from.
      const r = await api.post(`/clients/export?${query}`, { columns: picked, unmask });
      download(r.filename, r.csv);
      onClose();
    } catch (e) { setProblem(e.message); setBusy(false); }
  };

  return (
    <Modal title="Export accounts"
      subtitle={`${count.toLocaleString('en-IN')} account${count === 1 ? '' : 's'}, as currently filtered`}
      onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

        <div className="stack" style={{ gap: 2, maxHeight: '40vh', overflowY: 'auto' }}>
          {columns.map((c) => (
            <label key={c.key} className="row" style={{ gap: 8, padding: '6px 2px', cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.includes(c.key)} onChange={() => toggle(c.key)} />
              <span style={{ flex: 1 }}>{c.label}</span>
              {c.pii && <span className="chip chip-muted tiny">Identifier</span>}
            </label>
          ))}
        </div>

        {hasPii && (
          meta?.may_unmask ? (
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

        {capped && (
          <div className="notice notice-warn">
            <Icon name="info" size={17} />
            <span>
              This filter matches more than one export can carry. The first{' '}
              {(meta?.export_cap ?? 5000).toLocaleString('en-IN')} will be included —
              narrow the filters if you need a particular set.
            </span>
          </div>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !picked.length} onClick={run}>
            {busy ? 'Building…' : 'Download CSV'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
