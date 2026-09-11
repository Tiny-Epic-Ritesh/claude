/**
 * Messages — P3-21, phase 1.
 *
 * One-to-one conversations with colleagues. The rules are the server's
 * (engine/messaging.js) and this screen states them rather than enforcing
 * them: who may be messaged is whoever the people search returns, a lead is
 * drawn as the reader is allowed to see it, and a refusal is shown in the
 * server's own words.
 *
 * Three things are always on screen when they apply, because each changes
 * what somebody can do: the standing notice that compliance may read this
 * (Ritesh, 11 September), a frozen conversation's reason, and a suspension.
 *
 * A lead is asked for from inside a conversation, of the person in it. The
 * request is a card in the thread that the other person decides on the spot,
 * and it updates in place when they do.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, dateTime, parseTs, ROLE_LABEL } from '../api.js';
import { useApi, Loading, ErrorBanner, Empty, Modal, Spinner, Icon, Avatar } from '../components/ui.jsx';

const THREAD_POLL_MS = 5_000;
const LIST_POLL_MS = 30_000;
const WITHDRAW_MS = 15 * 60 * 1000;

const names = (people = []) => people.map((p) => p.name).join(', ') || 'Conversation';

const sentAt = (s) => {
  const t = parseTs(s);
  return t instanceof Date ? t.getTime() : Number(t) || 0;
};

export default function Messages() {
  const [search, setSearch] = useSearchParams();
  const openId = Number(search.get('c')) || null;
  const [list, { error: listError, reload: reloadList }] = useApi('/messages/conversations');
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) reloadList(); }, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [reloadList]);

  const choose = (id) => setSearch(id ? { c: String(id) } : {});

  if (listError && !list) return <ErrorBanner error={listError} />;
  if (!list) return <Loading label="Opening your messages…" />;

  const start = async (person) => {
    setProblem(null);
    try {
      const opened = await api.post('/messages/conversations', { user_id: person.id });
      setStarting(false);
      reloadList();
      choose(opened.id);
    } catch (err) { setProblem(err.message); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <p>
            Conversations with colleagues. A lead you mention stays on its own record, and the
            other person sees it only if they could open it anyway.
          </p>
        </div>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      {list.suspended && (
        <div className="glass notice notice-warn">
          <Icon name="block" />
          <div>
            <strong>Your messaging is suspended.</strong> {list.suspended} You can still read your
            conversations.
          </div>
        </div>
      )}

      <div className={`msg-layout ${openId ? 'is-open' : ''}`}>
        <aside className="card msg-side">
          <p className="msg-notice"><Icon name="shield" size={15} /> {list.notice}</p>

          {starting ? (
            <PeoplePicker onPick={start} onCancel={() => setStarting(false)} />
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setStarting(true)}
              disabled={Boolean(list.suspended)}
            >
              <Icon name="add" size={16} /> New conversation
            </button>
          )}

          <div className="msg-convos">
            {list.conversations.length === 0 && <Empty>No conversations yet.</Empty>}
            {list.conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                className="msg-convo"
                aria-current={c.id === openId ? 'true' : undefined}
                onClick={() => choose(c.id)}
              >
                <Avatar name={c.with[0]?.name ?? '?'} size={30} seed={String(c.with[0]?.id ?? c.id)} />
                <span className="msg-convo-body">
                  <span className="row-between" style={{ gap: 6 }}>
                    <strong className="small">{names(c.with)}</strong>
                    {c.unread > 0 && <span className="badge badge-accent">{c.unread}</span>}
                  </span>
                  <span className="tiny muted msg-preview">
                    {c.frozen_at && <Icon name="lock" size={12} />}
                    {c.last ? `${c.last.mine ? 'You: ' : ''}${c.last.preview}` : 'No messages yet'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="card msg-main">
          {openId ? (
            <Thread
              key={openId}
              id={openId}
              suspended={Boolean(list.suspended)}
              onBack={() => choose(null)}
              onChanged={reloadList}
              onProblem={setProblem}
            />
          ) : (
            <Empty>Choose a conversation, or start one.</Empty>
          )}
        </section>
      </div>
    </>
  );
}

/* ----------------------------------------------------------- people */

function PeoplePicker({ onPick, onCancel }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState(null);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api.get(`/messages/people?q=${encodeURIComponent(q)}`)
        .then((r) => { if (live) setPeople(r); })
        .catch(() => { if (live) setPeople([]); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <input
          autoFocus
          placeholder="Search colleagues"
          aria-label="Search colleagues"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="btn-ghost btn-sm" onClick={onCancel} aria-label="Cancel">
          <Icon name="close" size={16} />
        </button>
      </div>
      <span className="tiny muted">Only people your administrator lets you message are listed.</span>
      <div className="msg-pick">
        {(people ?? []).map((p) => (
          <button key={p.id} type="button" className="msg-convo" onClick={() => onPick(p)}>
            <Avatar name={p.name} size={26} seed={String(p.id)} />
            <span className="msg-convo-body">
              <strong className="small">{p.name}</strong>
              <span className="tiny muted msg-preview">{p.role_name} · {p.sales_org}</span>
            </span>
          </button>
        ))}
        {people && !people.length && <span className="tiny muted">Nobody you can message matches that.</span>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- thread */

function Thread({ id, suspended, onBack, onChanged, onProblem }) {
  const [convo, setConvo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const lastRead = useRef(0);
  const box = useRef(null);
  const shown = useRef(0);

  /* The whole newest page every time rather than only what is new: a card
     changes in place when the other person decides it, and a message can be
     withdrawn after it was fetched. Incremental fetching would show both
     stale. */
  const load = useCallback(async () => {
    try {
      const r = await api.get(`/messages/conversations/${id}/messages`);
      setConvo(r.conversation);
      setMessages(r.messages);
      setError(null);
      const newest = r.messages.at(-1)?.id ?? 0;
      if (newest > lastRead.current) {
        lastRead.current = newest;
        api.post(`/messages/conversations/${id}/read`, { last_id: newest }).then(onChanged).catch(() => {});
      }
    } catch (err) { setError(err.message); }
  }, [id, onChanged]);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, THREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Down to the newest, but only when something new arrived -- never on a poll
  // that changed nothing, which would yank somebody reading further up.
  useEffect(() => {
    if (messages.length > shown.current && box.current) box.current.scrollTop = box.current.scrollHeight;
    shown.current = messages.length;
  }, [messages.length]);

  const act = async (fn) => {
    onProblem(null);
    try { await fn(); await load(); onChanged(); } catch (err) { onProblem(err.message); }
  };

  if (error && !convo) return <ErrorBanner error={error} />;
  if (!convo) return <Loading />;

  const other = convo.with[0];
  const frozen = Boolean(convo.frozen_at);

  return (
    <>
      <div className="row msg-head">
        <button type="button" className="btn-ghost btn-sm msg-back" onClick={onBack} aria-label="Back to conversations">
          <Icon name="arrow_back" size={18} />
        </button>
        <Avatar name={other?.name ?? '?'} size={32} seed={String(other?.id ?? id)} />
        <div>
          <strong>{names(convo.with)}</strong>
          {other && <div className="tiny muted">{ROLE_LABEL[other.role] || other.role} · {other.sales_org}</div>}
        </div>
      </div>

      {frozen && (
        <div className="glass notice notice-warn">
          <Icon name="lock" />
          <div>
            <strong>Frozen by compliance.</strong> {convo.frozen_reason} Nothing more can be sent here
            until it is reopened.
          </div>
        </div>
      )}

      <div className="msg-thread" ref={box}>
        {messages.length === 0 && <Empty>No messages yet.</Empty>}
        {messages.map((m) => <MessageRow key={m.id} m={m} onAct={act} />)}
      </div>

      {!frozen && !suspended && (
        <Composer id={id} other={other} onSent={load} onProblem={onProblem} />
      )}
    </>
  );
}

function MessageRow({ m, onAct }) {
  if (m.kind === 'system') return <div className="msg-system">{m.body}</div>;
  if (m.transfer) return <TransferCard m={m} onAct={onAct} />;

  const recent = m.mine && !m.withdrawn && Date.now() - sentAt(m.created_at) < WITHDRAW_MS;
  return (
    <div className={`msg-bubble ${m.mine ? 'is-mine' : ''} ${m.withdrawn ? 'is-withdrawn' : ''}`}>
      {m.withdrawn ? 'Message withdrawn' : m.body}
      {m.lead && <LeadChip lead={m.lead} />}
      <div className="msg-meta">
        {!m.mine && <span>{m.sender_name}</span>}
        <span>{dateTime(m.created_at)}</span>
        {recent && (
          <button
            type="button"
            className="msg-meta-act"
            onClick={() => onAct(() => api.post(`/messages/message/${m.id}/withdraw`, {}))}
          >
            Withdraw
          </button>
        )}
      </div>
    </div>
  );
}

function LeadChip({ lead }) {
  if (lead.hidden) {
    return (
      <span className="msg-chip is-hidden" title="You cannot open this lead">
        <Icon name="lock" size={13} /> A lead you cannot open
      </span>
    );
  }
  return (
    <Link className="msg-chip" to={`/leads/${lead.id}`}>
      <Icon name="person" size={13} /> {lead.name}{lead.stage ? ` · ${lead.stage}` : ''}
    </Link>
  );
}

const STATUS_TONE = { Pending: 'badge-amber', Approved: 'badge-green', Rejected: 'badge-red' };

function TransferCard({ m, onAct }) {
  const t = m.transfer;
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const decide = (approve) => onAct(() => api.post(`/approvals/${t.approval_id}/decide`, {
    approve, reason: reason.trim() || undefined,
  }));

  return (
    <div className={`card msg-transfer ${m.mine ? 'is-mine' : ''}`}>
      <div className="row-between" style={{ gap: 8 }}>
        <strong className="small">
          <Icon name="swap_horiz" size={16} />{' '}
          {m.mine ? `You asked ${t.target_name} for a lead` : `${t.requested_by_name} asked for a lead`}
        </strong>
        <span className={`badge ${STATUS_TONE[t.status] ?? ''}`}>{t.status}</span>
      </div>

      {m.lead && <LeadChip lead={m.lead} />}
      <p className="small" style={{ margin: '6px 0 0' }}>{t.reason}</p>
      {t.status !== 'Pending' && t.decided_by_name && (
        <p className="tiny muted" style={{ margin: '4px 0 0' }}>
          {t.status} by {t.decided_by_name}{t.decision_reason ? `: ${t.decision_reason}` : ''}
        </p>
      )}

      {t.can_decide && !declining && (
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => setDeclining(true)}>Decline</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => decide(true)}>Approve the transfer</button>
        </div>
      )}
      {t.can_decide && declining && (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why not"
            aria-label="Why you are declining"
          />
          <small className="muted">{t.requested_by_name} sees this, so it has to tell them why.</small>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setDeclining(false)}>Cancel</button>
            <button type="button" className="btn btn-danger btn-sm" disabled={!reason.trim()} onClick={() => decide(false)}>
              Decline
            </button>
          </div>
        </div>
      )}
      {t.can_withdraw && (
        <button
          type="button"
          className="btn-ghost btn-sm"
          style={{ marginTop: 6 }}
          onClick={() => onAct(() => api.post(`/approvals/${t.approval_id}/withdraw`, {}))}
        >
          Withdraw the request
        </button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- composing */

function Composer({ id, other, onSent, onProblem }) {
  const [text, setText] = useState('');
  const [lead, setLead] = useState(null);
  const [picking, setPicking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    onProblem(null);
    try {
      await api.post(`/messages/conversations/${id}/messages`, { body: text, lead_id: lead?.id ?? null });
      setText('');
      setLead(null);
      onSent();
    } catch (err) { onProblem(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="msg-compose">
      {lead && (
        <span className="msg-chip">
          <Icon name="person" size={13} /> {lead.name}
          <button type="button" className="msg-chip-x" aria-label="Remove the lead" onClick={() => setLead(null)}>
            <Icon name="close" size={13} />
          </button>
        </span>
      )}
      <textarea
        rows={2}
        value={text}
        maxLength={4000}
        placeholder={other ? `Message ${other.name}` : 'Message'}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
      />
      <div className="row-between" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setPicking(true)}>
            <Icon name="attach_file" size={16} /> Attach a lead
          </button>
          {other && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setAsking(true)}>
              <Icon name="swap_horiz" size={16} /> Ask for a lead
            </button>
          )}
          <span className="tiny muted">Enter sends · Shift+Enter for a new line</span>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={send} disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : <><Icon name="send" size={16} /> Send</>}
        </button>
      </div>

      {picking && (
        <Modal title="Attach a lead" subtitle="They see it only if they could open it anyway" onClose={() => setPicking(false)}>
          <LeadSearch onPick={(l) => { setLead(l); setPicking(false); }} />
        </Modal>
      )}
      {asking && (
        <AskForLead other={other} onClose={() => setAsking(false)} onDone={() => { setAsking(false); onSent(); }} />
      )}
    </div>
  );
}

/** Leads this person can open, by the same search the Leads screen uses. */
function LeadSearch({ onPick }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let live = true;
    const term = q.trim();
    if (term.length < 2) { setRows([]); return undefined; }
    const timer = setTimeout(() => {
      api.get(`/leads?q=${encodeURIComponent(term)}&limit=8`)
        .then((r) => { if (live) setRows(Array.isArray(r) ? r : []); })
        .catch(() => { if (live) setRows([]); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  return (
    <div className="stack" style={{ gap: 6 }}>
      <input
        autoFocus
        placeholder="Search by name, mobile or email"
        aria-label="Search leads"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="msg-pick">
        {rows.map((l) => (
          <button key={l.id} type="button" className="msg-convo" onClick={() => onPick(l)}>
            <Icon name="person" size={16} />
            <span className="msg-convo-body">
              <strong className="small">{l.name}</strong>
              <span className="tiny muted msg-preview">{l.stage}{l.owner_name ? ` · ${l.owner_name}` : ''}</span>
            </span>
          </button>
        ))}
        {q.trim().length >= 2 && !rows.length && (
          <span className="tiny muted">No lead you can open matches that.</span>
        )}
      </div>
    </div>
  );
}

function AskForLead({ other, onClose, onDone }) {
  const [lead, setLead] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/messages/transfer', { lead_id: lead.id, to_user_id: other.id, reason });
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <Modal
      title={`Ask ${other.name} for a lead`}
      subtitle="They decide. You are told either way, and a yes moves the lead to you."
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <div className="span-2">
          {lead ? (
            <div className="row-between">
              <span className="msg-chip">
                <Icon name="person" size={13} /> {lead.name}{lead.owner_name ? ` · with ${lead.owner_name}` : ''}
              </span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setLead(null)}>Change</button>
            </div>
          ) : (
            <LeadSearch onPick={setLead} />
          )}
        </div>

        <label className="span-2">
          <span>Why you are asking</span>
          <textarea
            rows={3}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="The client rang me directly and wants to stay with me"
          />
          <small className="muted">{other.name} sees this, so it has to give them a reason to say yes.</small>
        </label>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !lead || !reason.trim()}>
            {busy ? <Spinner /> : 'Ask'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
