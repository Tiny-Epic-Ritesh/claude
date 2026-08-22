/**
 * The modals behind the action menu.
 *
 * One file, one export, so both the lead record and the lead list get identical
 * behaviour from `<ActionModal>` without either page knowing what a WhatsApp
 * send involves.
 *
 * Everything here opens over the page. Nothing navigates away — an RM acting on
 * a lead should not lose the lead, and on the list they should not lose their
 * filters and scroll position to send one message.
 */

import { useState } from 'react';
import { api, money } from '../api.js';
import { useApi, Modal, Spinner, ErrorBanner, Loading, Icon } from '../components/ui.jsx';

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };

export default function ActionModal({ state, session, onClose, onDone, onNotice }) {
  if (!state) return null;
  const { kind, lead, channel, ids } = state;

  const common = { lead, session, onClose, onDone, onNotice };
  const bulk = { ids, onClose, onDone, onNotice };

  switch (kind) {
    case 'bulk_owner': return <BulkOwnerModal {...bulk} />;
    case 'bulk_stage': return <BulkStageModal {...bulk} />;
    case 'bulk_message': return <BulkMessageModal {...bulk} channel={channel} />;
    case 'message': return <MessageModal {...common} channel={channel} />;
    case 'task': return <TaskModal {...common} />;
    case 'case': return <CaseModal {...common} />;
    case 'card': return <CardModal {...common} />;
    case 'stage': return <StageModal {...common} />;
    case 'owner': return <OwnerModal {...common} />;
    case 'delete': return <DeleteModal {...common} />;
    default: return null;
  }
}

/* ------------------------------------------------------------ message */

/**
 * Send on a channel.
 *
 * The intent switch is the important control. A client who opted out of
 * marketing can still be sent a KYC reminder, and the API enforces exactly
 * that split — so the RM has to say which kind of message this is, and the
 * choice is recorded rather than assumed.
 */
function MessageModal({ lead, channel, onClose, onDone, onNotice }) {
  const [meta] = useApi('/meta');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [intent, setIntent] = useState('service');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const templates = (meta?.templates ?? []).filter((t) => t.channel === channel);
  const gate = lead.contactability?.[channel];
  const marketingBlocked = gate && !gate.marketing;
  const allBlocked = gate && !gate.service && !gate.marketing;

  function applyTemplate(id) {
    setTemplateId(id);
    const t = templates.find((x) => String(x.id) === String(id));
    if (!t) return;
    setBody((t.body || '').replace(/\{\{name\}\}/g, lead.name));
    if (t.subject) setSubject(t.subject);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post(`/leads/${lead.id}/message`, {
        channel, body, subject: subject || undefined,
        template_id: templateId || undefined, intent,
      });
      onNotice?.(`${CHANNEL_LABEL[channel]} sent to ${lead.name}.`);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal
      title={`Send ${CHANNEL_LABEL[channel]}`}
      subtitle={`To ${lead.name} · ${channel === 'email' ? (lead.email || 'no email') : (lead.mobile || 'no mobile')}`}
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        {allBlocked && (
          <div className="glass notice notice-warn span-2">
            <Icon name="block" />
            <div><strong>Cannot send.</strong> {gate.reason}</div>
          </div>
        )}

        <div className="span-2">
          <span className="field-label">What kind of message is this?</span>
          <div className="intent-switch">
            <button
              type="button"
              className={`intent-opt ${intent === 'service' ? 'is-on' : ''}`}
              onClick={() => setIntent('service')}
            >
              <Icon name="support_agent" />
              <span><strong>Service</strong><em>KYC, statements, dues, case updates</em></span>
            </button>
            <button
              type="button"
              className={`intent-opt ${intent === 'marketing' ? 'is-on' : ''} ${marketingBlocked ? 'is-blocked' : ''}`}
              disabled={marketingBlocked}
              title={marketingBlocked ? gate.reason : undefined}
              onClick={() => setIntent('marketing')}
            >
              <Icon name="campaign" />
              <span>
                <strong>Marketing</strong>
                <em>{marketingBlocked ? gate.reason : 'Offers, product pitches, campaigns'}</em>
              </span>
            </button>
          </div>
        </div>

        {templates.length > 0 && (
          <label className="span-2">
            <span>Template <span className="muted">(optional)</span></span>
            <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">Write it myself</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}

        {channel === 'email' && (
          <label className="span-2">
            <span>Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} />
          </label>
        )}

        <label className="span-2">
          <span>Message</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} required
            placeholder={`Hello ${(lead.name || '').split(' ')[0]}, …`} />
          <small className="muted">{body.length} characters</small>
        </label>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || allBlocked || !body.trim()}>
            {busy ? <Spinner /> : `Send ${CHANNEL_LABEL[channel]}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------------- task */

function TaskModal({ lead, onClose, onDone, onNotice }) {
  const [form, setForm] = useState({
    title: '', kind: 'Follow-up', due_at: '', priority: 'Medium',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // A follow-up with no date is a note. Default to tomorrow morning so the
  // common case needs no thought.
  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/tasks', {
        lead_id: lead.id,
        title: form.title,
        kind: form.kind,
        due_at: (form.due_at || tomorrow()).replace('T', ' '),
        priority: form.priority,
      });
      onNotice?.('Task created.');
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Create task" subtitle={`On ${lead.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        <label className="span-2">
          <span>What needs doing</span>
          <input value={form.title} onChange={set('title')} required autoFocus
            placeholder="Call back about the PMS proposal" />
        </label>
        <label>
          <span>Type</span>
          <select value={form.kind} onChange={set('kind')}>
            {['Follow-up', 'Call', 'Meeting', 'Document', 'Other'].map((k) => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select value={form.priority} onChange={set('priority')}>
            {['High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="span-2">
          <span>Due</span>
          <input type="datetime-local" value={form.due_at || tomorrow()} onChange={set('due_at')} />
        </label>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.title.trim()}>
            {busy ? <Spinner /> : 'Create task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------------- case */

function CaseModal({ lead, onClose, onDone, onNotice }) {
  const [meta] = useApi('/meta');
  const [form, setForm] = useState({ subject: '', description: '', priority: 'Medium', category_id: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/tickets', {
        lead_id: lead.id,
        subject: form.subject,
        description: form.description,
        priority: form.priority,
        category_id: form.category_id || undefined,
      });
      onNotice?.('Case raised and routed to Customer Care.');
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Raise a case" subtitle={`For ${lead.name}`} onClose={onClose} wide>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        <label className="span-2">
          <span>Subject</span>
          <input value={form.subject} onChange={set('subject')} required autoFocus />
        </label>
        <label>
          <span>Priority</span>
          <select value={form.priority} onChange={set('priority')}>
            {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label>
          <span>Category</span>
          <select value={form.category_id} onChange={set('category_id')}>
            <option value="">Uncategorised</option>
            {(meta?.ticket_categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="span-2">
          <span>What happened</span>
          <textarea value={form.description} onChange={set('description')} rows={4} />
        </label>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.subject.trim()}>
            {busy ? <Spinner /> : 'Raise case'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------- product card */

function CardModal({ lead, onClose, onDone, onNotice }) {
  const [meta] = useApi('/meta');
  const [detail] = useApi(`/leads/${lead.id}`);
  const [productId, setProductId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!meta || !detail) return <Modal title="Add a product interest" onClose={onClose}><Loading /></Modal>;

  // Only products the lead is not already engaged on — offering a duplicate
  // is how a lead ends up with two cards for the same product.
  const engaged = new Set(detail.cards.filter((c) => c.state !== 'INACTIVE').map((c) => c.product_type_id));
  const available = (meta.products ?? []).filter((p) => !engaged.has(p.id));

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const card = detail.cards.find((c) => String(c.product_type_id) === String(productId));
      if (!card) throw new Error('That product is not available on this lead');
      await api.post(`/cards/${card.id}/state`, { state: 'EXPLORING', note: 'Interest recorded from the action menu' });
      onNotice?.('Product interest recorded.');
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Add a product interest" subtitle={`On ${lead.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        {available.length === 0 ? (
          <p className="span-2 muted">
            {lead.name} is already engaged on every product available to your sales org.
          </p>
        ) : (
          <label className="span-2">
            <span>Which product?</span>
            <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
              <option value="">Choose…</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.min_investment > 0 ? ` · from ${money(p.min_investment)}` : ''}
                </option>
              ))}
            </select>
            <small className="muted">The card moves to Exploring and appears on the lead immediately.</small>
          </label>
        )}
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !productId}>
            {busy ? <Spinner /> : 'Record interest'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------- stage */

function StageModal({ lead, onClose, onDone, onNotice }) {
  const [meta] = useApi('/meta/fields/lead');
  const [stage, setStage] = useState(lead.stage ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const values = meta?.fields.find((f) => f.api_name === 'stage')?.values ?? [];

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.patch(`/leads/${lead.id}`, { stage });
      onNotice?.(`Stage moved to ${stage}.`);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Change stage" subtitle={lead.name} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        <label className="span-2">
          <span>Stage</span>
          <select value={stage} onChange={(e) => setStage(e.target.value)} required>
            {values.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
          <small className="muted">Stage changes are recorded in the lead's history with your name.</small>
        </label>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || stage === lead.stage}>
            {busy ? <Spinner /> : 'Change stage'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------- owner */

function OwnerModal({ lead, onClose, onDone, onNotice }) {
  const [meta] = useApi('/meta');
  const [ownerId, setOwnerId] = useState(lead.owner_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.patch(`/leads/${lead.id}`, { owner_id: ownerId });
      const who = (meta?.users ?? []).find((u) => String(u.id) === String(ownerId));
      onNotice?.(`${lead.name} reassigned${who ? ` to ${who.name}` : ''}.`);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Change owner" subtitle={lead.name} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        <label className="span-2">
          <span>New owner</span>
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required>
            <option value="">Unassigned</option>
            {(meta?.users ?? []).map((u) => (
              <option key={u.id} value={u.id}>{u.name} · {u.role.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <small className="muted">Only colleagues in your sales org are listed.</small>
        </label>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || String(ownerId) === String(lead.owner_id)}>
            {busy ? <Spinner /> : 'Reassign'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------- delete */

function DeleteModal({ lead, onClose, onDone, onNotice }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.del(`/leads/${lead.id}`);
      onNotice?.(`${lead.name} moved to the recycle bin.`);
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Delete lead" subtitle={lead.name} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        <div className="glass notice notice-warn span-2">
          <Icon name="delete" />
          <div>
            This is a soft delete — {lead.name} goes to the recycle bin with every
            activity, card and case intact, and an administrator can restore them.
          </div>
        </div>
        {/* Typing the name is friction on purpose. A menu item one click from
            "Send WhatsApp" should not delete a client record on a misclick. */}
        <label className="span-2">
          <span>Type <strong>{lead.name}</strong> to confirm</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
        </label>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-danger" disabled={busy || confirm !== lead.name}>
            {busy ? <Spinner /> : 'Delete lead'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* --------------------------------------------------------- bulk modals */

/**
 * Bulk reassign, bulk stage, bulk message.
 *
 * Each one loops the individual endpoint rather than inventing a bulk route,
 * for one reason: every per-lead guard — permission, org scope, consent — keeps
 * running. A dedicated bulk endpoint is where those checks get skipped "for
 * performance", and that is how 200 opted-out clients get a campaign message.
 *
 * The result is reported honestly: how many went, how many were refused, and
 * why. A bulk action that says "done" while silently dropping a third of the
 * selection is worse than one that fails.
 */
function BulkRunner({ ids, title, subtitle, children, onClose, onDone, onNotice, run, verb }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);

    const failures = [];
    let done = 0;
    for (const id of ids) {
      try {
        await run(id);
      } catch (err) {
        failures.push({ id, reason: err.message });
      }
      done += 1;
      setProgress(done);
    }

    setBusy(false);
    if (!failures.length) {
      onNotice?.(`${verb} ${ids.length} lead${ids.length === 1 ? '' : 's'}.`);
      onDone();
      return;
    }
    setResult({ ok: ids.length - failures.length, failures });
  }

  if (result) {
    return (
      <Modal title="Finished, with exceptions" onClose={onDone}>
        <div className="glass notice notice-warn">
          <Icon name="rule" />
          <div>
            <strong>{result.ok} succeeded, {result.failures.length} refused.</strong>
            <p className="tiny muted" style={{ margin: '4px 0 0' }}>
              Each refusal is a per-lead rule the bulk action did not override.
            </p>
          </div>
        </div>
        <ul className="bulk-failures">
          {result.failures.slice(0, 12).map((f) => (
            <li key={f.id}><code>#{f.id}</code> {f.reason}</li>
          ))}
        </ul>
        {result.failures.length > 12 && (
          <p className="tiny muted">…and {result.failures.length - 12} more.</p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onDone}>Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        {children}
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <><Spinner /> {progress ?? 0} of {ids.length}</> : `${verb} ${ids.length}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BulkOwnerModal({ ids, onClose, onDone, onNotice }) {
  const [meta] = useApi('/meta');
  const [ownerId, setOwnerId] = useState('');

  return (
    <BulkRunner
      ids={ids} onClose={onClose} onDone={onDone} onNotice={onNotice}
      title="Reassign owner" subtitle={`${ids.length} leads selected`} verb="Reassigned"
      run={(id) => api.patch(`/leads/${id}`, { owner_id: ownerId })}
    >
      <label className="span-2">
        <span>New owner</span>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required>
          <option value="">Choose…</option>
          {(meta?.users ?? []).map((u) => (
            <option key={u.id} value={u.id}>{u.name} · {u.role.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </label>
    </BulkRunner>
  );
}

function BulkStageModal({ ids, onClose, onDone, onNotice }) {
  const [meta] = useApi('/meta/fields/lead');
  const [stage, setStage] = useState('');
  const values = meta?.fields.find((f) => f.api_name === 'stage')?.values ?? [];

  return (
    <BulkRunner
      ids={ids} onClose={onClose} onDone={onDone} onNotice={onNotice}
      title="Change stage" subtitle={`${ids.length} leads selected`} verb="Moved"
      run={(id) => api.patch(`/leads/${id}`, { stage })}
    >
      <label className="span-2">
        <span>Stage</span>
        <select value={stage} onChange={(e) => setStage(e.target.value)} required>
          <option value="">Choose…</option>
          {values.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
        </select>
        <small className="muted">Every move is recorded in each lead's history.</small>
      </label>
    </BulkRunner>
  );
}

function BulkMessageModal({ ids, channel, onClose, onDone, onNotice }) {
  const [meta] = useApi('/meta');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [intent, setIntent] = useState('marketing');
  const templates = (meta?.templates ?? []).filter((t) => t.channel === channel);

  return (
    <BulkRunner
      ids={ids} onClose={onClose} onDone={onDone} onNotice={onNotice}
      title={`Send ${CHANNEL_LABEL[channel]}`} subtitle={`${ids.length} leads selected`} verb="Sent to"
      run={(id) => api.post(`/leads/${id}/message`, {
        channel, body, template_id: templateId || undefined, intent,
      })}
    >
      <div className="glass notice span-2">
        <Icon name="shield" />
        <div className="tiny">
          Leads who have opted out of marketing will be refused individually and
          listed at the end. Nothing here overrides a consent flag.
        </div>
      </div>

      <label className="span-2">
        <span>This send is</span>
        <select value={intent} onChange={(e) => setIntent(e.target.value)}>
          <option value="marketing">Marketing — offers, pitches, campaigns</option>
          <option value="service">Service — KYC, statements, dues</option>
        </select>
      </label>

      {templates.length > 0 && (
        <label className="span-2">
          <span>Template</span>
          <select
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              const t = templates.find((x) => String(x.id) === String(e.target.value));
              if (t) setBody(t.body || '');
            }}
          >
            <option value="">Write it myself</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}

      <label className="span-2">
        <span>Message</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} required />
        <small className="muted">
          {'{{name}}'} is replaced with each lead&apos;s own name.
        </small>
      </label>
    </BulkRunner>
  );
}
