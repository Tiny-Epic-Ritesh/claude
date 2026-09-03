import { useState } from 'react';
import { api, dateTime } from '../../api.js';
import {
  useApi, Loading, ErrorBanner, Empty, Icon,
} from '../../components/ui.jsx';

/*
 * Moving configuration between environments. P2-03.
 *
 * The screen is deliberately two halves that do not talk to each other, because
 * in real use they are on two different machines: you package in UAT, carry the
 * bundle across by whatever means the network allows, and apply in Production.
 * A single "promote" button would imply the two environments can see each
 * other, which is the opposite of why they are separate.
 *
 * Applying always shows what would change before it changes anything. That is
 * not a nicety on a screen that writes to Production — it is the only moment
 * when a mistake is still cheap.
 */

const KIND_LABEL = {
  rule: 'Automation rules',
  template: 'Message templates',
  kyc_journey: 'KYC journeys',
  sla_policy: 'SLA policies',
};

const STATUS_BADGE = {
  create: 'badge-green',
  update: 'badge-amber',
  identical: 'badge-blue',
  blocked: 'badge-red',
};

export function Promotion() {
  const [data, { loading, error, reload }] = useApi('/admin/promotions');

  const [picked, setPicked] = useState({});      // `${kind}:${logical_id}` → true
  const [note, setNote] = useState('');
  const [bundle, setBundle] = useState(null);    // what packaging produced
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  const [incoming, setIncoming] = useState(''); // pasted bundle text
  const [preview, setPreview] = useState(null);
  const [applied, setApplied] = useState(null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Empty>Promotion is not available here.</Empty>;

  const selection = Object.entries(picked)
    .filter(([, on]) => on)
    .map(([key]) => {
      const at = key.indexOf(':');
      return { kind: key.slice(0, at), logical_id: key.slice(at + 1) };
    });

  const toggle = (kind, logicalId) => setPicked((p) => {
    const key = `${kind}:${logicalId}`;
    return { ...p, [key]: !p[key] };
  });

  const packageUp = async () => {
    setBusy('packaging');
    setProblem(null);
    setBundle(null);
    try {
      /* logical_id goes back as it came: an SLA policy's is "12:High", and
         coercing it to a number here would quietly break that one kind. */
      const out = await api.post('/admin/promotions/package', { selection, note: note || null });
      setBundle(out.bundle);
      reload();
    } catch (e) {
      setProblem(e.message);
    } finally {
      setBusy(null);
    }
  };

  const parseIncoming = () => {
    try {
      return { value: JSON.parse(incoming) };
    } catch {
      return { error: 'That is not valid JSON. Paste the whole bundle file, including its outer braces.' };
    }
  };

  const inspect = async () => {
    setBusy('inspect');
    setProblem(null);
    setPreview(null);
    setApplied(null);
    const parsed = parseIncoming();
    if (parsed.error) { setProblem(parsed.error); setBusy(null); return; }
    try {
      setPreview(await api.post('/admin/promotions/inspect', { bundle: parsed.value }));
    } catch (e) {
      setProblem(e.message);
    } finally {
      setBusy(null);
    }
  };

  const applyNow = async () => {
    setBusy('apply');
    setProblem(null);
    const parsed = parseIncoming();
    if (parsed.error) { setProblem(parsed.error); setBusy(null); return; }
    try {
      const out = await api.post('/admin/promotions/apply', { bundle: parsed.value });
      setApplied(out);
      setPreview(null);
      setIncoming('');
      reload();
    } catch (e) {
      setProblem(e.message);
    } finally {
      setBusy(null);
    }
  };

  const bundleText = bundle ? JSON.stringify(bundle, null, 2) : '';

  return (
    <>
      <div className="notice">
        <strong>This environment is “{data.environment}”.</strong>{' '}
        Configuration packaged here is stamped with that name, and anything applied here
        records it as the destination. Data is never included — no leads, clients or users.
      </div>

      {problem && <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />}

      {/* ------------------------------------------------------ package */}
      <section className="card">
        <div className="card-head">
          <h2>Package a bundle</h2>
          <span className="tiny muted">
            {selection.length === 0 ? 'Nothing selected' : `${selection.length} selected`}
          </span>
        </div>

        {Object.entries(data.candidates ?? {}).map(([kind, items]) => (
          <div key={kind} style={{ padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
            <div className="tiny muted" style={{ marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {KIND_LABEL[kind] ?? kind}
            </div>
            {items.length === 0
              ? <div className="tiny muted">None in this environment.</div>
              : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {items.map((item) => {
                    const key = `${kind}:${item.logical_id}`;
                    return (
                      <label
                        key={key}
                        className="tiny"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '5px 9px',
                          border: '1px solid var(--line)',
                          borderRadius: 6,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!!picked[key]}
                          onChange={() => toggle(kind, item.logical_id)}
                        />
                        <span style={{ fontWeight: 545 }}>{item.label}</span>
                        {item.hint && <span className="muted">· {item.hint}</span>}
                      </label>
                    );
                  })}
                </div>
              )}
          </div>
        ))}

        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What is this bundle for? (optional, travels with it)"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={selection.length === 0 || busy === 'packaging'}
            onClick={packageUp}
          >
            {busy === 'packaging' ? 'Packaging…' : 'Package'}
          </button>
        </div>

        {bundle && (
          <div style={{ padding: '0 14px 14px' }}>
            <div className="tiny muted" style={{ marginBottom: 6 }}>
              Bundle <strong>{bundle.bundle_id.slice(0, 8)}</strong> · {bundle.entries.length} item
              {bundle.entries.length === 1 ? '' : 's'} · checksum {bundle.checksum.slice(0, 12)}…
              {' '}Copy this to the target environment and paste it below there.
            </div>
            <textarea
              readOnly
              value={bundleText}
              rows={10}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: 6 }}
              onClick={() => navigator.clipboard?.writeText(bundleText)}
            >
              <Icon name="content_copy" size={14} /> Copy
            </button>
          </div>
        )}
      </section>

      {/* -------------------------------------------------------- apply */}
      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Apply a bundle here</h2>
          <span className="tiny muted">Shows what would change first</span>
        </div>

        <div style={{ padding: '12px 14px' }}>
          <textarea
            value={incoming}
            onChange={(e) => { setIncoming(e.target.value); setPreview(null); setApplied(null); }}
            rows={6}
            placeholder="Paste a bundle here"
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={!incoming.trim() || busy === 'inspect'}
              onClick={inspect}
            >
              {busy === 'inspect' ? 'Checking…' : 'Show what would change'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              /* Deliberately gated on a successful inspection: nobody applies to
                 an environment without having been shown what it does first. */
              disabled={!preview?.ok || !preview.appliable || busy === 'apply'}
              onClick={applyNow}
            >
              {busy === 'apply' ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>

        {preview?.ok && (
          <div style={{ padding: '0 14px 14px' }}>
            <div className="tiny muted" style={{ marginBottom: 8 }}>
              From <strong>{preview.source_env}</strong> into <strong>{preview.target_env}</strong>
              {preview.note ? ` · ${preview.note}` : ''} — {preview.summary.create} to create,{' '}
              {preview.summary.update} to update, {preview.summary.identical} already identical
              {preview.summary.blocked > 0 && `, ${preview.summary.blocked} blocked`}
            </div>

            {!preview.appliable && (
              <div className="notice" style={{ marginBottom: 8 }}>
                Nothing will be applied while any item is blocked. A part-applied bundle
                would leave this environment in a state nobody designed.
              </div>
            )}

            <table>
              <thead>
                <tr><th>Item</th><th>Effect</th><th>Changes</th></tr>
              </thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr key={`${item.kind}-${item.describes}`}>
                    <td style={{ fontWeight: 545 }}>{item.describes}</td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[item.status] ?? 'badge-blue'}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="tiny muted">
                      {item.status === 'blocked'
                        ? item.reason
                        : (item.changes.length === 0
                          ? '—'
                          : item.changes.map((c) => c.field).join(', '))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {applied?.ok && (
          <div className="notice" style={{ margin: '0 14px 14px' }}>
            Applied bundle <strong>{applied.bundle_id.slice(0, 8)}</strong> from{' '}
            {applied.source_env}: {applied.created} created, {applied.updated} updated.
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ history */}
      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Recent promotions</h2>
          <span className="tiny muted">The last {data.kept} are kept</span>
        </div>
        {(data.recent ?? []).length === 0
          ? <Empty>Nothing has been packaged or applied here yet.</Empty>
          : (
            <table>
              <thead>
                <tr><th>When</th><th>What</th><th>Route</th><th>Items</th><th>By</th><th>Note</th></tr>
              </thead>
              <tbody>
                {data.recent.map((row) => (
                  <tr key={row.id}>
                    <td className="tiny">{dateTime(row.created_at)}</td>
                    <td>
                      <span className={`badge ${row.direction === 'applied' ? 'badge-amber' : 'badge-blue'}`}>
                        {row.direction}
                      </span>
                    </td>
                    <td className="tiny">
                      {row.source_env}
                      {row.target_env ? ` → ${row.target_env}` : ' → not yet applied'}
                    </td>
                    <td className="tiny">{row.entry_count}</td>
                    <td className="tiny">{row.created_by_name ?? '—'}</td>
                    <td className="tiny muted">{row.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>
    </>
  );
}
