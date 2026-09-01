/**
 * Logs — webhook, telephony, API, payment, portal (P2-15a).
 *
 * Three tables sit behind this screen. `request_log` is the access log built
 * after the book-boundary incident, `integration_log` is vendor traffic, and
 * `audit_log` is configuration history. They were not designed together and
 * they carry different columns, which is why each kind renders its own row
 * shape rather than being forced into one grid that shows blanks for two
 * thirds of every row.
 *
 * WHAT IS NOT HERE, AND WHY THE SCREEN SAYS SO
 *
 * No message bodies, no phone numbers, no payloads. A log that quietly becomes
 * a second copy of the client database is a breach waiting for somebody to
 * grant read access to support. The screen states that rather than leaving an
 * administrator to wonder whether the field is missing or empty.
 *
 * Retention sits on the same screen as the logs it governs. A retention policy
 * on a different tab from the data is a policy nobody checks against reality.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Spinner } from '../components/ui.jsx';
import ApiAccess from './ApiAccess.jsx';

/**
 * API access and Logs, on one screen (Q-02).
 *
 * P2-02 and P2-15 were raised as separate items and are the same screen: one is
 * the credentials an integration uses, the other is the record of what it did.
 * Two screens over the same credentials is exactly the duplication the legacy
 * audit spent ten findings on — if a key can be seen in two places, one of them
 * will drift.
 */
export default function ApiAndLogs() {
  const [half, setHalf] = useState('logs');
  return (
    <section className="stack" style={{ gap: 14 }}>
      <div className="tabs tabs-sub" style={{ margin: 0 }}>
        <button className={half === 'access' ? 'is-active' : ''} onClick={() => setHalf('access')}>
          API access
        </button>
        <button className={half === 'logs' ? 'is-active' : ''} onClick={() => setHalf('logs')}>
          Logs
        </button>
      </div>
      {half === 'access' ? <ApiAccess /> : <Logs />}
    </section>
  );
}

function Logs() {
  const [meta, { loading, error, reload }] = useApi('/setup/logs');
  const [kind, setKind] = useState('api');
  const [q, setQ] = useState('');
  const [notice, setNotice] = useState(null);
  const [problem, setProblem] = useState(null);

  const query = `/setup/logs/${kind}?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const [page, { loading: loadingRows }] = useApi(query);

  if (loading || !meta) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const current = meta.kinds.find((k) => k.kind === kind);

  return (
    <section className="stack" style={{ gap: 14 }}>
      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {notice && (
        <div className="glass notice notice-ok row-between">
          <span><Icon name="check_circle" size={16} /> {notice}</span>
          <button className="btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <Retention
        kinds={meta.kinds}
        onSaved={(m) => { setNotice(m); reload(); }}
        onError={setProblem}
      />

      <div className="card">
        <div className="card-head">
          <div>
            <h2>{current?.label ?? kind}</h2>
            <span className="tiny muted">
              {meta.counts[kind]?.toLocaleString('en-IN') ?? 0} entries · kept {current?.days} days ·
              {' '}no message bodies, numbers or payloads are stored
            </span>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter…"
            style={{ width: 200 }}
          />
        </div>

        <div className="tabs tabs-sub">
          {meta.kinds.map((k) => (
            <button
              key={k.kind}
              className={kind === k.kind ? 'is-active' : ''}
              onClick={() => { setKind(k.kind); setQ(''); }}
            >
              {k.label}
              <span className="tiny muted"> {meta.counts[k.kind] ?? 0}</span>
            </button>
          ))}
        </div>

        {loadingRows && <Loading />}
        {!loadingRows && !page?.rows?.length && (
          <Empty>Nothing recorded here yet.</Empty>
        )}
        {!loadingRows && Boolean(page?.rows?.length) && <Rows source={page.source} rows={page.rows} />}

        {page && page.total > page.rows.length && (
          <p className="tiny muted" style={{ margin: '10px 0 0' }}>
            Showing the most recent {page.rows.length} of {page.total.toLocaleString('en-IN')}.
          </p>
        )}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- rows */

const when = (t) => (t ? String(t).replace('T', ' ').slice(0, 19) : '—');

function Rows({ source, rows }) {
  if (source === 'request_log') {
    return (
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Request</th><th className="num">Status</th><th className="num">ms</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small api-name">{when(r.at)}</td>
              <td className="small">{r.user_name ?? <span className="muted">signed out</span>}<div className="tiny muted">{r.role}</div></td>
              {/* Query strings are stripped before this is stored — they carry
                  ids and search terms, which are client data by another name. */}
              <td className="api-name small">{r.method} {r.path}</td>
              <td className="num"><StatusChip value={r.status} /></td>
              <td className="num small">{r.duration_ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (source === 'audit_log') {
    return (
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Change</th><th>On</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small api-name">{when(r.at)}</td>
              <td className="small">{r.user_name ?? r.actor ?? <span className="muted">system</span>}</td>
              <td className="small">{String(r.action).replace(/_/g, ' ')}</td>
              <td className="api-name small">{r.entity}{r.entity_id ? ` #${r.entity_id}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <table>
      <thead>
        <tr><th>When</th><th>What</th><th>About</th><th>Vendor reference</th><th className="num">Result</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="small api-name">{when(r.at)}</td>
            <td className="small">
              {r.summary ?? r.kind}
              <div className="tiny muted">
                {r.kind}{r.direction === 'in' ? ' · inbound' : ''}{r.simulated ? ' · simulated' : ''}
              </div>
            </td>
            <td className="small">
              {r.lead_name ?? <span className="muted">—</span>}
              {r.user_name && <div className="tiny muted">by {r.user_name}</div>}
            </td>
            {/* The vendor's own id. It is what they ask for on the phone when
                you call them about a failure. */}
            <td className="api-name small">{r.reference ?? '—'}</td>
            <td className="num">
              <StatusChip value={r.status} />
              {r.error && <div className="tiny warn-text">{r.error}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusChip({ value }) {
  const n = Number(value);
  const bad = Number.isFinite(n) ? n >= 400 : /fail|refus|error/i.test(String(value));
  const soft = !Number.isFinite(n) && /simulat|queue/i.test(String(value));
  return (
    <span className={`badge ${bad ? 'badge-amber' : soft ? '' : 'badge-green'}`}>{value}</span>
  );
}

/* ---------------------------------------------------------- retention */

function Retention({ kinds, onSaved, onError }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);

  const save = async (k) => {
    const days = Number(draft[k.kind]);
    setBusy(true);
    try {
      await api.patch(`/setup/log-retention/${k.kind}`, { days });
      setDraft((d) => ({ ...d, [k.kind]: undefined }));
      onSaved(`${k.label} is now kept ${days} days.`);
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  };

  const runPurge = async () => {
    setBusy(true);
    try {
      const r = await api.post('/setup/logs/purge', {});
      onSaved(r.total
        ? `Removed ${r.total} entries past their retention period.`
        : 'Nothing was past its retention period.');
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>How long each log is kept</h2>
          <span className="tiny muted">
            Configuration, not code — Compliance can change these without a deploy, and the
            purge runs on every restart.
          </span>
        </div>
        <span className="row" style={{ gap: 8 }}>
          <button className="btn-ghost btn-sm" disabled={busy} onClick={runPurge}>
            <Icon name="delete_sweep" size={15} /> Purge now
          </button>
          <button className="btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'}
          </button>
        </span>
      </div>

      {open && (
        <table>
          <thead><tr><th>Log</th><th className="num">Days</th><th>Why</th><th /></tr></thead>
          <tbody>
            {kinds.map((k) => {
              const pending = draft[k.kind] !== undefined && Number(draft[k.kind]) !== k.days;
              return (
                <tr key={k.kind}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{k.label}</div>
                    <div className="tiny muted api-name">{k.source}</div>
                  </td>
                  <td className="num">
                    <input
                      type="number" min="1" style={{ width: 90 }}
                      value={draft[k.kind] ?? k.days}
                      onChange={(e) => setDraft((d) => ({ ...d, [k.kind]: e.target.value }))}
                    />
                    {k.is_default && <div className="tiny muted">default</div>}
                  </td>
                  <td className="small muted" style={{ maxWidth: 380 }}>{k.note}</td>
                  <td className="num">
                    {pending && (
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => save(k)}>
                        {busy ? <Spinner /> : 'Save'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
