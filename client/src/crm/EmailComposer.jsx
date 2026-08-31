/**
 * The email composer (ENH-06).
 *
 * Opens from the lead's email address, which used to be plain text.
 *
 * The attachment picker leads with the Content Library rather than the file
 * input, and that ordering is deliberate. An RM emailing a client should be
 * sending approved, versioned, in-date collateral; the library knows which
 * brochures are current and simply does not offer the withdrawn ones. A file
 * from somebody's desktop is still allowed — it is asked for — but it is the
 * second option, capped and type-checked, rather than the obvious one.
 *
 * Consent is shown before the compose box, not discovered on send. If this
 * client cannot lawfully receive it, the RM should learn that before writing
 * three paragraphs.
 */

import { useState } from 'react';
import { api } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Modal } from '../components/ui.jsx';

const MAX_BYTES = 5 * 1024 * 1024;

const readFile = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onerror = () => reject(new Error(`Could not read ${file.name}`));
  fr.onload = () => resolve({
    name: file.name,
    type: file.type,
    size: file.size,
    // The comma split drops the "data:...;base64," prefix the server does not want.
    data: String(fr.result).split(',')[1] ?? '',
  });
  fr.readAsDataURL(file);
});

export default function EmailComposer({ leadId, onClose, onSent, onError }) {
  const [d, { loading, error }] = useApi(leadId ? `/email/compose/${leadId}` : null, [leadId]);
  const [form, setForm] = useState({ subject: '', body: '', template_id: '', intent: 'service' });
  const [contentIds, setContentIds] = useState([]);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  if (loading && !d) return <Modal title="Email" onClose={onClose}><Loading /></Modal>;
  if (error) return <Modal title="Email" onClose={onClose}><ErrorBanner error={error} /></Modal>;
  if (!d) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  /** Choosing a template replaces the draft, so it is confirmed once written. */
  const useTemplate = (id) => {
    const t = d.templates.find((x) => String(x.id) === String(id));
    if (!t) { set('template_id', ''); return; }
    if ((form.subject || form.body)
      && !window.confirm('Replace what you have written with this template?')) return;
    setForm({ template_id: id, subject: t.subject ?? '', body: t.body ?? '' });
  };

  const addFiles = async (list) => {
    setProblem(null);
    const picked = [...list];
    const tooBig = picked.find((f) => f.size > MAX_BYTES);
    if (tooBig) { setProblem(`${tooBig.name} is larger than 5 MB`); return; }
    const bad = picked.find((f) => !d.limits.allowed_types.includes(f.type));
    if (bad) { setProblem(`${bad.name}: that file type cannot be emailed to a client`); return; }
    try {
      // Read them all first, then set once. Awaiting inside the state callback
      // is not allowed and would not batch anyway.
      const read = await Promise.all(picked.map(readFile));
      setFiles((prev) => [...prev, ...read]);
    } catch (e) { setProblem(e.message); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setProblem(null);
    try {
      const r = await api.post('/email/send', {
        lead_id: leadId,
        subject: form.subject,
        body: form.body,
        template_id: form.template_id || null,
        content_ids: contentIds,
        attachments: files,
        // Declared, never defaulted. The server treats a missing intent as
        // 'service', and service is the permissive branch -- it is allowed
        // through a marketing opt-out on purpose, because a KYC reminder is
        // not a pitch. Sending everything unlabelled therefore let a pitch
        // reach somebody who had opted out of exactly that.
        intent: form.intent,
      });
      onSent?.(r.note ?? 'Email logged.');
    } catch (err) {
      setProblem(err.message);
      setBusy(false);
    }
  };

  const blocked = !d.consent.allowed;

  return (
    <Modal title={`Email ${d.lead.name}`} subtitle={d.lead.email || 'No email address on file'} onClose={onClose} wide>
      <form onSubmit={submit} className="stack" style={{ gap: 13 }}>
        <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

        {/* Said before the compose box, not after three paragraphs. */}
        {blocked && (
          <div className="notice notice-warn">
            <Icon name="block" size={17} />
            <span>{d.consent.reason}</span>
          </div>
        )}
        {!blocked && !d.consent.marketing_allowed && (
          <div className="notice">
            <Icon name="info" size={17} />
            <span>
              This client has opted out of marketing. Service emails about an
              existing account are still fine; a pitch is not.
            </span>
          </div>
        )}

        {/* Which kind of email this is, asked before it is written.
          *
          * Not a formality: consent differs by intent. A service email about an
          * existing account reaches a client who has opted out of marketing; a
          * pitch does not. The composer used to send neither answer, so the
          * server fell back to 'service' and every email -- pitches included --
          * went out on the permissive branch.
          *
          * Marketing is disabled rather than hidden when they have opted out,
          * so the reason is visible instead of the option silently missing. */}
        <div className="field">
          <span className="field-label">What kind of email is this?</span>
          <div className="intent-switch">
            <button
              type="button"
              className={`intent-opt ${form.intent === 'service' ? 'is-on' : ''}`}
              onClick={() => set('intent', 'service')}
            >
              <Icon name="support_agent" />
              <span><strong>Service</strong><em>KYC, statements, dues, case updates</em></span>
            </button>
            <button
              type="button"
              className={`intent-opt ${form.intent === 'marketing' ? 'is-on' : ''} ${d.consent.marketing_allowed ? '' : 'is-blocked'}`}
              disabled={!d.consent.marketing_allowed}
              title={d.consent.marketing_allowed ? undefined : 'This client has opted out of marketing'}
              onClick={() => set('intent', 'marketing')}
            >
              <Icon name="campaign" />
              <span>
                <strong>Marketing</strong>
                <em>{d.consent.marketing_allowed ? 'Offers, product pitches, campaigns' : 'Opted out'}</em>
              </span>
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="em-template">Start from a template</label>
          <select id="em-template" value={form.template_id}
            onChange={(e) => useTemplate(e.target.value)}>
            <option value="">Write from scratch</option>
            {d.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="tiny muted">
            Only approved templates appear here. {'{{name}}'} and {'{{rm}}'} are filled in when it sends.
          </span>
        </div>

        <div className="field">
          <label htmlFor="em-subject">Subject</label>
          <input id="em-subject" value={form.subject} onChange={(e) => set('subject', e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="em-body">Message</label>
          <textarea id="em-body" rows={10} value={form.body}
            onChange={(e) => set('body', e.target.value)} />
        </div>

        {/* Approved collateral first. */}
        <div className="field">
          <label htmlFor="em-library">Attach approved collateral</label>
          <select id="em-library" value=""
            onChange={(e) => {
              const id = Number(e.target.value);
              if (id && !contentIds.includes(id)) setContentIds((c) => [...c, id]);
            }}>
            <option value="">Choose from the Content Library…</option>
            {d.library.filter((l) => !contentIds.includes(l.id)).map((l) => (
              <option key={l.id} value={l.id}>{l.name} · {l.type} · v{l.version}</option>
            ))}
          </select>
          <span className="tiny muted">
            Withdrawn and out-of-date documents are not listed, so what is here is current.
          </span>
        </div>

        {(contentIds.length > 0 || files.length > 0) && (
          <div className="row wrap" style={{ gap: 6 }}>
            {contentIds.map((id) => {
              const item = d.library.find((l) => l.id === id);
              return (
                <button key={`c${id}`} type="button" className="chip chip-active"
                  onClick={() => setContentIds((c) => c.filter((x) => x !== id))}>
                  <Icon name="description" size={13} /> {item?.name ?? id}
                  <Icon name="close" size={13} />
                </button>
              );
            })}
            {files.map((f, i) => (
              <button key={`f${f.name}${i}`} type="button" className="chip chip-active"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>
                <Icon name="attach_file" size={13} /> {f.name}
                <Icon name="close" size={13} />
              </button>
            ))}
          </div>
        )}

        <div className="field">
          <label htmlFor="em-file">Or attach a file</label>
          <input id="em-file" type="file" multiple
            accept={d.limits.allowed_types.join(',')}
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <span className="tiny muted">PDF, image, spreadsheet or document. Up to 5 MB each.</span>
        </div>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary"
            disabled={busy || blocked || !form.subject.trim() || !form.body.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
