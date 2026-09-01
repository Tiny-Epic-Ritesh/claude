/**
 * Request-scoped context, for facts that every write needs and no call site
 * should have to carry.
 *
 * There is exactly one of these today: who is really acting, when a ghost
 * session means `req.user` is somebody else. `audit()` is called from 132
 * places with a user id and nothing else, and threading a second argument
 * through all of them would guarantee that some of them are missed — which is
 * the same failure as not doing it at all, except harder to notice.
 *
 * AsyncLocalStorage is the right tool for this and is used sparingly on
 * purpose. It is invisible control flow, and invisible control flow is only
 * worth it when the alternative is worse. Adding a second thing to this store
 * should require the same argument being made again.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Run `fn` with a context attached to everything it awaits. */
export const withContext = (context, fn) => storage.run(context, fn);

export const current = () => storage.getStore() ?? null;

/**
 * "Kavita Nair acting as Sneha Kulkarni", or null when nobody is pretending.
 *
 * Written onto the `actor` column of every audited row so that the question an
 * auditor actually asks — who did this, really — has an answer on the row
 * itself rather than by joining it to a session that has since expired.
 */
export function actingActor() {
  const ctx = current();
  if (!ctx?.ghostOf) return null;
  return `${ctx.ghostOf.name} acting as ${ctx.actingAs?.name ?? 'another user'}`;
}

/** Express middleware. Must run after the session is attached. */
export const contextMiddleware = (req, _res, next) => withContext(
  { ghostOf: req.ghost_of ?? null, actingAs: req.user ?? null },
  next,
);
