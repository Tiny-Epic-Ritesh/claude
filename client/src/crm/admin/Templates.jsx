/**
 * Setup → Templates (P3-17).
 *
 * "Template Management currently offers no way to add or create a template."
 * It did not: this screen was a list and an approve button.
 *
 * THE LIMITS ARE THE PROVIDER'S, AND THEY ARE SHOWN WHILE TYPING
 * -------------------------------------------------------------
 * A WhatsApp template is approved or rejected by Meta, so a builder that
 * accepts a 90-character header collects somebody's work and loses it a day
 * later to a rejection they cannot read. Every limit here comes from the
 * server's own spec — the same one the write enforces — and is shown against
 * the field it applies to.
 *
 * THE PREVIEW IS THE SERVER'S
 * ---------------------------
 * Rendering the merge fields, counting SMS segments and translating our named
 * fields into Meta's positional {{1}} all happen on the server, and the preview
 * shows what it returns. A preview computed separately in the browser would be
 * a second implementation of the thing most likely to be wrong.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useApi, Loading, Icon, Modal, ErrorBanner, Empty, Spinner, Tabs } from '../../components/ui.jsx';

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' };

export function Templates() {
  const [rows, { loading, reload }] = useApi('/admin/templates');
  const [spec] = useApi('/admin/templates/spec');
  const [channel, setChannel] = useState('all');
  const [editing, setEditing] = useState(null);
  const [problem, setProblem] = useState(null);

  if (loading) return <Loading />;

  const shown = channel === 'all' ? rows : rows.filter((t) => t.channel === channel);
  const counts = rows.reduce((acc, t) => ({ ...acc, [t.channel]: (acc[t.channel] ?? 0) + 1 }), {});

  const remove = async (t) => {
    setProblem(null);
    try {
      await api.del(`/admin/templates/${t.id}`);
      reload();
    } catch (err) { setProblem(err.message); }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between">
        <Tabs
          tabs={[
            { id: 'all', label: `All ${rows.length}` },
            ...Object.keys(CHANNEL_LABEL).map((c) => ({
              id: c, label: `${CHANNEL_LABEL[c]} ${counts[c] ?? 0}`,
            })),
          ]}
          active={channel}
          onChange={setChannel}
        />
        <button className="btn btn-primary" onClick={() => setEditing({ channel: channel === 'all' ? 'whatsapp' : channel })}>
          <Icon name="add" size={16} /> New template
        </button>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      {!shown.length ? (
        <Empty>No templates yet.</Empty>
      ) : (
        <section className="card">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Channel</th><th>Message</th><th>Approved</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 545 }}>{t.name}</td>
                    <td><span className="badge">{CHANNEL_LABEL[t.channel] ?? t.channel}</span></td>
                    <td className="small muted" style={{ maxWidth: 420 }}>
                      {t.body.slice(0, 120)}{t.body.length > 120 ? '…' : ''}
                    </td>
                    <td>
                      <button
                        className="btn-sm"
                        onClick={async () => {
                          await api.patch(`/admin/templates/${t.id}`, { approved: t.approved ? 0 : 1 });
                          reload();
                        }}
                      >
                        {t.approved ? 'Approved' : 'Approve'}
                      </button>
                    </td>
                    <td className="num">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn-sm" onClick={() => setEditing(t)}>Edit</button>
                        <button className="btn-sm" onClick={() => remove(t)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editing && spec && (
        <TemplateBuilder
          template={editing}
          spec={spec}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
          onError={setProblem}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- builder */

function TemplateBuilder({ template, spec, onClose, onSaved, onError }) {
  const making = !template.id;
  const channel = template.channel ?? 'whatsapp';
  const rules = spec.channels[channel] ?? {};

  const [draft, setDraft] = useState(() => ({
    channel,
    name: template.name ?? '',
    subject: template.subject ?? '',
    body: template.body ?? '',
    components: (() => {
      const saved = (() => {
        try { return JSON.parse(template.components || 'null') ?? {}; }
        catch { return {}; }
      })();
      /* Seeded, not just displayed. The language select fell back to 'en' for
         its value while the draft held nothing, so the screen said English and
         the validator said "say which language this is in" — a form arguing
         with itself about a field the person had not touched. */
      return channel === 'whatsapp' ? { language: 'en', ...saved } : saved;
    })(),
  }));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  /* A patch object rather than a (key, value) pair. The keys are then keys
     rather than quoted strings, which also keeps `language` from being read as
     an icon name by the glyph scanner. */
  const setPart = (patch) => setDraft((d) => ({ ...d, components: { ...d.components, ...patch } }));

  /* The preview and the problems come from the server, debounced, so what the
     screen shows and what the save allows are the same answer. */
  useEffect(() => {
    const timer = setTimeout(async () => {
      try { setPreview(await api.post('/admin/templates/preview', draft)); }
      catch { /* a failed preview is not worth an error banner mid-typing */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [draft]);

  const problemsFor = (field) => (preview?.problems ?? []).filter((p) => p.field === field);

  const save = async () => {
    setBusy(true);
    try {
      if (making) await api.post('/admin/templates', draft);
      else await api.patch(`/admin/templates/${template.id}`, draft);
      onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  const Field = ({ field, label, hint, children }) => (
    <div className="field">
      <label>{label}</label>
      {children}
      {problemsFor(field).map((p) => <p key={p.message} className="err-text">{p.message}</p>)}
      {hint && !problemsFor(field).length && <p className="hint">{hint}</p>}
    </div>
  );

  return (
    <Modal
      title={making ? `New ${CHANNEL_LABEL[channel]} template` : template.name}
      subtitle={CHANNEL_LABEL[channel]}
      onClose={onClose}
      wide
    >
      <div className="tmpl-build">
        <div className="stack" style={{ gap: 2 }}>
          {/* ------------------------------------------------ basic details */}
          <h4 className="muted">Basic details</h4>

          <Field field="name" label="Name" hint={rules.name_hint}>
            <input value={draft.name} onChange={set('name')} placeholder="sip_review_reminder" autoFocus />
          </Field>

          {channel === 'whatsapp' && (
            <>
              <div className="field-row">
                <Field field="category" label="Category">
                  <select
                    value={draft.components.category ?? ''}
                    onChange={(e) => setPart({ category: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {(rules.categories ?? []).map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                  {/* Meta prices and gates by category, so the note is worth the
                      space: picking Marketing where Utility was meant needs an
                      opt-in the client may not have given. */}
                  <p className="hint">
                    {(rules.categories ?? []).find((c) => c.key === draft.components.category)?.note ?? ' '}
                  </p>
                </Field>

                <Field field="language" label="Language">
                  <select
                    value={draft.components.language ?? 'en'}
                    onChange={(e) => setPart({ language: e.target.value })}
                  >
                    <option value="en">English</option>
                    <option value="en_GB">English (UK)</option>
                    <option value="hi">Hindi</option>
                    <option value="mr">Marathi</option>
                    <option value="gu">Gujarati</option>
                    <option value="ta">Tamil</option>
                    <option value="te">Telugu</option>
                  </select>
                </Field>
              </div>

              {/* ------------------------------------------------------ header */}
              <h4 className="muted">Header</h4>
              <div className="field-row">
                <Field field="header" label="Type">
                  <select
                    value={draft.components.header?.type ?? 'none'}
                    onChange={(e) => setPart({ header: { ...draft.components.header, type: e.target.value } })}
                  >
                    {(rules.header?.types ?? []).map((t) => (
                      <option key={t} value={t}>{t === 'none' ? 'No header' : t}</option>
                    ))}
                  </select>
                </Field>

                {draft.components.header?.type === 'text' && (
                  <Field field="header" label="Header text" hint={`Up to ${rules.header?.max} characters, one merge field.`}>
                    <input
                      value={draft.components.header?.text ?? ''}
                      onChange={(e) => setPart({ header: { ...draft.components.header, text: e.target.value } })}
                      maxLength={rules.header?.max}
                    />
                  </Field>
                )}
              </div>
            </>
          )}

          {channel === 'email' && (
            <Field field="subject" label="Subject">
              <input value={draft.subject} onChange={set('subject')} maxLength={rules.subject?.max} />
            </Field>
          )}

          {/* -------------------------------------------------------- body */}
          <h4 className="muted">Body</h4>
          <Field
            name="body"
            label="Message"
            hint={rules.body?.max ? `${draft.body.length} of ${rules.body.max} characters.` : null}
          >
            <textarea
              value={draft.body}
              onChange={set('body')}
              rows={channel === 'sms' ? 4 : 6}
              style={{ width: '100%' }}
            />
          </Field>

          <div className="row wrap" style={{ gap: 5 }}>
            <span className="tiny muted">Insert:</span>
            {spec.merge_fields.map((f) => (
              <button
                key={f.key}
                type="button"
                className="btn-sm"
                onClick={() => setDraft((d) => ({ ...d, body: `${d.body}{{${f.key}}}` }))}
              >
                {f.label}
              </button>
            ))}
          </div>

          {channel === 'sms' && preview?.sms && (
            /* The billing fact, next to the thing that causes it. A rupee sign
               or a curly quote pasted from Word pushes the whole message into
               unicode, where a segment is 70 characters rather than 160 — and
               the invoice, not the screen, is where that is usually noticed. */
            <p className={`hint ${preview.sms.segments > 1 ? 'err-text' : ''}`}>
              {preview.sms.characters} characters ·{' '}
              {preview.sms.segments} segment{preview.sms.segments === 1 ? '' : 's'}
              {preview.sms.unicode && ' · unicode, so 70 characters per segment instead of 160'}
            </p>
          )}

          {channel === 'whatsapp' && (
            <>
              {/* ----------------------------------------------------- footer */}
              <h4 className="muted">Footer</h4>
              <Field field="footer" label="Footer" hint={`Up to ${rules.footer?.max} characters. No merge fields — Meta does not allow them here.`}>
                <input
                  value={draft.components.footer ?? ''}
                  onChange={(e) => setPart({ footer: e.target.value })}
                  maxLength={rules.footer?.max}
                  placeholder="Reply STOP to opt out"
                />
              </Field>

              {/* ---------------------------------------------------- buttons */}
              <h4 className="muted">Buttons</h4>
              <Buttons
                buttons={draft.components.buttons ?? []}
                rules={rules.buttons ?? {}}
                problems={problemsFor('buttons')}
                onChange={(b) => setPart({ buttons: b })}
              />
            </>
          )}
        </div>

        {/* ------------------------------------------------------- preview */}
        <div>
          <h4 className="muted">Preview</h4>
          <Preview channel={channel} draft={draft} preview={preview} />

          {channel === 'whatsapp' && preview?.meta && (
            <details className="tmpl-meta">
              <summary className="tiny muted">What Meta is sent</summary>
              {/* The translation from our named fields to Meta's numbered ones
                  is the part most likely to be wrong, and reading it costs
                  nothing next to having a template rejected. */}
              <pre className="tiny">{JSON.stringify(preview.meta, null, 2)}</pre>
            </details>
          )}
        </div>
      </div>

      <div className="row-between" style={{ marginTop: 14 }}>
        <span className="tiny muted">
          {preview && !preview.ok
            ? `${preview.problems.length} thing${preview.problems.length === 1 ? '' : 's'} to fix`
            : 'Ready to save'}
        </span>
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !preview?.ok} onClick={save}>
            {busy ? <Spinner /> : making ? 'Create template' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- buttons */

/**
 * WhatsApp buttons.
 *
 * Two kinds, with different limits: up to three quick replies, up to two that
 * do something. The counts are shown rather than the controls silently
 * stopping, because a disabled button with no explanation reads as a bug.
 */
function Buttons({ buttons, rules, problems, onChange }) {
  const quick = buttons.filter((b) => b.type === 'quick_reply').length;
  const cta = buttons.length - quick;

  const add = (type) => onChange([...buttons, { type, text: '' }]);
  const edit = (i, patch) => onChange(buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <div className="stack" style={{ gap: 6 }}>
      {buttons.map((b, i) => (
        <div className="row" key={i} style={{ gap: 6, alignItems: 'center' }}>
          <span className="badge">{b.type === 'quick_reply' ? 'Reply' : b.type === 'url' ? 'Link' : 'Call'}</span>
          <input
            value={b.text}
            onChange={(e) => edit(i, { text: e.target.value })}
            placeholder="Button label"
            maxLength={rules.label_max}
            style={{ flex: 1 }}
          />
          {b.type === 'url' && (
            <input
              value={b.url ?? ''}
              onChange={(e) => edit(i, { url: e.target.value })}
              placeholder="https://"
              style={{ flex: 1 }}
            />
          )}
          {b.type === 'phone' && (
            <input
              value={b.phone ?? ''}
              onChange={(e) => edit(i, { phone: e.target.value })}
              placeholder="+91…"
              style={{ flex: 1 }}
            />
          )}
          <button type="button" className="btn-sm" onClick={() => onChange(buttons.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}

      {problems.map((p) => <p key={p.message} className="err-text">{p.message}</p>)}

      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn-sm" disabled={quick >= rules.quick_reply_max} onClick={() => add('quick_reply')}>
          Quick reply {quick}/{rules.quick_reply_max}
        </button>
        <button type="button" className="btn-sm" disabled={cta >= rules.cta_max} onClick={() => add('url')}>
          Link {cta}/{rules.cta_max}
        </button>
        <button type="button" className="btn-sm" disabled={cta >= rules.cta_max} onClick={() => add('phone')}>
          Call
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- preview */

/**
 * What the client will see.
 *
 * Drawn as the channel draws it — a WhatsApp bubble, an inbox row, a phone
 * message — because a template is judged by how it lands, and a preview shown
 * as a form field tells nobody whether the footer is doing its job.
 */
function Preview({ channel, draft, preview }) {
  const r = preview?.rendered ?? {};
  const buttons = draft.components?.buttons ?? [];

  if (channel === 'whatsapp') {
    return (
      <div className="wa-phone">
        <div className="wa-bubble">
          {r.header && <div className="wa-header">{r.header}</div>}
          {draft.components?.header?.type && !['none', 'text'].includes(draft.components.header.type) && (
            <div className="wa-media">{draft.components.header.type}</div>
          )}
          <div className="wa-body">{r.body || <span className="muted">Your message…</span>}</div>
          {r.footer && <div className="wa-footer">{r.footer}</div>}
          <div className="wa-time">now</div>
        </div>
        {buttons.length > 0 && (
          <div className="wa-buttons">
            {buttons.map((b, i) => (
              <div className="wa-button" key={i}>
                {b.type === 'url' && <Icon name="open_in_new" size={13} />}
                {b.type === 'phone' && <Icon name="call" size={13} />}
                {b.text || 'Button'}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (channel === 'sms') {
    return (
      <div className="wa-phone">
        <div className="wa-bubble is-sms">
          <div className="wa-body">{r.body || <span className="muted">Your message…</span>}</div>
          <div className="wa-time">now</div>
        </div>
      </div>
    );
  }

  return (
    <div className="mail-preview">
      <div className="mail-head">
        <strong>{r.subject || <span className="muted">Subject</span>}</strong>
        <span className="tiny muted">Bonanza Portfolio Ltd.</span>
      </div>
      <div className="mail-body" dangerouslySetInnerHTML={{ __html: r.body || '' }} />
    </div>
  );
}
