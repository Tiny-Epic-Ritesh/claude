import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { api, token, ROLE_LABEL } from '../api.js';
import GhostBar from './GhostBar.jsx';
import { Loading, Icon, Avatar, OrgSwitcher, ThemeToggle } from '../components/ui.jsx';
import { AppLauncher, TabBar, GlobalSearch, UserMenu } from '../components/AppNav.jsx';
import { applyOrgAccent } from '../theme.js';
import Login from './Login.jsx';
import Cockpit from './Cockpit.jsx';
import Leads from './Leads.jsx';
import LeadDetail from './LeadDetail.jsx';
import Clients from './Clients.jsx';
import LeadLists from './LeadLists.jsx';
import Dashboard from './Dashboard.jsx';
import Dashboards from './Dashboards.jsx';
import Pipeline from './Pipeline.jsx';
import Products from './Products.jsx';
import Ccm from './Ccm.jsx';
import Team from './Team.jsx';
import Revenue from './Revenue.jsx';
import Campaigns from './Campaigns.jsx';
import Content from './Content.jsx';
import Calendar from './Calendar.jsx';
import Kra from './Kra.jsx';
import Incentives from './Incentives.jsx';
import ListDetail from './ListDetail.jsx';
import ClientDetail from './ClientDetail.jsx';
import Tickets from './Tickets.jsx';
import Partners from './Partners.jsx';
import PartnerProfile from './PartnerProfile.jsx';
import KycConsole from './KycConsole.jsx';
import Tasks from './Tasks.jsx';
import MarketTab, { MarketStrip } from '../components/Market.jsx';
import Approvals from './Approvals.jsx';
import BrandLogo from '../components/BrandLogo.jsx';
import Reports from './Reports.jsx';
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
 * Everything an RM, caller or dealer uses all day stays in the main bundle:
 * a loading flicker on the screens people live in would be a worse trade than
 * the bytes.
 */
const SetupShell = lazy(() => import('../setup/SetupShell.jsx'));

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

  useEffect(() => {
    if (!token.get('crm')) { setSession(null); return; }
    api.get('/auth/me')
      .then((d) => setSession({ ...d.user, ghost_of: d.ghost_of ?? null }))
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

  const signOut = async () => {
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
            onLeave={() => window.location.reload()}
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
          onLeave={() => window.location.reload()}
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
        </div>
      </div>

      <Copilot open={copilotOpen} onClose={() => setCopilotOpen(false)} session={session} />
    </div>
  );
}
