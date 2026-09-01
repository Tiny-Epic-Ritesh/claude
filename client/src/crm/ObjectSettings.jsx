/**
 * The object's own settings (P2-21).
 *
 * The other half of "edit and configuration options for all objects". Fields
 * could be added, renamed, reordered and constrained; the object itself could
 * not be renamed at all, though the route to do it has always been there.
 *
 * That matters more here than it looks. This product's fifth non-negotiable is
 * that a label is not an API name — the legacy tenant carries
 * `mx_Subscription_End_dtae` in perpetuity because it never separated the two.
 * Keeping the label editable is what makes the API name safe to freeze, so a
 * screen that freezes both quietly gives up the benefit of having two.
 *
 * "Cases" is the live example: the object is `case` in the API, labelled Cases
 * in this product and Tickets in the last one. Whichever word the business
 * settles on, nothing downstream should have to change.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { Modal, ErrorBanner, Spinner, Icon } from '../components/ui.jsx';

export default function ObjectSettings({ object, onClose, onSaved }) {
  const [form, setForm] = useState({
    label: object.label ?? '',
    label_plural: object.label_plural ?? '',
    description: object.description ?? '',
    icon: object.icon ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const dirty = ['label', 'label_plural', 'description', 'icon']
    .some((k) => (form[k] ?? '') !== (object[k] ?? ''));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/setup/objects/${object.api_name}`, form);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`${object.label_plural} — settings`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

        <div className="glass notice">
          <Icon name="lock" size={16} />
          <div>
            <p>
              The API name is <code>{object.api_name}</code> and never changes. Integrations,
              saved filters and the automation rules all bind to it, so renaming below is safe:
              it changes what people read, not what anything depends on.
            </p>
          </div>
        </div>

        <label>
          <span>Name</span>
          <input value={form.label} onChange={set('label')} required />
          <span className="tiny muted">One of them — &ldquo;Case&rdquo;.</span>
        </label>

        <label>
          <span>Plural</span>
          <input value={form.label_plural} onChange={set('label_plural')} required />
          {/* Stored rather than derived. English plurals are irregular, and a
              product that shows "Companys" in its navigation looks unfinished
              in the one place everybody looks. */}
          <span className="tiny muted">More than one — &ldquo;Cases&rdquo;. Used in navigation and headings.</span>
        </label>

        <label>
          <span>Description</span>
          <textarea
            value={form.description} onChange={set('description')} rows={2}
            placeholder="What this object is for, in a sentence."
          />
          <span className="tiny muted">Shown to administrators on the objects list.</span>
        </label>

        <label>
          <span>Icon</span>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <input value={form.icon} onChange={set('icon')} placeholder="support_agent" />
            {/* Shown as it will appear. An icon name that is not in the subset
                renders as its own name in words, and this is the only place
                somebody would find that out before everyone else does. */}
            <span className="material-symbols-rounded" style={{ fontSize: 28 }}>{form.icon}</span>
          </div>
          <span className="tiny muted">A Material Symbols name. The preview is what users will see.</span>
        </label>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
            {busy ? <Spinner /> : 'Save settings'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
