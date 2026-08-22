import { useEffect, useState } from 'react';
import { api, token, money, rupees, shortDate, dateTime } from '../api.js';
import { ErrorBanner, Loading, Spinner, Empty, Modal, Tabs } from '../components/ui.jsx';
import {
  BarChart, Donut, Funnel, ProgressRing, StatTile, compactMoney,
} from '../components/charts.jsx';
import ProductCard, { minimumFact } from '../components/ProductCard.jsx';
import BrandLogo from '../components/BrandLogo.jsx';

/**
 * Partner Portal — the separate authenticated surface for partners.
 *
 * BRD OD-10 keeps partners out of the CRM entirely; this portal is how they see
 * their own sourced leads, commissions, onboarding progress and support tickets.
 */
export default function PartnerPortal() {
  const [partner, setPartner] = useState(undefined);

  useEffect(() => {
    if (!token.get('partner')) { setPartner(null); return; }
    api.get('/auth/me', 'partner')
      .then((d) => setPartner(d.partner))
      .catch(() => { token.clear('partner'); setPartner(null); });
  }, []);

  if (partner === undefined) return <div className="public"><div className="public-body"><Loading /></div></div>;
  if (!partner) return <PartnerLogin onSignedIn={setPartner} />;
  return <Dashboard partner={partner} onSignOut={() => { token.clear('partner'); setPartner(null); }} />;
}

/* --------------------------------------------------------------- login */

function PartnerLogin({ onSignedIn }) {
  const [email, setEmail] = useState('girish@partner.test');
  const [password, setPassword] = useState('partner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/auth/partner-login', { email, password });
      token.set('partner', res.token);
      onSignedIn(res.partner);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand"><BrandLogo org="BONANZA" height={30} /><div><strong>Partner Portal</strong></div></div>
        <p className="small muted" style={{ marginTop: 0 }}>
          For Remisiers, Agents, Associates and Authorised Persons. Refer clients, track your business and raise support requests.
        </p>
        <form onSubmit={submit}>
          <ErrorBanner error={error} />
          <div className="field"><label>Email</label><input value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></div>
          <div className="field"><label>Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <button className="btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
            {busy ? <Spinner /> : 'Sign in'}
          </button>
        </form>
        <div className="tiny muted" style={{ marginTop: 14 }}>
          Demo partners: <code>girish@partner.test</code> (Associate) or <code>lakshmi@partner.test</code> (Remisier) — password <code>partner</code>.
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- dashboard */

/**
 * The partner's own business, on one screen.
 *
 * A partner is not a CRM user with fewer buttons — they run a book and get paid
 * on it. So the first thing on the page is what they earned and what is moving,
 * not a table of leads. The previous build put six numbers in a 440px column and
 * everything else below the fold; this one gives the surface the same width and
 * rhythm as the CRM, because it is doing the same weight of work.
 */
function Dashboard({ partner, onSignOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview');
  const [refer, setRefer] = useState(false);
  const [raise, setRaise] = useState(false);

  const load = () => api.get('/portal/dashboard', 'partner').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <div className="public"><div className="public-body"><ErrorBanner error={error} /></div></div>;
  if (!data) return <div className="portal"><div className="portal-body"><Loading /></div></div>;

  const m = data.metrics;
  const p = data.partner;

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'clients', label: 'My clients', count: data.sourced_leads.length },
    { key: 'earnings', label: 'Earnings' },
    { key: 'products', label: 'Products' },
    { key: 'onboarding', label: 'Onboarding' },
    { key: 'support', label: 'Support', count: data.tickets.length },
  ];

  return (
    <div className="portal">
      <header className="portal-head">
        <div className="portal-id">
          <BrandLogo org={p.sales_org} height={28} />
          <div style={{ minWidth: 0 }}>
            <div className="portal-name">{p.business_name || p.name}</div>
            <div className="portal-sub">
              <span>{p.model}</span>
              {p.code && <><span aria-hidden>·</span><code className="api-name">{p.code}</code></>}
              <span aria-hidden>·</span>
              <span className={`state-pill ${p.state === 'ACTIVE' ? 'state-active' : ''}`}>{p.state}</span>
            </div>
          </div>
        </div>
        <div className="portal-head-actions">
          <button type="button" className="btn btn-primary" onClick={() => setRefer(true)}>
            <span className="material-symbols-rounded">person_add</span> Refer a client
          </button>
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <div className="portal-body">
        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {tab === 'overview' && <Overview data={data} onRefer={() => setRefer(true)} onRaise={() => setRaise(true)} />}
        {tab === 'clients' && <Clients data={data} onRefer={() => setRefer(true)} />}
        {tab === 'earnings' && <Earnings data={data} />}
        {tab === 'products' && <ProductCatalogue data={data} onRefer={() => setRefer(true)} />}
        {tab === 'onboarding' && <Onboarding data={data} />}
        {tab === 'support' && <Support data={data} onRaise={() => setRaise(true)} />}
      </div>

      {refer && <ReferModal products={data.products} onClose={() => setRefer(false)} onDone={() => { setRefer(false); load(); }} />}
      {raise && <RaiseModal onClose={() => setRaise(false)} onDone={() => { setRaise(false); load(); }} />}
    </div>
  );
}

/* ------------------------------------------------------------ overview */

function Overview({ data, onRefer, onRaise }) {
  const m = data.metrics;
  const p = data.partner;

  // The commission series arrives newest-first for the table; a trend has to
  // read left-to-right in time or the line means the opposite of what it shows.
  const series = [...data.commissions].reverse();
  const trend = series.map((c) => ({ label: c.period?.slice(5) ?? '', value: c.payout || 0 }));

  const lastTwo = series.slice(-2);
  const delta = lastTwo.length === 2 && lastTwo[0].payout
    ? Math.round(((lastTwo[1].payout - lastTwo[0].payout) / lastTwo[0].payout) * 100)
    : null;

  /**
   * The referral journey, as a funnel.
   *
   * A funnel is only readable if each row is a subset of the row above it. CRM
   * stage and KYC status are independent tracks — a lead can be sitting at
   * stage New with KYC already underway — so counting each level on its own
   * condition produced 2 → 0 → 0 → 2 → 1, which reads as nonsense.
   *
   * Instead: work out how far each client actually got, then count how many
   * reached at least each level. Monotonic by construction.
   */
  const LEVELS = ['Referred', 'Engaged', 'Product interest', 'KYC underway', 'Trading'];

  const furthest = (l) => {
    const cards = (l.cards || '').split(',').filter(Boolean);
    if (cards.some((c) => c.endsWith(':ACTIVE'))) return 4;
    if (l.kyc_status && l.kyc_status !== 'NOT_STARTED') return 3;
    if (cards.length) return 2;
    if (l.stage && l.stage !== 'New') return 1;
    return 0;
  };

  const reached = data.sourced_leads.map(furthest);
  const funnel = LEVELS.map((label, i) => ({
    label,
    value: reached.filter((r) => r >= i).length,
    tone: i === LEVELS.length - 1 ? 'ok' : 'accent',
  }));

  const byProduct = new Map();
  for (const l of data.sourced_leads) {
    for (const pair of (l.cards || '').split(',').filter(Boolean)) {
      const [code, state] = pair.split(':');
      if (state === 'INACTIVE') continue;
      byProduct.set(code, (byProduct.get(code) || 0) + 1);
    }
  }
  const tones = ['accent', 'info', 'ok', 'warn', 'danger'];
  const mix = [...byProduct.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([code, n], i) => ({ label: code, value: n, tone: tones[i % tones.length] }));

  return (
    <>
      <div className="portal-hero">
        <div className="glass section-card portal-welcome">
          <div>
            <h1>Good to see you, {(p.name || '').split(' ')[0]}.</h1>
            <p>
              You have sourced <strong>{m.leads_sourced}</strong> client{m.leads_sourced === 1 ? '' : 's'}, of which{' '}
              <strong>{m.converted}</strong> {m.converted === 1 ? 'is' : 'are'} trading. Your lifetime commission stands at{' '}
              <strong>{rupees(m.commission_lifetime)}</strong> at {p.commission_pct}%.
            </p>
          </div>
          <div className="row" style={{ gap: 9, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" onClick={onRefer}>
              <span className="material-symbols-rounded">person_add</span> Refer a client
            </button>
            <button type="button" className="btn" onClick={onRaise}>
              <span className="material-symbols-rounded">support_agent</span> Raise a request
            </button>
          </div>
          {data.rm && (
            <div className="rm-card">
              <span className="material-symbols-rounded">badge</span>
              <div>
                <strong>{data.rm.name}</strong>
                <div className="tiny muted">
                  Your relationship manager{data.rm.email ? ` · ${data.rm.email}` : ''}
                  {data.rm.phone ? ` · ${data.rm.phone}` : ''}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="glass section-card">
          <div className="section-head">
            <div>
              <h2>Commission trend</h2>
              <p>Last {series.length || 0} periods</p>
            </div>
            <span className="stat-tile-value" style={{ fontSize: 20 }}>{rupees(m.commission_month)}</span>
          </div>
          {trend.length >= 2
            ? <BarChart data={trend} height={168} format={compactMoney} />
            : <div className="chart-empty">Commission history appears here once your first payout is processed.</div>}
        </div>
      </div>

      <div className="stat-strip">
        <StatTile label="Clients sourced" value={m.leads_sourced} sub={`${m.leads_this_month} this month`} icon="group_add" />
        <StatTile label="Converted" value={m.converted} sub={`${m.conversion_rate}% conversion`} tone="ok" icon="verified" />
        <StatTile label="AUM attributed" value={money(m.aum_attributed)} icon="account_balance" tone="info" />
        <StatTile label="Commission this month" value={rupees(m.commission_month)} sub={`at ${p.commission_pct}%`} trend={delta} icon="payments" />
        <StatTile label="Lifetime commission" value={rupees(m.commission_lifetime)} icon="savings" />
        <StatTile
          label="Open requests" value={m.open_tickets}
          tone={m.open_tickets ? 'warn' : null} icon="support_agent"
          goodWhen="down"
          sub={m.open_tickets ? 'awaiting response' : 'all clear'}
        />
      </div>

      <div className="portal-grid is-split">
        <div className="glass section-card">
          <div className="section-head">
            <div>
              <h2>Where your clients are</h2>
              <p>Every client you have sourced, by how far they have travelled</p>
            </div>
          </div>
          <Funnel stages={funnel} />
        </div>

        <div className="glass section-card">
          <div className="section-head">
            <div>
              <h2>What they buy</h2>
              <p>Your top products by client count</p>
            </div>
          </div>
          {/* The centre counts interests, not clients — one client may hold
              three products, and a centre that disagreed with its own legend
              would be the first thing a partner queried. */}
          {mix.length
            ? <Donut segments={mix} centre={mix.reduce((t, x) => t + x.value, 0)} caption="interests" />
            : <div className="chart-empty">No product interest recorded yet</div>}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- clients */

function Clients({ data, onRefer }) {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('all');

  const rows = data.sourced_leads.filter((l) => {
    if (stage === 'active' && !(l.cards || '').includes(':ACTIVE')) return false;
    if (stage === 'pending' && (l.cards || '').includes(':ACTIVE')) return false;
    if (!q.trim()) return true;
    const needle = q.toLowerCase();
    return (l.name || '').toLowerCase().includes(needle) || (l.city || '').toLowerCase().includes(needle);
  });

  return (
    <div className="glass section-card">
      <div className="section-head">
        <div>
          <h2>Clients you have sourced</h2>
          <p>{rows.length} of {data.sourced_leads.length} shown</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="input-sm" placeholder="Search name or city…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input-sm" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="all">All</option>
            <option value="active">Trading</option>
            <option value="pending">In progress</option>
          </select>
          <button type="button" className="btn btn-primary btn-sm" onClick={onRefer}>Refer a client</button>
        </div>
      </div>

      {rows.length === 0 ? (
        <Empty>
          {data.sourced_leads.length
            ? 'No client matches that filter.'
            : 'You have not referred anyone yet. Your first referral appears here immediately.'}
        </Empty>
      ) : (
        <div className="client-grid">
          {rows.map((l) => {
            const cards = (l.cards || '').split(',').filter(Boolean)
              .map((pair) => { const [code, state] = pair.split(':'); return { code, state }; });
            const trading = cards.some((c) => c.state === 'ACTIVE');
            return (
              <article key={l.id} className={`glass client-card ${trading ? 'is-active' : ''}`}>
                <div className="client-head">
                  <span className="avatar" aria-hidden>{(l.name || '?').slice(0, 1).toUpperCase()}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong className="truncate">{l.name}</strong>
                    <div className="tiny muted">{l.city || '—'} · referred {shortDate(l.created_at)}</div>
                  </div>
                  <span className={`state-pill ${trading ? 'state-active' : 'state-exploring'}`}>
                    {trading ? 'Trading' : l.stage}
                  </span>
                </div>

                {/* Product interest, not the client's contact details. A partner
                    is paid on what the client buys; they do not need — and under
                    the data policy should not have — the client's live PII. */}
                <div className="chip-row">
                  {cards.length
                    ? cards.map((c) => (
                      <span key={c.code} className={`state-pill ${c.state === 'ACTIVE' ? 'state-active' : 'state-exploring'}`}>
                        {c.code}
                      </span>
                    ))
                    : <span className="tiny muted">No product interest recorded yet</span>}
                </div>

                <div className="product-facts">
                  <div className="product-fact">
                    <dt>KYC</dt>
                    <dd style={{ fontSize: 12.5 }}>{(l.kyc_status || 'Not started').replace(/_/g, ' ')}</dd>
                  </div>
                  <div className="product-fact">
                    <dt>AUM</dt>
                    <dd>{l.aum ? money(l.aum) : '—'}</dd>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ earnings */

function Earnings({ data }) {
  const m = data.metrics;
  const rows = data.commissions;

  const byProduct = new Map();
  for (const c of rows) {
    const k = c.product_name || 'Unattributed';
    byProduct.set(k, (byProduct.get(k) || 0) + (c.payout || 0));
  }
  const tones = ['accent', 'info', 'ok', 'warn', 'danger'];
  const mix = [...byProduct.entries()].map(([label, value], i) => ({
    label, value: Math.round(value), tone: tones[i % tones.length],
  }));

  return (
    <>
      <div className="stat-strip">
        <StatTile label="This month" value={rupees(m.commission_month)} icon="payments" />
        <StatTile label="Lifetime" value={rupees(m.commission_lifetime)} icon="savings" tone="ok" />
        <StatTile label="Rate" value={`${data.partner.commission_pct}%`} icon="percent" />
        <StatTile label="Periods paid" value={rows.length} icon="receipt_long" />
      </div>

      <div className="portal-grid is-split">
        <div className="glass section-card">
          <div className="section-head">
            <div>
              <h2>Commission statement</h2>
              <p>Most recent period first</p>
            </div>
          </div>
          {rows.length === 0 ? (
            <Empty>No commission has been processed yet.</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Period</th><th>Product</th><th className="num">Base</th><th className="num">Payout</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>{c.period}</td>
                      <td>{c.product_name || <span className="muted">—</span>}</td>
                      <td className="num">{c.base_amount != null ? rupees(c.base_amount) : '—'}</td>
                      <td className="num"><strong>{rupees(c.payout)}</strong></td>
                      <td>
                        <span className={`state-pill ${c.status === 'PAID' ? 'state-active' : ''}`}>
                          {c.status || 'Pending'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="glass section-card">
          <div className="section-head">
            <div>
              <h2>Earnings by product</h2>
              <p>Lifetime, where attributed</p>
            </div>
          </div>
          {mix.length
            ? <Donut segments={mix} centre={compactMoney(m.commission_lifetime)} caption="lifetime" />
            : <div className="chart-empty">Nothing attributed yet</div>}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ products */

/**
 * The catalogue a partner can sell, as cards.
 *
 * The same card component the KYC portal and the lead detail use, because it is
 * the same object. A partner reading this is deciding what to pitch, so the
 * minimum ticket and the category are the two facts that lead.
 */
function ProductCatalogue({ data, onRefer }) {
  const [q, setQ] = useState('');

  const sold = new Map();
  for (const l of data.sourced_leads) {
    for (const pair of (l.cards || '').split(',').filter(Boolean)) {
      const [code] = pair.split(':');
      sold.set(code, (sold.get(code) || 0) + 1);
    }
  }

  const rows = data.products.filter((p) =>
    !q.trim() || `${p.name} ${p.category}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="glass section-card">
      <div className="section-head">
        <div>
          <h2>What you can offer</h2>
          <p>Every product open to your clients, and how many of yours hold each</p>
        </div>
        <input className="input-sm" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {rows.length === 0 ? <Empty>No product matches that search.</Empty> : (
        <div className="product-grid">
          {rows.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              showFeatures
              featureLimit={3}
              facts={[
                minimumFact(p),
                { label: 'Your clients', value: sold.get(p.code) || 0 },
              ]}
              actions={(
                <button type="button" className="btn btn-primary btn-sm" onClick={onRefer}>
                  Refer for this
                </button>
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}


/* ---------------------------------------------------------- onboarding */

function Onboarding({ data }) {
  const steps = data.onboarding ?? [];
  const done = steps.filter((s) => s.status === 'DONE' || s.completed_at).length;

  const lms = data.lms ?? [];
  const lmsDone = lms.filter((l) => l.status === 'COMPLETED' || l.completed_at).length;

  return (
    <div className="portal-grid is-split">
      <div className="glass section-card">
        <div className="section-head">
          <div>
            <h2>Your onboarding</h2>
            <p>{done} of {steps.length} steps complete</p>
          </div>
          <ProgressRing value={done} total={steps.length || 1} size={72} thickness={7} />
        </div>

        {steps.length === 0 ? <Empty>No onboarding steps recorded.</Empty> : (
          <ol className="step-rail">
            {steps.map((s) => {
              const complete = s.status === 'DONE' || s.completed_at;
              return (
                <li key={s.code} className={complete ? 'is-done' : ''}>
                  <span className="step-dot material-symbols-rounded">
                    {complete ? 'check' : 'radio_button_unchecked'}
                  </span>
                  <div>
                    <strong>{s.label}</strong>
                    <div className="tiny muted">
                      {complete ? `Completed ${shortDate(s.completed_at)}` : (s.status || 'Pending')}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="glass section-card">
        <div className="section-head">
          <div>
            <h2>Training</h2>
            <p>{lmsDone} of {lms.length} modules complete</p>
          </div>
          <ProgressRing value={lmsDone} total={lms.length || 1} size={72} thickness={7} />
        </div>

        {lms.length === 0 ? <Empty>No training assigned.</Empty> : (
          <div className="module-list">
            {lms.map((l) => {
              const complete = l.status === 'COMPLETED' || l.completed_at;
              return (
                <div key={l.module} className="module-row">
                  <span className={`material-symbols-rounded ${complete ? 'is-done' : ''}`}>
                    {complete ? 'task_alt' : 'school'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong className="truncate">{l.module}</strong>
                    <div className="tiny muted">{complete ? `Passed ${shortDate(l.completed_at)}` : (l.status || 'Not started')}</div>
                  </div>
                  {l.score != null && <span className="score-pill">{l.score}%</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- support */

function Support({ data, onRaise }) {
  const rows = data.tickets ?? [];
  const open = rows.filter((t) => !['Resolved', 'Closed'].includes(t.status));

  return (
    <div className="glass section-card">
      <div className="section-head">
        <div>
          <h2>Support requests</h2>
          <p>{open.length} open · {rows.length} total</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={onRaise}>
          <span className="material-symbols-rounded">add</span> Raise a request
        </button>
      </div>

      {rows.length === 0 ? (
        <Empty>Nothing raised. Anything you send here reaches your relationship manager directly.</Empty>
      ) : (
        <div className="client-grid">
          {rows.map((t) => {
            const closed = ['Resolved', 'Closed'].includes(t.status);
            return (
              <article key={t.id} className={`glass client-card ${closed ? '' : 'is-active'}`}>
                <div className="client-head">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <code className="api-name">{t.ref}</code>
                    <strong className="truncate" style={{ display: 'block' }}>{t.subject}</strong>
                  </div>
                  <span className={`state-pill ${closed ? 'state-active' : t.priority === 'Critical' ? 'state-risk' : 'state-exploring'}`}>
                    {t.status}
                  </span>
                </div>
                {t.ai_summary && <p className="product-desc">{t.ai_summary}</p>}
                <div className="product-facts">
                  <div className="product-fact"><dt>Priority</dt><dd style={{ fontSize: 12.5 }}>{t.priority}</dd></div>
                  <div className="product-fact"><dt>Raised</dt><dd style={{ fontSize: 12.5 }}>{shortDate(t.created_at)}</dd></div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReferModal({ products, onClose, onDone }) {
  const [form, setForm] = useState({ name: '', mobile: '', email: '', city: '', product_type_id: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/portal/referrals', { ...form, product_type_id: form.product_type_id || undefined }, 'partner');
      setDone(res.message);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Refer a client" subtitle="Your referral goes straight into the Bonanza CRM, attributed to you." onClose={done ? onDone : onClose}>
      {done ? (
        <div style={{ textAlign: 'center', padding: '18px 0' }}>
          <div style={{ fontSize: 30 }}>✓</div>
          <h3 style={{ marginTop: 8 }}>{done}</h3>
          <button className="btn-primary" style={{ marginTop: 14 }} onClick={onDone}>Done</button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <ErrorBanner error={error} />
          <div className="field-row">
            <div className="field"><label>Client name</label><input value={form.name} onChange={set('name')} required autoFocus /></div>
            <div className="field">
              <label>Mobile</label>
              <input value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value.replace(/\D/g, '').slice(0, 10) })} inputMode="numeric" required />
            </div>
          </div>
          <div className="field-row">
            <div className="field"><label>Email</label><input type="email" value={form.email} onChange={set('email')} /></div>
            <div className="field"><label>City</label><input value={form.city} onChange={set('city')} /></div>
          </div>
          <div className="field">
            <label>Interested in</label>
            <select value={form.product_type_id} onChange={set('product_type_id')}>
              <option value="">Not sure yet</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Anything the RM should know</label>
            <textarea value={form.note} onChange={set('note')} placeholder="Existing investor, prefers Gujarati, best reached after 6pm…" style={{ minHeight: 70 }} />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy || !form.name.trim() || form.mobile.length !== 10}>
              {busy ? <Spinner /> : 'Submit referral'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function RaiseModal({ onClose, onDone }) {
  const [form, setForm] = useState({ subject: '', description: '', priority: 'Medium' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal title="Raise a support request" onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await api.post('/portal/tickets', form, 'partner'); onDone(); }
        catch (err) { setError(err.message); setBusy(false); }
      }}>
        <ErrorBanner error={error} />
        <div className="field"><label>Subject</label><input value={form.subject} onChange={set('subject')} required autoFocus /></div>
        <div className="field"><label>Details</label><textarea value={form.description} onChange={set('description')} /></div>
        <div className="field">
          <label>Priority</label>
          <select value={form.priority} onChange={set('priority')}>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}</select>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !form.subject.trim()}>{busy ? <Spinner /> : 'Submit'}</button>
        </div>
      </form>
    </Modal>
  );
}
