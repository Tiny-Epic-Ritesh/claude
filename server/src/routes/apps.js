/**
 * Apps and tabs — the Salesforce navigation model.
 *
 * Salesforce does not present one flat menu of everything. It groups tabs into
 * APPS, and the App Launcher switches between them. That is what stops a
 * hundred-object org from becoming an unusable sidebar, and it is why a service
 * agent and a sales rep can share one platform without sharing one cluttered
 * screen.
 *
 * The registry lives on the server rather than in the client bundle for two
 * reasons. It has to be filtered by permission AND by sales org before it
 * reaches the browser — a tab the user cannot open should not be in the payload
 * at all, not merely hidden by CSS. And it is the thing an administrator will
 * eventually configure, so it belongs where configuration lives.
 *
 * `needs` is an OR across permissions: hold any one and the tab appears. `orgs`
 * restricts a tab to particular businesses — Bigul has no PMS desk, so the
 * Product RM tab has no meaning there.
 */

import { Router } from 'express';
import { requireUser, can, orgsFor, activeOrg } from '../auth.js';
import { visibleTabs, FEATURE_KEYS, resolveTab } from '../engine/tabs.js';

const router = Router();
router.use(requireUser);

/**
 * Tabs, keyed by id. A tab is a destination; apps assemble them into a working
 * surface. The same tab may appear in several apps, which is exactly how
 * Salesforce behaves — Accounts lives in Sales and in Service.
 */
export const TABS = {
  home:       { id: 'home',       label: 'Home',            icon: 'home',                  to: '/' },
  leads:      { id: 'leads',      label: 'Leads',           icon: 'group_add',             to: '/leads',      needs: ['lead.view.all', 'lead.view.own', 'lead.view.product'] },
  clients:    { id: 'clients',    label: 'Clients',         icon: 'people',                to: '/clients',    needs: ['client.view.all', 'client.view.own'] },
  pipeline:   { id: 'pipeline',   label: 'Pipeline',        icon: 'view_kanban',           to: '/pipeline',   needs: ['lead.view.all', 'lead.view.own', 'lead.view.product'] },
  tasks:      { id: 'tasks',      label: 'Tasks',           icon: 'assignment_turned_in',  to: '/tasks' },
  // No capability gate: delayed index levels, a results calendar and the
  // issue pipeline are context every role on a broking floor uses daily,
  // and none of it is client data.
  market:     { id: 'market',     label: 'Market',          icon: 'monitoring',            to: '/market' },
  // No capability gate: everyone either has approvals waiting on them or has
  // asked for something. The page itself shows only what applies to them.
  approvals:  { id: 'approvals',  label: 'Approvals',       icon: 'approval',              to: '/approvals' },
  calendar:   { id: 'calendar',   label: 'Calendar',        icon: 'calendar_month',        to: '/calendar' },
  kyc:        { id: 'kyc',        label: 'KYC Console',     icon: 'verified_user',         to: '/kyc',        needs: ['kyc.view'] },
  products:   { id: 'products',   label: 'Products',        icon: 'inventory_2',           to: '/products' },
  revenue:    { id: 'revenue',    label: 'Revenue',         icon: 'leaderboard',           to: '/revenue',    needs: ['report.team', 'report.system', 'report.self'] },
  kra:        { id: 'kra',        label: 'KRA Scorecard',   icon: 'article',               to: '/kra' },
  incentives: { id: 'incentives', label: 'Incentives',      icon: 'account_balance_wallet', to: '/incentives' },

  tickets:    { id: 'tickets',    label: 'Cases',           icon: 'support_agent',         to: '/tickets',    needs: ['ticket.view.all', 'ticket.view.own'] },
  ccm:        { id: 'ccm',        label: 'Client Master',   icon: 'recent_actors',         to: '/ccm',        needs: ['lead.view.all', 'lead.view.own'] },

  partners:   { id: 'partners',   label: 'Partners',        icon: 'handshake',             to: '/partners',   needs: ['partner.view'] },
  team:       { id: 'team',       label: 'My Team',         icon: 'groups',                to: '/team',       needs: ['report.team', 'report.system'] },

  campaigns:  { id: 'campaigns',  label: 'Campaigns',       icon: 'campaign',              to: '/campaigns',  needs: ['campaign.manage'] },
  content:    { id: 'content',    label: 'Marketing Hub',   icon: 'auto_stories',          to: '/content',    needs: ['admin.content', 'campaign.manage'] },
  lists:      { id: 'lists',      label: 'Lead Lists',      icon: 'format_list_bulleted',  to: '/lists',      needs: ['list.create'] },

  reports:    { id: 'reports',    label: 'Reports',         icon: 'assessment',            to: '/reports',    needs: ['report.team', 'report.system', 'report.self'] },
  dashboards: { id: 'dashboards', label: 'Dashboards',      icon: 'space_dashboard',       to: '/dashboards', needs: ['report.team', 'report.system', 'report.self'] },

  data:       { id: 'data',       label: 'Data Tools',      icon: 'swap_vert',             to: '/data',       needs: ['lead.create', 'lead.delete'] },
  setup:      { id: 'setup',      label: 'Setup',           icon: 'settings',              to: '/admin',      needs: ['admin.users', 'admin.products', 'admin.rules', 'admin.system'] },
};

/**
 * Apps. `primary` is the tab the App Launcher opens.
 *
 * The split follows how the desk actually works rather than how the data is
 * modelled: a customer-care agent lives in Cases all day and never opens a
 * Revenue board, so putting both in one app would cost them a scan of the tab
 * bar every time.
 */
export const APPS = [
  {
    id: 'sales',
    label: 'Sales Console',
    description: 'Leads, clients and the pipeline you own.',
    icon: 'trending_up',
    colour: '#81c141',
    tabs: ['home', 'leads', 'pipeline', 'clients', 'lists', 'tasks', 'calendar', 'kyc', 'products', 'market', 'approvals'],
    needs: ['lead.view.all', 'lead.view.own', 'lead.view.product'],
  },
  {
    id: 'service',
    label: 'Service Console',
    description: 'Cases, SLAs and the firm-wide client directory.',
    icon: 'support_agent',
    colour: '#3d6ea8',
    tabs: ['home', 'tickets', 'clients', 'ccm', 'tasks'],
    /* Reading cases is what the console is for; raising them is one action
       inside it. Keyed off the view grants now that those exist, so a
       read-only service role is not shown a console it cannot open — and a
       role that may raise a case but not read one is not either. */
    needs: ['ticket.view.all', 'ticket.view.own'],
  },
  {
    id: 'partner',
    label: 'Partner Management',
    description: 'Partner onboarding, performance and commission.',
    icon: 'handshake',
    colour: '#7a5cc4',
    tabs: ['home', 'partners', 'team', 'leads', 'market', 'approvals'],
    needs: ['partner.view'],
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Revenue, KRA scorecard and incentives.',
    icon: 'leaderboard',
    colour: '#c98a1e',
    tabs: ['home', 'revenue', 'kra', 'incentives', 'team', 'market'],
    needs: ['report.team', 'report.system', 'report.self'],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    description: 'Campaigns, content and lead lists.',
    icon: 'campaign',
    colour: '#c4557f',
    tabs: ['home', 'campaigns', 'content', 'lists', 'leads', 'market'],
    needs: ['campaign.manage', 'admin.content'],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    description: 'Reports, dashboards and the report builder.',
    icon: 'insights',
    colour: '#2f8f8a',
    tabs: ['home', 'reports', 'dashboards'],
    needs: ['report.team', 'report.system', 'report.self'],
  },
  {
    id: 'setup',
    label: 'Setup',
    description: 'Users, objects, permissions and configuration.',
    icon: 'settings',
    colour: '#5a6472',
    tabs: ['setup', 'data'],
    needs: ['admin.users', 'admin.products', 'admin.rules', 'admin.system'],
  },
];

/* --------------------------------------------------------------- rules */

/** OR across permissions: holding any one is enough. */
const permitted = (user, needs) => !needs || needs.some((p) => can(user.role, p));

/** A tab restricted to some businesses is dropped for the rest. */
const inOrg = (entry, orgs) => !entry.orgs || entry.orgs.some((o) => orgs.includes(o));

export function appsFor(user, orgs) {
  /**
   * Three independent gates, and the order matters for what each one means.
   *
   *   capability  — can the API serve this at all? Enforced there too; this is
   *                 only stopping us from advertising a door that is locked.
   *   org         — Bigul has no PMS desk, so the tab has no meaning there.
   *   visibility  — the administrator's ENH-08 choice. Navigation, not security:
   *                 it tidies a screen and protects nothing on its own.
   *
   * Resolved once per request rather than per tab, so this is two extra queries
   * for the whole navigation payload.
   */
  const visible = visibleTabs(user, Object.keys(TABS));

  return APPS
    .filter((app) => permitted(user, app.needs))
    .map((app) => {
      const tabs = app.tabs
        .map((id) => TABS[id])
        .filter(Boolean)
        .filter((t) => permitted(user, t.needs) && inOrg(t, orgs) && visible.has(t.id));
      /* The tab the launcher opens. P3-32.

         It used to be `tabs[0]`, and every app lists `home` first -- so every
         console's primary was `/`, and switching consoles navigated to the page
         you were already on. React Router did nothing, the body did not change,
         and the switch looked broken. It was only ever visible when you
         happened to be somewhere other than Home.

         A console opens on the work it is for: Service on Cases, Sales on
         Leads, Partner on Partners. Home is a tab every console shares, which
         makes it the one tab that cannot identify any of them. */
      const landing = tabs.find((t) => t.id !== 'home') ?? tabs[0];
      return { ...app, tabs, primary: landing?.to ?? '/' };
    })
    // An app whose every tab was filtered away is not an app — showing it would
    // hand the user a door that opens onto nothing.
    .filter((app) => app.tabs.length > 0);
}

/* -------------------------------------------------------------- routes */

router.get('/', (req, res) => {
  const orgs = orgsFor(req.user);
  const narrowed = activeOrg(req);
  const scope = narrowed ? [narrowed] : orgs;

  const apps = appsFor(req.user, scope);

  res.json({
    apps,
    // Every tab the user can reach, for the launcher's "All Items" list and
    // for global search to know what it may return.
    all_tabs: [...new Map(apps.flatMap((a) => a.tabs).map((t) => [t.id, t])).values()],
    default_app: apps[0]?.id ?? null,
    // Features are not destinations, so they travel beside the tabs rather than
    // inside them (ENH-04). The client asks "may I show the ticker?" instead of
    // hunting for a tab that was never going to be there.
    features: Object.fromEntries(
      FEATURE_KEYS.map((key) => [key, resolveTab(req.user, key).visible]),
    ),
  });
});

export default router;
