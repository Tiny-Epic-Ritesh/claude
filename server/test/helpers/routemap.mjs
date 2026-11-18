/**
 * Where each route file is mounted, and every route that takes a path
 * parameter -- read from the source, so nothing is a list somebody remembered.
 *
 * Shared by bookscope.test.mjs (reads) and bookscopewrites.test.mjs (writes).
 * A2b (18 Nov 2026): attendance.js and automations.js were missing from the
 * map the reads test kept, and a file missing from it was skipped in silence --
 * so none of their routes was ever checked. Now a route file must be either
 * mounted here or named, with a reason, as not mounting routes at all.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROUTES = join(here, '..', '..', 'src', 'routes');

/** File → the variable each router is held in → where it is mounted. */
export const MOUNTS = {
  'activities.js': { router: '/api/activities' },
  'admin.js': { router: '/api/admin' },
  'ai.js': { router: '/api/ai' },
  'apps.js': { router: '/api/apps' },
  'approvals.js': { router: '/api/approvals' },
  'attendance.js': { router: '/api/attendance' },
  'automations.js': { router: '/api/admin/automations' },
  'calendar.js': { router: '/api/calendar' },
  'ccm.js': { router: '/api/ccm' },
  'clients.js': { router: '/api/clients' },
  'cockpit.js': { router: '/api/cockpit' },
  'crm.js': { router: '/api' },
  'dashboard.js': { router: '/api/dashboard' },
  'dashboards.js': { router: '/api/dashboards' },
  'library.js': { router: '/api/libraries' },
  'email.js': { router: '/api/email' },
  'kra.js': { router: '/api/kra' },
  'kyc.js': { internal: '/api/kyc', dkyc: '/dkyc-api' },
  'lists.js': { router: '/api/lists' },
  'market.js': { router: '/api/market', publicIndices: '/public/market' },
  'messages.js': { router: '/api/messages' },
  'orgs.js': { router: '/api/orgs' },
  'partners.js': { router: '/api/partners' },
  'pipeline.js': { router: '/api/pipeline' },
  'platform.js': { router: '/api/platform' },
  'portal.js': { router: '/api/portal' },
  'products.js': { router: '/api/products' },
  'reports.js': { router: '/api/reports' },
  'revenue.js': { router: '/api/revenue' },
  'search-advanced.js': { router: '/api/search-advanced' },
  'search.js': { router: '/api/search' },
  'setup.js': { router: '/api/setup' },
  'team.js': { router: '/api/team' },
  'tickets.js': { router: '/api/tickets' },
  'webhooks.js': { router: '/api/webhooks' },
};

/** Files in src/routes that mount no routes of their own. */
export const NOT_A_ROUTER = {
  'partners-support.js': 'Helpers shared by partners.js and approvals.js (onboarding steps, activation, closure); it defines no routes.',
};

/** Every route taking a path parameter, for the given methods, as { file, method, path }. */
export function routesWithParams(methods = ['get', 'post', 'put', 'patch', 'delete']) {
  const found = [];
  const wanted = methods.join('|');
  for (const file of readdirSync(ROUTES)) {
    const map = MOUNTS[file];
    if (!map) continue;
    const src = readFileSync(join(ROUTES, file), 'utf8').replace(/\r\n/g, '\n');
    for (const m of src.matchAll(new RegExp(`(\\w+)\\.(${wanted})\\(\\s*'([^']*)'`, 'g'))) {
      const [, variable, method, path] = m;
      if (!(variable in map) || !path.includes(':')) continue;
      found.push({ file, method: method.toUpperCase(), path: (map[variable] + path).replace(/\/$/, '') });
    }
  }
  return found;
}

/** Route files that are neither mounted here nor declared as mounting nothing. */
export const unmappedRouteFiles = () => readdirSync(ROUTES)
  .filter((f) => f.endsWith('.js') && !(f in MOUNTS) && !(f in NOT_A_ROUTER));
