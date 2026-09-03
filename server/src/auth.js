/**
 * Authentication + the role permission matrix.
 *
 * Two separate session kinds share one table:
 *   kind='crm'     → an internal user (one of the 11 roles)
 *   kind='partner' → a partner on the Partner Portal (BRD OD-10: partners are
 *                    NOT CRM users; the portal is a distinct surface)
 *
 * Permissions are enforced here at the API layer, which is what BRD §3.2 requires
 * ("enforced at the API level") — the UI only hides what the API already refuses.
 */

import { one, run, audit, SALES_ORGS } from './db.js';
import { authenticate as authenticateKey, scopedCapabilities } from './engine/apikeys.js';
import { queueScopeSql } from './engine/queues.js';
import { maskedFieldsFor } from './engine/masking.js';
import { managerScopeSql, explainVisibility } from './engine/sharing.js';
import {
  seedAccessModel, roleCapabilities, effectiveCapabilities, dataScope,
} from './engine/access.js';
import {
  hashPassword, verifyPassword, newSessionToken,
  SESSION_TTL_HOURS, SESSION_IDLE_MINUTES,
} from './security.js';

/* ------------------------------------------------------- permission matrix */

/**
 * Every capability the CRM gates on, mapped to the roles that hold it.
 * Sourced line-by-line from BRD §3.2 "Key Permission Rules".
 */
export const PERMISSIONS = {
  // Lead lifecycle
  /**
   * Org-wide sight. Under the Private floor this is a grant like any other, so
   * it is held only by roles whose declared `data_scope` is `org` — anything
   * else was a contradiction between what the role says it is and what it could
   * actually see.
   *
   * Sales Supervisor was removed: it is declared `team`, and its supervisory
   * reach now comes from the management chain (engine/sharing.js), which
   * follows reports to any depth rather than granting the whole org. Granting
   * this capability back restores the old behaviour if the business wants it.
   */
  'lead.view.all':        ['superadmin', 'admin', 'product_supervisor', 'marketing_manager', 'customer_care'],
  'lead.view.own':        ['caller', 'dealer', 'sales_rm', 'partner_rm'],
  'lead.view.product':    ['product_rm'],            // read-only, filtered to their product
  'lead.create':          ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor', 'partner_rm'],
  'lead.edit':            ['superadmin', 'admin', 'sales_rm', 'sales_supervisor', 'dealer'],
  'lead.stage.change':    ['superadmin', 'admin', 'sales_supervisor'],
  'lead.reassign':        ['superadmin', 'admin', 'sales_supervisor'],
  'lead.delete':          ['superadmin', 'admin'],
  'lead.contact':         ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor', 'customer_care'],

  /* Clients — per the confirmed Q-26 matrix.
   *
   * Caller is absent by design: a caller works a dial list of prospects, and a
   * live account appearing in it is a mis-dial waiting to happen. Marketing is
   * absent because it segments and sends rather than opening account records.
   * Partner RM reads a partner's clients inside the partner record, not here. */
  'client.view.all':      ['superadmin', 'admin', 'customer_care', 'product_supervisor'],
  'client.view.own':      ['sales_rm', 'sales_supervisor', 'dealer', 'product_rm'],
  'client.edit':          ['superadmin', 'admin', 'sales_rm', 'dealer', 'customer_care'],
  'client.reassign':      ['superadmin', 'admin', 'sales_supervisor'],
  'client.export':        ['superadmin', 'admin'],

  // Product cards
  'card.mark.exploring':  ['caller', 'dealer', 'sales_rm', 'superadmin', 'admin'],
  'card.mark.warm':       ['dealer', 'sales_rm', 'superadmin', 'admin'],
  'card.request.productrm': ['sales_rm', 'sales_supervisor', 'superadmin', 'admin'],
  'card.engage':          ['product_rm', 'product_supervisor', 'superadmin', 'admin'],
  'card.close':           ['product_rm', 'product_supervisor', 'superadmin', 'admin'],
  'card.reassign':        ['product_supervisor', 'superadmin', 'admin'],

  // KYC
  'kyc.manage':           ['product_rm', 'product_supervisor', 'superadmin', 'admin'],
  'kyc.override':         ['product_supervisor', 'superadmin', 'admin'],
  'kyc.view':             ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor', 'partner_rm', 'product_rm', 'product_supervisor', 'customer_care'],

  /* Cases.
   *
   * `view.all` is held only by roles declared org scope, so the capability and
   * the declared scope cannot disagree — the mistake called out in leadScope,
   * where Sales Supervisor held lead.view.all while being declared `team` and
   * made data_scope decorative. A supervisor reaches their team's cases through
   * the management chain instead, which is what `team` already means. */
  'ticket.view.all':      ['superadmin', 'admin', 'customer_care', 'product_supervisor'],
  'ticket.view.own':      ['caller', 'dealer', 'sales_rm', 'sales_supervisor', 'partner_rm', 'product_rm', 'marketing_manager'],
  'ticket.create':        ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor', 'partner_rm', 'product_rm', 'product_supervisor', 'customer_care', 'marketing_manager'],
  'ticket.reply':         ['superadmin', 'admin', 'customer_care', 'sales_rm', 'sales_supervisor', 'product_rm', 'partner_rm'],
  'ticket.reassign':      ['superadmin', 'admin', 'customer_care', 'sales_supervisor'],
  'ticket.escalate':      ['superadmin', 'admin', 'customer_care', 'sales_supervisor'],
  'ticket.merge':         ['superadmin', 'admin', 'customer_care'],

  // Partners
  'partner.view':         ['superadmin', 'admin', 'partner_rm', 'sales_supervisor'],
  'partner.create':       ['superadmin', 'admin', 'partner_rm'],
  'partner.elevate':      ['superadmin', 'admin'],           // Partner RM initiates, Admin approves
  'partner.elevate.request': ['partner_rm'],
  'partner.suspend':      ['superadmin', 'admin'],

  // Configuration
  'admin.users':          ['superadmin', 'admin'],
  'admin.roles':          ['superadmin', 'admin'],
  'admin.products':       ['superadmin', 'admin'],
  'admin.rules':          ['superadmin', 'admin'],
  'admin.sla':            ['superadmin', 'admin'],
  'admin.kyc.journeys':   ['superadmin', 'admin'],
  'admin.templates':      ['superadmin', 'admin', 'marketing_manager'],
  'admin.content':        ['superadmin', 'admin', 'marketing_manager', 'product_supervisor'],
  // Schema configuration is a distinct power from managing users or rules:
  // a field added here changes what every screen and every integration sees.
  // Export takes client data out of the system, so it is deliberately narrow.
  'data.export':          ['superadmin', 'admin', 'sales_supervisor'],
  'admin.objects':        ['superadmin', 'admin'],
  'admin.system':         ['superadmin'],

  // Marketing
  'campaign.manage':      ['superadmin', 'admin', 'marketing_manager'],
  'list.create':          ['superadmin', 'admin', 'caller', 'dealer', 'sales_rm', 'sales_supervisor', 'partner_rm', 'product_rm', 'product_supervisor', 'customer_care', 'marketing_manager'],

  // PII — unmasking a client identifier is a distinct, audited capability
  'pii.unmask':           ['superadmin', 'admin', 'sales_rm', 'sales_supervisor', 'product_rm', 'product_supervisor', 'customer_care'],

  // Audit — the compliance trail, including the AI egress log. Read-only by
  // design: nobody may edit it, which is the whole point of keeping it.
  'audit.read':           ['superadmin', 'admin'],

  // Reporting
  /* Seeing your own numbers is not a supervisory act.
   *
   * The confirmed ENH-08 matrix gives Sales RM, Partner RM and Customer Care
   * the Reports and Dashboards tabs, and none of them held a reporting
   * capability -- so the tab would have been hidden by the capability gate no
   * matter what the matrix said, and the Setup screen would have been telling
   * an administrator something the app did not do.
   *
   * Safe to grant because reports.js already wraps every query in the caller's
   * own leadScope: this opens the door, it does not widen the room. Whether a
   * role actually sees the tab is then the matrix's decision, not this one. */
  'report.self':          ['sales_rm', 'partner_rm', 'product_rm', 'dealer',
    'customer_care', 'marketing_manager', 'sales_supervisor', 'product_supervisor',
    'superadmin', 'admin'],
  /* Caller is deliberately absent. The confirmed matrix gives them none of
   * Revenue, Reports or Dashboards -- their screen should be almost entirely
   * the work list -- so granting the capability would only create a door the
   * matrix then has to keep shut. */
  'report.team':          ['superadmin', 'admin', 'sales_supervisor', 'product_supervisor'],
  'report.system':        ['superadmin', 'admin'],
};

/**
 * PERMISSIONS above is now SEED DATA, not the runtime source of truth.
 *
 * It is loaded into the `roles` / `role_capabilities` tables at boot so that an
 * administrator can create the twelfth role without a developer — which is the
 * specific failure the audit blames for the legacy tenant's four overlapping
 * access mechanisms (Part 4.1). Behaviour on day one is identical; the
 * difference is that it is now editable.
 *
 * Keep this constant in step with the catalogue in engine/access.js when adding
 * a capability: the seed is what gives a fresh database its defaults.
 */
seedAccessModel(PERMISSIONS);

/** Does this role hold this capability? Signature unchanged; source is now data. */
export const can = (role, permission) => roleCapabilities(role).has(permission);

/**
 * Everything a specific person can do — their role plus any permission sets
 * granted to them individually. Sent to the client so the UI hides what the API
 * would refuse.
 *
 * Accepts a user object; a bare role string still works for the many call sites
 * that only know the role, and simply returns the role's own capabilities.
 */
export const permissionsFor = (userOrRole) => {
  if (typeof userOrRole === 'string') return [...roleCapabilities(userOrRole)].sort();
  return [...effectiveCapabilities(userOrRole)].sort();
};

/* ------------------------------------------------------------- sessions */

export async function login(email, password) {
  /* Both come straight from the request body and either may be absent.
     node:sqlite refuses to bind undefined, and while this function was
     synchronous that threw into Express and became a 500. Once it became async
     the same throw was an unhandled rejection in an async route handler, which
     Express 4 does not catch and Node answers by ending the process -- so an
     empty POST to /api/auth/login stopped the server. Anyone who could reach
     the sign-in page could do it. */
  if (typeof email !== 'string' || typeof password !== 'string') return null;

  const user = one('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', [email]);
  if (!user) return null;

  const { ok, needsRehash } = await verifyPassword(password, user.password);
  if (!ok) {
    audit(null, 'login_failed', 'user', user.id, { email });
    return null;
  }

  /* Upgrade a hash made under weaker parameters, now that the plaintext has
     been verified and is briefly in hand. Sign-in is the only place this can
     happen, so rows strengthen as their owners appear rather than all at once.
     A failure here must not cost anyone their session: the old hash still
     verifies, so log it and carry on. */
  if (needsRehash) {
    try {
      run('UPDATE users SET password = ? WHERE id = ?', [await hashPassword(password), user.id]);
      audit(user.id, 'password_rehashed', 'user', user.id, {});
    } catch (err) {
      console.warn('[auth] could not upgrade a stored password:', err.message);
    }
  }

  const token = newSessionToken();
  run(
    "INSERT INTO sessions (token, user_id, kind, expires_at, last_seen_at) VALUES (?,?,?,datetime('now', ?),datetime('now'))",
    [token, user.id, 'crm', `+${SESSION_TTL_HOURS} hours`],
  );
  audit(user.id, 'login', 'user', user.id, { role: user.role });
  return { token, user: publicUser(user), expires_in_hours: SESSION_TTL_HOURS };
}

export async function partnerLogin(email, password) {
  // Same untrusted body, same consequence. See login above.
  if (typeof email !== 'string' || typeof password !== 'string') return null;

  const partner = one('SELECT * FROM partners WHERE lower(email) = lower(?)', [email]);
  if (!partner || !partner.portal_password) return null;

  const { ok, needsRehash } = await verifyPassword(password, partner.portal_password);
  if (!ok) {
    audit(null, 'partner_login_failed', 'partner', partner.id, { email });
    return null;
  }

  if (needsRehash) {
    try {
      run('UPDATE partners SET portal_password = ? WHERE id = ?', [await hashPassword(password), partner.id]);
    } catch (err) {
      console.warn('[auth] could not upgrade a stored portal password:', err.message);
    }
  }
  if (!['ACTIVE', 'ONBOARDING'].includes(partner.state_code)) return { blocked: partner.state_code };

  const token = newSessionToken();
  run(
    "INSERT INTO sessions (token, partner_id, kind, expires_at, last_seen_at) VALUES (?,?,?,datetime('now', ?),datetime('now'))",
    [token, partner.id, 'partner', `+${SESSION_TTL_HOURS} hours`],
  );
  audit(null, 'partner_login', 'partner', partner.id, { email });
  return { token, partner: publicPartner(partner) };
}

export const logout = (token) => run('DELETE FROM sessions WHERE token = ?', [token]);

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  product_type_id: u.product_type_id, permissions: permissionsFor(u),
  employee_code: u.employee_code ?? null,
  // The org switcher renders from these. `orgs` is the entitlement; the client
  // may narrow within it but the server re-checks on every request regardless.
  sales_org: u.sales_org || 'BONANZA',
  orgs: orgsFor(u),
});

export const publicPartner = (p) => ({
  id: p.id, name: p.name, code: p.partner_code, model: p.partner_model,
  state: p.state_code, business_name: p.business_name, city: p.city,
});

const tokenFrom = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;

/**
 * Attaches req.user (CRM) or req.partner (portal) when a valid token is
 * present, or when a valid API credential is.
 *
 * An API key authenticates AS a user, producing the same req.user a sign-in
 * would — so every downstream scope check, mask and capability gate applies
 * unchanged. The only difference is req.api_credential, which the access log
 * records so "which integration did this" is answerable.
 */
export function attachSession(req, _res, next) {
  const token = tokenFrom(req);

  /* Tried only when there is no session token, so a signed-in browser session
     always wins. A request carrying both is a confused client, and resolving
     it towards the human is the safer reading. */
  if (!token) {
    const keyId = req.get('x-api-key');
    const secret = req.get('x-api-secret');
    if (keyId && secret) {
      const auth = authenticateKey(keyId, secret);
      if (auth) {
        req.user = auth.user;
        req.api_credential = auth.credential;
        // Scopes narrow; they never widen. See engine/apikeys.js.
        req.caps = scopedCapabilities(effectiveCapabilities(auth.user), auth.scopes);
      }
    }
    return next();
  }

  const session = one('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!session) return next();

  // Absolute expiry and idle timeout are both enforced here, on every request.
  const expired = session.expires_at && new Date(`${session.expires_at.replace(' ', 'T')}Z`) < new Date();
  const idleCutoff = session.last_seen_at
    && (Date.now() - new Date(`${session.last_seen_at.replace(' ', 'T')}Z`).getTime()) > SESSION_IDLE_MINUTES * 60_000;

  if (expired || idleCutoff) {
    run('DELETE FROM sessions WHERE token = ?', [token]);
    return next();
  }
  run("UPDATE sessions SET last_seen_at = datetime('now') WHERE token = ?", [token]);

  if (session.kind === 'crm') {
    const user = one('SELECT * FROM users WHERE id = ? AND active = 1', [session.user_id]);
    if (user) {
      req.user = user;
      /* A ghost session carries the administrator behind it. req.user stays the
         impersonated person — every scope, mask and permission check must see
         exactly what they would see, which is the entire point — and this is
         what the audit trail and the banner are built from. */
      if (session.ghost_of) {
        req.ghost_of = one('SELECT id, name, role FROM users WHERE id = ?', [session.ghost_of]) ?? null;
      }
      // Resolved once per request: role capabilities plus any permission sets
      // granted to this person. Field-level security and route guards both
      // read it, and recomputing per call site would be three lookups a row.
      req.caps = effectiveCapabilities(user);
    }
  } else {
    const partner = one('SELECT * FROM partners WHERE id = ?', [session.partner_id]);
    if (partner) req.partner = partner;
  }
  req.token = token;
  next();
}

export const requireUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Sign in required' });

export const requirePartner = (req, res, next) =>
  req.partner ? next() : res.status(401).json({ error: 'Partner sign-in required' });

/** Route guard: `requirePermission('lead.stage.change')`. */
/**
 * Any one of several permissions is enough.
 *
 * Some screens are reachable by two different jobs. The duplicate check is the
 * example: the person about to create a lead needs it, and so does the person
 * answering the phone to somebody who may already be a client. Requiring a
 * single permission forced a choice between them and locked one out.
 */
export const requireAnyPermission = (...permissions) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (!permissions.some((p) => can(req.user.role, p))) {
    return res.status(403).json({
      error: `Your role (${req.user.role}) cannot do this`,
      required: permissions.join(' or '),
    });
  }
  next();
};

export const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (!can(req.user.role, permission)) {
    return res.status(403).json({
      error: `Your role (${req.user.role}) cannot do this`,
      required: permission,
    });
  }
  next();
};

/**
 * The lead-visibility rule, in one place.
 *
 * Returns a SQL fragment + params scoping a lead query to what this role may see:
 * everything, only their own, or (Product RM) only leads carrying their product.
 */
export function leadScope(user, alias = 'l', active = null) {
  const org = orgScope(user, alias, active);

  /**
   * Visibility comes from the role's declared `data_scope`, so a new role gets
   * its reach declared rather than coded. `lead.view.all` still wins where a
   * role holds it, which keeps every existing role behaving exactly as before.
   *
   * Note what this separates: CAN SEE is data_scope; MANAGES is manager_id.
   * The audit found the legacy tenant conflating the two — `Bigul Dealer Team`
   * had 12 managers and 1 sales user because the manager slot was the only way
   * to grant visibility (Part 4.4).
   */
  const role = (() => {
    /**
     * `lead.view.all` means org-wide reach, and nothing more.
     *
     * It still resolves to `1=1` — a role granted sight of everything does see
     * everything, and pretending otherwise would be theatre. What changed is
     * who holds it: only roles declared `org` scope do, so the capability and
     * the declared scope can no longer disagree. Sales Supervisor used to hold
     * it while being declared `team`, which made `data_scope` decorative.
     */
    if (can(user.role, 'lead.view.all')) return { sql: '1=1', params: [] };

    switch (dataScope(user.role)) {
      case 'org':
        return { sql: '1=1', params: [] };

      case 'team':
        // The management chain grant below covers reports at any depth, so
        // `team` only has to carry the floor here.
        return { sql: `${alias}.owner_id = ?`, params: [user.id] };

      case 'product':
        return {
          sql: `EXISTS (SELECT 1 FROM product_cards pc
                        WHERE pc.lead_id = ${alias}.id AND pc.product_type_id = ?)`,
          params: [user.product_type_id ?? -1],
        };

      case 'own':
      default:
        return { sql: `${alias}.owner_id = ?`, params: [user.id] };
    }
  })();

  /**
   * Work waiting in a queue this person can take from is visible to them.
   *
   * ORed with role scope, because a queue is a grant on top of what someone
   * already sees — not a replacement for it. Without this a lead placed in a
   * queue would vanish from everybody's list until someone claimed it, which is
   * the opposite of what a queue is for.
   */
  /**
   * Grant-only layers, ORed on top of the floor. Each is optional; none of them
   * can take visibility away, which is what makes this a floor rather than a
   * set of competing rules.
   */
  const grants = [role];

  const manager = managerScopeSql(user, alias);
  if (manager) grants.push(manager);

  const queue = queueScopeSql(user, alias);
  if (queue) grants.push(queue);

  const reach = {
    sql: `(${grants.map((g) => `(${g.sql})`).join(' OR ')})`,
    params: grants.flatMap((g) => g.params),
  };

  // Reach and org scope are ANDed, never substituted for one another. An admin
  // still sees only the orgs they are entitled to; an RM entitled to both orgs
  // still sees only their own leads within them.
  return {
    sql: `(${reach.sql}) AND (${org.sql})`,
    params: [...reach.params, ...org.params],
  };
}

/**
 * The client-visibility rule.
 *
 * Deliberately a sibling of leadScope rather than a reuse of it. The two answer
 * different questions and are allowed to diverge: Customer Care sees every
 * client because servicing requires it, but no leads at all, because a service
 * agent works accounts and not prospects. Folding clients into leadScope would
 * force those two answers to be the same one.
 *
 * What it does keep identical is the shape — one restrictive floor, then
 * grant-only layers, then org entitlement ANDed on top. A rule that reads the
 * same as the lead rule is a rule an administrator can reason about.
 */
export function clientScope(user, alias = 'c', active = null) {
  const org = orgScope(user, alias, active);

  const role = (() => {
    if (can(user.role, 'client.view.all')) return { sql: '1=1', params: [] };

    switch (dataScope(user.role)) {
      case 'org':
        // An org-scoped role without client.view.all has not been granted sight
        // of accounts. Marketing sits here, and fails closed rather than open.
        return can(user.role, 'client.view.own')
          ? { sql: `${alias}.owner_id = ?`, params: [user.id] }
          : { sql: '1=0', params: [] };

      case 'product':
        // A Product RM sees an account that holds their product, which is the
        // client-side equivalent of the product card test on leads.
        return {
          sql: `EXISTS (SELECT 1 FROM product_cards pc
                        JOIN leads pl ON pl.id = pc.lead_id
                        WHERE pl.id = ${alias}.converted_from_lead_id
                          AND pc.product_type_id = ?)`,
          params: [user.product_type_id ?? -1],
        };

      case 'team':
      case 'own':
      default:
        return can(user.role, 'client.view.own')
          ? { sql: `${alias}.owner_id = ?`, params: [user.id] }
          : { sql: '1=0', params: [] };
    }
  })();

  const grants = [role];
  const manager = managerScopeSql(user, alias);
  if (manager) grants.push(manager);

  const reach = {
    sql: `(${grants.map((g) => `(${g.sql})`).join(' OR ')})`,
    params: grants.flatMap((g) => g.params),
  };

  return {
    sql: `(${reach.sql}) AND (${org.sql})`,
    params: [...reach.params, ...org.params],
  };
}

/**
 * What cases this person may read.
 *
 * Until now there was no answer to this question: `/api/tickets` and
 * `/api/tickets/:id` carried no capability gate at all, so any signed-in user
 * could read every case in their own book — including the client's own
 * description of their own money, and every reply. Recorded as §6a of the
 * security register.
 *
 * Shaped like `clientScope` rather than `leadScope`, because it should fail
 * closed the same way: an org-scoped role that has not been granted sight of
 * cases gets none, rather than falling through to everything.
 *
 * "Own" means assigned OR raised. Gating on the assignee alone would take a
 * case away from the person who opened it the moment support picked it up,
 * which is how a security fix turns into people losing their own work.
 */
export function ticketScope(user, alias = 't', active = null) {
  const org = orgScope(user, alias, active);
  const mine = {
    sql: `(${alias}.assignee_id = ? OR ${alias}.created_by = ?)`,
    params: [user.id, user.id],
  };

  const role = (() => {
    if (can(user.role, 'ticket.view.all')) return { sql: '1=1', params: [] };

    switch (dataScope(user.role)) {
      case 'org':
        // Marketing sits here: org scope, but no grant of sight over cases.
        return can(user.role, 'ticket.view.own') ? mine : { sql: '1=0', params: [] };

      case 'product':
        // The case hangs off a product card, which is the same test the lead
        // and client rules make against the card's product type.
        return {
          sql: `EXISTS (SELECT 1 FROM product_cards pc
                        WHERE pc.id = ${alias}.card_id AND pc.product_type_id = ?)`,
          params: [user.product_type_id ?? -1],
        };

      case 'team':
      case 'own':
      default:
        return can(user.role, 'ticket.view.own') ? mine : { sql: '1=0', params: [] };
    }
  })();

  const grants = [role];

  // A supervisor reaches their reports' cases, at any depth of the chain.
  const manager = managerScopeSql(user, alias, 'assignee_id');
  if (manager) grants.push(manager);

  /* A case raised against a lead you can already see is a case about your own
     client, and you will be asked about it whoever is handling it. This grants
     nothing new — if the lead is invisible to you, so is the case. */
  if (can(user.role, 'ticket.view.own')) {
    const lead = leadScope(user, 'sl');
    grants.push({
      sql: `EXISTS (SELECT 1 FROM leads sl WHERE sl.id = ${alias}.lead_id AND ${lead.sql})`,
      params: lead.params,
    });
  }

  const reach = {
    sql: `(${grants.map((g) => `(${g.sql})`).join(' OR ')})`,
    params: grants.flatMap((g) => g.params),
  };

  return {
    sql: `(${reach.sql}) AND (${org.sql})`,
    params: [...reach.params, ...org.params],
  };
}

/* --------------------------------------------------------- sales orgs */

/**
 * Which sales orgs may this user work in?
 *
 * `org_access` is a JSON array for people who straddle both businesses — a
 * relationship manager whose KRA scorecard mixes Bonanza and Bigul metrics.
 * When it is absent the user is confined to their own org, which is the safe
 * default: entitlement to a second book has to be granted, never inherited.
 */
export function orgsFor(user) {
  if (!user) return [];
  let access = null;
  try { access = user.org_access ? JSON.parse(user.org_access) : null; } catch { access = null; }

  /**
   * No sales_org means no book, and no book means nothing -- not Bonanza.
   *
   * This used to default to BONANZA, which reads as harmless until something
   * passes a partial user: every caller assembling `{ id, capabilities }` was
   * silently granted the Bonanza book, and the approvals queue did exactly
   * that. A missing org is a programming error, and the safe answer to one is
   * to see nothing rather than to see the larger of the two books.
   */
  if (!Array.isArray(access) || !access.length) {
    if (!user.sales_org) return [];
  }
  const list = Array.isArray(access) && access.length ? access : [user.sales_org];
  // Superadmin is a platform role, not a business role, so it spans both.
  if (user.role === 'superadmin') return [...new Set([...list, ...SALES_ORGS])];
  return [...new Set(list.filter((o) => SALES_ORGS.includes(o)))];
}

/**
 * SQL scoping a query to the orgs this user may see, further narrowed by the
 * org they are currently looking at (the header switcher). The switcher is a
 * view filter and can only narrow — it can never widen entitlement.
 */
export function orgScope(user, alias = 'l', activeOrg = null) {
  const allowed = orgsFor(user);
  const scoped = activeOrg && allowed.includes(activeOrg) ? [activeOrg] : allowed;

  if (!scoped.length) return { sql: '1=0', params: [] };   // fail closed
  return {
    sql: `${alias}.sales_org IN (${scoped.map(() => '?').join(',')})`,
    params: scoped,
  };
}

/**
 * The org a request is currently scoped to, from ?org=. Absent or "ALL" means
 * every org the user is entitled to.
 */
export function activeOrg(req) {
  const requested = req.query?.org || req.get('x-sales-org') || null;
  if (!requested || requested === 'ALL') return null;
  return orgsFor(req.user).includes(requested) ? requested : null;
}

/** May this user create or move records in this org? */
export const mayUseOrg = (user, org) => orgsFor(user).includes(org);

/**
 * The scope for a request: role visibility AND org entitlement AND whatever the
 * header switcher is currently narrowed to.
 *
 * Prefer this over calling leadScope directly. Passing the user alone silently
 * drops the switcher, which is how "?org= does nothing" bugs happen.
 */
export const reqScope = (req, alias = 'l') => leadScope(req.user, alias, activeOrg(req));

/** The same, for clients. Bigul users never see Bonanza accounts, and back. */
export const reqClientScope = (req, alias = 'c') => clientScope(req.user, alias, activeOrg(req));

/**
 * The same, for cases.
 *
 * The routes were calling `ticketScope(req.user, 't')` directly and dropping
 * the third argument, which is precisely the "?org= does nothing" bug the
 * comment above warns about: switching business narrowed leads and clients and
 * left cases alone.
 */
export const reqTicketScope = (req, alias = 't') => ticketScope(req.user, alias, activeOrg(req));

/** Product RMs never get write access to a lead record (BRD §3.2). */
export const isReadOnlyOnLeads = (role) => ['product_rm', 'marketing_manager'].includes(role);

/** May this request see unmasked client identifiers? */
export const mayUnmask = (req) => Boolean(req.user && can(req.user.role, 'pii.unmask'));

/**
 * Masking options for a request (ENH-16).
 *
 * One call rather than two, so a route cannot remember the unmask check and
 * forget the per-role field set -- which would silently mask everything for a
 * role the business had configured to see it, and look like a caching bug.
 */
export function maskFor(req, entity, entityId) {
  return {
    unmask: unmaskRequested(req, entity, entityId),
    fields: maskedFieldsFor(req.user?.role),
  };
}

/**
 * An explicit unmask is a deliberate act and is recorded as one.
 * Callers pass ?unmask=true; without it, PII is masked even for permitted roles.
 */
export function unmaskRequested(req, entity, entityId) {
  if (req.query?.unmask !== 'true') return false;
  if (!mayUnmask(req)) return false;
  audit(req.user.id, 'pii_unmasked', entity, entityId ?? null, { path: req.originalUrl });
  return true;
}
