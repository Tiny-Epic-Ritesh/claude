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
import RichText from '../../components/RichText.jsx';

/* The rich editor is addressed by id so a merge field can be inserted at the
   caret rather than appended to the markup. */
const BODY_ID = 'tmpl-body';

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
            { key: 'all', label: `All ${rows.length}` },
            ...Object.keys(CHANNEL_LABEL).map((c) => ({
              key: c, label: `${CHANNEL_LABEL[c]} ${counts[c] ?? 0}`,
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

/**
 * A labelled control, with whatever the server says is wrong with it.
 *
 * Declared here rather than inside TemplateBuilder. A component defined inside
 * another component is a new function every render, so React reads it as a new
 * type, unmounts the subtree and mounts a replacement -- which destroys the
 * input and takes the caret with it. The builder could not be typed into at
 * all until this moved out, and nothing caught it because a test that sets a
 * value in one shot survives a remount and only real typing does not.
 */
function Field({ problems = [], label, hint, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {problems.map((p) => <p key={p.message} className="err-text">{p.message}</p>)}
      {hint && !problems.length && <p className="hint">{hint}</p>}
    </div>
  );
}

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

  /* Only what is still sendable. The send route re-checks approval and expiry
     at the moment of sending, so offering a withdrawn document here would be
     offering something that fails later, quietly, to a client. */
  const [library, setLibrary] = useState([]);
  useEffect(() => {
    if (channel !== 'email') return;
    api.get('/admin/content?status=approved')
      .then((rows) => setLibrary(rows.filter((r) => !r.expired)))
      .catch(() => setLibrary([]));
  }, [channel]);

  const intentNote = (rules.intents ?? []).find((i) => i.key === draft.components.intent)?.note;

  /* Only the senders this user may send under. Bigul and Bonanza are separate
     Principal Entities, so the list is already the book boundary. */
  const [headers, setHeaders] = useState([]);
  useEffect(() => {
    if (channel !== 'sms') return;
    api.get('/admin/dlt-headers').then(setHeaders).catch(() => setHeaders([]));
  }, [channel]);

  const dlt = draft.components.dlt ?? {};
  const setDlt = (patch) => setPart({ dlt: { ...dlt, ...patch } });
  const dltNote = (rules.dlt?.categories ?? []).find((c) => c.key === dlt.category)?.note;

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

  /**
   * Put a merge field where the caret is.
   *
   * A plain textarea has no caret we track, so it appends -- which is what it
   * did before and is fine for a short SMS. The rich editor does have one, and
   * appending to its innerHTML would drop the text outside the last paragraph
   * where it renders in the wrong place and cannot be edited normally.
   * execCommand fires the editor's own input handler, so the draft updates
   * through the same path typing does.
   */
  const insertMerge = (key) => {
    const token = `{{${key}}}`;
    if (channel !== 'email') {
      setDraft((d) => ({ ...d, body: `${d.body}${token}` }));
      return;
    }
    const el = document.getElementById(BODY_ID);
    if (!el) return;
    el.focus();
    // eslint-disable-next-line no-restricted-syntax
    document.execCommand('insertText', false, token);
  };

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

          <Field problems={problemsFor('name')} label="Name" hint={rules.name_hint}>
            <input value={draft.name} onChange={set('name')} placeholder="sip_review_reminder" autoFocus />
          </Field>

          {channel === 'whatsapp' && (
            <>
              <div className="field-row">
                <Field problems={problemsFor('category')} label="Category">
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

                <Field problems={problemsFor('language')} label="Language">
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
                <Field problems={problemsFor('header')} label="Type">
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
                  <Field problems={problemsFor('header')} label="Header text" hint={`Up to ${rules.header?.max} characters, one merge field.`}>
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
            <>
              {/* Not a label. The send path already runs
                  checkConsent(lead, 'email', intent), which suppresses a
                  marketing send to a lead who opted out and lets a KYC or
                  statement through. Declared here rather than at send time so
                  a campaign cannot be posted as "service" to get past it. */}
              <Field problems={problemsFor('intent')} label="What kind of email">
                <select
                  value={draft.components.intent ?? ''}
                  onChange={(e) => setPart({ intent: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {(rules.intents ?? []).map((i) => (
                    <option key={i.key} value={i.key}>{i.label}</option>
                  ))}
                </select>
              </Field>
              {intentNote && <p className="hint">{intentNote}</p>}

              <Field problems={problemsFor('subject')} label="Subject">
                <input value={draft.subject} onChange={set('subject')} maxLength={rules.subject?.max} />
              </Field>

              <Field
                field="preheader"
                label="Preheader"
                hint={`The grey line an inbox shows after the subject. Up to ${rules.preheader?.max ?? 140} characters.`}
              >
                <input
                  value={draft.components.preheader ?? ''}
                  onChange={(e) => setPart({ preheader: e.target.value })}
                  maxLength={rules.preheader?.max}
                  placeholder="Your quarterly review is ready"
                />
              </Field>

              <Field problems={problemsFor('reply_to')} label="Replies go to" hint="Leave blank to use the sending address.">
                <input
                  value={draft.components.reply_to ?? ''}
                  onChange={(e) => setPart({ reply_to: e.target.value })}
                  placeholder="rm@bonanza.com"
                />
              </Field>
            </>
          )}

          {/* -------------------------------------------------------- body */}
          <h4 className="muted">Body</h4>
          <Field
            field="body"
            label="Message"
            hint={rules.body?.max ? `${draft.body.length} of ${rules.body.max} characters.` : null}
          >
            {channel === 'email' ? (
              <RichText
                id={BODY_ID}
                value={draft.body}
                onChange={(html) => setDraft((d) => ({ ...d, body: html }))}
                placeholder="Write the email…"
                rows={12}
              />
            ) : (
              <textarea
                value={draft.body}
                onChange={set('body')}
                rows={channel === 'sms' ? 4 : 6}
                style={{ width: '100%' }}
              />
            )}
          </Field>

          <div className="row wrap" style={{ gap: 5 }}>
            <span className="tiny muted">Insert:</span>
            {spec.merge_fields.map((f) => (
              <button
                key={f.key}
                type="button"
                className="btn-sm"
                /* onMouseDown, not onClick: clicking blurs the editor and the
                   caret is gone before a click handler runs. Same reason the
                   RichText toolbar does it. */
                onMouseDown={(e) => { e.preventDefault(); insertMerge(f.key); }}
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
              {' '}of {preview.sms.per_segment}
              {preview.sms.unicode && ' · unicode, which halves what fits'}
            </p>
          )}

          {channel === 'sms' && (
            <>
              <h4 className="muted">DLT registration</h4>
              <p className="hint">
                An Indian operator delivers a commercial SMS only when the sender, the
                template id and the text are all registered together. Everything below is
                checked against what you have written before it can be saved.
              </p>

              <div className="field-row">
                <Field problems={problemsFor('header')} label="Sender">
                  <select value={dlt.header ?? ''} onChange={(e) => setDlt({ header: e.target.value })}>
                    <option value="">Choose…</option>
                    {headers.map((h) => (
                      <option key={h.header} value={h.header}>{h.header} · {h.org_name ?? h.sales_org}</option>
                    ))}
                  </select>
                </Field>

                <Field problems={problemsFor('category')} label="DLT category">
                  <select value={dlt.category ?? ''} onChange={(e) => setDlt({ category: e.target.value })}>
                    <option value="">Choose…</option>
                    {(rules.dlt?.categories ?? []).map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                </Field>
              </div>
              {dltNote && <p className="hint">{dltNote}</p>}

              <div className="field-row">
                <Field
                  problems={problemsFor('template_id')}
                  label="DLT template id"
                  hint="The long number the portal gives you once it approves the text."
                >
                  <input
                    value={dlt.template_id ?? ''}
                    onChange={(e) => setDlt({ template_id: e.target.value })}
                    placeholder="1107160000000000000"
                  />
                </Field>

                <Field problems={problemsFor('status')} label="Registration">
                  <select value={dlt.status ?? 'draft'} onChange={(e) => setDlt({ status: e.target.value })}>
                    <option value="draft">Not registered yet</option>
                    <option value="submitted">Submitted for approval</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </Field>
              </div>

              {/* The text to register, ready to copy. Retyping it on the portal
                  is exactly how the registered text and the sent text come to
                  differ, which is the failure everything here exists to catch. */}
              {preview?.dlt && (
                <Field problems={[]} label="Register this exact text">
                  <div className="dlt-text">
                    <code>{preview.dlt.text || 'Write the message first.'}</code>
                    <button
                      type="button"
                      className="btn-sm"
                      onClick={() => navigator.clipboard?.writeText(preview.dlt.text ?? '')}
                    >
                      <Icon name="content_copy" size={14} /> Copy
                    </button>
                  </div>
                </Field>
              )}

              <Field
                problems={problemsFor('registered_text')}
                label="What the portal approved"
                hint="Paste it back once approved and it is compared with yours, character for character."
              >
                <textarea
                  value={dlt.registered_text ?? ''}
                  onChange={(e) => setDlt({ registered_text: e.target.value })}
                  rows={3}
                  style={{ width: '100%' }}
                  placeholder="Paste the approved text from the DLT portal"
                />
              </Field>
            </>
          )}

          {channel === 'email' && (
            <>
              <h4 className="muted">Attachments</h4>
              <Attachments
                chosen={draft.components.attachments ?? []}
                library={library}
                problems={problemsFor('attachments')}
                onChange={(attachments) => setPart({ attachments })}
              />
            </>
          )}

          {channel === 'whatsapp' && (
            <>
              {/* ----------------------------------------------------- footer */}
              <h4 className="muted">Footer</h4>
              <Field problems={problemsFor('footer')} label="Footer" hint={`Up to ${rules.footer?.max} characters. No merge fields — Meta does not allow them here.`}>
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

/**
 * Documents attached by reference, never by copy.
 *
 * content_items already carries version, expiry and approval state, so a
 * template that points at "SIP factsheet" sends whatever the current approved
 * version is and stops sending when it expires. A copy taken at the moment the
 * template was written would go stale without anybody being told, which is the
 * failure this is shaped to avoid.
 */
function Attachments({ chosen, library, problems, onChange }) {
  const ids = chosen.map((a) => Number(a.content_id ?? a));
  const toggle = (id) => onChange(
    ids.includes(id)
      ? chosen.filter((a) => Number(a.content_id ?? a) !== id)
      : [...chosen, { content_id: id }],
  );

  if (!library.length) {
    return <p className="hint">Nothing in the content library is approved and current.</p>;
  }

  return (
    <>
      <div className="stack" style={{ gap: 1 }}>
        {library.map((item) => (
          <label key={item.id} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={ids.includes(item.id)} onChange={() => toggle(item.id)} />
            <Icon name="attach_file" size={14} />
            <span>{item.name}</span>
            <span className="tiny muted">
              {item.type} · v{item.version}
              {item.expiring_soon ? ' · expires within 30 days' : ''}
            </span>
          </label>
        ))}
      </div>
      {problems.map((p) => <p key={p.message} className="err-text">{p.message}</p>)}
    </>
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

  return <MailPreview draft={draft} rendered={r} />;
}

/**
 * An email, both halves of it.
 *
 * Every email goes out as formatted HTML and as a plain-text alternative, and
 * the text half is generated rather than written -- so it is the half that
 * goes wrong without anybody seeing. Shown behind a toggle rather than left to
 * be discovered by a client reading mail on something that will not render the
 * other one.
 *
 * The body is the server's sanitised output, so what is drawn here is what
 * would be sent rather than what was typed.
 */
function MailPreview({ draft, rendered: r }) {
  const [plain, setPlain] = useState(false);
  const marketing = draft.components?.intent === 'marketing';

  return (
    <div className="mail-preview">
      <div className="mail-head">
        <strong>{r.subject || <span className="muted">Subject</span>}</strong>
        {r.preheader && <span className="tiny muted">{r.preheader}</span>}
        <span className="tiny muted">Bonanza Portfolio Ltd.</span>
      </div>

      {plain
        ? <pre className="mail-body is-plain">{r.text || ''}</pre>
        : <div className="mail-body" dangerouslySetInnerHTML={{ __html: r.body || '' }} />}

      {marketing && (
        /* Appended by the sender and refused if switched off, so it belongs in
           the preview even though it is not in the body. */
        <div className="mail-unsub tiny muted">Unsubscribe</div>
      )}

      <div className="row" style={{ gap: 4, marginTop: 6 }}>
        <button type="button" className={`btn-sm ${plain ? '' : 'is-on'}`} onClick={() => setPlain(false)}>
          Formatted
        </button>
        <button type="button" className={`btn-sm ${plain ? 'is-on' : ''}`} onClick={() => setPlain(true)}>
          Plain text
        </button>
      </div>
    </div>
  );
}
