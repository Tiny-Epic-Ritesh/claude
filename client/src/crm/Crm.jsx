import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, token, ROLE_LABEL } from '../api.js';
import { Loading, Icon, Avatar, OrgSwitcher, ThemeToggle } from '../components/ui.jsx';
import { AppLauncher, TabBar, GlobalSearch, UserMenu } from '../components/AppNav.jsx';
import { applyOrgAccent } from '../theme.js';
import Login from './Login.jsx';
import Cockpit from './Cockpit.jsx';
import Leads from './Leads.jsx';
import LeadDetail from './LeadDetail.jsx';
import Tickets from './Tickets.jsx';
import Partners from './Partners.jsx';
import PartnerProfile from './PartnerProfile.jsx';
import KycConsole from './KycConsole.jsx';
import Tasks from './Tasks.jsx';
import Admin from './Admin.jsx';
import MarketTab, { MarketStrip } from '../components/Market.jsx';
import Approvals from './Approvals.jsx';
import BrandLogo from '../components/BrandLogo.jsx';
import Reports from './Reports.jsx';
import DataTools from './DataTools.jsx';
import Placeholder from './Placeholder.jsx';
import Copilot from './Copilot.jsx';

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
    { to: '/clients', label: 'Clients Board', icon: 'people', needs: ['lead.view.all', 'lead.view.own'] },
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
    { to: '/data', label: 'Data Tools', icon: 'swap_vert', needs: ['lead.create', 'lead.delete'] },
  ] },
  { section: 'Configuration', items: [
    { to: '/admin', label: 'Administration', icon: 'settings', needs: ['admin.users', 'admin.products', 'admin.rules', 'admin.templates', 'admin.content', 'campaign.manage'] },
  ] },
];

export default function Crm() {
  const [session, setSession] = useState(undefined);   // undefined = checking
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [apps, setApps] = useState([]);
  const [appId, setAppId] = useState(() => {
    try { return localStorage.getItem('bnz_app') || null; } catch { return null; }
  });
  const [activeOrg, setActiveOrg] = useState(() => {
    try { return localStorage.getItem('bnz_active_org') || null; } catch { return null; }
  });
  const navigate = useNavigate();

  useEffect(() => {
    if (!token.get('crm')) { setSession(null); return; }
    api.get('/auth/me')
      .then((d) => setSession(d.user))
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
        if (!d.apps?.some((a) => a.id === appId)) setAppId(d.default_app);
      })
      .catch(() => setApps([]));
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

  return (
    <div className="app-shell">
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

          <button className="btn-ghost btn-sm" onClick={() => setCopilotOpen(true)} title="Ask the copilot">
            <Icon name="auto_awesome" size={18} />
          </button>

          <UserMenu session={session} orgName={orgName} onSignOut={signOut} />
        </header>

        <TabBar app={apps.find((a) => a.id === appId)} />

        <div className="page">
          <MarketStrip className="on-cockpit" />

          <Routes>
            <Route path="/" element={<Cockpit session={session} />} />
            <Route path="/leads" element={<Leads session={session} />} />
            <Route path="/leads/:id" element={<LeadDetail session={session} />} />
            <Route path="/tickets" element={<Tickets session={session} />} />
            <Route path="/tickets/:id" element={<Tickets session={session} />} />
            <Route path="/partners" element={<Partners session={session} />} />
            <Route path="/partners/:id" element={<PartnerProfile session={session} />} />
            <Route path="/kyc" element={<KycConsole session={session} />} />
            <Route path="/tasks" element={<Tasks session={session} />} />
            <Route path="/reports" element={<Reports session={session} />} />
            <Route path="/market" element={<MarketTab />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/data" element={<DataTools session={session} />} />
            <Route path="/admin" element={<Admin session={session} />} />

            {/* Advertised in the launcher, surface not built yet. Each states
                what it will hold and points at the part that already works. */}
            {['pipeline', 'clients', 'calendar', 'products', 'ccm', 'team',
              'revenue', 'kra', 'incentives', 'campaigns', 'content', 'lists',
              'dashboards'].map((key) => (
                <Route key={key} path={`/${key}`} element={<Placeholder moduleKey={key} />} />
              ))}

            <Route path="*" element={<Placeholder moduleKey="__unknown" />} />
          </Routes>
        </div>
      </div>

      <Copilot open={copilotOpen} onClose={() => setCopilotOpen(false)} session={session} />
    </div>
  );
}
