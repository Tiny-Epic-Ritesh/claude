/**
 * Common Client Master — the check before you onboard.
 *
 * Deliberately a search box and almost nothing else. This is not a directory to
 * browse; it answers one question, asked one record at a time: does this person
 * already exist somewhere in the firm, and who holds them?
 *
 * There is no "list everyone" view for the same reason the API never returns a
 * contact detail — a screen that lists the whole book is a screen somebody will
 * export, and that is not what this is for.
 */

import { useEffect, useState } from 'react';
import { api, shortDate } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty } from '../components/ui.jsx';

export default function Ccm() {
  const [summary] = useApi('/ccm/summary');
  const [q, setQ] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dupes, setDupes] = useState(null);

  // Debounced, so typing a ten-digit number is one request rather than ten.
  useEffect(() => {
    if (q.trim().length < 3) { setResult(null); return undefined; }
    const t = setTimeout(async () => {
      setBusy(true); setError(null);
      try { setResult(await api.get(`/ccm/search?q=${encodeURIComponent(q.trim())}`)); }
      catch (e) { setError(e.message); setResult(null); }
      finally { setBusy(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const loadDupes = async () => {
    setError(null);
    try { setDupes(await api.get('/ccm/duplicates')); }
    catch (e) { setError(e.message); }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Common Client Master</h1>
          <p className="muted">
            Check before you onboard, so nobody re-approaches an existing client
            or opens a second account for them.
          </p>
        </div>
      </div>

      {summary && (
        <div className="grid-auto" style={{ marginBottom: 16 }}>
          <div className="card stat">
            <div className="stat-label">Leads on record</div>
            <div className="stat-value">{summary.leads}</div>
            <div className="stat-sub">{summary.orgs.join(' · ')}</div>
          </div>
          <div className="card stat">
            <div className="stat-label">Live accounts</div>
            <div className="stat-value">{summary.clients}</div>
            <div className="stat-sub">Already converted</div>
          </div>
          <div className={`card stat ${summary.duplicate_mobiles ? 'tone-warn' : ''}`}>
            <div className="stat-label">Numbers held twice</div>
            <div className="stat-value">{summary.duplicate_mobiles}</div>
            <div className="stat-sub">Duplicates already in the book</div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body stack" style={{ gap: 10 }}>
          <div className="field">
            <label htmlFor="ccm-q">Search the firm</label>
            <input id="ccm-q" value={q} autoFocus
              onChange={(e) => setQ(e.target.value)}
              placeholder="Mobile number, PAN, name, email or UCC" />
            <span className="tiny muted">
              This searches every business you work in, including records owned by
              colleagues — that is the point of the check. Contact details are
              never shown.
            </span>
          </div>
          {busy && <Loading label="Checking…" />}
        </div>
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {result && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>
              {result.matches.length
                ? `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'}`
                : 'No match'}
            </h2>
            <span className="tiny muted">Matched on {result.matched_on}</span>
          </div>

          <div className={`card-body notice ${result.matches.length ? 'notice-warn' : 'notice-ok'}`}
            style={{ margin: 12 }}>
            <Icon name={result.matches.length ? 'warning' : 'check_circle'} size={17} />
            <span>{result.note}</span>
          </div>

          {result.matches.length > 0 && (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>Name</th><th>Status</th><th>Held by</th><th>Since</th></tr>
                </thead>
                <tbody>
                  {result.matches.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <div>{m.name}</div>
                        <div className="small muted">{m.mobile} · {m.city || '—'}</div>
                      </td>
                      <td>
                        <div className="row wrap" style={{ gap: 4 }}>
                          <span className="badge">{m.sales_org}</span>
                          {m.already_a_client
                            ? <span className="badge badge-green">Client {m.client_code || ''}</span>
                            : <span className="badge badge-blue">{m.stage}</span>}
                        </div>
                      </td>
                      <td>
                        <div>{m.owner_name || 'Unassigned'}</div>
                        {/* The email is the point of the row: it is how you
                            reach the colleague, not the client. */}
                        {m.owner_email && <div className="small muted">{m.owner_email}</div>}
                        {m.partner_name && <div className="tiny muted">via {m.partner_name}</div>}
                      </td>
                      <td className="muted">{shortDate(m.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2 style={{ fontSize: 15 }}>Duplicates already in the book</h2>
          {!dupes && (
            <button className="btn-sm" onClick={loadDupes}>Show them</button>
          )}
        </div>
        {!dupes && (
          <div className="card-body">
            <p className="small muted" style={{ margin: 0 }}>
              The same number on more than one lead. These are the ones that got in
              before the guard, and the ones an import creates when it is bypassed.
            </p>
          </div>
        )}
        {dupes && dupes.length === 0 && <Empty>No number appears twice. The book is clean.</Empty>}
        {dupes && dupes.length > 0 && (
          <div className="card-body stack" style={{ gap: 12 }}>
            {dupes.map((g) => (
              <div key={g.mobile}>
                <div className="row wrap" style={{ gap: 7 }}>
                  <span className="mono">{g.mobile}</span>
                  <span className="badge badge-amber">{g.count} records</span>
                </div>
                <div className="small muted">
                  {g.records.map((r) => `${r.name} (${r.owner_name || 'unassigned'}, ${r.stage})`).join(' · ')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
