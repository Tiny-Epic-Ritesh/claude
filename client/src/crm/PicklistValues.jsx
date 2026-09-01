/**
 * Editing the values behind a picklist (P2-21).
 *
 * The route to do this has existed since the metadata engine was built; there
 * was no screen for it. So an administrator could see that Stage offers six
 * values and could not change them — which is the single most common
 * configuration change any CRM gets asked for, on exactly the objects the
 * feedback named.
 *
 * TWO THINGS THIS SCREEN INSISTS ON
 * ---------------------------------
 * Retiring a value does not remove it from records that hold it. The string
 * stays, the picker stops offering it, and those records quietly show something
 * that is not in the list. That is often exactly what an administrator means —
 * but it must be a decision, so the count sits next to every value and removing
 * one that is in use asks first.
 *
 * Nothing saves until Save is pressed. Same rule as the field order beside it:
 * on a configuration screen a wrong value affects everybody at once and nobody
 * notices for a week, so the change is one audited edit rather than a write per
 * keystroke.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Modal, ErrorBanner, Spinner, Loading, Icon } from '../components/ui.jsx';

/** The API value derived from a label, once, the way the field name is. */
const slug = (label) => String(label).trim();

export default function PicklistValues({ entity, field, onClose, onSaved }) {
  const [usage, { loading }] = useApi(`/setup/objects/${entity}/fields/${field.api_name}/value-usage`);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  /* When the server refuses because values are in use, it says which and how
     many. Held here so the confirmation names them rather than asking a vague
     "are you sure". */
  const [confirming, setConfirming] = useState(null);

  if (loading || !usage) return <Modal title={field.label} onClose={onClose}><Loading /></Modal>;

  const current = rows ?? usage.values
    .filter((v) => v.defined && v.active)
    .map((v) => ({ ...v, isNew: false }));

  /* Values found on records but not in the list. Not editable here — they are
     the result of this edit having been made without the counts, and the fix is
     to correct the records or re-add the value, not to hide them. */
  const orphans = usage.values.filter((v) => !v.defined && v.records > 0);
  const countOf = (value) => usage.values.find((v) => String(v.value) === String(value))?.records ?? 0;

  const set = (i, patch) => setRows(current.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const move = (i, by) => {
    const next = [...current];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
  };

  const add = () => setRows([...current, { value: '', label: '', records: 0, is_default: 0, isNew: true }]);

  const remove = (i) => setRows(current.filter((_, j) => j !== i));

  /* One default, enforced here as well as on the server. Clicking a second one
     moves it rather than adding it, because two defaults is not a decision. */
  const setDefault = (i) => setRows(current.map((r, j) => ({ ...r, is_default: j === i ? 1 : 0 })));

  async function save(retireInUse = false) {
    setBusy(true);
    setError(null);
    try {
      const values = current
        .filter((r) => String(r.label ?? '').trim())
        .map((r) => ({
          value: r.isNew ? slug(r.label) : r.value,
          label: String(r.label).trim(),
          is_default: r.is_default ? 1 : 0,
          controlling_value: r.controlling_value ?? null,
          colour: r.colour ?? null,
        }));

      await api.put(`/setup/objects/${entity}/fields/${field.api_name}/values`, {
        values,
        ...(retireInUse ? { retire_in_use: true } : {}),
      });
      onSaved();
    } catch (err) {
      // 409 carries the list of values still on records. Anything else is a
      // plain error and is shown as one.
      if (err.payload?.in_use) setConfirming(err.payload);
      else setError(err.message);
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <Modal title="These values are still in use" onClose={() => setConfirming(null)}>
        <div className="stack">
          <div className="glass notice notice-warn">
            <Icon name="warning" size={16} />
            <div>
              <p>
                Retiring a value does not change the records that hold it. They keep it, and it
                stops appearing in filters and pickers — so those records will show a value that
                is no longer on the list.
              </p>
            </div>
          </div>

          <table className="field-table compact">
            <thead><tr><th>Value</th><th className="num">Records</th></tr></thead>
            <tbody>
              {confirming.in_use.map((v) => (
                <tr key={v.value}>
                  <td><strong>{v.label}</strong></td>
                  <td className="num">{v.records.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button" className="btn btn-ghost"
              onClick={() => {
                /* Actually put them back. Dismissing the dialog alone left the
                   draft exactly as it was, so the button promised one thing and
                   the next Save produced the same refusal. */
                /* Back where it was, not on the end. Appending would put a
                   restored value last, which on Stage silently reorders the
                   pipeline — undoing a removal should leave no trace. */
                const original = usage.values.filter((v) => v.defined && v.active).map((v) => String(v.value));
                const restored = [...current];
                for (const v of confirming.in_use) {
                  if (restored.some((r) => String(r.value) === String(v.value))) continue;
                  const home = original.indexOf(String(v.value));
                  const at = home === -1 ? restored.length : restored.findIndex(
                    (r) => original.indexOf(String(r.value)) > home,
                  );
                  restored.splice(at === -1 ? restored.length : at, 0, { ...v, is_default: 0, isNew: false });
                }
                setRows(restored);
                setConfirming(null);
              }}
            >
              Keep them in the list
            </button>
            <button
              type="button" className="btn btn-danger" disabled={busy}
              onClick={() => { setConfirming(null); save(true); }}
            >
              {busy ? <Spinner /> : 'Retire anyway'}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`${field.label} — values`} onClose={onClose} wide>
      <div className="stack">
        {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

        <p className="tiny muted" style={{ margin: 0 }}>
          The order here is the order they appear in every picker.
          Record counts are for the businesses you work in.
        </p>

        <table className="field-table">
          <thead>
            <tr>
              <th>Label</th><th>Stored as</th><th className="num">Records</th><th>Default</th><th />
            </tr>
          </thead>
          <tbody>
            {current.map((r, i) => (
              <tr key={r.value || `new-${i}`}>
                <td>
                  <input
                    value={r.label ?? ''}
                    onChange={(e) => set(i, { label: e.target.value })}
                    aria-label={`Label for value ${i + 1}`}
                  />
                </td>
                <td>
                  {/* Frozen once created, for the same reason a field's API
                      name is: reports, filters and every record already hold
                      this string. Renaming the label is free; renaming the
                      value would orphan the records. */}
                  {r.isNew
                    ? <span className="tiny muted">set from the label</span>
                    : <code className="api-name"><Icon name="lock" size={12} />{r.value}</code>}
                </td>
                <td className="num">{(countOf(r.value) || 0).toLocaleString('en-IN')}</td>
                <td>
                  <button
                    type="button"
                    className={`btn btn-sm ${r.is_default ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setDefault(i)}
                    aria-label={`Make ${r.label || 'this value'} the default`}
                  >
                    {r.is_default ? 'Default' : 'Set'}
                  </button>
                </td>
                <td>
                  <span className="order-moves">
                    <button
                      type="button" className="btn btn-ghost btn-sm" disabled={i === 0}
                      onClick={() => move(i, -1)} aria-label={`Move ${r.label} up`} title="Move up"
                    >
                      <Icon name="arrow_upward" size={16} />
                    </button>
                    <button
                      type="button" className="btn btn-ghost btn-sm" disabled={i === current.length - 1}
                      onClick={() => move(i, 1)} aria-label={`Move ${r.label} down`} title="Move down"
                    >
                      <Icon name="arrow_downward" size={16} />
                    </button>
                    <button
                      type="button" className="btn btn-ghost btn-sm"
                      onClick={() => remove(i)} aria-label={`Remove ${r.label}`} title="Remove"
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div>
          <button type="button" className="btn btn-ghost" onClick={add}>
            <Icon name="add" size={16} /> Add a value
          </button>
        </div>

        {orphans.length > 0 && (
          <div className="glass notice notice-warn">
            <Icon name="inventory" size={16} />
            <div>
              <p>
                <strong>On records but not on the list:</strong>{' '}
                {orphans.map((v) => `${v.value} (${v.records.toLocaleString('en-IN')})`).join(', ')}.
              </p>
              <p className="tiny">
                These were retired while records still held them, or arrived from an import.
                Add the value back to make those records match the picker again.
              </p>
            </div>
          </div>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button" className="btn btn-primary"
            disabled={busy || rows === null} onClick={() => save(false)}
          >
            {busy ? <Spinner /> : 'Save values'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
