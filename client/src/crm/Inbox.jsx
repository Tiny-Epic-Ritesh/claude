/**
 * The inbox in the header — P3-21.
 *
 * Two things arrive for a person, and until now only one of them could be seen
 * anywhere but the homepage. A mention on a lead, an approval decided, a
 * transfer asked for: all of it landed in `notifications` and was shown on the
 * cockpit alone, so somebody working a lead did not see it until they went
 * home. Messages are the second thing. Both sit behind one button and one
 * count, because "is anything waiting for me?" is one question.
 *
 * One button rather than a bell beside a chat icon: the icon font is
 * subsetted and has no bell, and two badges side by side is one more thing to
 * read than the question needs.
 *
 * Polled, not pushed. Live push needs the proxy to pass upgrade headers, which
 * is an nginx change and ruled out; every thirty seconds, and on returning to
 * the tab, is quick enough for a colleague and costs the server nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, dateTime } from '../api.js';
import { Icon, useDismiss } from '../components/ui.jsx';

const POLL_MS = 30_000;

const names = (people = []) => people.map((p) => p.name).join(', ') || 'Conversation';

export default function Inbox() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('chats');
  const [unread, setUnread] = useState({ messages: 0, notes: 0 });
  const [notes, setNotes] = useState(null);
  const [convos, setConvos] = useState(null);

  const close = useCallback(() => setOpen(false), []);
  const wrap = useDismiss(open, close);

  /* A failed poll keeps the last count. A stale number for thirty seconds is
     the harmless direction; a badge that flickers to zero is not. */
  const refresh = useCallback(async () => {
    try {
      const [m, n] = await Promise.all([api.get('/messages/unread'), api.get('/notifications')]);
      setUnread({ messages: m.messages ?? 0, notes: (n ?? []).filter((x) => !x.read).length });
      setNotes(n ?? []);
    } catch { /* see above */ }
  }, []);

  useEffect(() => {
    refresh();
    const tick = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    refresh();
    api.get('/messages/conversations')
      .then((d) => setConvos(d))
      .catch(() => setConvos({ conversations: [], notice: null }));
  }, [open, refresh]);

  const go = (to) => { setOpen(false); navigate(to); };

  /* Read on the way out, not awaited -- the same rule the homepage follows:
     the point of the click is to arrive. */
  const openNote = (n) => {
    if (!n.read) api.post(`/notifications/${n.id}/read`, {}).then(refresh).catch(() => {});
    if (n.link) go(n.link);
  };
  const readAll = async () => {
    await api.post('/notifications/read-all', {}).catch(() => {});
    refresh();
  };

  const total = unread.messages + unread.notes;

  return (
    <div style={{ position: 'relative' }} ref={wrap}>
      <button
        type="button"
        className="btn-ghost btn-sm inbox-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Messages and notifications"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={total ? `Messages and notifications, ${total} unread` : 'Messages and notifications'}
      >
        <Icon name="forum" size={18} />
        {total > 0 && <span className="inbox-count">{total > 9 ? '9+' : total}</span>}
      </button>

      {open && (
        <div className="popover inbox-pop" aria-label="Inbox">
          <div className="inbox-tabs" role="tablist">
            <button type="button" role="tab" className="inbox-tab" aria-selected={tab === 'chats'} onClick={() => setTab('chats')}>
              Messages{unread.messages ? ` · ${unread.messages}` : ''}
            </button>
            <button type="button" role="tab" className="inbox-tab" aria-selected={tab === 'alerts'} onClick={() => setTab('alerts')}>
              Notifications{unread.notes ? ` · ${unread.notes}` : ''}
            </button>
          </div>

          {tab === 'chats' ? (
            <>
              <div className="inbox-list">
                {!convos && <p className="tiny muted inbox-empty">Loading…</p>}
                {convos && convos.conversations.length === 0 && (
                  <p className="tiny muted inbox-empty">No conversations yet.</p>
                )}
                {convos?.conversations.slice(0, 6).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`inbox-row ${c.unread ? 'is-unread' : ''}`}
                    onClick={() => go(`/messages?c=${c.id}`)}
                  >
                    <Icon name={c.frozen_at ? 'lock' : 'forum'} size={16} />
                    <span className="inbox-row-body">
                      <strong className="small">{names(c.with)}</strong>
                      <span className="tiny muted">{c.last ? `${c.last.mine ? 'You: ' : ''}${c.last.preview}` : 'No messages yet'}</span>
                    </span>
                    {c.unread > 0 && <span className="badge badge-accent">{c.unread}</span>}
                  </button>
                ))}
              </div>
              <div className="inbox-foot">
                <span className="tiny muted">{convos?.notice}</span>
                <button type="button" className="btn-ghost btn-sm" onClick={() => go('/messages')}>Open messages</button>
              </div>
            </>
          ) : (
            <>
              <div className="inbox-list">
                {notes && notes.length === 0 && <p className="tiny muted inbox-empty">Nothing yet.</p>}
                {(notes ?? []).slice(0, 20).map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`inbox-row ${n.read ? '' : 'is-unread'}`}
                    onClick={() => openNote(n)}
                    disabled={!n.link && Boolean(n.read)}
                  >
                    <span className={`inbox-dot ${n.read ? '' : 'is-on'}`} aria-hidden="true" />
                    <span className="inbox-row-body">
                      <strong className="small">{n.title}</strong>
                      {n.body && <span className="tiny muted">{n.body}</span>}
                      <span className="tiny muted">{dateTime(n.created_at)}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="inbox-foot">
                <span />
                <button type="button" className="btn-ghost btn-sm" onClick={readAll} disabled={!unread.notes}>Mark all read</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
