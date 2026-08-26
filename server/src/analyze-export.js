/**
 * Turn a LeadSquared CSV export into the five aggregates the migration map needs.
 *
 *   node src/analyze-export.js path/to/leads-export.csv
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/migration-map.md` carries a dozen decisions marked NEEDS DATA — how full
 * each field is, what values a picklist really holds, how many leads use client
 * code 5. Those cannot be answered from the audit, only from the data.
 *
 * The obvious route is to export and eyeball it in Excel. At 495,118 rows and
 * ~330 columns that is not a spreadsheet, and the manual version of this is
 * where "we think that field is mostly empty" comes from.
 *
 * PII GOES IN, IT DOES NOT COME OUT
 * ---------------------------------
 * This is the important property. The export contains every client's name, PAN,
 * mobile and email. This script streams it, counts, and writes **only
 * aggregates** — fill rates, distinct counts, and value lists for fields that
 * are demonstrably categorical.
 *
 * Two guards make that true rather than aspirational:
 *
 *   1. A field is only allowed to have its values listed if it looks like a
 *      picklist: few distinct values relative to the row count. A field with
 *      400,000 distinct values is a name or a phone number and only ever gets a
 *      count.
 *   2. Anything whose column name matches a known-identifier pattern is
 *      hard-blocked from value listing regardless of how it distributes — a
 *      tenant where every lead shares one of ten test PANs must not leak them.
 *
 * The output is safe to attach to a ticket, paste into chat, or commit. The
 * input is not, and should be deleted once this has run.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

/* --------------------------------------------------------------- guards */

/**
 * Columns that must never have their values printed, whatever they look like.
 *
 * Matched loosely on purpose: `mx_PAN_Number`, `PAN`, `pan_number` and
 * `mx_Client_PAN` should all be caught by one rule rather than three.
 */
const IDENTIFIER_PATTERNS = [
  /pan/i, /aadhaar|aadhar/i, /mobile|phone|contact.*number/i, /email/i,
  /name/i, /address|street|zip|pincode/i, /account.*number|bank/i,
  /client.*code|boid|dp.*id/i, /dob|date.*of.*birth/i, /ip.*address/i,
  /url|referrer/i, /note|remark|comment|description/i, /father|spouse/i,
];

const isIdentifier = (col) => IDENTIFIER_PATTERNS.some((re) => re.test(col));

/**
 * A field earns a value listing only if it behaves like a picklist.
 *
 * Both conditions must hold: few enough distinct values to be a controlled
 * list, and few enough relative to the rows that it is not simply a sparse
 * free-text field in a small sample.
 */
const MAX_DISTINCT_TO_LIST = 60;
const MAX_DISTINCT_RATIO = 0.05;

/* ----------------------------------------------------------- CSV parsing */

/**
 * A minimal RFC-4180 line splitter.
 *
 * LeadSquared exports quote fields containing commas and escape quotes by
 * doubling them. Splitting on commas alone corrupts every note field and
 * silently shifts columns for the rest of the row, which is worse than failing.
 */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* ---------------------------------------------------------------- main */

const file = process.argv[2];
if (!file) {
  console.error(`
Usage:  node src/analyze-export.js <leads-export.csv>

Produces migration-data-quality.md — aggregates only, no client data.
Delete the CSV once this has run.
`);
  process.exit(1);
}

const stats = new Map();   // column -> { filled, values: Map, distinctOverflow }
let header = null;
let rows = 0;
let malformed = 0;

const rl = createInterface({
  input: createReadStream(file, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

console.log(`Reading ${basename(file)}…`);

for await (const line of rl) {
  if (!line.trim()) continue;

  const cells = splitCsvLine(line);

  if (!header) {
    header = cells.map((h) => h.trim().replace(/^﻿/, ''));
    for (const h of header) {
      stats.set(h, { filled: 0, values: new Map(), distinctOverflow: false });
    }
    console.log(`  ${header.length} columns`);
    continue;
  }

  // A row with the wrong column count means the CSV parse has drifted. Count
  // it and carry on rather than silently attributing values to wrong fields.
  if (cells.length !== header.length) { malformed += 1; continue; }

  rows += 1;
  for (let i = 0; i < header.length; i += 1) {
    const col = header[i];
    const raw = (cells[i] ?? '').trim();
    if (!raw) continue;

    const s = stats.get(col);
    s.filled += 1;

    // Stop tracking distinct values once a field is obviously not a picklist.
    // Without this, a 495k-row export builds a 495k-entry map per free-text
    // column and exhausts memory long before it finishes.
    if (s.distinctOverflow) continue;
    if (s.values.size > 5000) { s.distinctOverflow = true; s.values.clear(); continue; }
    s.values.set(raw, (s.values.get(raw) ?? 0) + 1);
  }

  if (rows % 50_000 === 0) console.log(`  ${rows.toLocaleString('en-IN')} rows…`);
}

if (!header) {
  console.error('That file has no header row. Is it a CSV export?');
  process.exit(1);
}

/* --------------------------------------------------------------- report */

const pct = (n) => (rows ? Math.round((n / rows) * 1000) / 10 : 0);

const fields = header.map((col) => {
  const s = stats.get(col);
  const distinct = s.distinctOverflow ? null : s.values.size;

  const listable =
    distinct !== null
    && distinct > 0
    && distinct <= MAX_DISTINCT_TO_LIST
    && distinct / Math.max(rows, 1) <= MAX_DISTINCT_RATIO
    && !isIdentifier(col);

  return {
    col,
    filled: s.filled,
    fill: pct(s.filled),
    distinct,
    listable,
    top: listable
      ? [...s.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      : null,
  };
});

const empty = fields.filter((f) => f.filled === 0);
const nearlyEmpty = fields.filter((f) => f.filled > 0 && f.fill < 1);
const picklists = fields.filter((f) => f.listable);

const md = [];
md.push('# LeadSquared data quality — migration input\n');
md.push(`Generated from \`${basename(file)}\` · **${rows.toLocaleString('en-IN')} rows** · ${header.length} columns`);
if (malformed) md.push(`\n> ${malformed} rows were skipped as malformed (column count did not match the header).`);
md.push(`
**This file contains aggregates only.** Value lists appear only for fields that
behave like controlled lists — at most ${MAX_DISTINCT_TO_LIST} distinct values and under
${MAX_DISTINCT_RATIO * 100}% of the row count — and never for a column whose name suggests it holds an
identifier. Free text, names, PANs, phone numbers and emails are counted, never listed.
`);

/* 1 — the fields that can simply be dropped */
md.push('\n## 1 · Empty and near-empty fields\n');
md.push(`**${empty.length} fields are empty on every row** and **${nearlyEmpty.length} more are under 1% full.** `);
md.push('Each of these needs one decision: is it dead, or is it rare-but-required?\n');
md.push('### Completely empty\n');
md.push(empty.length ? empty.map((f) => `- \`${f.col}\``).join('\n') : '_None._');
md.push('\n### Under 1% full\n');
md.push(nearlyEmpty.length
  ? ['| Field | Filled | % |', '|---|---:|---:|',
    ...nearlyEmpty.sort((a, b) => a.filled - b.filled)
      .map((f) => `| \`${f.col}\` | ${f.filled} | ${f.fill}% |`)].join('\n')
  : '_None._');

/* 2 — the picklists, which is what the disposition matrix needs */
md.push('\n\n## 2 · Controlled-list fields and their values\n');
md.push(`${picklists.length} fields behave like picklists. These drive the disposition matrix, `);
md.push('the stage model and every cascading list in Setup.\n');
for (const f of picklists.sort((a, b) => b.filled - a.filled)) {
  md.push(`\n### \`${f.col}\`\n`);
  md.push(`${f.filled.toLocaleString('en-IN')} filled (${f.fill}%) · ${f.distinct} distinct\n`);
  md.push('| Value | Count | Share |');
  md.push('|---|---:|---:|');
  for (const [v, n] of f.top) {
    md.push(`| ${String(v).replace(/\|/g, '\\|').slice(0, 80)} | ${n.toLocaleString('en-IN')} | ${pct(n)}% |`);
  }
  if (f.distinct > f.top.length) md.push(`\n_…and ${f.distinct - f.top.length} more values._`);
}

/* 3 — everything, ranked, so the long tail is visible */
md.push('\n\n## 3 · Every field by fill rate\n');
md.push('| Field | Filled | % | Distinct |');
md.push('|---|---:|---:|---:|');
for (const f of [...fields].sort((a, b) => b.fill - a.fill)) {
  md.push(`| \`${f.col}\` | ${f.filled.toLocaleString('en-IN')} | ${f.fill}% | ${f.distinct ?? '>5000'} |`);
}

/* 4 — the specific questions the migration map asked */
md.push('\n\n## 4 · Answers to the migration map\n');

const clientCodes = fields.filter((f) => /client_?code/i.test(f.col));
if (clientCodes.length) {
  md.push('\n### Client codes — how many are really used?\n');
  md.push('| Field | Filled | % |');
  md.push('|---|---:|---:|');
  for (const f of clientCodes) md.push(`| \`${f.col}\` | ${f.filled.toLocaleString('en-IN')} | ${f.fill}% |`);
  md.push('\n_If `_4` through `_6` are near zero, the child table proposed in the migration map is over-engineering and two columns will do._');
}

const consent = fields.filter((f) => /donot|do_not|optin|opt_in|mailingpref|consent/i.test(f.col));
if (consent.length) {
  md.push('\n### Consent — the highest-risk group\n');
  md.push('| Field | Filled | % | Distinct |');
  md.push('|---|---:|---:|---:|');
  for (const f of consent) md.push(`| \`${f.col}\` | ${f.filled.toLocaleString('en-IN')} | ${f.fill}% | ${f.distinct ?? '>5000'} |`);
  md.push('\n_Per-channel consent is already built. These counts say how many leads carry each withdrawal, which is what the reconciliation step checks against after load._');
}

const dispositions = fields.filter((f) => /disposition|lead_status|lead_type|reason/i.test(f.col));
if (dispositions.length) {
  md.push('\n### Dispositions — the matrix has 22 entries\n');
  md.push('| Field | Filled | % | Distinct |');
  md.push('|---|---:|---:|---:|');
  for (const f of dispositions) md.push(`| \`${f.col}\` | ${f.filled.toLocaleString('en-IN')} | ${f.fill}% | ${f.distinct ?? '>5000'} |`);
  md.push('\n_Any distinct count well above 22 means the matrix needs extending or those values need an explicit mapping. Unmapped outcomes make the follow-up engine silently do nothing._');
}

const out = 'migration-data-quality.md';
writeFileSync(out, md.join('\n'), 'utf8');

console.log(`
Done.

  rows read        ${rows.toLocaleString('en-IN')}
  columns          ${header.length}
  empty fields     ${empty.length}
  under 1% full    ${nearlyEmpty.length}
  picklist-shaped  ${picklists.length}${malformed ? `\n  malformed rows   ${malformed}` : ''}

  written to       ${out}

That file contains no client data and is safe to share.
Delete the CSV export now that it has been read.
`);
