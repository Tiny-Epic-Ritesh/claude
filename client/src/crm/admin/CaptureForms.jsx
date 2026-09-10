import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApi, Loading, Icon, Modal, ErrorBanner, Spinner, Empty } from '../../components/ui.jsx';

/**
 * Capture forms (P3-13).
 *
 * WHY THIS IS A VIEW AND NOT A FORM BUILDER
 *
 * The ticket asks for "a Forms section where the phone call form and its fields
 * can be configured and managed by Admins and Super Admins". The obvious build
 * is a form-definition system with its own field table. That would be wrong
 * here, and the project already wrote down why: non-negotiable #6 is uniform
 * configuration surfaces across all entities, and an activity is already an
 * entity — `interaction`, backed by `activities`, with field definitions,
 * typed value storage, picklists, history and field-level security.
 *
 * A second field system for the same entity means two places to define a field,
 * two places to look when one is missing, and two things to keep in step. That
 * is the shape this product exists to stop repeating.
 *
 * So this screen writes ordinary `field_def` rows. Everything configured here
 * is visible in Object Manager and vice versa; what this adds is the one thing
 * Object Manager cannot say — which capture form a field belongs on, and in
 * what order it is drawn.
 *
 * WHAT "REMOVE" MEANS HERE
 *
 * Taking a field off a form takes it off *that* form. It never deactivates the
 * field and never touches the values already recorded against it. Somebody
 * tidying the Call form must not silently blank a year of Meeting data.
 */

/* The types worth offering on a capture form. The full palette includes
   formulas, roll-ups and lookups, which are either computed or need a target
   record — neither belongs on a form somebody fills in during a phone call. */
const FIELD_TYPES = [
  { type: 'text', label: 'Text' },
  { type: 'textarea', label: 'Long text' },
  { type: 'picklist', label: 'Choice list' },
  { type: 'multipicklist', label: 'Choice list (multi-select)' },
  { type: 'checkbox', label: 'Tick box' },
  { type: 'number', label: 'Number' },
  { type: 'currency', label: 'Amount' },
  { type: 'date', label: 'Date' },
  { type: 'datetime', label: 'Date and time' },
  { type: 'phone', label: 'Phone' },
  { type: 'email', label: 'Email' },
  { type: 'url', label: 'Link' },
];

export function CaptureForms({ session }) {
  const [data, { loading, reload }] = useApi('/setup/forms');
  const [type, setType] = useState('Call');
  const [order, setOrder] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState(null);

  const onForm = (f) => !f.on_activity_types || f.on_activity_types.includes(type);

  /* Reset whenever the chosen form or the underlying fields change. Keeping a
     half-finished reorder across a type switch would save it to the wrong
     form, which is the kind of mistake nobody attributes correctly. */
  useEffect(() => {
    if (!data) return;
    setOrder(data.fields.filter((f) => f.active && onForm(f)).map((f) => f.api_name));
    setDirty(false);
  }, [data, type]);

  if (loading || !data) return <Loading />;

  const byName = new Map(data.fields.map((f) => [f.api_name, f]));
  const available = data.fields.filter((f) => f.active && !order.includes(f.api_name));

  const move = (i, by) => {
    const to = i + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    [next[i], next[to]] = [next[to], next[i]];
    setOrder(next);
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/setup/forms/${type}`, { fields: order });
      setDirty(false);
      reload();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      <div className="row-between">
        <div>
          <h2>Capture forms</h2>
          <p className="tiny muted">
            What an RM is asked for when they log an activity. The phone call form opens by itself
            when a call is placed.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setMaking(true)}>
          <Icon name="add" size={16} /> New field
        </button>
      </div>

      {/* Which form. Call first, because it is the one that opens on its own. */}
      <div className="row wrap" style={{ gap: 6 }}>
        {data.types.map((t) => (
          <button
            key={t}
            type="button"
            className={t === type ? 'btn btn-primary btn-sm' : 'btn-sm'}
            onClick={() => setType(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(320px, 2fr) minmax(240px, 1fr)', gap: 14 }}>

        {/* ------------------------------------------------ on this form */}
        <section className="card">
          <div className="card-head">
            <h3>On the {type} form</h3>
            <span className="row" style={{ gap: 6 }}>
              {dirty && <span className="tiny muted">Not saved</span>}
              <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>
                {busy ? <Spinner /> : 'Save order'}
              </button>
            </span>
          </div>

          <div className="card-body stack" style={{ gap: 6 }}>
            <p className="tiny muted">
              Drawn between the outcome and the notes, in this order. The built-in questions —
              outcome, what was discussed, follow-up date — are always there and are configured
              under Call outcomes.
            </p>

            {!order.length ? (
              <Empty>No extra fields on this form. It asks the built-in questions only.</Empty>
            ) : order.map((name, i) => {
              const f = byName.get(name);
              if (!f) return null;
              return (
                <div key={name} className="row-between" style={{ padding: '8px 10px', border: '1px solid var(--hairline)', borderRadius: 'var(--r-xs)' }}>
                  <span className="stack" style={{ gap: 1 }}>
                    <strong style={{ fontSize: 13.5 }}>
                      {f.label}{f.required ? ' *' : ''}
                    </strong>
                    <span className="tiny muted">
                      {FIELD_TYPES.find((t) => t.type === f.type)?.label ?? f.type} · {f.api_name}
                    </span>
                  </span>
                  <span className="row" style={{ gap: 4 }}>
                    <button className="btn-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${f.label} up`}>↑</button>
                    <button className="btn-sm" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${f.label} down`}>↓</button>
                    <button className="btn-sm" onClick={() => setEditing(f)}>Edit</button>
                    <button
                      className="btn-sm"
                      title={`Take off the ${type} form — the field and its data stay`}
                      onClick={() => { setOrder(order.filter((n) => n !== name)); setDirty(true); }}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* -------------------------------------------------- not on it */}
        <section className="card">
          <div className="card-head"><h3>Not on this form</h3></div>
          <div className="card-body stack" style={{ gap: 6 }}>
            {!available.length ? (
              <p className="tiny muted">Every Interaction field is on this form.</p>
            ) : available.map((f) => (
              <div key={f.api_name} className="row-between" style={{ padding: '7px 9px', border: '1px solid var(--hairline)', borderRadius: 'var(--r-xs)' }}>
                <span className="stack" style={{ gap: 1 }}>
                  <strong style={{ fontSize: 13 }}>{f.label}</strong>
                  <span className="tiny muted">
                    {f.on_activity_types?.length ? `on ${f.on_activity_types.join(', ')}` : 'on every form'}
                  </span>
                </span>
                <button className="btn-sm" onClick={() => { setOrder([...order, f.api_name]); setDirty(true); }}>Add</button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {making && (
        <NewField
          onClose={() => setMaking(false)}
          onMade={(f) => { setMaking(false); setOrder([...order, f.api_name]); setDirty(true); reload(); }}
          onError={setError}
          session={session}
          type={type}
        />
      )}

      {editing && (
        <EditField
          field={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------- new field */

/**
 * A new field on Interaction.
 *
 * Purpose and owner are required by the server and asked for here rather than
 * defaulted, because the legacy tenant reached 289 custom fields with eight
 * duplicate pairs and four test fields live — and every one of them was added
 * by somebody who would have typed a purpose if asked.
 */
function NewField({ onClose, onMade, onError, session, type }) {
  const [form, setForm] = useState({ label: '', type: 'text', required: false, help_text: '', purpose: '' });
  const [values, setValues] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const isList = form.type === 'picklist' || form.type === 'multipicklist';

  const create = async () => {
    setBusy(true);
    try {
      const made = await api.post('/setup/objects/interaction/fields', {
        label: form.label.trim(),
        type: form.type,
        required: form.required ? 1 : 0,
        help_text: form.help_text || undefined,
        purpose: form.purpose.trim(),
        owner_user_id: session?.id,
        values: isList
          ? values.split('\n').map((v) => v.trim()).filter(Boolean).map((v) => ({ value: v, label: v }))
          : undefined,
      });
      onMade(made);
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title="New field" subtitle={`It will be added to the ${type} form`} onClose={onClose}>
      <div className="field">
        <label>What to call it</label>
        <input value={form.label} autoFocus onChange={(e) => set('label', e.target.value)} placeholder="Competitor mentioned" />
      </div>

      <div className="field">
        <label>What kind of answer</label>
        <select value={form.type} onChange={(e) => set('type', e.target.value)}>
          {FIELD_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
      </div>

      {isList && (
        <div className="field">
          <label>The choices, one per line</label>
          <textarea rows={4} value={values} onChange={(e) => setValues(e.target.value)} placeholder={'Zerodha\nGroww\nUpstox\nOther'} />
        </div>
      )}

      <div className="field">
        <label>Hint under the field</label>
        <input value={form.help_text} onChange={(e) => set('help_text', e.target.value)} placeholder="Optional — shown in small text" />
      </div>

      <div className="field">
        <label className="row" style={{ gap: 7, alignItems: 'center' }}>
          <input type="checkbox" checked={form.required} onChange={(e) => set('required', e.target.checked)} />
          <span>An activity cannot be logged without it</span>
        </label>
      </div>

      <div className="field">
        <label>Why this field exists</label>
        <input value={form.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="So we can report on who we lose deals to" />
        <p className="hint">
          Required, and it is the gate that stops the field list growing without limit. The old
          system reached 289 custom fields, eight duplicate pairs and four test fields live.
        </p>
      </div>

      <div className="row-between" style={{ marginTop: 12 }}>
        <span />
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !form.label.trim() || !form.purpose.trim()}
            onClick={create}
          >
            {busy ? <Spinner /> : 'Add the field'}
          </button>
        </span>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- edit field */

/** The parts of a field that can change after it exists. The API name and the
 *  type cannot: integrations bind to the name, and stored values match the
 *  type. The server refuses both, and this does not offer them. */
function EditField({ field, onClose, onSaved, onError }) {
  const [label, setLabel] = useState(field.label);
  const [help, setHelp] = useState(field.help_text ?? '');
  const [required, setRequired] = useState(field.required);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/setup/objects/interaction/fields/${field.api_name}`, {
        label: label.trim(), help_text: help, required: required ? 1 : 0,
      });
      onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Modal title={field.label} subtitle={`${field.api_name} · ${field.type}`} onClose={onClose}>
      <div className="field">
        <label>What to call it</label>
        <input value={label} autoFocus onChange={(e) => setLabel(e.target.value)} />
        <p className="hint">
          The name people read. <strong>{field.api_name}</strong> is what reports and integrations
          use, and it never changes.
        </p>
      </div>

      <div className="field">
        <label>Hint under the field</label>
        <input value={help} onChange={(e) => setHelp(e.target.value)} />
      </div>

      <div className="field">
        <label className="row" style={{ gap: 7, alignItems: 'center' }}>
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          <span>An activity cannot be logged without it</span>
        </label>
      </div>

      <div className="row-between" style={{ marginTop: 12 }}>
        <span />
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !label.trim()} onClick={save}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </span>
      </div>
    </Modal>
  );
}
