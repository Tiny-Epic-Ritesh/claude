import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { api, appUrl, token, ROLE_LABEL } from '../api.js';
import GhostBar, { hasParentToken, parentName, leaveGhost, ghostReturnTo } from './GhostBar.jsx';
import { Loading, Icon, Avatar, OrgSwitcher, ThemeToggle } from '../components/ui.jsx';
import { AppLauncher, TabBar, GlobalSearch, UserMenu } from '../components/AppNav.jsx';
import { applyOrgAccent } from '../theme.js';
import Login from './Login.jsx';
import Cockpit from './Cockpit.jsx';
/* Cockpit imports this statically, so a dynamic import here would move
   nothing out of the main chunk -- Rollup warns about exactly that. */
import Dashboard from './Dashboard.jsx';
import MarketTab, { MarketStrip } from '../components/Market.jsx';
import BrandLogo from '../components/BrandLogo.jsx';
import Placeholder from './Placeholder.jsx';
import Copilot from './Copilot.jsx';

/**
 * Loaded on demand, not with the shell.
 *
 * Setup is the largest screen in the product and it reaches Object Manager,
 * Targets, Dispositions, Field masking and Navigation, so it carries most of
 * that weight with it. Nine of the eleven roles cannot open either of these
 * and were downloading both on every first load.
 *
 * This used to be the only thing loaded on demand, on the reasoning that a
 * loading flicker on the screens people live in would be a worse trade than the
 * bytes. The reasoning was right about the flicker and wrong about the choice:
 * the screens are on demand now too, and the flicker is answered by warming
 * them on idle rather than by shipping them all up front. See `screen` below.
 */
const SetupShell = lazy(() => import('../setup/SetupShell.jsx'));

/**
 * A screen that loads on demand and can be fetched ahead of time.
 *
 * `lazy` alone would trade bytes for a spinner on every first visit to a tab,
 * which is the objection recorded above and a fair one: an RM who opens Leads
 * forty times a day should not watch it load. `preload` is what settles it --
 * the shell warms every screen once it is idle, so the chunk is usually already
 * in memory by the time anyone clicks, and the download has moved off the path
 * to first paint rather than out of the product.
 */
const screen = (load) => {
  const Component = lazy(load);
  Component.preload = load;
  return Component;
};

const Leads = screen(() => import('./Leads.jsx'));
const LeadDetail = screen(() => import('./LeadDetail.jsx'));
const Clients = screen(() => import('./Clients.jsx'));
const ClientDetail = screen(() => import('./ClientDetail.jsx'));
const LeadLists = screen(() => import('./LeadLists.jsx'));
const ListDetail = screen(() => import('./ListDetail.jsx'));
const Dashboards = screen(() => import('./Dashboards.jsx'));
const Pipeline = screen(() => import('./Pipeline.jsx'));
const Products = screen(() => import('./Products.jsx'));
const Ccm = screen(() => import('./Ccm.jsx'));
const Team = screen(() => import('./Team.jsx'));
const Revenue = screen(() => import('./Revenue.jsx'));
const Campaigns = screen(() => import('./Campaigns.jsx'));
const Content = screen(() => import('./Content.jsx'));
const Calendar = screen(() => import('./Calendar.jsx'));
const Kra = screen(() => import('./Kra.jsx'));
const Incentives = screen(() => import('./Incentives.jsx'));
const Tickets = screen(() => import('./Tickets.jsx'));
const Partners = screen(() => import('./Partners.jsx'));
const PartnerProfile = screen(() => import('./PartnerProfile.jsx'));
const KycConsole = screen(() => import('./KycConsole.jsx'));
const Tasks = screen(() => import('./Tasks.jsx'));
const Reports = screen(() => import('./Reports.jsx'));
const Approvals = screen(() => import('./Approvals.jsx'));

/** Warmed on idle, after the shell has painted. Order is not significant. */
const SCREENS = [
  Leads,
  LeadDetail,
  Clients,
  ClientDetail,
  LeadLists,
  ListDetail,
  Dashboards,
  Pipeline,
  Products,
  Ccm,
  Team,
  Revenue,
  Campaigns,
  Content,
  Calendar,
  Kra,
  Incentives,
  Tickets,
  Partners,
  PartnerProfile,
  KycConsole,
  Tasks,
  Reports,
  Approvals,
];

/**
 * `/admin` was Setup's address for the whole of the build so far, and
 * `/admin?tab=sla` was made to work only days ago. Both keep working: the tab
 * name and the section key are the same word, so the redirect is a rename
 * rather than a translation table that would need maintaining.
 */
function AdminRedirect() {
  const [search] = useSearchParams();
  const tab = search.get('tab');
  return <Navigate to={`/setup${tab ? `/${tab}` : ''}`} replace />;
}
const DataTools = lazy(() => import('./DataTools.jsx'));

/**
 * Navigation is Salesforce-shaped: an App Launcher switches working surfaces
 * and a tab bar shows the one you are in. There is deliberately no sidebar —
 * two navigation systems on one screen means every user reads both to find
 * anything. The app and tab registry lives on the server, filtered by
 * permission and sales org before it is ever sent.
 */
const NAV = [
  { section: null, items: [
    { to: '/', label: 'Overview', icon: 'dashboard', end: true },
    { to: '/revenue', label: 'Revenue Board', icon: 'leaderboard', needs: ['report.team', 'report.system'] },
    { to: '/leads', label: 'Lead Board', icon: 'group_add', needs: ['lead.view.all', 'lead.view.own', 'lead.view.product'] },
    { to: '/clients', label: 'Clients Board', icon: 'people', needs: ['client.view.all', 'client.view.own'] },
    { to: '/tickets', label: 'Query Management', icon: 'support_agent', needs: ['ticket.create'] },
    { to: '/tasks', label: 'Tasks', icon: 'assignment_turned_in' },
    // Every role, no capability gate: delayed index levels and a results
    // calendar are context anyone on a broking floor uses daily.
    { to: '/market', label: 'Market', icon: 'monitoring' },
  ] },
  { section: 'Business', items: [
    { to: '/kyc', label: 'KYC Console', icon: 'verified_user', needs: ['kyc.view'] },
    { to: '/partners', label: 'Partners', icon: 'handshake', needs: ['partner.view'] },
    { to: '/reports', label: 'Reports', icon: 'assessment', needs: ['report.team', 'report.system'] },
    /* No capability gate: anyone may build a dashboard about their own
       records (Q-13). Publishing one to other people is what needs
       report.team, and that is checked where it happens. */
    { to: '/boards', label: 'My Dashboards', icon: 'space_dashboard' },
    { to: '/data', label: 'Data Tools', icon: 'swap_vert', needs: ['lead.create', 'lead.delete'] },
  ] },
  { section: 'Configuration', items: [
    { to: '/setup', label: 'Setup', icon: 'settings', needs: ['admin.users', 'admin.products', 'admin.rules', 'admin.templates', 'admin.content', 'campaign.manage'] },
  ] },
];

export default function Crm() {
  const [session, setSession] = useState(undefined);   // undefined = checking
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [apps, setApps] = useState([]);
  const [features, setFeatures] = useState({});
  const [appId, setAppId] = useState(() => {
    try { return localStorage.getItem('bnz_app') || null; } catch { return null; }
  });
  const [activeOrg, setActiveOrg] = useState(() => {
    try { return localStorage.getItem('bnz_active_org') || null; } catch { return null; }
  });
  const navigate = useNavigate();
  const location = useLocation();

  /* Fetch every screen's chunk once the shell is idle. This is what keeps the
     split from costing a spinner on the tabs people use all day: by the time
     anyone clicks Leads, the chunk is already there. It runs after first paint,
     so it buys the smaller critical path without giving up the warm cache. */
  useEffect(() => {
    let cancelled = false;
    const warm = () => { if (!cancelled) SCREENS.forEach((s) => s.preload()); };

    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => { cancelled = true; window.cancelIdleCallback(id); };
    }
    const id = setTimeout(warm, 2000);   // Safari has no requestIdleCallback.
    return () => { cancelled = true; clearTimeout(id); };
  }, []);

  useEffect(() => {
    if (!token.get('crm')) { setSession(null); return; }
    api.get('/auth/me')
      /* `hasParentToken()` is the local, synchronous truth: an administrator's
         own token is only ever stashed while they are acting as somebody else.
         Trusting it as well as the server means the banner cannot go missing
         because a response was slow, cached or revalidated — which is exactly
         how it went missing before. */
      .then((d) => setSession({
        ...d.user,
        ghost_of: d.ghost_of ?? (hasParentToken() ? { id: null, name: parentName() ?? 'your account' } : null),
      }))
      .catch(() => { token.clear('crm'); setSession(null); });
  }, []);

  // Which businesses this user may work in, and what colour each one is.
  useEffect(() => {
    if (!session) return;
    api.get('/orgs')
      .then((d) => {
        setOrgs(d.orgs || []);
        const chosen = (d.orgs || []).find((o) => o.code === activeOrg) ?? (d.orgs || []).find((o) => o.code === d.active_default);
        if (chosen) applyOrgAccent(chosen);
      })
      .catch(() => { /* single-org deployments simply get the default palette */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Apps are re-fetched per org, because a tab can be restricted to one
  // business and the strip must not offer a door that opens onto nothing.
  useEffect(() => {
    if (!session) return;
    api.get('/apps')
      .then((d) => {
        setApps(d.apps || []);
        setFeatures(d.features || {});
        if (!d.apps?.some((a) => a.id === appId)) setAppId(d.default_app);
      })
      .catch(() => { setApps([]); setFeatures({}); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, activeOrg]);

  const pickApp = (app) => {
    setAppId(app.id);
    try { localStorage.setItem('bnz_app', app.id); } catch { /* ignore */ }
    navigate(app.primary);
  };

  const switchOrg = (code) => {
    setActiveOrg(code);
    try {
      if (code) localStorage.setItem('bnz_active_org', code);
      else localStorage.removeItem('bnz_active_org');
    } catch { /* ignore */ }

    api.setOrg(code);
    const org = orgs.find((o) => o.code === code);
    // "All businesses" keeps the home org's colour: the alternative is a third
    // neutral palette, which would just look like a third business.
    applyOrgAccent(org ?? orgs.find((o) => o.code === session.sales_org) ?? orgs[0]);

    // Everything on screen is scoped to the old org, so re-mount the page.
    navigate(0);
  };

  if (session === undefined) return <Loading label="Checking your session…" />;
  if (!session) return <Login onSignedIn={setSession} />;

  const allowed = (item) => !item.needs || item.needs.some((p) => session.permissions.includes(p));

  /*
   * Signing out, while acting as somebody else, returns rather than ends.
   *
   * This is the trap that sent an administrator to the login screen: the banner
   * was not rendering, so the profile menu's Sign out was the only exit they
   * could see — and it ended both sessions. Salesforce does not offer that from
   * inside a "log in as" session either. Ending your own session is available
   * again the moment you are yourself.
   */
  const signOut = async () => {
    if (hasParentToken()) {
      const { returnTo } = await leaveGhost();
      window.location.assign(appUrl(returnTo || '/setup/users'));
      return;
    }
    try { await api.post('/auth/logout'); } catch { /* token may already be gone */ }
    token.clear('crm');
    setSession(null);
    navigate('/');
  };

  const orgName = orgs.find((o) => o.code === (activeOrg || session.sales_org))?.name ?? 'Bonanza';

  /* Setup is its own place, not a page inside this one.
   *
   * Returned before the CRM shell is built rather than as a route inside it, so
   * none of it renders: no Home / Leads / Pipeline tab strip, no market ticker,
   * no app launcher. An administrator changing how permissions work should not
   * have the sales navigation sitting above them, and 22 settings screens
   * crammed into a second scrolling strip is what that produced.
   *
   * The ghost banner is the one thing that follows, and it has to: somebody
   * acting as another user must be told so on every screen, and the screen
   * where they can rewrite the permission model least of all. */
  if (location.pathname === '/setup' || location.pathname.startsWith('/setup/')) {
    return (
      <>
        {session.ghost_of && (
          <GhostBar
            ghostOf={session.ghost_of.name}
            actingAs={session.name}
            onLeave={(restored, returnTo) => window.location.assign(appUrl(restored ? (returnTo || '/setup/users') : '/'))}
          />
        )}
        <Suspense fallback={<Loading />}>
          <SetupShell
            session={session}
            orgs={orgs}
            activeOrg={activeOrg}
            onSwitchOrg={switchOrg}
            onSignOut={signOut}
          />
        </Suspense>
      </>
    );
  }

  return (
    <div className={`app-shell${session.ghost_of ? ' is-ghosting' : ''}`}>
      {/* Fixed to the top of the window and not dismissible. See GhostBar. */}
      {session.ghost_of && (
        <GhostBar
          ghostOf={session.ghost_of.name}
          actingAs={session.name}
          onLeave={(restored, returnTo) => window.location.assign(appUrl(restored ? (returnTo || '/setup/users') : '/'))}
        />
      )}
      <div className="main-content">
        <header className="topbar">
          <span className="topbar-brand">
            <BrandLogo org={activeOrg || session.sales_org} height={26} />
          </span>

          <AppLauncher apps={apps} activeApp={appId} onPick={pickApp} />

          <GlobalSearch />

          <div className="spacer" />

          <OrgSwitcher orgs={orgs} value={activeOrg} onChange={switchOrg} />
          <ThemeToggle />

          {/* ENH-22: Setup sits in the header for anyone who has it, rather
              than only inside the App Launcher. It is the destination an
              administrator returns to most, and hiding it behind a grid of
              nine apps cost a click every time. */}
          {session.permissions.some((p) => ['admin.users', 'admin.products', 'admin.rules', 'admin.system'].includes(p)) && (
            <NavLink to="/setup" className="btn-ghost btn-sm" title="Setup">
              <Icon name="settings" size={18} />
            </NavLink>
          )}

          <button className="btn-ghost btn-sm copilot-trigger" onClick={() => setCopilotOpen(true)} title="Ask the copilot">
            <Icon name="auto_awesome" size={18} />
          </button>

          <UserMenu session={session} orgName={orgName} onSignOut={signOut} />
        </header>

        <TabBar app={apps.find((a) => a.id === appId)} />

        {/* ENH-03 / ENH-04: on every page rather than the cockpit alone, and
            only for roles and people configured to see it. */}
        {features.market_ticker && <MarketStrip className="on-shell" />}

        <div className="page">

          <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Cockpit session={session} />} />
            <Route path="/leads" element={<Leads session={session} />} />
            <Route path="/leads/:id" element={<LeadDetail session={session} />} />
            <Route path="/clients" element={<Clients session={session} />} />
            <Route path="/clients/:id" element={<ClientDetail session={session} />} />
            <Route path="/lists" element={<LeadLists session={session} />} />
            <Route path="/lists/:id" element={<ListDetail session={session} />} />
            <Route path="/pipeline" element={<Pipeline session={session} />} />
            <Route path="/products" element={<Products session={session} />} />
            <Route path="/ccm" element={<Ccm session={session} />} />
            <Route path="/team" element={<Team session={session} />} />
            <Route path="/revenue" element={<Revenue session={session} />} />
            <Route path="/campaigns" element={<Campaigns session={session} />} />
            <Route path="/content" element={<Content session={session} />} />
            <Route path="/calendar" element={<Calendar session={session} />} />
            <Route path="/kra" element={<Kra session={session} />} />
            <Route path="/incentives" element={<Incentives session={session} />} />
            {/* ENH-24b: the dashboard lives on the homepage, which was the
                stated preference. This tab renders the same component so
                the launcher entry works without a second implementation. */}
            <Route path="/dashboards" element={<Dashboard />} />
            {/* The role dashboard is what everyone lands on; this is the one
                they build themselves (P2-17b). */}
            <Route path="/boards" element={<Dashboards />} />
            <Route path="/tickets" element={<Tickets session={session} />} />
            <Route path="/tickets/:id" element={<Tickets session={session} />} />
            <Route path="/partners" element={<Partners session={session} />} />
            <Route path="/partners/:id" element={<PartnerProfile session={session} />} />
            <Route path="/kyc" element={<KycConsole session={session} />} />
            <Route path="/tasks" element={<Tasks session={session} />} />
            <Route path="/reports" element={<Reports session={session} />} />
            <Route path="/market" element={<MarketTab />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route
              path="/data"
              element={<Suspense fallback={<Loading />}><DataTools session={session} /></Suspense>}
            />
            {/* Where Setup used to live. Kept as a redirect rather than
                removed: bookmarks exist, and `?tab=` links were only just made
                to work. `AdminRedirect` carries the tab across to its section. */}
            <Route path="/admin" element={<AdminRedirect />} />

            {/* Every advertised module is built. Placeholder is kept only for
                an unknown route, which is a genuine 404 rather than a promise. */}

            <Route path="*" element={<Placeholder moduleKey="__unknown" />} />
          </Routes>
          </Suspense>
        </div>
      </div>

      <Copilot open={copilotOpen} onClose={() => setCopilotOpen(false)} session={session} />
    </div>
  );
}
