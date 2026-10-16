/**
 * Lead Import — the guided flow (P3-33, P3-34).
 *
 * "This must not be a basic feature." The paste box it replaces asked for a
 * spreadsheet already shaped like our database, which is not what anybody has:
 * a file exported from the old system says "Mobile No" and "City/Town", carries
 * thirty columns when we want nine, and contains rows that will not import for
 * reasons worth reading before four thousand of them are attempted.
 *
 * So: choose the file, say what its columns mean, decide what happens to people
 * already in the CRM, look at what would happen, and only then do it.
 *
 * THE PREVIEW IS THE SAME CODE AS THE IMPORT
 * ------------------------------------------
 * Step 3 shows counts and failures from the server's own dry run, not from a
 * second, more forgiving implementation in the browser. A preview that is
 * kinder than the import is worse than no preview, because it is believed.
 */

import { useMemo, useState } from 'react';
import { api, dmy, dmyTime, istToday } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Spinner } from '../components/ui.jsx';

/* ------------------------------------------------------------ CSV parsing */

/**
 * Minimal CSV: quoted fields with embedded commas and doubled quotes.
 *
 * Parsed here rather than on the server so the mapping step can show the file's
 * real headers and a few real rows. Somebody mapping "Column 4" to Mobile
 * should be able to see that column 4 holds phone numbers.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { if (row.length) rows.push(row); row = []; };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') pushCell();
    else if (c === '\r') { /* handled with the \n */ }
    else if (c === '\n') { pushCell(); pushRow(); }
    else cell += c;
  }
  pushCell();
  pushRow();

  const nonEmpty = rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  const [header = [], ...body] = nonEmpty;
  return { header: header.map((h) => h.trim()), rows: body };
}

/**
 * Match the file's columns to CRM fields, so the common case needs no thought.
 *
 * In passes, strongest evidence first: an exact name, then a column that starts
 * with one, then a column that ends with one. The order matters. "Full Name"
 * and "Company Name" both end in "name", and running suffixes early would let
 * whichever came first in the file take the field from a column actually called
 * Name.
 *
 * Every guess is shown with two real values from that column and can be changed,
 * so this only has to be right often enough to save typing — never trusted.
 */
function guessMapping(header, fields) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const out = {};
  const taken = new Set();

  const passes = [
    (c, k, l) => c === k || c === l,
    (c, k, l) => c.startsWith(k) || c.startsWith(l),
    (c, k, l) => c.endsWith(k) || c.endsWith(l),
  ];

  for (const matches of passes) {
    for (const column of header) {
      if (out[column]) continue;
      const c = norm(column);
      if (!c) continue;

      const hit = fields.find((f) => !taken.has(f.key) && matches(c, norm(f.key), norm(f.label)));
      if (hit) { out[column] = hit.key; taken.add(hit.key); }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ steps */

const STEPS = [
  { n: 1, title: 'Import your file', blurb: 'A .csv with a header row. Nothing is written yet.' },
  { n: 2, title: 'Map the fields', blurb: 'Say what each column in your file means. Anything you leave unmapped is ignored.' },
  { n: 3, title: 'Choose what happens', blurb: 'What to do about people already in the CRM, and where the new leads should go.' },
  { n: 4, title: 'Check and import', blurb: 'What would happen, row by row, before anything does — and what to do about values your lists do not hold.' },
];

function Steps({ at }) {
  return (
    <ol className="steps">
      {STEPS.map((s) => (
        <li key={s.n} className={s.n === at ? 'is-now' : s.n < at ? 'is-done' : ''}>
          <span className="steps-n">{s.n < at ? <Icon name="check" size={14} /> : s.n}</span>
          <span>
            <strong>{s.title}</strong>
            <em>{s.blurb}</em>
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ screen */

export default function LeadImport({ session }) {
  const [meta] = useApi('/leads/import/fields');
  const [runs, { reload: reloadRuns }] = useApi('/leads/import/runs');

  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  /* Null until the server says what the modes are. It sends them with their
     labels and explanations, so naming one here would be the client holding a
     second, quieter copy of a server enum. */
  const [mode, setMode] = useState(null);
  const [listName, setListName] = useState('');
  const [preview, setPreview] = useState(null);
  /* What each value the lists do not hold becomes: `{ source: { Self: 'DKYC
     Portal' } }`. An empty string is a real answer — leave the column blank —
     so "decided" is about the key being present, never about it being truthy. */
  const [valueMap, setValueMap] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fields = meta?.fields ?? [];
  /* The first mode the server lists is the default. It is the conservative one
     -- create only, skipping anybody already here -- and an import that does
     the least by default is the right way round. */
  const chosenMode = mode ?? meta?.modes?.[0]?.key ?? null;

  const mappedTo = useMemo(() => {
    const out = new Map();
    for (const [column, field] of Object.entries(mapping)) if (field) out.set(field, column);
    return out;
  }, [mapping]);

  const nameMapped = mappedTo.has('name');

  const take = async (chosen) => {
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      const text = await chosen.text();
      const read = parseCsv(text);
      if (!read.header.length) throw new Error('That file has no header row.');
      if (!read.rows.length) throw new Error('That file has a header but no rows.');

      setFile(chosen);
      setParsed(read);
      setMapping(guessMapping(read.header, fields));
      setStep(2);
    } catch (err) {
      setError(err.message);
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.post('/leads/import/preview', {
        header: parsed.header, rows: parsed.rows, mapping, mode: chosenMode, value_map: valueMap,
      }));
      setStep(4);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.post('/leads/import/run', {
        header: parsed.header,
        rows: parsed.rows,
        mapping,
        mode: chosenMode,
        filename: file?.name ?? null,
        list_name: listName.trim() || null,
        value_map: valueMap,
      });
      setResult(out);
      reloadRuns();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const restart = () => {
    setStep(1); setFile(null); setParsed(null); setMapping({});
    setMode(null); setListName(''); setPreview(null); setResult(null); setError(null);
    setValueMap({});
  };

  if (!session.permissions.includes('lead.create')) {
    return <Empty>You do not have permission to import leads.</Empty>;
  }
  if (!meta) return <Loading label="Loading the import…" />;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div>
        <h1>Import leads</h1>
        <p className="muted">
          From a spreadsheet, in four steps. Nothing is written until the last one.
        </p>
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <div className="grid grid-2" style={{ alignItems: 'start', gap: 14 }}>
        <section className="card">
          <div className="card-head">
            <h2>{STEPS[step - 1].title}</h2>
            {step > 1 && !result && (
              <button className="btn-sm" onClick={restart}>Start again</button>
            )}
          </div>

          <div className="card-body stack" style={{ gap: 14 }}>
            {/* ---------------------------------------------------- step 1 */}
            {step === 1 && (
              <>
                <p className="muted">
                  Choose a <strong>.csv</strong> file with a header row naming its columns. Up to{' '}
                  {meta.max_rows.toLocaleString('en-IN')} rows. You will be shown what would happen before
                  anything is saved.
                </p>
                <label className="filedrop">
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) take(f); }}
                  />
                  <Icon name="upload" size={17} />
                  <span>Choose a .csv file</span>
                </label>
                <p className="hint">
                  Not sure of the format? <button className="linkish" onClick={sampleDownload}>Download a sample</button>
                </p>
              </>
            )}

            {/* ---------------------------------------------------- step 2 */}
            {step === 2 && parsed && (
              <>
                <p className="muted">
                  {parsed.rows.length.toLocaleString('en-IN')} rows in <strong>{file?.name}</strong>.
                  Each column below was matched to a CRM field where the name was close enough — change
                  anything that is wrong, and set the rest to <em>Ignore</em>.
                </p>

                <div className="maprows">
                  {parsed.header.map((column, i) => (
                    <div className="maprow" key={column + i}>
                      <div>
                        <strong>{column || <em className="muted">(unnamed column)</em>}</strong>
                        <div className="tiny muted mono">
                          {parsed.rows.slice(0, 2).map((r) => r[i]).filter(Boolean).join(' · ') || '—'}
                        </div>
                      </div>
                      <select
                        value={mapping[column] ?? ''}
                        onChange={(e) => setMapping({ ...mapping, [column]: e.target.value || undefined })}
                      >
                        <option value="">Ignore this column</option>
                        {fields.map((f) => (
                          <option
                            key={f.key}
                            value={f.key}
                            disabled={mappedTo.has(f.key) && mappedTo.get(f.key) !== column}
                          >
                            {f.label}{f.required ? ' (required)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>

                {!nameMapped && (
                  <div className="notice notice-warn">
                    <Icon name="info" size={16} />
                    <span>Map one column to <strong>Name</strong> — a lead cannot be saved without it.</span>
                  </div>
                )}

                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn-primary" disabled={!nameMapped} onClick={() => setStep(3)}>
                    Continue
                  </button>
                </div>
              </>
            )}

            {/* ---------------------------------------------------- step 3 */}
            {step === 3 && (
              <>
                <p className="muted">
                  Rows are matched to leads you already have on <strong>{meta.match_on}</strong>, within
                  your own business only.
                </p>

                <div className="stack" style={{ gap: 8 }}>
                  {meta.modes.map((m) => (
                    <label key={m.key} className={`pick-row ${chosenMode === m.key ? 'is-chosen' : ''}`}>
                      <input type="radio" name="mode" checked={chosenMode === m.key} onChange={() => setMode(m.key)} />
                      <span>
                        <strong>{m.label}</strong>
                        <div className="tiny muted">{m.note}</div>
                      </span>
                    </label>
                  ))}
                </div>

                <div className="field">
                  <label>Put these leads in a new list (optional)</label>
                  <input
                    value={listName}
                    onChange={(e) => setListName(e.target.value)}
                    placeholder={`Imported ${dmy(istToday())}`}
                  />
                  <p className="hint">Leave blank and the leads go into your book without a list.</p>
                </div>

                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <button onClick={() => setStep(2)}>Back</button>
                  <button className="btn-primary" disabled={busy} onClick={runPreview}>
                    {busy ? <Spinner /> : 'Check the file'}
                  </button>
                </div>
              </>
            )}

            {/* ---------------------------------------------------- step 4 */}
            {step === 4 && preview && !result && (
              <>
                <Summary report={preview} />
                {preview.unmapped?.length > 0 && (
                  <p className="hint">
                    Ignoring {preview.unmapped.length} unmapped column
                    {preview.unmapped.length === 1 ? '' : 's'}: {preview.unmapped.join(', ')}.
                  </p>
                )}
                <Strays
                  unknown={preview.unknown_values}
                  choices={preview.choices ?? meta.choices}
                  fields={meta.fields}
                  valueMap={valueMap}
                  onDecide={(column, value, becomes) => setValueMap((prev) => ({
                    ...prev,
                    [column]: { ...(prev[column] ?? {}), [value]: becomes },
                  }))}
                  onRecheck={runPreview}
                  busy={busy}
                />

                <Failures rows={preview.failures} truncated={preview.truncated} />

                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <button onClick={() => setStep(3)}>Back</button>
                  <button
                    className="btn-primary"
                    disabled={busy || (preview.created + preview.updated === 0) || undecided(preview, valueMap) > 0}
                    onClick={commit}
                  >
                    {busy ? <Spinner /> : `Import ${(preview.created + preview.updated).toLocaleString('en-IN')} leads`}
                  </button>
                </div>
              </>
            )}

            {/* ------------------------------------------------- the result */}
            {result && (
              <>
                <div className="notice">
                  <Icon name="check" size={16} />
                  <span>
                    Imported from <strong>{file?.name}</strong>.
                    {result.list_id ? ' The leads are in the new list.' : ''}
                  </span>
                </div>
                <Summary report={result} />
                <Failures rows={result.failures} truncated={result.truncated} />
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn-primary" onClick={restart}>Import another file</button>
                </div>
              </>
            )}
          </div>
        </section>

        <div className="stack" style={{ gap: 14 }}>
          <section className="card">
            <div className="card-head"><h2>Steps</h2></div>
            <div className="card-body"><Steps at={result ? 4 : step} /></div>
          </section>

          <PastRuns runs={runs?.runs ?? []} />
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- pieces */

/**
 * How many values still have no answer.
 *
 * Counted from the preview rather than tracked as the user clicks, so it cannot
 * drift from what the server will refuse. A value is decided when the map has a
 * key for it — an empty string means "leave the column blank", which is a real
 * decision and not an absent one.
 */
function undecided(preview, valueMap) {
  return Object.entries(preview.unknown_values ?? {}).reduce(
    (n, [column, list]) => n + list.filter(
      (u) => !Object.prototype.hasOwnProperty.call(valueMap[column] ?? {}, u.value),
    ).length,
    0,
  );
}

/**
 * The values this file carries that the lists do not hold.
 *
 * An import is a writer like any other, so Setup's picklist decides what it may
 * store (OPS-14). Refusing the file would be no use on the data this exists
 * for — the legacy export carries nineteen sources, most of them not on the new
 * list — so every stray value gets a decision instead: become one that is on
 * the list, or leave the column empty. Nothing is imported until each has one.
 *
 * Commonest first, with the row count beside it, because "this one is 41,000
 * rows" is the thing that decides how much care it deserves.
 */
function Strays({ unknown, choices, fields, valueMap, onDecide, onRecheck, busy }) {
  const columns = Object.entries(unknown ?? {});
  if (!columns.length) return null;

  const label = (key) => fields.find((f) => f.key === key)?.label ?? key;

  return (
    <div className="notice" style={{ display: 'block' }}>
      <p>
        <strong>Some values in this file are not on their list.</strong> Say what each one
        becomes. Nothing is imported until they all have an answer.
      </p>

      {columns.map(([column, list]) => (
        <div key={column} style={{ marginTop: 10 }}>
          <strong className="small">{label(column)}</strong>
          <table className="field-table compact">
            <thead>
              <tr><th>In your file</th><th className="num">Rows</th><th>Becomes</th></tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.value}>
                  <td><code>{u.value || '(blank)'}</code></td>
                  <td className="num">{u.rows.toLocaleString('en-IN')}</td>
                  <td>
                    <select
                      value={valueMap[column]?.[u.value] ?? '\u0000'}
                      onChange={(e) => onDecide(column, u.value, e.target.value === '\u0000' ? undefined : e.target.value)}
                      aria-label={`What "${u.value}" becomes`}
                    >
                      <option value={'\u0000'}>Choose…</option>
                      <option value="">Leave it blank</option>
                      {(choices?.[column] ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <p className="tiny">
        A value missing from a list is added in Setup → Objects, under that field&rsquo;s values.
        Add it there and check the file again.
      </p>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={onRecheck}>
        Check the file again
      </button>
    </div>
  );
}

function Summary({ report }) {
  const cells = [
    { label: 'Rows read', value: report.total },
    { label: 'To create', value: report.created, tone: 'good' },
    { label: 'To update', value: report.updated, tone: 'good' },
    { label: 'Skipped', value: report.skipped },
    { label: 'Failed', value: report.failed, tone: report.failed ? 'bad' : null },
  ];
  return (
    <div className="importsum">
      {cells.map((c) => (
        <div key={c.label} className={`importsum-cell ${c.tone ? `is-${c.tone}` : ''}`}>
          <strong>{Number(c.value ?? 0).toLocaleString('en-IN')}</strong>
          <span>{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The rows that will not import, and why (P3-34).
 *
 * Row numbers are the file's own, so somebody can open the spreadsheet and go
 * to the line rather than counting.
 */
function Failures({ rows, truncated }) {
  if (!rows?.length) return null;
  return (
    <div>
      <h4 className="muted">Rows that will not import</h4>
      <div className="table-scroll" style={{ maxHeight: 260 }}>
        <table className="table">
          <thead><tr><th>Row</th><th>Why</th></tr></thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.row ?? f.row_no}>
                <td className="num mono">{f.row ?? f.row_no}</td>
                <td>{f.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && <p className="hint">Only the first 1,000 problems are listed.</p>}
    </div>
  );
}

/** P3-34: the summary is retrievable after the fact, not only on completion. */
function PastRuns({ runs }) {
  const [open, setOpen] = useState(null);
  const [detail] = useApi(open ? `/leads/import/runs/${open}` : null);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Earlier imports</h2>
        <span className="tiny muted">The result of an import is kept</span>
      </div>
      <div className="card-body">
        {!runs.length ? <Empty>No imports yet.</Empty> : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>File</th><th className="num">Created</th><th className="num">Updated</th><th className="num">Failed</th><th /></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.filename || <em className="muted">unnamed</em>}
                      <div className="tiny muted">{dmyTime(r.created_at)} · {r.user_name}</div>
                    </td>
                    <td className="num">{r.created}</td>
                    <td className="num">{r.updated}</td>
                    <td className="num">{r.failed}</td>
                    <td className="num">
                      {r.failed > 0 && (
                        <button className="btn-sm" onClick={() => setOpen(open === r.id ? null : r.id)}>
                          {open === r.id ? 'Hide' : 'Why'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {open && detail && (
          <div style={{ marginTop: 12 }}>
            <Failures rows={detail.failures} truncated={detail.truncated} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The sample, from the server, so it matches what the importer accepts. */
async function sampleDownload() {
  const blob = await api.blob('/leads/import/sample');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lead-import-sample.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
