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
 *
 * WHAT EACH PERSON CONTROLS
 * -------------------------
 * Pins, density and folded groups are per person and live on the server, not in
 * the browser — an administrator who arranges Setup on the office machine
 * should find it arranged on the laptop. None of it changes what anybody may do
 * or see. Which screens a ROLE sees is the separate thing, configured on the
 * Navigation screen and applied here.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo.jsx';
import { Icon, Loading, OrgSwitcher, ThemeToggle } from '../components/ui.jsx';
import Copilot from '../crm/Copilot.jsx';
import { api } from '../api.js';
import { GROUPS, sectionsFor, sectionByKey, searchSections } from './registry.js';
import SetupHome from './SetupHome.jsx';
import SetupBoundary from './SetupBoundary.jsx';

/* --------------------------------------------------------- preferences */

/**
 * Per-person preferences, saved as they change.
 *
 * Written optimistically: a pin should feel instant, and a failed write costs
 * the person a star that comes back on reload rather than anything real.
 */
function usePrefs() {
  const [prefs, setPrefs] = useState(null);
  const [sections, setSections] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/setup/preferences')
      .then((d) => { if (alive) { setPrefs(d.prefs ?? {}); setSections(d.sections ?? null); } })
      .catch(() => { if (alive) { setPrefs({}); setSections(null); } });
    return () => { alive = false; };
  }, []);

  const set = useCallback((key, value) => {
    setPrefs((p) => ({ ...(p ?? {}), [key]: value }));
    api.put(`/setup/preferences/${key}`, { value }).catch(() => { /* see above */ });
  }, []);

  return { prefs, sections, set, ready: prefs !== null };
}

/* ------------------------------------------------------------ Quick Find */

/**
 * The search box, and the whole reason the sidebar can stay one level deep.
 *
 * Keyboard-first because this is a screen administrators live in: "/" focuses
 * it from anywhere, arrows move, Enter opens, Escape gets out. An admin console
 * that needs the mouse for its primary navigation is slower than the tab strip
 * it replaced.
 */
function QuickFind({ sections }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const results = useMemo(() => searchSections(query, sections), [query, sections]);

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
            <li className="quickfind-empty tiny muted">Nothing matches &ldquo;{query}&rdquo;.</li>
          )}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- sidebar row */

function SectionLink({ section, pinned, onTogglePin }) {
  return (
    <div className="setup-row">
      <NavLink
        to={`/setup/${section.key}`}
        className={({ isActive }) => `setup-link${isActive ? ' is-active' : ''}`}
        title={section.blurb}
      >
        <Icon name={section.icon} size={17} />
        <span>{section.label}</span>
      </NavLink>
      {/* Appears on hover or focus so the sidebar is not a column of stars,
          but is reachable by keyboard rather than hover alone. */}
      <button
        type="button"
        className={`setup-pin${pinned ? ' is-pinned' : ''}`}
        onClick={() => onTogglePin(section.key)}
        aria-label={pinned ? `Unpin ${section.label}` : `Pin ${section.label}`}
        title={pinned ? 'Unpin' : 'Pin to the top'}
      >
        <Icon name={pinned ? 'star' : 'star_border'} size={15} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ page head */

/**
 * The header every screen gets, drawn here rather than by each screen.
 *
 * Before this, one screen said "12 roles", another "API access", another
 * nothing at all — 22 screens each inventing their own opening. The group name
 * above the title is the answer to "where am I", which a flat sidebar of 22
 * items does not otherwise give.
 */
function PageHead({ section }) {
  if (!section) return null;
  const group = GROUPS.find((g) => g.key === section.group);
  return (
    <header className="setup-pagehead">
      <div>
        {group && (
          <span className="setup-crumb">
            <Icon name={group.icon} size={13} />
            {group.label}
          </span>
        )}
        <h1>{section.label}</h1>
        <p>{section.blurb}</p>
      </div>
      {/* Screens promote their primary action into here. Empty until one does,
          which is why it collapses rather than reserving space. */}
      <div id="setup-actions" className="setup-actions" />
    </header>
  );
}

/* ---------------------------------------------------------------- shell */

export default function SetupShell({ session, orgs = [], activeOrg, onSwitchOrg, onSignOut }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { prefs, sections: allowed, set, ready } = usePrefs();
  const [navOpen, setNavOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);

  const pins = prefs?.pins ?? [];
  const density = prefs?.density ?? 'comfortable';
  const collapsed = prefs?.collapsed ?? [];

  /* What this person may open: their capabilities, narrowed by what their role
     has been configured to see. `allowed` null means the preferences call has
     not answered — fall back to capability alone rather than an empty sidebar. */
  const available = useMemo(() => {
    const byCapability = sectionsFor(session.permissions);
    if (!allowed) return byCapability;
    return byCapability.filter((s) => allowed.includes(s.key));
  }, [session.permissions, allowed]);

  const current = location.pathname.startsWith('/setup/')
    ? sectionByKey(location.pathname.slice('/setup/'.length))
    : null;

  // Close the mobile drawer when the destination changes, or it covers the
  // screen the person just asked for.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  /* Remember where they were, and go back there. Only from Setup home, so a
     link straight to a screen is never overridden — the last place you were is
     a default, not a redirect. */
  useEffect(() => {
    if (!ready) return;
    if (location.pathname !== '/setup') return;
    const last = prefs?.last;
    if (last && available.some((s) => s.key === last)) navigate(`/setup/${last}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (current && prefs?.last !== current.key) set('last', current.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key]);

  const togglePin = (key) => set('pins', pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key]);
  const toggleGroup = (key) => set('collapsed', collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);

  const grouped = GROUPS
    .map((g) => ({ ...g, items: available.filter((s) => s.group === g.key) }))
    .filter((g) => g.items.length);

  const pinned = pins.map((k) => available.find((s) => s.key === k)).filter(Boolean);

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
            an administrator cannot tell which book they are configuring.
            The same control the CRM header uses, rather than a bare select —
            it carries the business's own colour, which is how you tell at a
            glance which one you are changing. */}
        <OrgSwitcher orgs={orgs} value={activeOrg} onChange={onSwitchOrg} />

        <ThemeToggle />

        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => setCopilotOpen(true)}
          title="Ask the copilot"
          aria-label="Ask the copilot"
        >
          <Icon name="auto_awesome" size={18} />
        </button>

        {/* The way out is a first-class control, not a browser Back. Setup is a
            place you leave deliberately. */}
        <NavLink to="/" className="btn btn-ghost btn-sm setup-exit">
          <Icon name="arrow_back" size={17} />
          <span>Back to CRM</span>
        </NavLink>
      </header>

      <div className={`setup-body${navOpen ? ' nav-open' : ''}`}>
        <nav className="setup-nav" aria-label="Settings">
          <QuickFind sections={available} />

          <NavLink
            to="/setup"
            end
            className={({ isActive }) => `setup-link setup-link-home${isActive ? ' is-active' : ''}`}
          >
            <Icon name="home" size={17} />
            <span>Setup home</span>
          </NavLink>

          {pinned.length > 0 && (
            <div className="setup-group">
              <h2 className="setup-group-head"><Icon name="star" size={14} />Pinned</h2>
              <div>
                {pinned.map((s) => (
                  <SectionLink key={s.key} section={s} pinned onTogglePin={togglePin} />
                ))}
              </div>
            </div>
          )}

          {grouped.map((g) => {
            const shut = collapsed.includes(g.key);
            return (
              <div key={g.key} className="setup-group">
                <h2 className="setup-group-head">
                  <button type="button" className="setup-group-toggle" onClick={() => toggleGroup(g.key)} aria-expanded={!shut}>
                    <Icon name={g.icon} size={14} />
                    <span>{g.label}</span>
                    <Icon name={shut ? 'expand_more' : 'expand_less'} size={15} />
                  </button>
                </h2>
                {!shut && (
                  <div>
                    {g.items.map((s) => (
                      <SectionLink key={s.key} section={s} pinned={pins.includes(s.key)} onTogglePin={togglePin} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className="setup-footer">
            {/* Density is here rather than buried in a preferences screen,
                because it is the kind of thing you change while looking at the
                table that is too tall. */}
            <div className="setup-density" role="group" aria-label="Row density">
              {[['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={density === k ? 'is-on' : ''}
                  onClick={() => set('density', k)}
                  aria-pressed={density === k}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="setup-signature tiny muted">
              {session.name}
              <button type="button" className="linklike" onClick={onSignOut}>Sign out</button>
            </p>
          </div>
        </nav>

        {/* Tapping the page behind the drawer closes it, which is what every
            drawer on a phone does. */}
        {navOpen && (
          <button
            type="button" className="setup-scrim"
            aria-label="Close settings menu" onClick={() => setNavOpen(false)}
          />
        )}

        <main className="setup-main" data-density={density}>
          <PageHead section={current} />

          {/* Keyed on the path so a crash on one screen clears when you leave
              it, rather than sticking until a full reload. */}
          <SetupBoundary resetKey={location.pathname}>
            <Suspense fallback={<Loading />}>
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
          </SetupBoundary>
        </main>
      </div>

      <Copilot open={copilotOpen} onClose={() => setCopilotOpen(false)} session={session} />
    </div>
  );
}
