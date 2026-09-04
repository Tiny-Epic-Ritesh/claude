/**
 * The Setup screens, as the server knows them.
 *
 * The client registry holds how each screen looks — icon, description, the
 * words Quick Find matches on, the component. This holds the half the server
 * has to be sure of: that a key names a real screen, and which capability it
 * takes. Visibility is configuration, and configuration cannot be validated
 * against a list that only exists in the browser.
 *
 * The two lists are checked against each other by `setupshell.test.mjs`. A
 * screen added on one side and forgotten on the other fails the build rather
 * than becoming a settings row that configures nothing, or a screen nobody can
 * hide.
 */

/** Section key → what it is called, and what it takes to open. */
export const SETUP_SECTIONS = [
  { key: 'users', label: 'Users', needs: ['admin.users'] },
  { key: 'roles', label: 'Roles & permissions', needs: null },
  { key: 'navigation', label: 'Navigation', needs: ['admin.roles'] },
  { key: 'groups', label: 'Sales groups', needs: ['admin.users'] },
  { key: 'masking', label: 'Field masking', needs: ['admin.users'] },
  { key: 'targets', label: 'Targets & incentives', needs: ['admin.rules'] },
  { key: 'objects', label: 'Objects & fields', needs: ['admin.objects'] },
  { key: 'products', label: 'Products', needs: ['admin.products'] },
  { key: 'rules', label: 'Rule builder', needs: ['admin.rules'] },
  { key: 'outcomes', label: 'Call outcomes', needs: ['admin.rules'] },
  { key: 'sla', label: 'SLA & categories', needs: ['admin.sla'] },
  { key: 'calendars', label: 'Working calendars', needs: ['admin.sla'] },
  { key: 'journeys', label: 'KYC journeys', needs: ['admin.kyc.journeys'] },
  { key: 'templates', label: 'Templates', needs: ['admin.templates'] },
  { key: 'content', label: 'Content library', needs: ['admin.content'] },
  { key: 'campaigns', label: 'Campaigns', needs: ['campaign.manage'] },
  { key: 'integrations', label: 'Integrations', needs: null },
  { key: 'telephony', label: 'Telephony', needs: ['admin.system'] },
  { key: 'meta', label: 'Facebook & Instagram', needs: ['admin.system'] },
  { key: 'audit', label: 'Audit log', needs: ['report.system'] },
  { key: 'logs', label: 'API & logs', needs: ['report.system'] },
  { key: 'database', label: 'Database', needs: ['report.system'] },
  { key: 'promotion', label: 'Promote configuration', needs: ['admin.system'] },
  { key: 'residency', label: 'Data residency', needs: null },
];

/**
 * Setup screens ride the existing tab-visibility table, prefixed.
 *
 * `products` is both a CRM tab and a Setup screen, so an unprefixed key would
 * make hiding one hide the other. The prefix is what keeps two things that
 * share a name from sharing a setting.
 */
export const SETUP_TAB_PREFIX = 'setup:';

export const setupTabId = (key) => `${SETUP_TAB_PREFIX}${key}`;
export const isSetupTabId = (id) => String(id ?? '').startsWith(SETUP_TAB_PREFIX);
export const sectionKeyOf = (id) => String(id ?? '').slice(SETUP_TAB_PREFIX.length);

export const isSetupSection = (key) => SETUP_SECTIONS.some((s) => s.key === key);

/** The same shape TAB_LIST returns, so the Navigation screen renders it alike. */
export const setupTabList = () => SETUP_SECTIONS.map((s) => ({
  id: setupTabId(s.key),
  label: s.label,
  icon: 'settings',
  kind: 'setup',
}));
