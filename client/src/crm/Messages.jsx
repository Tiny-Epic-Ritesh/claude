/**
 * Messages — P3-21, phases 1 and 2.
 *
 * Direct messages and channels, one screen. The rules are the server's
 * (engine/messaging.js, engine/channels.js) and this screen states them rather
 * than enforcing them: who may be messaged is whoever the people search
 * returns, who may be added to a channel is whoever the candidates search
 * returns, a lead is drawn as the reader is allowed to see it, and a refusal
 * is shown in the server's own words.
 *
 * Always on screen when it applies, because each changes what somebody can do:
 * the standing notice that compliance may read this (Ritesh, 11 September), a
 * frozen conversation's reason, an archived channel, and a suspension.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, dateTime, parseTs, ROLE_LABEL } from '../api.js';
import {
  useApi, useDismiss, Loading, ErrorBanner, Empty, Modal, Spinner, Icon, Avatar,
} from '../components/ui.jsx';

const THREAD_POLL_MS = 5_000;
const LIST_POLL_MS = 30_000;
const WITHDRAW_MS = 15 * 60 * 1000;

/* Any emoji may be a reaction (Ritesh, 11 September); these are the ones a
   thumb reaches for, and anything else is typed or picked from the keyboard. */
const QUICK_REACTIONS = ['👍', '✅', '👀', '🙏', '❤️', '😂'];

const names = (people = []) => people.map((p) => p.name).join(', ') || 'Conversation';
const titleOf = (c) => (c.kind === 'channel' ? `#${c.name}` : names(c.with));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const sentAt = (s) => {
  const t = parseTs(s);
  return t instanceof Date ? t.getTime() : Number(t) || 0;
};

export default function Messages() {
  const [search, setSearch] = useSearchParams();
  const openId = Number(search.get('c')) || null;
  const [list, { error: listError, reload: reloadList }] = useApi('/messages/conversations');
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [making, setMaking] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) reloadList(); }, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [reloadList]);

  const choose = useCallback((id) => setSearch(id ? { c: String(id) } : {}), [setSearch]);

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

  const open = (id) => { reloadList(); choose(id); };

  const suspended = Boolean(list.suspended);
  const channels = list.conversations.filter((c) => c.kind === 'channel');
  const directs = list.conversations.filter((c) => c.kind !== 'channel');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <p>
            Conversations and channels with colleagues. A lead you mention stays on its own record,
            and the other person sees it only if they could open it anyway.
          </p>
        </div>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      {suspended && (
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
            <div className="row wrap" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => setStarting(true)} disabled={suspended}>
                <Icon name="add" size={16} /> New conversation
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setMaking(true)} disabled={suspended}>
                <Icon name="forum" size={16} /> New channel
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setBrowsing(true)}>
                <Icon name="explore" size={16} /> Browse channels
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setAsking(true)} disabled={suspended}>
                <Icon name="swap_horiz" size={16} /> Ask for a lead
              </button>
            </div>
          )}

          <div className="msg-convos">
            <p className="msg-group-title">Channels</p>
            {channels.length === 0 && <span className="tiny muted">None yet. Browse, or open one.</span>}
            {channels.map((c) => <ConvoRow key={c.id} c={c} current={c.id === openId} onPick={choose} />)}

            <p className="msg-group-title">Direct messages</p>
            {directs.length === 0 && <span className="tiny muted">No conversations yet.</span>}
            {directs.map((c) => <ConvoRow key={c.id} c={c} current={c.id === openId} onPick={choose} />)}
          </div>
        </aside>

        <section className="card msg-main">
          {openId ? (
            <Thread
              key={openId}
              id={openId}
              suspended={suspended}
              onBack={() => choose(null)}
              onGo={choose}
              onLeft={() => { reloadList(); choose(null); }}
              onChanged={reloadList}
              onProblem={setProblem}
            />
          ) : (
            <Empty>Choose a conversation or a channel, or start one.</Empty>
          )}
        </section>
      </div>

      {asking && (
        <AskForLead
          onClose={() => setAsking(false)}
          onDone={(out) => { setAsking(false); open(out.conversation_id); }}
        />
      )}
      {making && (
        <NewChannel onClose={() => setMaking(false)} onDone={(id) => { setMaking(false); open(id); }} />
      )}
      {browsing && (
        <BrowseChannels
          onClose={() => setBrowsing(false)}
          onOpen={(id) => { setBrowsing(false); open(id); }}
          onProblem={setProblem}
        />
      )}
    </>
  );
}

function ConvoRow({ c, current, onPick }) {
  const channel = c.kind === 'channel';
  return (
    <button
      type="button"
      className={`msg-convo ${c.archived_at ? 'is-archived' : ''}`}
      aria-current={current ? 'true' : undefined}
      onClick={() => onPick(c.id)}
    >
      {channel
        ? <span className="msg-hash" aria-hidden="true">#</span>
        : <Avatar name={c.with[0]?.name ?? '?'} size={30} seed={String(c.with[0]?.id ?? c.id)} />}
      <span className="msg-convo-body">
        <span className="row-between" style={{ gap: 6 }}>
          <strong className="small">{channel ? c.name : names(c.with)}</strong>
          {c.unread > 0 && <span className="badge badge-accent">{c.unread}</span>}
        </span>
        <span className="tiny muted msg-preview">
          {(c.frozen_at || c.visibility === 'private') && <Icon name="lock" size={12} />}
          {c.last ? `${c.last.mine ? 'You: ' : ''}${c.last.preview}` : 'No messages yet'}
        </span>
      </span>
    </button>
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
        <input autoFocus placeholder="Search colleagues" aria-label="Search colleagues" value={q} onChange={(e) => setQ(e.target.value)} />
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

/* ----------------------------------------------------------- channels */

function NewChannel({ onClose, onDone }) {
  const [info] = useApi('/messages/channels');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const books = info?.books ?? [];
  const business = org || books[0] || '';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await api.post('/messages/channels', {
        name, topic, visibility: isPrivate ? 'private' : 'public', home_org: business || undefined,
      });
      onDone(out.id);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <Modal title="New channel" subtitle="Anyone can open one. You can add people once it exists." onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}
        <label className="span-2">
          <span>Name</span>
          <input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="pune-walk-ins" />
        </label>
        <label className="span-2">
          <span>What it is for <em className="muted">(optional)</em></span>
          <input maxLength={250} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Who is covering walk-ins, and when" />
        </label>
        {books.length > 1 && (
          <label className="span-2">
            <span>Business</span>
            <select value={business} onChange={(e) => setOrg(e.target.value)}>
              {books.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        )}
        <fieldset className="span-2 msg-choice">
          <label>
            <input type="radio" checked={!isPrivate} onChange={() => setIsPrivate(false)} />
            <span><strong>Public</strong> — anyone in {business || 'your business'} can find it and join</span>
          </label>
          <label>
            <input type="radio" checked={isPrivate} onChange={() => setIsPrivate(true)} />
            <span><strong>Private</strong> — only people who are added; any member can add a colleague</span>
          </label>
        </fieldset>
        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || name.trim().length < 2}>
            {busy ? <Spinner /> : 'Open the channel'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BrowseChannels({ onClose, onOpen, onProblem }) {
  const [data, { loading }] = useApi('/messages/channels');

  const join = async (c) => {
    onProblem(null);
    try {
      await api.post(`/messages/channels/${c.id}/join`, {});
      onOpen(c.id);
    } catch (err) { onProblem(err.message); onClose(); }
  };

  return (
    <Modal title="Channels" subtitle="Public channels in your business, and any you are in" onClose={onClose}>
      {loading || !data ? <Loading /> : (
        <div className="msg-pick" style={{ maxHeight: 420 }}>
          {data.channels.length === 0 && <Empty>No channels yet. Open the first one.</Empty>}
          {data.channels.map((c) => (
            <div key={c.id} className={`row-between msg-member ${c.archived_at ? 'is-archived' : ''}`}>
              <span className="msg-convo-body">
                <strong className="small">
                  #{c.name}
                  {c.visibility === 'private' && <Icon name="lock" size={12} />}
                  {c.archived_at && <span className="badge" style={{ marginLeft: 6 }}>archived</span>}
                </strong>
                <span className="tiny muted">{c.topic ? `${c.topic} · ` : ''}{plural(c.members, 'member', 'members')}</span>
              </span>
              <button type="button" className={c.joined ? 'btn-ghost btn-sm' : 'btn btn-sm'} onClick={() => (c.joined ? onOpen(c.id) : join(c))}>
                {c.joined ? 'Open' : 'Join'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function CandidatePicker({ channelId, onPick, onCancel }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState(null);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api.get(`/messages/channels/${channelId}/candidates?q=${encodeURIComponent(q)}`)
        .then((r) => { if (live) setPeople(r.people ?? []); })
        .catch(() => { if (live) setPeople([]); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [q, channelId]);

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <input autoFocus placeholder="Search colleagues" aria-label="Search colleagues to add" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn-ghost btn-sm" onClick={onCancel} aria-label="Cancel">
          <Icon name="close" size={16} />
        </button>
      </div>
      <span className="tiny muted">
        Somebody from the other business is listed only where your administrator has opened messages
        between the two.
      </span>
      <div className="msg-pick">
        {(people ?? []).map((p) => (
          <button key={p.id} type="button" className="msg-convo" onClick={() => onPick(p)}>
            <Avatar name={p.name} size={26} seed={String(p.id)} />
            <span className="msg-convo-body">
              <strong className="small">{p.name}</strong>
              <span className="tiny muted msg-preview">{ROLE_LABEL[p.role] || p.role} · {p.sales_org}</span>
            </span>
          </button>
        ))}
        {people && !people.length && <span className="tiny muted">Nobody who could be added matches that.</span>}
      </div>
    </div>
  );
}

function MembersPanel({ convo, onClose, onChanged, onLeft, onProblem }) {
  const [adding, setAdding] = useState(false);
  const others = new Set(convo.with.map((p) => p.id));

  const act = async (fn, after) => {
    onProblem(null);
    try { await fn(); after?.(); onChanged(); } catch (err) { onProblem(err.message); }
  };

  return (
    <Modal
      title={`#${convo.name}`}
      subtitle={`${plural(convo.members.length, 'member', 'members')} · ${convo.visibility === 'private' ? 'Private' : 'Public'} · ${convo.home_org}`}
      onClose={onClose}
    >
      <div className="stack" style={{ gap: 10 }}>
        {convo.topic && <p className="small" style={{ margin: 0 }}>{convo.topic}</p>}

        <div className="msg-pick" style={{ maxHeight: 280 }}>
          {convo.members.map((p) => (
            <div key={p.id} className="row-between msg-member">
              <span className="row" style={{ gap: 8 }}>
                <Avatar name={p.name} size={26} seed={String(p.id)} />
                <span>
                  <strong className="small">{p.name}{others.has(p.id) ? '' : ' (you)'}</strong>
                  <span className="tiny muted" style={{ display: 'block' }}>{ROLE_LABEL[p.role] || p.role} · {p.sales_org}</span>
                </span>
              </span>
              {convo.is_creator && others.has(p.id) && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => act(() => api.del(`/messages/channels/${convo.id}/members/${p.id}`))}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        {!convo.archived_at && (adding ? (
          <CandidatePicker
            channelId={convo.id}
            onCancel={() => setAdding(false)}
            onPick={(p) => act(() => api.post(`/messages/channels/${convo.id}/members`, { user_id: p.id }), () => setAdding(false))}
          />
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
            <Icon name="person_add" size={16} /> Add people
          </button>
        ))}

        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn-ghost btn-sm" onClick={() => act(() => api.post(`/messages/channels/${convo.id}/leave`, {}), onLeft)}>
            Leave the channel
          </button>
          {convo.is_creator && (convo.archived_at ? (
            <button type="button" className="btn-ghost btn-sm" onClick={() => act(() => api.post(`/messages/channels/${convo.id}/unarchive`, {}), onClose)}>
              Reopen it
            </button>
          ) : (
            <button type="button" className="btn-ghost btn-sm" onClick={() => act(() => api.post(`/messages/channels/${convo.id}/archive`, {}), onClose)}>
              Archive it
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- thread */

function Thread({ id, suspended, onBack, onGo, onLeft, onChanged, onProblem }) {
  const [convo, setConvo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [threadOf, setThreadOf] = useState(null);
  const [showMembers, setShowMembers] = useState(false);
  const lastRead = useRef(0);
  const box = useRef(null);
  const shown = useRef(0);

  /* The whole newest page every time rather than only what is new: a card or a
     reaction changes in place, and a message can be withdrawn after it was
     fetched. Incremental fetching would show all three stale. */
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

  const channel = convo.kind === 'channel';
  const other = channel ? null : convo.with[0];
  const frozen = Boolean(convo.frozen_at);
  const archived = Boolean(convo.archived_at);
  const canWrite = !frozen && !archived && !suspended;

  return (
    <>
      <div className="row msg-head">
        <button type="button" className="btn-ghost btn-sm msg-back" onClick={onBack} aria-label="Back to conversations">
          <Icon name="arrow_back" size={18} />
        </button>
        {channel
          ? <span className="msg-hash" aria-hidden="true">#</span>
          : <Avatar name={other?.name ?? '?'} size={32} seed={String(other?.id ?? id)} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong>{titleOf(convo)}</strong>
          {channel ? (
            <div className="tiny muted msg-head-meta">
              {convo.visibility === 'private' && <Icon name="lock" size={12} />}
              <span>{convo.topic || (convo.visibility === 'private' ? 'Private channel' : 'Public channel')}</span>
            </div>
          ) : (
            other && <div className="tiny muted">{ROLE_LABEL[other.role] || other.role} · {other.sales_org}</div>
          )}
        </div>
        {channel && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setShowMembers(true)}>
            <Icon name="group" size={16} /> {convo.members?.length ?? 0}
          </button>
        )}
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
      {archived && (
        <div className="glass notice">
          <Icon name="info" />
          <div><strong>This channel is archived.</strong> It can be read, not written to.</div>
        </div>
      )}

      <div className="msg-thread" ref={box}>
        {messages.length === 0 && <Empty>No messages yet.</Empty>}
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} onAct={act} reactable={canWrite} onOpenThread={setThreadOf} />
        ))}
      </div>

      {canWrite && (
        <Composer
          id={id}
          other={other}
          members={channel ? convo.with : null}
          onSent={load}
          onGo={onGo}
          onProblem={onProblem}
        />
      )}

      {threadOf && (
        <ThreadPanel
          conversationId={id}
          messageId={threadOf}
          convo={convo}
          canWrite={canWrite}
          onClose={() => { setThreadOf(null); load(); }}
          onChanged={onChanged}
          onProblem={onProblem}
        />
      )}
      {showMembers && channel && (
        <MembersPanel
          convo={convo}
          onClose={() => { setShowMembers(false); load(); }}
          onChanged={() => { load(); onChanged(); }}
          onLeft={onLeft}
          onProblem={onProblem}
        />
      )}
    </>
  );
}

function ThreadPanel({ conversationId, messageId, convo, canWrite, onClose, onChanged, onProblem }) {
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.get(`/messages/conversations/${conversationId}/thread/${messageId}`)); }
    catch (err) { onProblem(err.message); }
  }, [conversationId, messageId, onProblem]);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, THREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn) => {
    onProblem(null);
    try { await fn(); await load(); onChanged(); } catch (err) { onProblem(err.message); }
  };

  return (
    <Modal title="Thread" subtitle={titleOf(convo)} onClose={onClose} wide>
      {!data ? <Loading /> : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="msg-thread" style={{ maxHeight: '50vh' }}>
            <MessageRow m={data.root} onAct={act} reactable={canWrite} />
            <p className="tiny muted msg-thread-divider">{plural(data.replies.length, 'reply', 'replies')}</p>
            {data.replies.map((m) => <MessageRow key={m.id} m={m} onAct={act} reactable={canWrite} />)}
          </div>
          {canWrite && (
            <Composer
              id={conversationId}
              parentId={data.root.id}
              members={convo.kind === 'channel' ? convo.with : null}
              onSent={() => { load(); onChanged(); }}
              onProblem={onProblem}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

function MessageRow({ m, onAct, reactable, onOpenThread }) {
  const [picking, setPicking] = useState(false);

  if (m.kind === 'system') return <div className="msg-system">{m.body}</div>;
  if (m.transfer) return <TransferCard m={m} onAct={onAct} />;

  const recent = m.mine && !m.withdrawn && Date.now() - sentAt(m.created_at) < WITHDRAW_MS;
  const react = (emoji) => onAct(() => api.post(`/messages/message/${m.id}/react`, { emoji }));

  return (
    <div className={`msg-bubble ${m.mine ? 'is-mine' : ''} ${m.withdrawn ? 'is-withdrawn' : ''} ${m.mentions_me ? 'is-mentioned' : ''}`}>
      {m.withdrawn ? 'Message withdrawn' : m.body}
      {m.lead && <LeadChip lead={m.lead} />}

      {m.reactions?.length > 0 && (
        <div className="msg-reactions">
          {m.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              className={`msg-reaction ${r.mine ? 'is-mine' : ''}`}
              aria-pressed={r.mine}
              disabled={!reactable}
              title={r.mine ? 'Take your reaction off' : 'Add yours'}
              onClick={() => react(r.emoji)}
            >
              <span>{r.emoji}</span><span className="tiny">{r.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="msg-meta">
        {!m.mine && <span>{m.sender_name}</span>}
        <span>{dateTime(m.created_at)}</span>
        {reactable && !m.withdrawn && (
          <button type="button" className="msg-meta-act" onClick={() => setPicking((p) => !p)}>React</button>
        )}
        {onOpenThread && (
          <button type="button" className="msg-meta-act" onClick={() => onOpenThread(m.id)}>
            {m.reply_count ? plural(m.reply_count, 'reply', 'replies') : 'Reply'}
          </button>
        )}
        {recent && (
          <button type="button" className="msg-meta-act" onClick={() => onAct(() => api.post(`/messages/message/${m.id}/withdraw`, {}))}>
            Withdraw
          </button>
        )}
      </div>

      {picking && <ReactionPicker onPick={(e) => { setPicking(false); react(e); }} onClose={() => setPicking(false)} />}
    </div>
  );
}

/* Six a thumb reaches for, and any other emoji typed or picked from the
   keyboard's own emoji panel. The server decides what counts as one. */
function ReactionPicker({ onPick, onClose }) {
  const [other, setOther] = useState('');
  const ref = useDismiss(true, onClose);
  return (
    <div className="msg-picker" ref={ref}>
      <div className="row wrap" style={{ gap: 4 }}>
        {QUICK_REACTIONS.map((e) => (
          <button key={e} type="button" className="msg-reaction" aria-label={`React with ${e}`} onClick={() => onPick(e)}>{e}</button>
        ))}
      </div>
      <form className="row" style={{ gap: 4 }} onSubmit={(ev) => { ev.preventDefault(); if (other.trim()) onPick(other.trim()); }}>
        <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Any emoji" aria-label="Any emoji" style={{ width: 120 }} />
        <button type="submit" className="btn-sm" disabled={!other.trim()}>Add</button>
      </form>
      <span className="tiny muted">On Windows, press the Windows key and full stop for every emoji.</span>
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
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not" aria-label="Why you are declining" />
          <small className="muted">{t.requested_by_name} sees this, so it has to tell them why.</small>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setDeclining(false)}>Cancel</button>
            <button type="button" className="btn btn-danger btn-sm" disabled={!reason.trim()} onClick={() => decide(false)}>Decline</button>
          </div>
        </div>
      )}
      {t.can_withdraw && (
        <button type="button" className="btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => onAct(() => api.post(`/approvals/${t.approval_id}/withdraw`, {}))}>
          Withdraw the request
        </button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- composing */

/* The `@` being typed at the end of the message, if there is one. */
const MENTION_AT_END = /@([^@\n]{0,30})$/;

function Composer({ id, other = null, members = null, parentId = null, onSent, onGo, onProblem }) {
  const [text, setText] = useState('');
  const [lead, setLead] = useState(null);
  const [picking, setPicking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [named, setNamed] = useState(() => new Map());

  /* @mentions, in channels only: who the `@` at the end could be. */
  const typed = members ? MENTION_AT_END.exec(text)?.[1] ?? null : null;
  const suggestions = typed === null ? [] : members
    .filter((p) => p.name.toLowerCase().startsWith(typed.toLowerCase()))
    .slice(0, 6);

  const mention = (p) => {
    setText((t) => t.replace(MENTION_AT_END, `@${p.name} `));
    setNamed((m) => new Map(m).set(p.name, p.id));
  };

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    onProblem(null);
    try {
      // Only the names still in the message when it is sent.
      const mentions = [...named].filter(([n]) => text.includes(`@${n}`)).map(([, uid]) => uid);
      await api.post(`/messages/conversations/${id}/messages`, {
        body: text, lead_id: lead?.id ?? null, parent_id: parentId, mentions,
      });
      setText('');
      setLead(null);
      setNamed(new Map());
      onSent();
    } catch (err) { onProblem(err.message); }
    finally { setBusy(false); }
  };

  const placeholder = parentId ? 'Reply in the thread' : (other ? `Message ${other.name}` : 'Message the channel — type @ to mention somebody');

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
      {suggestions.length > 0 && (
        <div className="msg-mentions" role="listbox" aria-label="Mention somebody">
          {suggestions.map((p) => (
            <button key={p.id} type="button" className="msg-convo" onClick={() => mention(p)}>
              <Avatar name={p.name} size={22} seed={String(p.id)} />
              <span className="small">{p.name}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        rows={2}
        value={text}
        maxLength={4000}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
      />
      <div className="row-between" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setPicking(true)}>
            <Icon name="attach_file" size={16} /> Attach a lead
          </button>
          {other && !parentId && (
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
        <Modal title="Attach a lead" subtitle="Others see it only if they could open it anyway" onClose={() => setPicking(false)}>
          <LeadSearch onPick={(l) => { setLead(l); setPicking(false); }} />
        </Modal>
      )}
      {asking && (
        <AskForLead
          other={other}
          onClose={() => setAsking(false)}
          onDone={(out) => {
            setAsking(false);
            onSent();
            // Asked of somebody other than the person here: go where it landed.
            if (out?.conversation_id && out.conversation_id !== id) onGo?.(out.conversation_id);
          }}
        />
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
      <input autoFocus placeholder="Search by name, mobile or email" aria-label="Search leads" value={q} onChange={(e) => setQ(e.target.value)} />
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
        {q.trim().length >= 2 && !rows.length && <span className="tiny muted">No lead you can open matches that.</span>}
      </div>
    </div>
  );
}

/**
 * Any lead in your own business, by its exact mobile or full name.
 *
 * Ritesh, 11 September: an RM may name any lead. The answer is who has it and
 * who could hand it over -- nothing from the client record -- and the screen
 * says, before the lookup, that it is recorded against the person looking.
 */
function LeadLookup({ onPick }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const look = async () => {
    const typed = text.trim();
    if (!typed) return;
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const digits = typed.replace(/[^0-9]/g, '');
      const r = await api.post('/messages/lookup', digits.length >= 10 ? { mobile: typed } : { name: typed });
      setFound(r.matches);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); look(); } }}
          placeholder="The full mobile number, or the client's full name"
          aria-label="Mobile number or full name"
        />
        <button type="button" className="btn btn-sm" onClick={look} disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : 'Look up'}
        </button>
      </div>
      <span className="tiny muted">
        Exact matches only, in your own business. It tells you who has the lead and nothing else, and
        the lookup is recorded against your name.
      </span>
      {error && <ErrorBanner error={error} />}
      {found && found.length === 0 && <span className="tiny muted">No lead in your business has exactly that number or name.</span>}
      <div className="msg-pick">
        {(found ?? []).map((m) => {
          const blocked = m.mine || Boolean(m.in_queue);
          let line = `With ${m.owner?.name ?? 'nobody'}`;
          if (m.mine) line = 'Already yours';
          else if (m.in_queue) line = `Waiting in ${m.in_queue}`;
          let sub = `${plural(m.grantors.length, 'person', 'people')} you can ask`;
          if (m.in_queue) sub = 'Take it from the queue instead';
          else if (m.can_open) sub = 'You can already open this one';
          return (
            <button key={m.lead_id} type="button" className="msg-convo" disabled={blocked} onClick={() => onPick(m)}>
              <Icon name="person" size={16} />
              <span className="msg-convo-body">
                <strong className="small">{line}</strong>
                <span className="tiny muted msg-preview">{sub}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Ask somebody for a lead.
 *
 * Inside a conversation it defaults to the person in it; from the side panel,
 * to whoever has the lead. A lead found by lookup offers only the people who
 * could hand it over and whom you may message -- the owner first -- because
 * asking anybody else would be refused.
 */
function AskForLead({ other = null, onClose, onDone }) {
  const [lookingUp, setLookingUp] = useState(false);
  const [lead, setLead] = useState(null);
  const [targetId, setTargetId] = useState(other?.id ?? null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pickOpenable = (l) => {
    setLead({
      id: l.id,
      label: `${l.name}${l.owner_name ? ` · with ${l.owner_name}` : ''}`,
      owner: l.owner_id ? { id: l.owner_id, name: l.owner_name } : null,
      grantors: null,
    });
    setTargetId(other?.id ?? l.owner_id ?? null);
  };

  const pickFound = (m) => {
    const grantors = m.grantors ?? [];
    setLead({
      id: m.lead_id,
      label: m.owner ? `The lead you looked up · with ${m.owner.name}` : 'The lead you looked up',
      owner: m.owner,
      grantors,
    });
    setTargetId((grantors.find((g) => g.id === other?.id) ?? grantors[0])?.id ?? null);
  };

  const people = lead?.grantors ?? [other, lead?.owner].filter(Boolean);
  const target = people.find((p) => p.id === targetId) ?? null;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await api.post('/messages/transfer', { lead_id: lead.id, to_user_id: targetId, reason });
      onDone(out);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <Modal
      title={other ? `Ask ${other.name} for a lead` : 'Ask for a lead'}
      subtitle="They decide. You are told either way, and a yes moves the lead to you."
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="span-2"><ErrorBanner error={error} /></div>}

        <div className="span-2">
          {lead ? (
            <div className="row-between">
              <span className="msg-chip"><Icon name="person" size={13} /> {lead.label}</span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setLead(null)}>Change</button>
            </div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <div className="inbox-tabs" role="tablist" style={{ padding: 0, border: 0 }}>
                <button type="button" role="tab" className="inbox-tab" aria-selected={!lookingUp} onClick={() => setLookingUp(false)}>
                  A lead you can open
                </button>
                <button type="button" role="tab" className="inbox-tab" aria-selected={lookingUp} onClick={() => setLookingUp(true)}>
                  Look one up
                </button>
              </div>
              {lookingUp ? <LeadLookup onPick={pickFound} /> : <LeadSearch onPick={pickOpenable} />}
            </div>
          )}
        </div>

        {lead && (
          <label className="span-2">
            <span>Ask</span>
            {people.length ? (
              <select value={targetId ?? ''} onChange={(e) => setTargetId(Number(e.target.value))}>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.is_owner || p.id === lead.owner?.id ? ' (has it now)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <small className="muted">Nobody who could hand this lead over is somebody you can message.</small>
            )}
          </label>
        )}

        <label className="span-2">
          <span>Why you are asking</span>
          <textarea rows={3} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The client rang me directly and wants to stay with me" />
          <small className="muted">{target ? `${target.name} sees this` : 'They see this'}, so it has to give them a reason to say yes.</small>
        </label>

        <div className="modal-actions span-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !lead || !targetId || !reason.trim()}>
            {busy ? <Spinner /> : target ? `Ask ${target.name}` : 'Ask'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
