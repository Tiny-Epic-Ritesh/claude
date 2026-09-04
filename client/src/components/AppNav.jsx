/**
 * The Salesforce navigation model, in three parts.
 *
 *   AppLauncher  the waffle grid that switches between working surfaces
 *   TabBar       the per-app tab strip under the header
 *   GlobalSearch the one box that finds anything you are entitled to see
 *
 * The point of apps is restraint. A flat menu of thirty destinations makes
 * every user pay for every other user's features; grouping them means a service
 * agent opens Cases and a rep opens Leads, and neither scans past the other's
 * tools. The server decides which apps and tabs exist for this person, so
 * nothing they cannot open is ever in the payload.
 */

import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, ROLE_LABEL } from '../api.js';
import { Icon, Avatar, useDismiss } from './ui.jsx';

/* ------------------------------------------------------- app launcher */

export function AppLauncher({ apps = [], activeApp, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrap = useDismiss(open, () => setOpen(false));

  const term = q.trim().toLowerCase();
  const matches = (t) => !term || t.label.toLowerCase().includes(term);

  const visibleApps = apps.filter((a) => !term || a.label.toLowerCase().includes(term) || a.tabs.some(matches));
  const allTabs = [...new Map(apps.flatMap((a) => a.tabs).map((t) => [t.id, t])).values()].filter(matches);

  return (
    <div style={{ position: 'relative' }} ref={wrap}>
      <button
        className="waffle"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="App Launcher"
      >
        <Icon name="apps" size={26} />
      </button>

      {open && (
        <>
          <div className="popover launcher" role="dialog" aria-label="App Launcher">
            <div style={{ padding: '4px 6px 10px' }}>
              <input
                type="search"
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search apps and items…"
                aria-label="Search apps and items"
              />
            </div>

            <div className="launcher-section">Apps</div>
            <div className="launcher-grid">
              {visibleApps.map((a) => (
                <button
                  key={a.id}
                  className={`launcher-app ${activeApp === a.id ? 'active' : ''}`}
                  onClick={() => { onPick(a); setOpen(false); setQ(''); }}
                >
                  <span className="launcher-icon" style={{ background: `linear-gradient(145deg, ${a.colour}, ${a.colour}cc)` }}>
                    <Icon name={a.icon} size={20} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="launcher-app-name">{a.label}</span>
                    <span className="tiny muted launcher-app-desc">{a.description}</span>
                  </span>
                </button>
              ))}
              {!visibleApps.length && <div className="tiny muted" style={{ padding: '8px 10px' }}>No apps match.</div>}
            </div>

            <div className="launcher-section">All items</div>
            <div className="launcher-items">
              {allTabs.map((t) => (
                <NavLink
                  key={t.id}
                  to={t.to}
                  className="popover-item"
                  onClick={() => { setOpen(false); setQ(''); }}
                >
                  <Icon name={t.icon} size={17} />
                  {t.label}
                </NavLink>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ tab bar */

export function TabBar({ app }) {
  if (!app?.tabs?.length) return null;
  return (
    <nav className="tabbar" aria-label={`${app.label} tabs`}>
      <span className="tabbar-app">
        <Icon name={app.icon} size={17} />
        {app.label}
      </span>
      <span className="tabbar-divider" />
      <div className="tabbar-tabs">
        {app.tabs.map((t) => (
          <NavLink
            key={t.id}
            to={t.to}
            end={t.to === '/'}
            className={({ isActive }) => `tabbar-tab ${isActive ? 'active' : ''}`}
          >
            <Icon name={t.icon} size={16} />
            {t.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/* ----------------------------------------------------------- search */

/**
 * Global search.
 *
 * Debounced, and scoped by the API to what the caller may see — so it can never
 * become a way to discover the existence of records the user has no right to.
 * Results are grouped by object because "which Sharma?" is a different question
 * from "which case?".
 */
export function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const wrap = useDismiss(open, () => setOpen(false));
  const timer = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults(null); return undefined; }

    setBusy(true);
    timer.current = setTimeout(() => {
      api.get(`/search?q=${encodeURIComponent(q.trim())}`)
        .then((d) => { setResults(d); setOpen(true); })
        .catch(() => setResults(null))
        .finally(() => setBusy(false));
    }, 260);

    return () => clearTimeout(timer.current);
  }, [q]);

  const go = (item) => {
    setOpen(false);
    setQ('');
    navigate(item.url);
  };

  const groups = results ? Object.entries(results.groups || {}).filter(([, rows]) => rows.length) : [];

  return (
    <div className="globalsearch" ref={wrap}>
      <Icon name="search" size={17} style={{ color: 'var(--ink-4)' }} />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results && setOpen(true)}
        placeholder="Search leads, clients, partners, cases…"
        aria-label="Global search"
      />
      {busy && <span className="spinner" />}

      {open && results && (
        <>
          <div className="popover searchresults" role="listbox">
            {!groups.length && <div className="tiny muted" style={{ padding: '10px 12px' }}>Nothing matched “{q}”.</div>}
            {groups.map(([kind, rows]) => (
              <div key={kind}>
                <div className="launcher-section">{kind}</div>
                {rows.map((r) => (
                  <button key={`${kind}-${r.id}`} className="popover-item" role="option" onClick={() => go(r)}>
                    <Avatar name={r.title} size={26} seed={`${kind}-${r.id}`} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 600 }}>{r.title}</span>
                      <span className="tiny muted" style={{ display: 'block' }}>{r.subtitle}</span>
                    </span>
                    {r.badge && <span className="badge">{r.badge}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The user menu, top right.
 *
 * With navigation moved into the App Launcher and tab bar there is no sidebar
 * left to hold identity, so it goes where every console app puts it. It also
 * carries the things that used to sit at the bottom of the sidebar — the
 * customer-facing surfaces and sign-out.
 */
export function UserMenu({ session, orgName, onSignOut }) {
  const [open, setOpen] = useState(false);
  const wrap = useDismiss(open, () => setOpen(false));

  return (
    <div style={{ position: 'relative' }} ref={wrap}>
      <button className="usermenu-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={session.name} size={30} seed={session.email} />
        <Icon name="expand_more" size={16} style={{ color: 'var(--ink-4)' }} />
      </button>

      {open && (
        <>
          <div className="popover usermenu" role="menu">
            <div className="usermenu-head">
              <Avatar name={session.name} size={40} seed={session.email} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{session.name}</div>
                <div className="tiny muted">{ROLE_LABEL[session.role] || session.role}</div>
                <div className="tiny muted">
                  {orgName}
                  {session.employee_code ? ` · ${session.employee_code}` : ''}
                  {session.branch ? ` · ${session.branch}` : ''}
                </div>
              </div>
            </div>

            <div className="divider" style={{ margin: '8px 0' }} />

            <div className="launcher-section">Customer surfaces</div>
            <a className="popover-item" href="/ai-crm/dkyc" target="_blank" rel="noreferrer" role="menuitem">
              <Icon name="badge" size={17} /> DKYC portal
              <Icon name="open_in_new" size={14} style={{ marginLeft: 'auto', color: 'var(--ink-4)' }} />
            </a>
            <a className="popover-item" href="/ai-crm/portal" target="_blank" rel="noreferrer" role="menuitem">
              <Icon name="handshake" size={17} /> Partner portal
              <Icon name="open_in_new" size={14} style={{ marginLeft: 'auto', color: 'var(--ink-4)' }} />
            </a>

            <div className="divider" style={{ margin: '8px 0' }} />

            {/* While acting as somebody else this is the way back, not the way
                out. It was the only exit an administrator could find when the
                banner failed to render, and it ended both sessions — so it says
                what it now does. Ending your own session is available again the
                moment you are yourself. */}
            {session?.ghost_of ? (
              <button className="popover-item" role="menuitem" onClick={onSignOut}>
                <Icon name="arrow_back" size={17} />
                <span>
                  Return to {session.ghost_of.name}
                  <span className="tiny muted" style={{ display: 'block' }}>
                    You are viewing as {session.name}
                  </span>
                </span>
              </button>
            ) : (
              <button className="popover-item" role="menuitem" onClick={onSignOut}>
                <Icon name="logout" size={17} /> Sign out
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
