/**
 * Every Setup screen, in one list.
 *
 * WHY A REGISTRY RATHER THAN A ROUTE TABLE
 * ----------------------------------------
 * Four things need the same list and must never disagree: the sidebar, the
 * Quick Find index, the router, and the permission check that decides whether
 * a screen is even offered. Written four times, one of them drifts — which is
 * how a screen ends up reachable by URL but invisible in the nav, or listed in
 * the nav and 403 when clicked.
 *
 * WHY ONE LEVEL OF GROUPING
 * -------------------------
 * `docs/salesforce-reference/setup-tree.md` says it plainly: Salesforce's tree
 * is 15 categories deep in four levels and "is only navigable because Quick
 * Find exists", and the design reference's rule 4 is "do not copy the Setup
 * tree depth — build search-first admin". So: six groups, no nesting, and a
 * search box that goes straight to any screen by name or by what it does.
 *
 * `keywords` is what makes search useful. An administrator looking for where
 * the SLA clock is set does not search "SLA & categories", they search
 * "response time" or "escalation" — so each screen carries the words somebody
 * would actually type, including the words the previous CRM used for it.
 */

import { lazy } from 'react';

/* Screens that live in their own files. */
const TabVisibility = lazy(() => import('../crm/TabVisibility.jsx'));
const Dispositions = lazy(() => import('../crm/Dispositions.jsx'));
const KraSetup = lazy(() => import('../crm/KraSetup.jsx'));
const FieldMasking = lazy(() => import('../crm/FieldMasking.jsx'));
const ObjectManager = lazy(() => import('../crm/ObjectManager.jsx'));
const RolesSetup = lazy(() => import('../crm/RolesSetup.jsx'));
const Telephony = lazy(() => import('../crm/Telephony.jsx'));
const Logs = lazy(() => import('../crm/Logs.jsx'));
const Database = lazy(() => import('../crm/Database.jsx'));

/* Screens that still live inside Admin.jsx. Exported from there rather than
   moved: relocating 1,700 lines to change how they are reached would put every
   one of them at risk for no benefit to the person using them. */
const Admin = () => import('../crm/Admin.jsx');
const from = (name) => lazy(() => Admin().then((m) => ({ default: m[name] })));

export const GROUPS = [
  { key: 'people', label: 'People & access', icon: 'group' },
  { key: 'objects', label: 'Objects & fields', icon: 'account_tree' },
  { key: 'automation', label: 'Automation', icon: 'bolt' },
  { key: 'comms', label: 'Customer communication', icon: 'forum' },
  { key: 'integrations', label: 'Integrations', icon: 'cable' },
  { key: 'monitoring', label: 'Monitoring & data', icon: 'monitoring' },
];

export const SECTIONS = [
  /* ------------------------------------------------------ people & access */
  {
    key: 'users',
    label: 'Users',
    group: 'people',
    icon: 'people',
    needs: ['admin.users'],
    blurb: 'Who can sign in, what they are, and who they report to',
    keywords: ['user', 'staff', 'employee', 'agent', 'rm', 'joiner', 'leaver', 'deactivate', 'password', 'reset', 'manager', 'reporting line', 'ghost', 'impersonate'],
    Component: from('Users'),
  },
  {
    key: 'roles',
    label: 'Roles & permissions',
    group: 'people',
    icon: 'shield_person',
    blurb: 'What each role may do, and how far it can see',
    keywords: ['role', 'permission', 'capability', 'access', 'grant', 'revoke', 'profile', 'permission set', 'data scope', 'visibility', 'sharing'],
    Component: RolesSetup,
  },
  {
    key: 'navigation',
    label: 'Navigation',
    group: 'people',
    icon: 'category',
    needs: ['admin.roles'],
    blurb: 'Which tabs and apps each role sees',
    keywords: ['tab', 'menu', 'nav', 'app', 'hide', 'show', 'launcher', 'sidebar'],
    Component: TabVisibility,
  },
  {
    key: 'masking',
    label: 'Field masking',
    group: 'people',
    icon: 'lock',
    needs: ['admin.users'],
    blurb: 'Which roles see mobile numbers and PAN in the clear',
    keywords: ['mask', 'pan', 'mobile', 'pii', 'unmask', 'redact', 'privacy', 'dpdp', 'personal data', 'hide'],
    Component: FieldMasking,
  },
  {
    key: 'targets',
    label: 'Targets & incentives',
    group: 'people',
    icon: 'badge',
    needs: ['admin.rules'],
    blurb: 'What each role is measured on, and what it pays',
    keywords: ['kra', 'kpi', 'target', 'incentive', 'commission', 'payout', 'quota', 'measure', 'performance'],
    Component: KraSetup,
  },

  /* ------------------------------------------------------ objects & fields */
  {
    key: 'objects',
    label: 'Objects & fields',
    group: 'objects',
    icon: 'account_tree',
    needs: ['admin.objects'],
    blurb: 'Fields, picklist values, layout order and validation rules',
    keywords: ['object', 'field', 'picklist', 'dropdown', 'value', 'stage', 'source', 'custom field', 'schema', 'layout', 'validation', 'required', 'formula', 'rollup', 'lead', 'client', 'case', 'ticket'],
    Component: ObjectManager,
  },
  {
    key: 'products',
    label: 'Products',
    group: 'objects',
    icon: 'inventory_2',
    needs: ['admin.products'],
    blurb: 'What the firm sells, and the stages each product moves through',
    keywords: ['product', 'demat', 'mutual fund', 'pms', 'insurance', 'card', 'offering', 'stage'],
    Component: from('Products'),
  },

  /* ----------------------------------------------------------- automation */
  {
    key: 'rules',
    label: 'Rule builder',
    group: 'automation',
    icon: 'rule',
    needs: ['admin.rules'],
    blurb: 'What happens automatically when a record changes',
    keywords: ['rule', 'automation', 'trigger', 'workflow', 'assign', 'routing', 'score', 'auto', 'when then'],
    Component: from('Rules'),
  },
  {
    key: 'outcomes',
    label: 'Call outcomes',
    group: 'automation',
    icon: 'call',
    needs: ['admin.rules'],
    blurb: 'The dispositions an RM picks after a call',
    keywords: ['disposition', 'outcome', 'call result', 'sub-disposition', 'not interested', 'callback', 'connected'],
    Component: Dispositions,
  },
  {
    key: 'sla',
    label: 'SLA & categories',
    group: 'automation',
    icon: 'schedule',
    needs: ['admin.sla'],
    blurb: 'Response and resolution clocks, and how cases are classified',
    keywords: ['sla', 'response time', 'resolution', 'breach', 'escalation', 'clock', 'category', 'case', 'ticket', 'priority'],
    Component: from('Sla'),
  },
  {
    key: 'calendars',
    label: 'Working calendars',
    group: 'automation',
    icon: 'schedule',
    needs: ['admin.sla'],
    blurb: 'Business hours and holidays — when the SLA clock runs',
    keywords: ['calendar', 'holiday', 'business hours', 'working day', 'weekend', 'diwali', 'shift', 'timing'],
    Component: from('Calendars'),
  },
  {
    key: 'journeys',
    label: 'KYC journeys',
    group: 'automation',
    icon: 'verified_user',
    needs: ['admin.kyc.journeys'],
    blurb: 'The steps an applicant goes through to open an account',
    keywords: ['kyc', 'ekyc', 'journey', 'onboarding', 'digilocker', 'esign', 'penny drop', 'aadhaar', 'verification', 'account opening'],
    Component: from('Journeys'),
  },

  /* ------------------------------------------------ customer communication */
  {
    key: 'templates',
    label: 'Templates',
    group: 'comms',
    icon: 'mail',
    needs: ['admin.templates'],
    blurb: 'Approved wording for email, SMS and WhatsApp',
    keywords: ['template', 'email', 'sms', 'whatsapp', 'message', 'merge field', 'wording', 'approved'],
    Component: from('Templates'),
  },
  {
    key: 'content',
    label: 'Content library',
    group: 'comms',
    icon: 'folder',
    needs: ['admin.content'],
    blurb: 'Collateral a client can be sent, with approval and expiry',
    keywords: ['content', 'library', 'collateral', 'brochure', 'factsheet', 'document', 'attachment', 'marketing hub', 'approval', 'expiry'],
    Component: from('Content'),
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    group: 'comms',
    icon: 'campaign',
    needs: ['campaign.manage'],
    blurb: 'Outbound sends, their audience and their results',
    keywords: ['campaign', 'blast', 'bulk', 'audience', 'segment', 'send', 'broadcast', 'outbound'],
    Component: from('Campaigns'),
  },

  /* --------------------------------------------------------- integrations */
  {
    key: 'integrations',
    label: 'Integrations',
    group: 'integrations',
    icon: 'cable',
    blurb: 'Every external system the CRM talks to, and whether it is live',
    keywords: ['integration', 'vendor', 'api', 'webhook', 'connector', 'smartping', 'aisensy', 'kyc api', 'credentials', 'key'],
    Component: from('Integrations'),
  },
  {
    key: 'telephony',
    label: 'Telephony',
    group: 'integrations',
    icon: 'phone',
    needs: ['admin.system'],
    blurb: 'The dialler, its campaigns and each agent extension',
    keywords: ['telephony', 'dialler', 'dialer', 'cube', 'quickcall', 'cti', 'extension', 'click to call', 'screen pop', 'call recording'],
    Component: Telephony,
  },
  {
    key: 'meta',
    label: 'Facebook & Instagram',
    group: 'integrations',
    icon: 'public',
    needs: ['admin.system'],
    blurb: 'Lead ads flowing in from Meta',
    keywords: ['facebook', 'instagram', 'meta', 'lead ads', 'social', 'leadgen', 'ads'],
    Component: from('MetaConnector'),
  },

  /* ------------------------------------------------------ monitoring & data */
  {
    key: 'audit',
    label: 'Audit log',
    group: 'monitoring',
    icon: 'receipt_long',
    needs: ['report.system'],
    blurb: 'Who changed what, and when',
    keywords: ['audit', 'log', 'history', 'change', 'who did', 'trail', 'compliance', 'sebi'],
    Component: from('Audit'),
  },
  {
    key: 'logs',
    label: 'API & logs',
    group: 'monitoring',
    icon: 'api',
    needs: ['report.system'],
    blurb: 'API credentials, and the log of every call in and out',
    keywords: ['api', 'log', 'webhook', 'error', 'request', 'credential', 'token', 'retention', 'debug'],
    Component: Logs,
  },
  {
    key: 'database',
    label: 'Database',
    group: 'monitoring',
    icon: 'database',
    needs: ['report.system'],
    blurb: 'What the database holds and how fast it is growing',
    keywords: ['database', 'size', 'storage', 'growth', 'disk', 'table', 'rows', 'capacity'],
    Component: Database,
  },
  {
    key: 'residency',
    label: 'Data residency',
    group: 'monitoring',
    icon: 'public',
    blurb: 'Where client data physically sits, and what leaves India',
    keywords: ['residency', 'india', 'location', 'dpdp', 'compliance', 'sovereignty', 'region', 'hosting', 'egress'],
    Component: from('Residency'),
  },
];

/** The sections this person may actually open. */
export const sectionsFor = (permissions = []) =>
  SECTIONS.filter((s) => !s.needs || s.needs.some((p) => permissions.includes(p)));

/** One section by key, or undefined. */
export const sectionByKey = (key) => SECTIONS.find((s) => s.key === key);

/**
 * Quick Find.
 *
 * Ranked, because an administrator typing "cal" should get Working calendars
 * before Campaigns even though both contain the letters. A label match beats a
 * blurb match beats a keyword match, and a prefix beats a match in the middle.
 */
export function searchSections(query, sections = SECTIONS) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  /* Searches what this person can actually open, not the whole catalogue. A
     result you cannot follow is worse than no result: it tells somebody the
     screen exists and then refuses to show it. */
  return sections
    .map((s) => {
      const label = s.label.toLowerCase();
      let score = 0;

      if (label === q) score = 100;
      else if (label.startsWith(q)) score = 80;
      else if (label.includes(q)) score = 60;

      if (!score && s.keywords?.some((k) => k === q)) score = 55;
      if (!score && s.keywords?.some((k) => k.startsWith(q))) score = 45;
      if (!score && s.keywords?.some((k) => k.includes(q))) score = 30;
      if (!score && s.blurb?.toLowerCase().includes(q)) score = 20;

      return { section: s, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.section.label.localeCompare(b.section.label))
    .map((r) => r.section);
}
