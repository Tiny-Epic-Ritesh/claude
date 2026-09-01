/**
 * A nested AND/OR condition builder.
 *
 * The engine has supported arbitrary trees since it was written — a group is
 * `{ op: 'AND' | 'OR', children: [...] }` and a leaf is
 * `{ field, operator, value }`, over 27 typed lead fields with per-type
 * operators. Nothing exposed the catalogue, so the only filter anybody could
 * express through the interface was a single stage from a dropdown.
 *
 * That gap is the one the LeadSquared audit traced to 4,810 lists: people
 * export to Excel and re-import because the CRM cannot say what they mean.
 * "(Source is Website OR Referral) AND Stage is not Lost AND no contact in 30
 * days" is an ordinary broking question and was unaskable here.
 *
 * DRIVEN BY THE SERVER'S OWN SCHEMA
 * Fields, types and the operators valid for each type come from
 * `conditionSchema()` — the same definitions the query compiler uses. A field
 * added to the engine appears here without this file changing, and a builder
 * that offered an operator the compiler rejects would be a builder that writes
 * unsaveable filters.
 */

import { Icon } from './ui.jsx';

const isGroup = (node) => node && Array.isArray(node.children);

/** Look a field up by code. The schema ships them as an ordered array. */
const fieldOf = (schema, code) => schema.fields.find((f) => f.code === code) ?? schema.fields[0];

/** What an operator expects: nothing, one value, or several. */
const opOf = (schema, code) => schema.operators.find((o) => o.code === code);

/** A leaf with sensible defaults for the first field in the catalogue. */
const newLeaf = (schema) => {
  const f = schema.fields[0];
  return { field: f.code, operator: f.operators[0]?.code ?? 'eq', value: '' };
};

const newGroup = (schema, op = 'OR') => ({ op, children: [newLeaf(schema)] });

/** Replace the node at `path`, returning a new tree. */
function replaceAt(node, path, next) {
  if (!path.length) return next;
  const [i, ...rest] = path;
  const children = [...node.children];
  children[i] = replaceAt(children[i], rest, next);
  return { ...node, children };
}

function removeAt(node, path) {
  const [i, ...rest] = path;
  if (!rest.length) {
    const children = node.children.filter((_, j) => j !== i);
    return { ...node, children };
  }
  const children = [...node.children];
  children[i] = removeAt(children[i], rest);
  return { ...node, children };
}

/* ------------------------------------------------------------- one row */

function Leaf({ node, schema, path, onChange, onRemove, canRemove }) {
  const def = fieldOf(schema, node.field);
  const operators = def.operators ?? [];
  const chosen = operators.find((o) => o.code === node.operator) ?? operators[0];

  /* Arity and list-ness come from the server's own operator table. "is empty"
     with a text box beside it invites somebody to type into a field that is
     ignored, and a single box beside "is any of" makes a list operator behave
     like an equality one. */
  const meta = opOf(schema, chosen?.code);
  const takesValue = meta ? meta.arity !== 0 : true;
  const takesList = Boolean(meta?.list);

  const set = (patch) => onChange(path, { ...node, ...patch });

  const changeField = (code) => {
    const next = fieldOf(schema, code);
    const nextOps = next.operators ?? [];
    // The operator has to be valid for the new field, or the tree will not save.
    const keep = nextOps.some((o) => o.code === node.operator);
    set({ field: code, operator: keep ? node.operator : (nextOps[0]?.code ?? 'eq'), value: '' });
  };

  return (
    <div className="cond-leaf">
      <select
        value={node.field}
        onChange={(e) => changeField(e.target.value)}
        aria-label="Field"
      >
        {schema.fields.map((f) => (
          <option key={f.code} value={f.code}>{f.label ?? f.code}</option>
        ))}
      </select>

      <select
        value={chosen?.code ?? ''}
        onChange={(e) => set({ operator: e.target.value, value: '' })}
        aria-label="Operator"
      >
        {operators.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
      </select>

      {takesValue && (
        def.values?.length
          ? (
            /* Real picklist values, joined from the metadata layer — the same
               ones the pickers on a lead offer. A filter written against a
               value nobody can select is a filter that matches nothing. */
            <select
              value={takesList ? (node.value?.[0] ?? '') : (node.value ?? '')}
              onChange={(e) => set({ value: takesList ? [e.target.value] : e.target.value })}
              aria-label="Value"
            >
              <option value="">Choose…</option>
              {def.values.map((v) => <option key={v.value} value={v.value}>{v.label ?? v.value}</option>)}
            </select>
          )
          : (
            <input
              type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
              value={Array.isArray(node.value) ? node.value.join(', ') : (node.value ?? '')}
              onChange={(e) => set({ value: takesList ? e.target.value.split(',').map((v) => v.trim()) : e.target.value })}
              placeholder={takesList ? 'Comma separated' : def.placeholder ?? 'Value'}
              aria-label="Value"
            />
          )
      )}

      <button
        type="button"
        className="cond-remove"
        onClick={() => onRemove(path)}
        disabled={!canRemove}
        aria-label="Remove this condition"
        title={canRemove ? 'Remove' : 'A filter needs at least one condition'}
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}

/* ----------------------------------------------------------- one group */

function Group({ node, schema, path, onChange, onRemove, depth }) {
  const set = (patch) => onChange(path, { ...node, ...patch });
  const add = (child) => set({ children: [...node.children, child] });

  return (
    <div className={`cond-group depth-${Math.min(depth, 3)}`}>
      <div className="cond-group-head">
        {/* Two buttons rather than a dropdown: the whole meaning of the group
            turns on this word, and it should be readable without opening
            anything. */}
        <div className="cond-op" role="group" aria-label="Match">
          {['AND', 'OR'].map((op) => (
            <button
              key={op}
              type="button"
              className={node.op === op ? 'is-on' : ''}
              aria-pressed={node.op === op}
              onClick={() => set({ op })}
            >
              {op === 'AND' ? 'All of' : 'Any of'}
            </button>
          ))}
        </div>

        <span className="spacer" />

        <button type="button" className="btn-ghost btn-sm" onClick={() => add(newLeaf(schema))}>
          <Icon name="add" size={14} /> Condition
        </button>
        {/* Three levels is already more nesting than anybody reads. Past that
            it is a query, and a query belongs in a report. */}
        {depth < 2 && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => add(newGroup(schema, node.op === 'AND' ? 'OR' : 'AND'))}
          >
            <Icon name="add" size={14} /> Group
          </button>
        )}
        {depth > 0 && (
          <button type="button" className="cond-remove" onClick={() => onRemove(path)} aria-label="Remove this group">
            <Icon name="close" size={15} />
          </button>
        )}
      </div>

      <div className="cond-children">
        {node.children.map((child, i) => (
          <div key={i} className="cond-child">
            {i > 0 && <span className="cond-joiner">{node.op === 'AND' ? 'and' : 'or'}</span>}
            {isGroup(child)
              ? (
                <Group
                  node={child} schema={schema} path={[...path, i]} depth={depth + 1}
                  onChange={onChange} onRemove={onRemove}
                />
              )
              : (
                <Leaf
                  node={child} schema={schema} path={[...path, i]}
                  onChange={onChange} onRemove={onRemove}
                  canRemove={node.children.length > 1 || depth > 0}
                />
              )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- root */

export default function ConditionBuilder({ value, schema, onChange }) {
  if (!Array.isArray(schema?.fields) || !schema.fields.length) return null;

  const tree = isGroup(value) ? value : { op: 'AND', children: [newLeaf(schema)] };

  const replace = (path, next) => onChange(replaceAt(tree, path, next));
  const remove = (path) => onChange(removeAt(tree, path));

  return (
    <div className="cond-builder">
      <Group node={tree} schema={schema} path={[]} depth={0} onChange={replace} onRemove={remove} />
    </div>
  );
}
