/**
 * Calendar.
 *
 * Outlook meetings and CRM due work on one timeline, kept visually distinct.
 * That distinction is the point: an RM looking at Thursday needs to know which
 * entries other people can see and which are only a promise the CRM is holding
 * them to. A meeting is somebody else's record and is read-only here; a
 * callback is ours and can be acted on.
 *
 * The source line at the top is not decoration either. While Graph credentials
 * are absent this is a simulated diary, and a calendar that quietly invents
 * meetings would be the most damaging thing in the product.
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, dateTime } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty } from '../components/ui.jsx';

const KIND = {
  meeting: { icon: 'event', label: 'Outlook', cls: 'is-meeting' },
  task: { icon: 'assignment_turned_in', label: 'Task', cls: 'is-task' },
  callback: { icon: 'phone_callback', label: 'Callback', cls: 'is-callback' },
};

const time = (s) => String(s ?? '').slice(11, 16) || '—';

const dayLabel = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 864e5);
  const name = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
  if (diff === 0) return `Today · ${name}`;
  if (diff === 1) return `Tomorrow · ${name}`;
  return name;
};

export default function Calendar() {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const days = Number(search.get('days') || 7);
  const [d, { loading, error, reload }] = useApi(`/calendar?days=${days}`, [days]);
  const [syncing, setSyncing] = useState(false);
  const [problem, setProblem] = useState(null);

  const setDays = (n) => {
    const next = new URLSearchParams(search);
    if (n === 7) next.delete('days'); else next.set('days', String(n));
    setSearch(next, { replace: true });
  };

  const sync = async () => {
    setSyncing(true); setProblem(null);
    try { await api.post('/calendar/sync', {}); reload(); }
    catch (e) { setProblem(e.message); }
    finally { setSyncing(false); }
  };

  if (loading && !d) return <Loading label="Reading your diary…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!d) return null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="muted">
            Your Outlook diary, with the callbacks and tasks the CRM is holding
            you to, on one timeline.
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="tabs" style={{ marginBottom: 0, display: 'inline-flex' }}>
            {[[1, 'Day'], [7, 'Week'], [14, 'Fortnight']].map(([n, label]) => (
              <button key={n} className={`tab ${days === n ? 'active' : ''}`}
                onClick={() => setDays(n)}>{label}</button>
            ))}
          </div>
          <button className="btn-ghost btn-sm" disabled={syncing} onClick={sync}>
            <Icon name="sync" size={15} /> {syncing ? 'Syncing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />

      {/* Where these meetings came from, stated rather than assumed. */}
      <div className={`notice ${d.source.live ? 'notice-ok' : 'notice-warn'}`} style={{ marginBottom: 14 }}>
        <Icon name={d.source.live ? 'cloud_done' : 'cloud_off'} size={17} />
        <span>
          {d.source.live
            ? <>Live from Outlook{d.synced_at ? <> · last checked {dateTime(d.synced_at)}</> : null}</>
            : (
              <>
                <strong>Simulated diary.</strong> These meetings are not real —
                Outlook is not connected yet. Add {d.source.needs.join(', ')} to
                server/.env to read the firm&apos;s actual calendars.
              </>
            )}
        </span>
      </div>

      <div className="grid-auto" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="stat-label">Meetings</div>
          <div className="stat-value">{d.counts.meetings}</div>
          <div className="stat-sub">From Outlook</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Tasks due</div>
          <div className="stat-value">{d.counts.tasks}</div>
          <div className="stat-sub">Assigned to you</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Callbacks promised</div>
          <div className="stat-value">{d.counts.callbacks}</div>
          <div className="stat-sub">To a client, by name</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 12 }}>
        {d.days.map((day) => (
          <div key={day.date} className="card">
            <div className="card-head">
              <h2 style={{ fontSize: 15 }}>{dayLabel(day.date)}</h2>
              <span className="tiny muted">
                {day.items.length === 0 ? 'Nothing booked' : `${day.items.length} item${day.items.length === 1 ? '' : 's'}`}
              </span>
            </div>
            {day.items.length === 0 ? (
              <div className="card-body"><span className="tiny muted">Clear.</span></div>
            ) : (
              <div className="card-body stack" style={{ gap: 6 }}>
                {day.items.map((item) => {
                  const meta = KIND[item.kind] ?? KIND.task;
                  const openable = item.lead_id;
                  const Row = openable ? 'button' : 'div';
                  return (
                    <Row
                      key={`${item.kind}-${item.id ?? item.lead_id}-${item.starts_at}`}
                      type={openable ? 'button' : undefined}
                      className={`cal-row ${meta.cls} ${openable ? 'is-clickable' : ''} ${item.cancelled ? 'is-retired' : ''}`}
                      onClick={openable ? () => navigate(`/leads/${item.lead_id}`) : undefined}
                    >
                      <span className="cal-time">{item.all_day ? 'All day' : time(item.starts_at)}</span>
                      <Icon name={meta.icon} size={16} />
                      <span className="cal-main">
                        <span className="cal-title">{item.subject ?? item.title}</span>
                        <span className="tiny muted">
                          {meta.label}
                          {item.location ? ` · ${item.location}` : ''}
                          {item.lead_name ? ` · ${item.lead_name}` : ''}
                          {item.cancelled ? ' · cancelled' : ''}
                        </span>
                      </span>
                      {item.online_url && !item.cancelled && (
                        <a className="btn btn-sm" href={item.online_url}
                          target="_blank" rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}>
                          Join
                        </a>
                      )}
                      {item.priority === 'High' && <span className="badge badge-amber">High</span>}
                    </Row>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {d.days.every((day) => day.items.length === 0) && (
        <Empty>Nothing in this window. Try a longer one, or check Outlook directly.</Empty>
      )}
    </div>
  );
}
