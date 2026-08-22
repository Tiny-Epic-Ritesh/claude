/**
 * The advanced search builder.
 *
 * A condition is a row: field, operator, value. Rows sit in a group, a group
 * joins its rows with AND or OR, and a group may contain another group. That
 * recursion is the whole feature — it is what lets "Facebook leads that are new
 * OR contacted" be expressed at all.
 *
 * WHAT THE COMPONENT DOES NOT KNOW
 * --------------------------------
 * Which fields exist, which operators apply to them, or what any of it means.
 * All of that comes from `/search-advanced/fields/:entity`, which is built from
 * the metadata layer and filtered by what this user may read. So a field an
 * administrator adds in Setup appears here on the next page load, and a field
 * they may not read is not offered — nor can it be typed in, because the server
 * rejects any field absent from the same registry.
 *
 * THE LIVE COUNT
 * --------------
 * Every edit re-asks the server how many records match, debounced. Building a
 * filter blind and pressing Search to find out you got zero is the thing that
 * makes people give up on query builders.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Spinner, Empty, ErrorBanner, Modal } from './ui.jsx';

/** Operators that compare against a whole value, so a picklist can offer one. */
const EXACT_OPS = new Set(['eq', 'neq']);

const emptyRow = () => ({ field: '', operator: '', value: '' });
const emptyGroup = (op = 'AND') => ({ op, children: [emptyRow()] });

/** Strip half-finished rows so a partial filter never reaches the server. */
export function prune(node) {
  if (!node) return null;
  if (node.op) {
    const kids = node.children.map(prune).filter(Boolean);
    if (!kids.length) return null;
    return kids.length === 1 && kids[0].op ? kids[0] : { op: node.op, children: kids };
  }
  if (!node.field || !node.operator) return null;
  return node;
}

/* ---------------------------------------------------------- one group */

function Group({ node, fields, onChange, onRemove, depth = 0 }) {
  const set = (i, child) => onChange({ ...node, children: node.children.map((c, j) => (j === i ? child : c)) });
  const remove = (i) => onChange({ ...node, children: node.children.filter((_, j) => j !== i) });

  return (
    <div className={`qgroup depth-${Math.min(depth, 3)}`}>
      <div className="qgroup-head">
        {/* The join is a two-state switch, not a dropdown: with two options a
            select costs a click to open and a click to choose, for nothing. */}
        <div className="join-switch" role="radiogroup" aria-label="Join conditions with">
          {['AND', 'OR'].map((op) => (
            <button
              key={op}
              type="button"
              role="radio"
              aria-checked={node.op === op}
              className={node.op === op ? 'is-on' : ''}
              onClick={() => onChange({ ...node, op })}
            >
              {op}
            </button>
          ))}
        </div>
        <span className="tiny muted">
          {node.op === 'AND' ? 'every condition must match' : 'any condition may match'}
        </span>
        {onRemove && (
          <button type="button" className="btn btn-ghost btn-icon" onClick={onRemove} aria-label="Remove group">
            <Icon name="close" size={16} />
          </button>
        )}
      </div>

      <div className="qrows">
        {node.children.map((child, i) => (
          child.op ? (
            <Group
              key={i}
              node={child}
              fields={fields}
              depth={depth + 1}
              onChange={(c) => set(i, c)}
              onRemove={() => remove(i)}
            />
          ) : (
            <Row
              key={i}
              row={child}
              fields={fields}
              onChange={(c) => set(i, c)}
              onRemove={node.children.length > 1 || depth > 0 ? () => remove(i) : null}
            />
          )
        ))}
      </div>

      <div className="qgroup-foot">
        <button type="button" className="btn btn-ghost btn-sm"
          onClick={() => onChange({ ...node, children: [...node.children, emptyRow()] })}>
          <Icon name="add" size={16} /> Add condition
        </button>
        {depth < 3 && (
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => onChange({ ...node, children: [...node.children, emptyGroup(node.op === 'AND' ? 'OR' : 'AND')] })}>
            <Icon name="account_tree" size={16} /> Add group
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ one row */

function Row({ row, fields, onChange, onRemove }) {
  const field = fields.find((f) => f.api_name === row.field);
  const op = field?.operators.find((o) => o.key === row.operator);

  // Changing the field usually invalidates the operator, so keep it only when
  // the new field still accepts it.
  const pickField = (api_name) => {
    const next = fields.find((f) => f.api_name === api_name);
    const keep = next?.operators.some((o) => o.key === row.operator);
    onChange({ field: api_name, operator: keep ? row.operator : (next?.operators[0]?.key ?? ''), value: '' });
  };

  return (
    <div className="qrow">
      <select value={row.field} onChange={(e) => pickField(e.target.value)} className="qfield">
        <option value="">Choose a field…</option>
        {fields.filter((f) => !f.custom).map((f) => (
          <option key={f.api_name} value={f.api_name}>{f.label}</option>
        ))}
        {fields.some((f) => f.custom) && (
          <optgroup label="Added in Setup">
            {fields.filter((f) => f.custom).map((f) => (
              <option key={f.api_name} value={f.api_name}>{f.label}</option>
            ))}
          </optgroup>
        )}
      </select>

      <select
        value={row.operator}
        onChange={(e) => onChange({ ...row, operator: e.target.value, value: '' })}
        disabled={!field}
        className="qop"
      >
        <option value="">…</option>
        {(field?.operators ?? []).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>

      {/* An operator that takes no value gets no box — "is blank" with an
          empty text field beside it invites people to type into it. */}
      {op && !op.noValue && (
        /* A dropdown of exact values only makes sense for exact-match
           operators. Offering it for "contains" means you can only contain a
           whole existing value, which is not what partial matching is for. */
        field?.values?.length && EXACT_OPS.has(row.operator) ? (
          <select value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} className="qval">
            <option value="">Choose…</option>
            {field.values.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
        ) : (
          <input
            className="qval"
            value={row.value}
            onChange={(e) => onChange({ ...row, value: e.target.value })}
            placeholder={op.list
              ? 'value, value, value'
              : field?.type === 'date' ? 'YYYY-MM-DD'
                : field?.values?.length ? `e.g. ${field.values[0].label}` : 'value'}
            list={field?.values?.length ? `vals-${field.api_name}` : undefined}
            type={field?.type === 'number' ? 'number' : 'text'}
          />
        )
      )}
      {/* Suggestions without restriction: type anything, but the real values
          are one keystroke away. */}
      {field?.values?.length > 0 && (
        <datalist id={`vals-${field.api_name}`}>
          {field.values.map((v) => <option key={v.value} value={v.value} />)}
        </datalist>
      )}
      {op?.noValue && <span className="qval qval-none tiny muted">no value needed</span>}

      {onRemove && (
        <button type="button" className="btn btn-ghost btn-icon" onClick={onRemove} aria-label="Remove condition">
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------- the panel */

export default function AdvancedSearch({ entity = 'lead', session, onResults, onClose }) {
  const [meta] = useApi(`/search-advanced/fields/${entity}`);
  const [saved, { reload: reloadSaved }] = useApi(`/search-advanced/saved/${entity}`);
  const [tree, setTree] = useState(emptyGroup);
  const [count, setCount] = useState(null);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef(null);

  const pruned = useMemo(() => prune(tree), [tree]);
  const can = (p) => session?.permissions?.includes(p);

  /** Debounced live count — one request per pause, not per keystroke. */
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setCounting(true); setError(null);
      try {
        const r = await api.post(`/search-advanced/${entity}/count`, { where: pruned });
        setCount(r.total);
      } catch (err) { setError(err.message); setCount(null); }
      finally { setCounting(false); }
    }, 400);
    return () => clearTimeout(timer.current);
  }, [pruned, entity]);

  const run = useCallback(async () => {
    setError(null);
    try {
      const r = await api.post(`/search-advanced/${entity}`, { where: pruned, limit: 100 });
      onResults?.({ ...r, where: pruned });
    } catch (err) { setError(err.message); }
  }, [pruned, entity, onResults]);

  if (!meta) return <div className="glass section-card"><Spinner /></div>;

  return (
    <div className="glass section-card advanced-search">
      <div className="section-head">
        <div>
          <h2>Advanced search</h2>
          <p>{meta.label} · {meta.fields.length} fields you can filter on</p>
        </div>
        {onClose && (
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        )}
      </div>

      {saved?.length > 0 && (
        <div className="saved-row">
          <span className="tiny muted">Saved:</span>
          {saved.map((s) => (
            <button
              key={s.id}
              type="button"
              className="chip"
              title={s.described}
              onClick={() => { try { setTree(JSON.parse(s.tree)); } catch { /* ignore */ } }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <Group node={tree} fields={meta.fields} onChange={setTree} />

      <div className="qfoot">
        <span className="qcount">
          {counting ? <Spinner /> : count == null ? '—' : <><strong>{count.toLocaleString('en-IN')}</strong> match{count === 1 ? '' : 'es'}</>}
        </span>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTree(emptyGroup())}>Clear</button>
          {can('list.create') && pruned && (
            <button type="button" className="btn btn-sm" onClick={() => setSaving(true)}>
              <Icon name="bookmark_add" size={16} /> Save as segment
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={run} disabled={counting}>
            <Icon name="search" size={16} /> Search
          </button>
        </div>
      </div>

      {saving && (
        <SaveSegment
          entity={entity}
          where={pruned}
          onClose={() => setSaving(false)}
          onSaved={() => { setSaving(false); reloadSaved(); }}
        />
      )}
    </div>
  );
}

function SaveSegment({ entity, where, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  return (
    <Modal title="Save as segment" subtitle="Stored as a query, so it stays current" onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError(null);
          try { await api.post(`/search-advanced/${entity}/save`, { name, where }); onSaved(); }
          catch (err) { setError(err.message); setBusy(false); }
        }}
      >
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        <label className="span-2">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus
            placeholder="Facebook leads not yet contacted" />
          <small className="muted">
            Saved as the question, not the answer — open it in March and it returns March&apos;s records.
          </small>
        </label>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : 'Save segment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export { Empty };
