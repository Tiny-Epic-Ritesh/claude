/**
 * Setup → Test records (QA-37; the auditor's section 9).
 *
 * An Admin marks a record as test data by kind and number; the list shows,
 * for each one, what retiring will do to it -- or what stops it -- before
 * anything happens; and Retire takes every marked record out of use through
 * its own lifecycle, with one reason. Nothing is deleted: the auditor's
 * evidence lives in these records, and the mark stays as the account of what
 * was done.
 */

import { useState } from 'react';
import { api, dateTime } from '../../api.js';
import { useApi, Loading, ErrorBanner, Empty, Icon, Modal, announce } from '../../components/ui.jsx';

export function TestRecords() {
  const [data, { loading, error, reload }] = useApi('/admin/test-records');
  const [form, setForm] = useState({ entity: 'lead', record_id: '', note: '' });
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(null);
  const [retiring, setRetiring] = useState(false);

  if (error) return <ErrorBanner error={error} />;
  if (loading || !data) return <Loading />;

  const open = data.records.filter((r) => !r.retired_at);
  const retired = data.records.filter((r) => r.retired_at);
  const ready = open.filter((r) => !r.plan?.blocked);

  async function mark(e) {
    e.preventDefault();
    setProblem(null); setDone(null);
    try {
      await api.post('/admin/test-records', { ...form, record_id: Number(form.record_id) });
      setForm({ ...form, record_id: '', note: '' });
      reload();
    } catch (err) { setProblem(err.message); }
  }

  async function unmark(r) {
    setProblem(null); setDone(null);
    try {
      await api.del(`/admin/test-records/${r.id}`);
      // Part 4, item 8.4.
      announce('Unmarked', [`${r.kind_label} ${r.record_id} is no longer marked as test data. Nothing else about it changed.`]);
      reload();
    }
    catch (err) { setProblem(err.message); }
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="notice">
        <Icon name="inventory_2" size={18} />
        <span className="small">
          Mark a record as test data, check what retiring it will do, then retire them together. A lead goes to the
          recycle bin, a case is closed, a list, rule, flow or library item is archived, a task is cancelled, a template
          retired, a partner&apos;s portal access withdrawn and the record archived. Nothing is deleted.
        </span>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />
      {done && <div className="notice notice-ok"><Icon name="check_circle" size={17} /> <span>{done}</span></div>}

      <section className="card">
        <div className="card-head"><h2>Mark a record</h2></div>
        <form onSubmit={mark} className="card-body row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="tr-kind">What it is</label>
            <select id="tr-kind" value={form.entity} onChange={(e) => setForm({ ...form, entity: e.target.value })}>
              {data.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, maxWidth: 140 }}>
            <label htmlFor="tr-id">Its number</label>
            <input id="tr-id" inputMode="numeric" value={form.record_id}
              onChange={(e) => setForm({ ...form, record_id: e.target.value.replace(/\D/g, '') })} placeholder="42" />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: '1 1 240px' }}>
            <label htmlFor="tr-note">Note (optional)</label>
            <input id="tr-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Auditor's record, round 4" />
          </div>
          <button className="btn-primary" disabled={!form.record_id}>Mark as test data</button>
        </form>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Marked, not yet retired</h2>
          <button className="btn-primary btn-sm" disabled={!ready.length} onClick={() => setRetiring(true)}>
            Retire {ready.length || ''}
          </button>
        </div>
        {!open.length ? <Empty>Nothing is marked.</Empty> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Record</th><th>What retiring does</th><th>Marked</th><th /></tr></thead>
              <tbody>
                {open.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong className="small">{r.kind_label} {r.record_id}</strong>
                      <div className="tiny muted">{r.current_label ?? r.label}{r.book ? ` · ${r.book}` : ''}</div>
                      {r.note && <div className="tiny muted">{r.note}</div>}
                    </td>
                    <td className="small">
                      {r.plan?.blocked
                        ? <span className="warn-text"><Icon name="block" size={13} /> {r.plan.blocked}</span>
                        : r.plan?.done ?? r.plan?.will}
                    </td>
                    <td className="tiny muted">{dateTime(r.marked_at)}{r.marked_by_name ? ` by ${r.marked_by_name}` : ''}</td>
                    <td><button className="btn-ghost btn-sm" onClick={() => unmark(r)}>Unmark</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {retired.length > 0 && (
        <details className="card" style={{ padding: '10px 14px' }}>
          <summary className="small">{retired.length} retired</summary>
          <div className="stack" style={{ gap: 6, marginTop: 10 }}>
            {retired.map((r) => (
              <div key={r.id} className="small">
                <strong>{r.kind_label} {r.record_id}</strong> {r.current_label ?? r.label} — {r.outcome}
                <span className="tiny muted"> · {dateTime(r.retired_at)}{r.retired_by_name ? ` by ${r.retired_by_name}` : ''}: {r.retire_reason}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {retiring && (
        <RetireAll count={ready.length} blocked={open.length - ready.length} onClose={() => setRetiring(false)}
          onDone={(out) => {
            setRetiring(false);
            const did = out.results.filter((x) => x.outcome).length;
            const skipped = out.results.filter((x) => x.skipped).length;
            setDone(`Retired ${did} test record${did === 1 ? '' : 's'}${skipped ? `; ${skipped} left as they were, each saying why` : ''}.`);
            reload();
          }} />
      )}
    </div>
  );
}

/** One reason for the lot; each record still goes through its own lifecycle. */
function RetireAll({ count, blocked, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/admin/test-records/retire', { reason })); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title={`Retire ${count} test record${count === 1 ? '' : 's'}`} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <ErrorBanner error={error} />
        <p className="small">
          Each is taken out of use as the list says. Nothing is deleted.
          {blocked ? ` ${blocked} cannot be retired yet and are left as they are.` : ''}
        </p>
        <div className="field">
          <label htmlFor="tr-reason">Why</label>
          <input id="tr-reason" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Round 4 audit finished; evidence preserved" autoFocus />
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy || reason.trim().length < 5}>{busy ? 'Retiring…' : 'Retire'}</button>
        </div>
      </form>
    </Modal>
  );
}
