/**
 * Setup, as its own place.
 *
 * It used to be one route inside the CRM shell, so the Home / Leads / Pipeline
 * tab strip sat above it and the 22 settings screens were crammed into a second
 * horizontally-scrolling strip beneath. Seven of them were unreachable until
 * that strip was made to scroll — which was a fix for the symptom.
 *
 * The shape here comes from `docs/salesforce-reference/setup-tree.md`, and from
 * the two rules that document is explicit about:
 *
 *   "Search-first, not browse-first. Quick Find is the primary entry point.
 *    With this many settings, a tree alone is unusable."
 *
 *   "Do not copy the Setup tree depth. 15 top-level categories with 4 levels of
 *    nesting is only navigable because Quick Find exists."
 *
 * So: one level of grouping, never two, and a search box that is the fastest
 * way to anything. The sidebar is the map for somebody who does not yet know
 * what the system can do; search is for everybody after their first week.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo.jsx';
import { Icon, Loading } from '../components/ui.jsx';
import { GROUPS, sectionsFor, searchSections } from './registry.js';
import SetupHome from './SetupHome.jsx';

/* ------------------------------------------------------------ Quick Find */

/**
 * The search box, and the whole reason the sidebar can stay one level deep.
 *
 * Keyboard-first because this is a screen administrators live in: "/" focuses
 * it from anywhere, arrows move, Enter opens, Escape gets out. An admin console
 * that requires the mouse for its primary navigation is slower than the tab
 * strip it replaced.
 */
function QuickFind({ permissions }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const results = useMemo(() => searchSections(query, permissions), [query, permissions]);

  useEffect(() => {
    const onKey = (e) => {
      // Not while somebody is typing a rule name into a form somewhere.
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (section) => {
    setQuery('');
    setActive(0);
    inputRef.current?.blur();
    navigate(`/setup/${section.key}`);
  };

  const onKeyDown = (e) => {
    if (!results.length) {
      if (e.key === 'Escape') { setQuery(''); inputRef.current?.blur(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active] ?? results[0]); }
    else if (e.key === 'Escape') { setQuery(''); setActive(0); inputRef.current?.blur(); }
  };

  return (
    <div className="quickfind">
      <div className="quickfind-box">
        <Icon name="search" size={17} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder="Quick Find"
          aria-label="Search every setting"
          autoComplete="off"
        />
        {!query && <kbd className="quickfind-key">/</kbd>}
      </div>

      {query && (
        <ul className="quickfind-results" role="listbox">
          {results.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                className={`quickfind-hit${i === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(s)}
              >
                <Icon name={s.icon} size={16} />
                <span>
                  <strong>{s.label}</strong>
                  <span className="tiny muted">{s.blurb}</span>
                </span>
              </button>
            </li>
          ))}
          {!results.length && (
            <li className="quickfind-empty tiny muted">
              Nothing matches &ldquo;{query}&rdquo;.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- shell */

export default function SetupShell({ session, orgs = [], activeOrg, onSwitchOrg, onSignOut }) {
  const location = useLocation();
  const available = useMemo(() => sectionsFor(session.permissions), [session.permissions]);
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile drawer when the destination changes, or it covers the
  // screen the person just asked for.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  const grouped = GROUPS
    .map((g) => ({ ...g, items: available.filter((s) => s.group === g.key) }))
    .filter((g) => g.items.length);

  const orgName = orgs.find((o) => o.code === (activeOrg || session.sales_org))?.name ?? 'Bonanza';

  return (
    <div className="setup-shell">
      <header className="setup-topbar">
        <button
          type="button"
          className="btn-ghost btn-sm setup-burger"
          onClick={() => setNavOpen((v) => !v)}
          aria-label={navOpen ? 'Hide settings menu' : 'Show settings menu'}
          aria-expanded={navOpen}
        >
          <Icon name="menu" size={20} />
        </button>

        <span className="setup-brand">
          <BrandLogo org={activeOrg || session.sales_org} height={22} />
          <span className="setup-wordmark">Setup</span>
        </span>

        <div className="spacer" />

        {/* Kept, because settings are not all firm-wide: permission sets,
            content libraries and campaigns each carry a business. Without this
            an administrator cannot tell which book they are configuring. */}
        {orgs.length > 1 && (
          <label className="setup-org">
            <span className="sr-only">Business</span>
            <select value={activeOrg || ''} onChange={(e) => onSwitchOrg(e.target.value)}>
              <option value="">All businesses</option>
              {orgs.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
            </select>
          </label>
        )}

        {/* The way out is a first-class control, not a browser Back. Setup is a
            place you leave deliberately. */}
        <NavLink to="/" className="btn btn-ghost btn-sm setup-exit">
          <Icon name="arrow_back" size={17} />
          <span>Back to CRM</span>
        </NavLink>
      </header>

      <div className={`setup-body${navOpen ? ' nav-open' : ''}`}>
        <nav className="setup-nav" aria-label="Settings">
          <QuickFind permissions={session.permissions} />

          <NavLink to="/setup" end className="setup-link setup-link-home">
            <Icon name="home" size={17} />
            <span>Setup home</span>
          </NavLink>

          {grouped.map((g) => (
            <div key={g.key} className="setup-group">
              {/* A heading, not a collapsible. One level means everything is
                  already visible, and a disclosure that hides five items is a
                  click that buys nothing. */}
              <h2 className="setup-group-head">
                <Icon name={g.icon} size={14} />
                {g.label}
              </h2>
              <ul>
                {g.items.map((s) => (
                  <li key={s.key}>
                    <NavLink
                      to={`/setup/${s.key}`}
                      className={({ isActive }) => `setup-link${isActive ? ' is-active' : ''}`}
                      title={s.blurb}
                    >
                      <Icon name={s.icon} size={17} />
                      <span>{s.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <p className="setup-signature tiny muted">
            Signed in as {session.name} · {orgName}
            <button type="button" className="linklike" onClick={onSignOut}>Sign out</button>
          </p>
        </nav>

        {/* Tapping the page behind the drawer closes it, which is what every
            drawer on a phone does. */}
        {navOpen && (
          <button
            type="button" className="setup-scrim"
            aria-label="Close settings menu" onClick={() => setNavOpen(false)}
          />
        )}

        <main className="setup-main">
          <Suspense fallback={<Loading />}>
            {/* Nested under an explicit `/setup` parent. This <Routes> is not
                inside a parent <Route> — the shell is returned before the CRM
                router is built — so without the parent path, `index` would be
                matched against "/" while the location is "/setup", and every
                screen would render as nothing at all. */}
            <Routes>
              <Route path="/setup">
                <Route index element={<SetupHome session={session} />} />
                {available.map(({ key, Component }) => (
                  <Route key={key} path={key} element={<Component session={session} />} />
                ))}
                {/* A settings screen this role cannot open is not a 404 — it
                    exists, they may not see it. Home says so rather than the
                    router pretending the URL is wrong. */}
                <Route path="*" element={<Navigate to="/setup" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
