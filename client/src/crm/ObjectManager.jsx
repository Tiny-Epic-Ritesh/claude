/**
 * Object Manager — the configuration surface every entity shares.
 *
 * One screen for all six objects, and for anything created later. That
 * uniformity is the product decision, not a shortcut: an administrator who
 * learns to configure Leads can configure Cases, because there is nothing here
 * that knows what a Lead is.
 *
 * The two ideas the screen has to carry visually:
 *
 *   Label and API name are different things. The label is large and editable;
 *   the API name sits under it in monospace, greyed, with a lock. Every screen
 *   that shows both this way teaches the distinction without a tooltip.
 *
 *   A field is a commitment. Creating one asks why it exists and who owns it,
 *   and shows near-duplicates before you commit. 289 unowned custom fields is
 *   what the absence of that question looks like after four years.
 */

import { useState } from 'react';
import { api } from '../api.js';
import ValidationRules from './ValidationRules.jsx';
import PicklistValues from './PicklistValues.jsx';
import ObjectSettings from './ObjectSettings.jsx';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner } from '../components/ui.jsx';

const TYPE_GROUPS = [
  ['Text', ['text', 'textarea', 'richtext', 'encrypted_text', 'email', 'phone', 'url']],
  ['Number', ['number', 'currency', 'percent']],
  ['Date', ['date', 'datetime', 'time']],
  ['Choice', ['picklist', 'multipicklist', 'checkbox']],
  ['Relationship', ['lookup', 'polymorphic_lookup']],
  ['Derived (read-only)', ['formula', 'rollup', 'auto_number']],
  ['Compound', ['address']],
];

const SCOPE_LABEL = {
  record: 'Anyone who can see the record',
  owner_or_manager: 'Owner and their managers',
  capability: 'Capability holders only',
};

export default function ObjectManager() {
  const [entity, setEntity] = useState(null);
  const [objects, { loading, error, reload }] = useApi('/setup/objects');

  if (loading) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  if (entity) {
    return <ObjectDetail entity={entity} onBack={() => { setEntity(null); reload(); }} />;
  }

  return (
    <>
      <p className="muted" style={{ marginBottom: 'var(--gap)' }}>
        Every object is configured the same way. Fields added here need no deploy —
        they appear on layouts, in filters and in the API immediately.
      </p>

      <div className="tile-grid">
        {(objects ?? []).map((o) => (
          <button key={o.api_name} type="button" className="glass tile" onClick={() => setEntity(o.api_name)}>
            <div className="tile-head">
              <span className="material-symbols-rounded">{o.icon ?? 'database'}</span>
              <div>
                <strong>{o.label_plural}</strong>
                <code className="api-name">{o.api_name}</code>
              </div>
            </div>
            <div className="tile-stats">
              <span>{o.field_count} fields</span>
              {o.custom_field_count > 0 && <span className="chip chip-soft">{o.custom_field_count} custom</span>}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

/* --------------------------------------------------------- one object */

function ObjectDetail({ entity, onBack }) {
  const [data, { loading, error, reload }] = useApi(`/setup/objects/${entity}`);
  const [usage] = useApi(`/setup/field-usage/${entity}`);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [values, setValues] = useState(null);
  const [settings, setSettings] = useState(false);

  /* Layout order.
   *
   * `draft` is null until somebody starts reordering, and holds the whole list
   * while they are. Explicit save rather than a write per move: this is a
   * configuration screen, where the Q-07 rule applies — a wrong layout affects
   * everybody at once and nobody notices for a week — and moving a field four
   * places should be one audited change, not four. */
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [orderError, setOrderError] = useState(null);

  if (loading || !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const fillRate = new Map((usage?.fields ?? []).map((f) => [f.api_name, f.fill_rate]));
  const reordering = draft !== null;
  const rows = draft ?? data.fields;

  const move = (i, by) => {
    const next = [...rows];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  };

  const saveOrder = async () => {
    setSaving(true);
    setOrderError(null);
    try {
      await api.patch(`/setup/objects/${entity}/field-order`, {
        order: rows.map((f) => f.api_name),
      });
      setDraft(null);
      reload();
    } catch (err) {
      setOrderError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="detail-head">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          <span className="material-symbols-rounded">arrow_back</span> All objects
        </button>
        <div>
          <h2>{data.object.label_plural}</h2>
          <code className="api-name">{data.object.api_name}</code>
        </div>
        {reordering ? (
          <span className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => { setDraft(null); setOrderError(null); }}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={saveOrder}>
              {saving ? <Spinner /> : 'Save order'}
            </button>
          </span>
        ) : (
          <span className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setSettings(true)}>
              <span className="material-symbols-rounded">settings</span> Settings
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setDraft(data.fields)}>
              <span className="material-symbols-rounded">swap_vert</span> Reorder
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <span className="material-symbols-rounded">add</span> New field
            </button>
          </span>
        )}
      </div>

      {usage && (usage.unused.length > 0 || usage.unowned.length > 0) && (
        <div className="glass notice notice-warn">
          <span className="material-symbols-rounded">inventory</span>
          <div>
            {usage.unused.length > 0 && (
              <p><strong>{usage.unused.length} custom field{usage.unused.length === 1 ? ' is' : 's are'} empty on every record:</strong> {usage.unused.join(', ')}. Worth retiring.</p>
            )}
            {usage.unowned.length > 0 && (
              <p><strong>No owner:</strong> {usage.unowned.join(', ')}. Someone should be answerable for each.</p>
            )}
          </div>
        </div>
      )}

      {orderError && <ErrorBanner error={orderError} onDismiss={() => setOrderError(null)} />}

      {reordering && (
        <div className="glass notice">
          <span className="material-symbols-rounded">swap_vert</span>
          <div>
            This is the order fields appear in on the record and in the edit form.
            Nothing is saved until you choose Save order.
          </div>
        </div>
      )}

      <div className="glass panel">
        <table className="field-table">
          <thead>
            <tr>
              <th>Field</th><th>Type</th><th>Visibility</th><th>Filled</th><th>Purpose</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => (
              <tr key={f.api_name} className={f.active ? '' : 'row-inactive'}>
                <td>
                  <div className="field-name">
                    <strong>{f.label}</strong>
                    {f.required === 1 && <span className="req" title="Required">*</span>}
                    {!f.active && <span className="chip chip-muted">inactive</span>}
                  </div>
                  {/* The distinction the legacy tenant never made, shown every time. */}
                  <code className="api-name">
                    <span className="material-symbols-rounded">lock</span>{f.api_name}
                  </code>
                </td>
                <td>
                  {f.type_label}
                  {f.encrypted === 1 && <span className="chip chip-lock"><span className="material-symbols-rounded">key</span>encrypted</span>}
                  {f.history_tracked === 1 && <span className="chip chip-soft">tracked</span>}
                </td>
                <td className="muted small">{SCOPE_LABEL[f.read_scope]}</td>
                <td className="num">
                  {fillRate.get(f.api_name) == null ? '—' : `${fillRate.get(f.api_name)}%`}
                </td>
                <td className="muted small">
                  {f.derived_as
                    ? <em>{f.derived_as}</em>
                    : f.is_custom ? (f.purpose ?? '—') : 'Core field'}
                </td>
                <td>
                  {reordering ? (
                    <span className="order-moves">
                      {/* Buttons rather than drag. A configuration screen is
                          used rarely and often on a laptop trackpad, and a
                          dropped drag silently reorders something else. */}
                      <button
                        type="button" className="btn btn-ghost btn-sm"
                        disabled={i === 0} onClick={() => move(i, -1)}
                        aria-label={`Move ${f.label} up`} title="Move up"
                      >
                        <span className="material-symbols-rounded">arrow_upward</span>
                      </button>
                      <button
                        type="button" className="btn btn-ghost btn-sm"
                        disabled={i === rows.length - 1} onClick={() => move(i, 1)}
                        aria-label={`Move ${f.label} down`} title="Move down"
                      >
                        <span className="material-symbols-rounded">arrow_downward</span>
                      </button>
                    </span>
                  ) : (
                    <span className="row" style={{ gap: 4 }}>
                      {/* Values sit beside the field rather than inside Edit:
                          changing what Stage offers is a different act from
                          renaming it, and the one people come here to do. */}
                      {(f.type === 'picklist' || f.type === 'multipicklist') && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setValues(f)}>
                          Values
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(f)}>Edit</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.fields.length === 0 && <Empty>No fields yet.</Empty>}
      </div>

      {/* Rules live under the fields they constrain, on the same screen.
          A separate tab would mean an administrator can add a required-looking
          field without ever seeing where "required" is actually decided. */}
      <ValidationRules entity={entity} />

      {adding && (
        <NewField
          entity={entity}
          types={data.types}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); reload(); }}
        />
      )}
      {settings && (
        <ObjectSettings
          object={data.object}
          onClose={() => setSettings(false)}
          onSaved={() => { setSettings(false); reload(); }}
        />
      )}
      {values && (
        <PicklistValues
          entity={entity}
          field={values}
          onClose={() => setValues(null)}
          onSaved={() => { setValues(null); reload(); }}
        />
      )}
      {editing && (
        <EditField
          entity={entity}
          field={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------- new field */

function NewField({ entity, types, onClose, onSaved }) {
  const [form, setForm] = useState({
    label: '', type: 'text', purpose: '', help_text: '', required: false,
    history_tracked: false, read_scope: 'record',
  });
  const [values, setValues] = useState('');
  const [derived, setDerived] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);

  const set = (k) => (e) => setForm((f) => ({
    ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
  }));

  // Shown live, so the permanence of the API name is visible before it is fixed.
  const apiName = form.label.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

  const isPicklist = form.type === 'picklist' || form.type === 'multipicklist';
  const isDerived = types?.[form.type]?.derived;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { ...form };
      // A derived type carries its definition; the API validates it before the
      // field is created, so a broken formula never reaches a record.
      if (form.type === 'formula') body.formula = derived;
      if (form.type === 'rollup') body.rollup = derived;
      if (isPicklist && values.trim()) {
        body.values = values.split('\n').map((l) => l.trim()).filter(Boolean)
          .map((l) => ({ value: l.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), label: l }));
      }
      const res = await api.post(`/setup/objects/${entity}/fields`, body);
      if (res.warnings?.length) { setWarnings(res.warnings); setBusy(false); return; }
      onSaved();
    } catch (err) {
      setError(err.message); setBusy(false);
    }
  }

  return (
    <Modal title="New field" onClose={onClose} wide>
      <form onSubmit={submit} className="form-grid">
        {error && <ErrorBanner error={error} />}

        {warnings.length > 0 && (
          <div className="glass notice notice-warn span-2">
            <span className="material-symbols-rounded">help</span>
            <div>
              {warnings.map((w) => <p key={w}>{w}</p>)}
              <p className="muted small">The field was created. Review it if this was not intended.</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={onSaved}>Understood</button>
            </div>
          </div>
        )}

        <label className="span-2">
          <span>Label</span>
          <input value={form.label} onChange={set('label')} required maxLength={80}
            placeholder="What people will see, e.g. Referral Code" />
          {apiName && (
            <small className="muted">
              API name will be <code>{apiName}</code> — permanent once saved. The label can be
              changed at any time; this cannot.
            </small>
          )}
        </label>

        <label>
          <span>Type</span>
          <select value={form.type} onChange={set('type')}>
            {TYPE_GROUPS.map(([group, codes]) => (
              <optgroup key={group} label={group}>
                {codes.filter((c) => types?.[c]).map((c) => (
                  <option key={c} value={c}>{types[c].label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          {isDerived && <small className="muted">Read-only. Computed rather than entered.</small>}
          {form.type === 'encrypted_text' && <small className="muted">Stored encrypted. Reading it needs a capability.</small>}
        </label>

        <label>
          <span>Who can read the value</span>
          <select value={form.read_scope} onChange={set('read_scope')}>
            <option value="record">{SCOPE_LABEL.record}</option>
            <option value="owner_or_manager">{SCOPE_LABEL.owner_or_manager}</option>
            <option value="capability">{SCOPE_LABEL.capability}</option>
          </select>
          <small className="muted">Separate from who can see the record itself.</small>
        </label>

        {isDerived && (form.type === 'formula' || form.type === 'rollup') && (
          <>
            <div className="span-2 form-divider"><span>What it computes</span></div>
            <DerivedBuilder
              entity={entity}
              type={form.type}
              value={derived}
              onChange={setDerived}
            />
          </>
        )}

        {isPicklist && (
          <label className="span-2">
            <span>Values — one per line</span>
            <textarea rows={5} value={values} onChange={(e) => setValues(e.target.value)}
              placeholder={'Equity\nDerivatives\nCommodity'} />
          </label>
        )}

        <label className="span-2">
          <span>Why does this field exist?</span>
          <input value={form.purpose} onChange={set('purpose')} required maxLength={200}
            placeholder="e.g. Track attribution for the 2026 referral scheme" />
          <small className="muted">
            Required. A field nobody can justify is a field nobody will retire.
          </small>
        </label>

        <label className="span-2">
          <span>Help text <span className="muted">(optional)</span></span>
          <input value={form.help_text} onChange={set('help_text')} maxLength={200} />
        </label>

        <div className="check-row span-2">
          <label className="inline">
            <input type="checkbox" checked={form.required} onChange={set('required')} disabled={isDerived} />
            <span>Required</span>
          </label>
          <label className="inline">
            <input type="checkbox" checked={form.history_tracked} onChange={set('history_tracked')} disabled={isDerived} />
            <span>Track changes</span>
          </label>
        </div>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !form.label.trim()
              || ((form.type === 'formula' || form.type === 'rollup') && !derived?.kind && !derived?.source)}
          >
            {busy ? <Spinner /> : 'Create field'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------ edit field */

function EditField({ entity, field, onClose, onSaved }) {
  const [form, setForm] = useState({
    label: field.label, help_text: field.help_text ?? '', purpose: field.purpose ?? '',
    required: field.required === 1, history_tracked: field.history_tracked === 1,
    read_scope: field.read_scope, active: field.active === 1,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({
    ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
  }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.patch(`/setup/objects/${entity}/fields/${field.api_name}`, form);
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title={field.label} onClose={onClose} wide>
      <form onSubmit={submit} className="form-grid">
        {error && <ErrorBanner error={error} />}

        <div className="glass notice span-2">
          <span className="material-symbols-rounded">lock</span>
          <div>
            <p>
              <code>{field.api_name}</code> · {field.type_label}
              {field.is_custom === 0 && ' · core field'}
            </p>
            <p className="muted small">
              Name and type are fixed. Integrations bind to the name and stored values match
              the type, so changing either in place would break both. Deactivate and replace instead.
            </p>
          </div>
        </div>

        <label className="span-2">
          <span>Label</span>
          <input value={form.label} onChange={set('label')} required maxLength={80} />
        </label>

        <label className="span-2">
          <span>Help text</span>
          <input value={form.help_text} onChange={set('help_text')} maxLength={200} />
        </label>

        {field.is_custom === 1 && (
          <label className="span-2">
            <span>Purpose</span>
            <input value={form.purpose} onChange={set('purpose')} maxLength={200} />
          </label>
        )}

        <label className="span-2">
          <span>Who can read the value</span>
          <select value={form.read_scope} onChange={set('read_scope')}>
            <option value="record">{SCOPE_LABEL.record}</option>
            <option value="owner_or_manager">{SCOPE_LABEL.owner_or_manager}</option>
            <option value="capability">{SCOPE_LABEL.capability}</option>
          </select>
        </label>

        <div className="check-row span-2">
          <label className="inline">
            <input type="checkbox" checked={form.required} onChange={set('required')} />
            <span>Required</span>
          </label>
          <label className="inline">
            <input type="checkbox" checked={form.history_tracked} onChange={set('history_tracked')} />
            <span>Track changes</span>
          </label>
          {field.is_custom === 1 && (
            <label className="inline">
              <input type="checkbox" checked={form.active} onChange={set('active')} />
              <span>Active</span>
            </label>
          )}
        </div>

        {field.is_custom === 1 && !form.active && (
          <p className="muted small span-2">
            Deactivating removes the field from layouts and pickers. Stored values and change
            history are kept, so reports over past periods stay answerable.
          </p>
        )}

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------- derived field builder */

/**
 * Building a formula or a roll-up, without typing an expression.
 *
 * The form renders itself from the catalogue the server sends: each formula
 * kind declares its inputs, and this walks them. It does not know what
 * `days_since` means, which is why adding a seventh formula kind needs no
 * change here at all.
 */
function DerivedBuilder({ entity, type, value, onChange }) {
  const [cat] = useApi(`/setup/objects/${entity}/derivable`);
  if (!cat) return <Loading />;

  return type === 'formula'
    ? <FormulaBuilder cat={cat} value={value} onChange={onChange} />
    : <RollupBuilder cat={cat} value={value} onChange={onChange} />;
}

function FormulaBuilder({ cat, value, onChange }) {
  const def = value ?? {};
  const kind = cat.formulas[def.kind];
  const set = (k, v) => onChange({ ...def, [k]: v });

  /** Only fields whose type this input accepts — no invalid choice offered. */
  const optionsFor = (input) => cat.fields.filter((f) => {
    if (input.name === 'field' && def.kind === 'age_in_stage') return f.history_tracked;
    return !input.of || input.of.includes(f.type);
  });

  return (
    <>
      <label className="span-2">
        <span>What should it compute?</span>
        <select
          value={def.kind ?? ''}
          onChange={(e) => onChange({ kind: e.target.value })}
          required
        >
          <option value="">Choose…</option>
          {Object.entries(cat.formulas).map(([k, f]) => (
            <option key={k} value={k}>{f.label}</option>
          ))}
        </select>
        {kind && <small className="muted">{kind.help}</small>}
      </label>

      {kind?.inputs.map((input) => {
        const opts = optionsFor(input);

        if (input.type === 'choice') {
          return (
            <label key={input.name}>
              <span>{input.label}</span>
              <select value={def[input.name] ?? ''} onChange={(e) => set(input.name, e.target.value)} required>
                <option value="">Choose…</option>
                {input.values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          );
        }

        if (input.type === 'field_list') {
          return (
            <label key={input.name} className="span-2">
              <span>{input.label}</span>
              <div className="chip-row">
                {cat.fields.map((f) => {
                  const on = (def[input.name] ?? []).includes(f.api_name);
                  return (
                    <button
                      key={f.api_name}
                      type="button"
                      className={`chip ${on ? 'chip-active' : ''}`}
                      onClick={() => {
                        const list = def[input.name] ?? [];
                        set(input.name, on ? list.filter((x) => x !== f.api_name) : [...list, f.api_name]);
                      }}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
              <small className="muted">Click to add. They join in the order you pick them.</small>
            </label>
          );
        }

        if (input.type === 'field' || input.type === 'field_or_number') {
          return (
            <label key={input.name}>
              <span>{input.label}</span>
              <select value={def[input.name] ?? ''} onChange={(e) => set(input.name, e.target.value)}
                required={!input.optional}>
                <option value="">Choose…</option>
                {opts.map((f) => <option key={f.api_name} value={f.api_name}>{f.label}</option>)}
              </select>
              {input.type === 'field_or_number' && (
                <input
                  placeholder="…or a fixed number"
                  value={Number.isNaN(Number(def[input.name])) ? '' : (def[input.name] ?? '')}
                  onChange={(e) => set(input.name, e.target.value)}
                  style={{ marginTop: 6 }}
                />
              )}
              {opts.length === 0 && (
                <small className="err-text">
                  No field on this object can be used here
                  {def.kind === 'age_in_stage' && ' — turn on change tracking for a picklist first'}.
                </small>
              )}
            </label>
          );
        }

        return (
          <label key={input.name}>
            <span>{input.label}{input.optional && <span className="muted"> (optional)</span>}</span>
            <input value={def[input.name] ?? ''} onChange={(e) => set(input.name, e.target.value)}
              required={!input.optional} />
          </label>
        );
      })}
    </>
  );
}

function RollupBuilder({ cat, value, onChange }) {
  const def = value ?? {};
  const source = cat.sources.find((s) => s.key === def.source);
  const agg = cat.aggregates[def.agg];
  const set = (k, v) => onChange({ ...def, [k]: v });

  const summable = source
    ? Object.entries(source.fields).filter(([, t]) => (['sum', 'avg'].includes(def.agg) ? t === 'number' : true))
    : [];

  return (
    <>
      <label>
        <span>Summarise which list?</span>
        <select value={def.source ?? ''} onChange={(e) => onChange({ source: e.target.value })} required>
          <option value="">Choose…</option>
          {cat.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </label>

      <label>
        <span>How?</span>
        <select value={def.agg ?? ''} onChange={(e) => set('agg', e.target.value)} required disabled={!source}>
          <option value="">Choose…</option>
          {Object.entries(cat.aggregates).map(([k, a]) => <option key={k} value={k}>{a.label}</option>)}
        </select>
      </label>

      {agg?.needsField && (
        <label className="span-2">
          <span>Which field?</span>
          <select value={def.field ?? ''} onChange={(e) => set('field', e.target.value)} required>
            <option value="">Choose…</option>
            {summable.map(([f, t]) => <option key={f} value={f}>{f} ({t})</option>)}
          </select>
          {['sum', 'avg'].includes(def.agg) && (
            <small className="muted">Only number fields can be summed or averaged.</small>
          )}
        </label>
      )}

      {source && (
        <label className="span-2">
          <span>Only count some of them? <span className="muted">(optional)</span></span>
          <div className="row" style={{ gap: 8 }}>
            <select
              value={Object.keys(def.where ?? {})[0] ?? ''}
              onChange={(e) => set('where', e.target.value ? { [e.target.value]: '' } : null)}
              style={{ flex: 1 }}
            >
              <option value="">No filter — count them all</option>
              {Object.keys(source.fields).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            {def.where && (
              <input
                placeholder="is…"
                value={Object.values(def.where)[0] ?? ''}
                onChange={(e) => set('where', { [Object.keys(def.where)[0]]: e.target.value })}
                style={{ flex: 1 }}
              />
            )}
          </div>
          <small className="muted">
            For example: Interactions where <code>type</code> is <code>Call</code>.
          </small>
        </label>
      )}
    </>
  );
}
