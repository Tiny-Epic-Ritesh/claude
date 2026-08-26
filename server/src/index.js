import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { attachSession, login, partnerLogin, logout, publicUser, publicPartner } from './auth.js';
import { rateLimiter, usingDevKey } from './security.js';
import { ROLE_LABELS } from './db.js';

import crm from './routes/crm.js';
import tickets from './routes/tickets.js';
import partners from './routes/partners.js';
import { internal as kycInternal, dkyc } from './routes/kyc.js';
import portal from './routes/portal.js';
import admin from './routes/admin.js';
import cockpit from './routes/cockpit.js';
import aiRoutes from './routes/ai.js';
import webhooks from './routes/webhooks.js';
import reports from './routes/reports.js';
import orgs from './routes/orgs.js';
import apps from './routes/apps.js';
import search from './routes/search.js';
import activities from './routes/activities.js';
import setup from './routes/setup.js';
import market, { publicIndices } from './routes/market.js';
import advancedSearch from './routes/search-advanced.js';
import approvals from './routes/approvals.js';

import { sweepSla } from './engine/sla.js';
import { sweepKyc } from './engine/kyc.js';
import { runEnabledRules } from './engine/rules.js';
import { sweepReminders } from './engine/followups.js';
import { sweepMetrics } from './engine/metrics.js';
import { seedMetadata, seedPicklists } from './engine/metadata.js';
import { seedCalendars } from './engine/calendar.js';
import { seedQueues } from './engine/queues.js';

/* Register the core entities and fields as metadata. Idempotent, and it
   preserves any label an administrator has renamed. */
seedMetadata();
seedPicklists();
seedCalendars();
seedQueues();

const app = express();
const PORT = process.env.PORT || 4100;

app.use(cors());
/**
 * Keep the raw body alongside the parsed one.
 *
 * Meta signs the exact bytes it sent. Re-serialising the parsed JSON changes
 * whitespace and key order, so the HMAC would never match and every legitimate
 * Lead Ads delivery would be refused.
 */
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

/* ----------------------------------------------------------------- auth */

/* Brute-force protection. Credential endpoints are limited per source address,
   the public KYC portal per address, because neither has a session to key on. */
const loginLimiter = rateLimiter({
  name: 'login', limit: 10, windowMs: 60_000,
  // Keyed by account, not address: brute force targets one account, and a shared
  // office NAT would otherwise lock out a whole branch.
  by: (req) => String(req.body?.email || req.ip || 'anon').toLowerCase(),
});
const dkycLimiter  = rateLimiter({ name: 'dkyc',  limit: 120, windowMs: 60_000 });

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const result = login(req.body.email, req.body.password);
  if (!result) return res.status(401).json({ error: 'Email or password is incorrect' });
  res.json(result);
});

app.post('/api/auth/partner-login', loginLimiter, (req, res) => {
  const result = partnerLogin(req.body.email, req.body.password);
  if (!result) return res.status(401).json({ error: 'Email or password is incorrect' });
  if (result.blocked) return res.status(403).json({ error: `Your partner account is ${result.blocked.toLowerCase()}. Contact your Partner RM.` });
  res.json(result);
});

app.use(attachSession);

app.post('/api/auth/logout', (req, res) => {
  if (req.token) logout(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (req.user) return res.json({ kind: 'crm', user: publicUser(req.user), role_label: ROLE_LABELS[req.user.role] });
  if (req.partner) return res.json({ kind: 'partner', partner: publicPartner(req.partner) });
  res.status(401).json({ error: 'Not signed in' });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'bonanza-crm' }));

/* --------------------------------------------------------------- routes */

/* Vendor callbacks. Mounted before the authenticated routers because the caller
   is a vendor, not a user — each verifies its own shared secret instead. */
app.use('/api/webhooks', webhooks);

app.use('/api/cockpit', cockpit);
app.use('/api/ai', aiRoutes);
app.use('/api/tickets', tickets);
app.use('/api/partners', partners);
app.use('/api/kyc', kycInternal);
app.use('/api/orgs', orgs);
app.use('/api/apps', apps);
app.use('/api/search', search);
app.use('/api/activities', activities);
app.use('/api/setup', setup);
app.use('/api/market', market);
app.use('/api/search-advanced', advancedSearch);
app.use('/api/approvals', approvals);
// The login-page strip: four delayed index levels, no session, rate limited
// like the other unauthenticated surfaces.
app.use('/public/market', dkycLimiter, publicIndices);
app.use('/api/reports', reports);
app.use('/api/admin', admin);
app.use('/api/portal', portal);
app.use('/dkyc-api', dkycLimiter, dkyc);   // public — no CRM session required
app.use('/api', crm);

/* --------------------------------------------------------- static / SPA */

/**
 * Serve the React build as static files and fall back to index.html for any
 * route the SPA handles client-side.
 *
 * The React app is built with base="/ai-crm/" so all its assets live under
 * /ai-crm/assets/…  Express static serves them directly from client/dist.
 *
 * Any request that does NOT start with a known API prefix and does NOT start
 * with /ai-crm is redirected to /ai-crm/ so that visiting bare "/" lands on
 * the CRM instead of a 404.
 *
 * This is only active when the built client/dist directory exists (i.e. in
 * production Docker). In local dev, Vite serves the frontend on its own port.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, '..', '..', 'client', 'dist');

if (existsSync(clientDist)) {
  // Serve hashed JS/CSS/image assets with a long cache
  app.use(express.static(clientDist, { maxAge: '1y', immutable: true }));

  // Redirect bare / → /ai-crm/  (exact root only — not a prefix catch-all).
  app.get('*', (req, res) => {
    if (req.path === '/') {
      return res.redirect(301, '/ai-crm/');
    }
    // SPA fallback — let React Router handle the path client-side.
    res.sendFile(join(clientDist, 'index.html'));
  });
} else {
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, _req, res, _next) => {
  // A residency block is not a server fault — it is the compliance policy doing
  // its job. 451 is the correct status: the request was refused for legal
  // reasons, and the client should show the reason rather than retry.
  if (err.residency_blocked) {
    console.warn('[residency] egress refused:', err.message);
    return res.status(451).json({
      error: err.message,
      residency_blocked: true,
      route: err.route ?? null,
    });
  }

  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

/* ----------------------------------------------------------- background */

/**
 * Engine ticks. In production these are cron jobs or a worker; here they run
 * in-process so the demo behaves like a live system.
 */
const MINUTE = 60_000;

/* Run each sweep once at startup. Without this a freshly started system serves
   stale SLA and KYC state until the first tick — a journey that should already
   read Abandoned still shows as Stalled for up to thirty seconds. */
for (const [label, sweep] of [['sla', sweepSla], ['kyc', sweepKyc], ['reminders', sweepReminders], ['metrics', sweepMetrics]]) {
  try { sweep(); } catch (e) { console.error(`[${label}]`, e.message); }
}

setInterval(() => { try { sweepSla(); } catch (e) { console.error('[sla]', e.message); } }, MINUTE);
setInterval(() => { try { sweepKyc(); } catch (e) { console.error('[kyc]', e.message); } }, 30_000);

/* Reminders run on their own cadence: a follow-up nudge that arrives ten
   minutes late is useless, but polling every second would be waste. */
setInterval(() => { try { sweepReminders(); } catch (e) { console.error('[reminders]', e.message); } }, 60_000);
setInterval(() => { try { runEnabledRules(); } catch (e) { console.error('[rules]', e.message); } }, 5 * MINUTE);

/* Recency decays with the calendar, so a lead nobody touches still changes
   score overnight. Rebuilding on a schedule is what keeps a derived value
   honest without anyone remembering to refresh it. */
setInterval(() => { try { sweepMetrics(); } catch (e) { console.error('[metrics]', e.message); } }, 15 * MINUTE);

app.listen(PORT, () => {
  console.log(`[server] Bonanza CRM API on http://localhost:${PORT}`);
  if (usingDevKey()) {
    console.warn('[security] CRM_MASTER_KEY is unset — using the development key. Encrypted fields are NOT protected. Set it before any pilot.');
  }
});
