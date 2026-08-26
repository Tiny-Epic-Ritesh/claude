import { useState } from 'react';
import { api, token, ROLE_LABEL, appUrl } from '../api.js';
import { ErrorBanner, Spinner } from '../components/ui.jsx';
import { MarketStrip } from '../components/Market.jsx';
import BrandLogo from '../components/BrandLogo.jsx';

/**
 * Every seeded role, as a box a tester can click.
 *
 * The scope line matters more than the name. "Sales Supervisor" tells a tester
 * nothing about what they will see; "the team's book, can reassign" tells them
 * which role to pick for the thing they are about to test.
 *
 * Ordered by how often a tester reaches for them, not alphabetically. The two
 * administrative roles lead because they can reach everything else; Sales RM
 * follows because it is the busiest cockpit in the product.
 */
const ROLES = [
  ['superadmin@bonanza.test', 'superadmin', 'shield_person', 'Everything, including Setup and the audit log'],
  ['admin@bonanza.test', 'admin', 'settings_account_box', 'Configuration, users, objects and fields'],
  ['salesrm@bonanza.test', 'sales_rm', 'support_agent', 'Own book of leads — the busiest cockpit'],
  ['salessupervisor@bonanza.test', 'sales_supervisor', 'groups', "The team's book; can change stage and reassign"],
  ['caller@bonanza.test', 'caller', 'call', 'Dial list only — qualifies and hands over'],
  ['dealer@bonanza.test', 'dealer', 'candlestick_chart', 'Trading desk view of active clients'],
  ['productrm@bonanza.test', 'product_rm', 'inventory_2', 'Leads carrying their own product'],
  ['productsupervisor@bonanza.test', 'product_supervisor', 'inventory', 'All product cards across the desk'],
  ['partnerrm@bonanza.test', 'partner_rm', 'handshake', 'Partners, onboarding and commissions'],
  ['care@bonanza.test', 'customer_care', 'headset_mic', 'Cases, SLA and the service queue'],
  ['marketing@bonanza.test', 'marketing_manager', 'campaign', 'Campaigns, lists and templates — no client PII'],
];

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('salesrm@bonanza.test');
  const [password, setPassword] = useState('bonanza');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  async function submit(e, asEmail) {
    e?.preventDefault();
    setBusy(true);
    setPending(asEmail ?? null);
    setError(null);
    try {
      const result = await api.post('/auth/login', { email: asEmail || email, password: 'bonanza' });
      token.set('crm', result.token);
      onSignedIn(result.user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <BrandLogo org="BONANZA" height={34} />
          <div>
            <strong>Bonanza CRM</strong>
            <span>Role-based cockpit for Bonanza Portfolio Ltd</span>
          </div>
        </div>

        <form onSubmit={submit} className="login-form">
          <ErrorBanner error={error} />
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input id="login-email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="login-pw">Password</label>
            <input id="login-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy && !pending ? <Spinner /> : 'Sign in'}
          </button>
        </form>

        <div className="login-divider"><span>or open a role directly</span></div>

        <div className="login-roles">
          {ROLES.map(([demoEmail, role, icon, scope]) => (
            <button
              key={role}
              type="button"
              className={`role-card ${pending === demoEmail ? 'is-loading' : ''}`}
              onClick={(e) => { setEmail(demoEmail); submit(e, demoEmail); }}
              disabled={busy}
            >
              <span className="role-icon material-symbols-rounded" aria-hidden>{icon}</span>
              <span className="role-body">
                <strong>{ROLE_LABEL[role]}</strong>
                <span className="role-scope">{scope}</span>
              </span>
              {pending === demoEmail
                ? <Spinner />
                : <span className="role-go material-symbols-rounded" aria-hidden>arrow_forward</span>}
            </button>
          ))}
        </div>

        {/* Delayed index levels, from the unauthenticated endpoint. Nothing
            here is client-specific and nothing requires a session. */}
        <MarketStrip publicMode className="on-login" />

        <p className="login-foot">
          Every demo account uses the password <code>bonanza</code>. The client-facing
          surfaces are at <a href={appUrl("/dkyc")}>/dkyc</a> and <a href={appUrl("/portal")}>/portal</a>.
        </p>
      </div>
    </div>
  );
}
