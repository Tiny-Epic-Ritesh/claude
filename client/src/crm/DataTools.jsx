/**
 * Data tools — lead import and the recycle bin.
 *
 * Grouped because they are the two places a user changes many records at once,
 * and both are therefore built around the same idea: show what will happen
 * before it happens, and make the reversal obvious.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Tabs, Spinner, Icon } from '../components/ui.jsx';
import { dateTime } from '../api.js';

/* ---------------------------------------------------------------- import */

const SAMPLE = `name,mobile,email,city,source
Rohan Kulkarni,9812345670,rohan.k@example.in,Pune,Website
Meera Iyer,9812345671,meera.i@example.in,Chennai,Referral
Arjun Nair,9812345672,arjun.n@example.in,Kochi,Campaign`;

const COLUMNS = ['name', 'mobile', 'email', 'city', 'source'];

/**
 * Minimal CSV parse — quoted fields with embedded commas, nothing more.
 *
 * Parsing on the client is deliberate: the user sees exactly which columns were
 * recognised and what landed in each field before anything is sent. A silent
 * server-side parse is where "why is every name in the email column?" comes from.
 */
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return { header: [], rows: [], unknown: [], error: lines.length ? 'Only a header row — no data to import.' : null };
  }

  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };

  const header = split(lines[0]).map((h) => h.toLowerCase());
  const unknown = header.filter((h) => h && !COLUMNS.includes(h));

  const rows = lines.slice(1).map((line, i) => {
    const cells = split(line);
    const row = { _line: i + 2 };
    header.forEach((h, idx) => { if (COLUMNS.includes(h)) row[h] = cells[idx] ?? ''; });
    return row;
  });

  return { header, rows, unknown, error: header.includes('name') ? null : 'No "name" column found in the header row.' };
}

/**
 * Lead import.
 *
 * The dry run is not optional politeness — it is the whole design. An import
 * that silently creates four hundred half-valid leads costs far more to undo
 * than to prevent, so nothing is written until the user has seen a per-row
 * verdict and pressed a second, differently-labelled button.
 */
function Import() {
  const [text, setText] = useState('');
  const [report, setReport] = useState(null);
  const [committed, setCommitted] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const parsed = text.trim() ? parseCsv(text) : null;

  const run = async (commit) => {
    setBusy(true);
    setError(null);
    try {
      // Strip the display-only line number before sending.
      const rows = parsed.rows.map(({ _line, ...r }) => r);
      const res = await api.post('/leads/import', { rows, commit });
      if (commit) { setCommitted(res); setReport(null); } else { setReport(res); setCommitted(null); }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // The API reports problems by 1-based row index. Map them back onto the parsed
  // rows so each line carries its own verdict, rather than making the user
  // cross-reference two lists.
  const [fileName, setFileName] = useState(null);
  const [sampling, setSampling] = useState(false);

  /* Fetched rather than built from the SAMPLE constant above: the server
     generates it from the same column list the importer validates against, so
     the file somebody follows cannot describe an importer we no longer have. */
  const downloadSample = async () => {
    setSampling(true);
    try {
      const blob = await api.blob('/leads/import/sample');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lead-import-sample.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setSampling(false);
    }
  };

  const verdicts = new Map();
  if (report) {
    for (const d of report.duplicates) verdicts.set(d.row, { kind: 'duplicate', text: 'already in the CRM' });
    for (const iv of report.invalid) verdicts.set(iv.row, { kind: 'invalid', text: iv.reason });
  }

  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-head">
          <h2>Import leads</h2>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn-sm" onClick={downloadSample} disabled={sampling}>
              {sampling ? <Spinner /> : 'Sample .csv'}
            </button>
            <button className="btn-sm" onClick={() => { setText(SAMPLE); setReport(null); setCommitted(null); }}>
              Use sample
            </button>
          </div>
        </div>
        <div style={{ padding: 14 }}>
          {/* P3-41. The file goes through the same parse as a paste, so the
              preview below is what was actually read out of it rather than a
              promise about what the server will find. */}
          <label className="filedrop">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFileName(file.name);
                setReport(null);
                setCommitted(null);
                setText(await file.text());
                e.target.value = '';        // so the same file can be chosen twice
              }}
            />
            <Icon name="upload" size={17} />
            <span>{fileName ? `${fileName} — choose another` : 'Choose a .csv file'}</span>
          </label>

          <p className="tiny muted" style={{ margin: '8px 0 10px' }}>
            Accepted format: <strong>.csv</strong>, with a header row naming the columns.
            You can also paste the rows below.
          </p>

          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setReport(null); setCommitted(null); }}
            rows={13}
            spellCheck={false}
            placeholder={SAMPLE}
            style={{ width: '100%', fontFamily: 'var(--mono, monospace)', fontSize: 12.5 }}
          />

          <p className="tiny muted" style={{ marginTop: 8 }}>
            First row is the header. <code>name</code> is required and <code>mobile</code> must be a valid Indian
            number when present. <code>email</code>, <code>city</code> and <code>source</code> are optional. Imported
            leads are assigned to you and receive a card for every active product.
          </p>

          {parsed?.error && <ErrorBanner error={parsed.error} />}
          {parsed?.unknown?.length > 0 && (
            <div className="notice" style={{ marginTop: 8 }}>
              Ignoring unrecognised column{parsed.unknown.length === 1 ? '' : 's'}: <strong>{parsed.unknown.join(', ')}</strong>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" disabled={!parsed || Boolean(parsed.error) || busy} onClick={() => run(false)}>
              {busy ? <Spinner /> : null} Check without importing
            </button>
            <button
              className="btn-primary"
              disabled={!report || report.valid === 0 || busy}
              onClick={() => run(true)}
              title={!report ? 'Run the check first' : undefined}
            >
              Import {report?.valid > 0 ? `${report.valid} row${report.valid === 1 ? '' : 's'}` : ''}
            </button>
          </div>
          {error && <ErrorBanner error={error} />}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>{committed ? 'Imported' : 'Preview'}</h2>
          {report && (
            <span className="tiny muted">
              {report.valid} of {report.total} will import
              {report.duplicates.length ? ` · ${report.duplicates.length} duplicate` : ''}
              {report.invalid.length ? ` · ${report.invalid.length} invalid` : ''}
            </span>
          )}
        </div>

        {committed && (
          <div className="notice" style={{ margin: 14 }}>
            <strong>{committed.imported} lead{committed.imported === 1 ? '' : 's'} created.</strong>
            {' '}
            {committed.duplicates.length || committed.invalid.length
              ? `${committed.duplicates.length} duplicate and ${committed.invalid.length} invalid row(s) were skipped.`
              : 'Every row was valid.'}
            {' '}Anything imported by mistake can be deleted and recovered from the recycle bin.
          </div>
        )}

        {!report && !committed && <Empty>Paste a CSV and run the check to see what would happen.</Empty>}

        {report && parsed && (
          <table>
            <thead><tr><th className="num">Line</th><th>Name</th><th>Mobile</th><th>Verdict</th></tr></thead>
            <tbody>
              {parsed.rows.map((r, i) => {
                const v = verdicts.get(i + 1);
                return (
                  <tr key={r._line}>
                    <td className="num tiny muted">{r._line}</td>
                    <td className="small">{r.name || <span className="muted">—</span>}</td>
                    <td className="small num">{r.mobile || <span className="muted">—</span>}</td>
                    <td>
                      {!v && <span className="badge badge-green">will import</span>}
                      {v?.kind === 'duplicate' && <span className="badge badge-amber">{v.text}</span>}
                      {v?.kind === 'invalid' && <span className="badge badge-red">{v.text}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* ----------------------------------------------------------- recycle bin */

/**
 * Recycle bin.
 *
 * Deletion in this system is a soft delete (BRD: a lead is never destroyed by a
 * user action), so this is the other half of that promise — visible, and one
 * click from reversal.
 */
function RecycleBin() {
  const [rows, { loading, error, reload }] = useApi('/recycle-bin');
  const [busy, setBusy] = useState(null);

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;
  if (!rows?.length) return <Empty>The recycle bin is empty.</Empty>;

  const restore = async (id) => {
    setBusy(id);
    try { await api.post(`/leads/${id}/restore`); reload(); } finally { setBusy(null); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Recycle bin</h2>
        <span className="tiny muted">{rows.length} deleted lead{rows.length === 1 ? '' : 's'}</span>
      </div>
      <table>
        <thead><tr><th>Lead</th><th>City</th><th>Source</th><th>Deleted</th><th /></tr></thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              <td style={{ fontWeight: 545 }}>{l.name}<div className="tiny muted">{l.mobile}</div></td>
              <td className="small muted">{l.city || '—'}</td>
              <td className="small muted">{l.source || '—'}</td>
              <td className="tiny muted num">{dateTime(l.deleted_at)}</td>
              <td className="num">
                <button className="btn-sm" disabled={busy === l.id} onClick={() => restore(l.id)}>
                  {busy === l.id ? <Spinner /> : 'Restore'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny muted" style={{ padding: '10px 14px', margin: 0 }}>
        Deleting a lead hides it from every list but destroys nothing — the record, its cards, its activity history and
        its tickets all survive, and restoring puts them all back. Permanent erasure is a separate, audited process for
        a data-subject request, not something a user does by clicking Delete.
      </p>
    </section>
  );
}

/* ----------------------------------------------------------------- page */

export default function DataTools({ session }) {
  const has = (p) => session.permissions.includes(p);
  const tabs = [
    has('lead.create') && { key: 'import', label: 'Import leads' },
    has('lead.delete') && { key: 'recycle', label: 'Recycle bin' },
  ].filter(Boolean);

  const [tab, setTab] = useState(tabs[0]?.key);

  if (!tabs.length) return <Empty>You do not have access to the data tools.</Empty>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Data tools</h1>
          <p>Bulk changes, shown before they happen and reversible after.</p>
        </div>
      </div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'import' && <Import />}
      {tab === 'recycle' && <RecycleBin />}
    </>
  );
}
