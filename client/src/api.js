/** Thin API client. Two token stores: CRM users and portal partners. */

const KEY = { crm: 'bnz_crm_token', partner: 'bnz_partner_token' };

export const token = {
  get: (kind = 'crm') => localStorage.getItem(KEY[kind]),
  set: (kind, value) => localStorage.setItem(KEY[kind], value),
  clear: (kind) => localStorage.removeItem(KEY[kind]),
};

/**
 * The sales org the user is currently looking at.
 *
 * Sent as a header on every request so a caller never has to remember to append
 * `?org=` — forgetting once would silently show the wrong business's numbers.
 * It is a view filter only: the server re-derives entitlement from the session,
 * so setting this to an org the user does not hold changes nothing.
 */
let activeOrg = null;
try { activeOrg = localStorage.getItem('bnz_active_org') || null; } catch { activeOrg = null; }

export const setActiveOrg = (code) => { activeOrg = code || null; };
export const getActiveOrg = () => activeOrg;

async function request(path, { method = 'GET', body, kind = 'crm', raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token.get(kind);
  if (t && !raw) headers.Authorization = `Bearer ${t}`;
  if (activeOrg && !raw) headers['X-Sales-Org'] = activeOrg;

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.required = data.required;
    err.payload = data;
    throw err;
  }
  return data;
}

export const api = {
  setOrg: setActiveOrg,
  getOrg: getActiveOrg,
  get: (p, kind) => request(`/api${p}`, { kind }),
  post: (p, body, kind) => request(`/api${p}`, { method: 'POST', body, kind }),
  patch: (p, body, kind) => request(`/api${p}`, { method: 'PATCH', body, kind }),
  del: (p, kind) => request(`/api${p}`, { method: 'DELETE', kind }),
};

/**
 * Unauthenticated endpoints.
 *
 * `raw` means no Authorization header and no org header are attached — these
 * must work with no session at all, and must never be handed a token by
 * accident.
 */
export const publicApi = {
  get: (p) => request(`/public${p}`, { raw: true }),
};

/** Public DKYC endpoints — no session, proxied to /dkyc on the API. */
export const dkycApi = {
  get: (p) => request(`/dkyc-api${p}`, { raw: true }),
  post: (p, body) => request(`/dkyc-api${p}`, { method: 'POST', body, raw: true }),
};

/* ------------------------------------------------------------ formatting */

export const money = (n) => {
  const v = Number(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN')}`;
};

export const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/**
 * Compact INR for dashboards, in the units an Indian desk actually speaks:
 * lakh and crore, not millions. ₹1.2 Cr reads instantly; ₹1,20,00,000 does not.
 * Use `rupees` wherever the exact figure matters — commission, valuations.
 */
export const rupeesCompact = (n) => {
  const v = Number(n || 0);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);

  // Three significant figures is the right resolution for a dashboard: enough
  // that ₹29.5 L is not rounded to ₹30 L, few enough to stay scannable.
  const trim = (x, dp) => String(Number(x.toFixed(dp)));

  if (a >= 1_00_00_000) return `${sign}₹${trim(a / 1_00_00_000, a >= 10_00_00_000 ? 1 : 2)} Cr`;
  if (a >= 1_00_000) return `${sign}₹${trim(a / 1_00_000, a >= 10_00_000 ? 1 : 2)} L`;
  if (a >= 1_000) return `${sign}₹${trim(a / 1_000, a >= 10_000 ? 0 : 1)} K`;
  return `${sign}₹${a.toLocaleString('en-IN')}`;
};

/**
 * Parse a timestamp from the API.
 *
 * SQLite's datetime('now') returns UTC with no zone marker — "2026-08-20
 * 16:57:25". JavaScript reads a bare "YYYY-MM-DDTHH:MM:SS" as LOCAL time, so
 * without the Z every timestamp in this UI rendered five and a half hours early
 * for an IST user. On a desk that runs on SLA deadlines and per-step KYC timers,
 * that is not cosmetic.
 *
 * So: normalise the separator, and append Z unless the string already carries a
 * zone of its own.
 */
export const parseTs = (s) => {
  if (!s) return null;
  const raw = String(s).trim();
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const zoned = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const shortDate = (s) => {
  const d = parseTs(s);
  return d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : (s || '—');
};

export const dateTime = (s) => {
  const d = parseTs(s);
  return d ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : (s || '—');
};

export const mins = (seconds) => {
  const s = Number(seconds || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const STATE_LABEL = {
  INACTIVE: 'Inactive',
  EXPLORING: 'Exploring',
  WARM: 'Warm',
  PRODUCT_RM_ENGAGED: 'Product RM engaged',
  KYC_IN_PROGRESS: 'KYC in progress',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  LOST: 'Lost / declined',
};

export const ROLE_LABEL = {
  superadmin: 'Superadmin', admin: 'Admin', caller: 'Caller', dealer: 'Dealer',
  sales_rm: 'Sales RM', sales_supervisor: 'Sales Supervisor', partner_rm: 'Partner RM',
  product_rm: 'Product RM', product_supervisor: 'Product Supervisor',
  customer_care: 'Customer Care', marketing_manager: 'Marketing Manager',
};
