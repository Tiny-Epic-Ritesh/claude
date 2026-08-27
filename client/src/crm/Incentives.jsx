/**
 * Incentives.
 *
 * The band-by-band working is shown rather than a single figure, because the
 * one question anybody has about their incentive is "how was that calculated?"
 * — and a payout somebody cannot check is a payout they will query by email
 * every month.
 *
 * Slabs are marginal: each band pays its own rate on the portion of production
 * inside it. The table makes that visible, which also makes it obvious that
 * earning one rupee more never reduces the total.
 */

import { useSearchParams } from 'react-router-dom';
import { rupees, rupeesCompact } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Segmented } from '../components/ui.jsx';

const BASIS = {
  brokerage: { label: 'Brokerage share', icon: 'percent', unit: 'rupees' },
  accounts: { label: 'Accounts opened', icon: 'person_add', unit: 'count' },
  aum: { label: 'Assets under management', icon: 'account_balance', unit: 'rupees' },
};

const amount = (v, unit) => (unit === 'rupees' ? rupeesCompact(v) : Number(v).toLocaleString('en-IN'));

const rateLabel = (s) => (s.rate_kind === 'percent' ? `${s.rate}%`
  : s.rate_kind === 'bps' ? `${s.rate} bps`
    : `${rupees(s.rate)} each`);

export default function Incentives() {
  const [search, setSearch] = useSearchParams();
  const range = search.get('range') || 'mtd';
  const [d, { loading, error }] = useApi(`/kra/incentives?range=${encodeURIComponent(range)}`, [range]);

  const setRange = (code) => {
    const next = new URLSearchParams(search);
    if (code === 'mtd') next.delete('range'); else next.set('range', code);
    setSearch(next, { replace: true });
  };

  if (loading && !d) return <Loading label="Working out your payout…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!d) return null;

  if (!d.plan) {
    return (
      <div>
        <div className="page-head"><div><h1>Incentives</h1></div></div>
        <Empty>{d.note}</Empty>
      </div>
    );
  }

  return (
    <div>
      <div className="row-between wrap" style={{ marginBottom: 14, gap: 12 }}>
        <div>
          <h1>Incentives</h1>
          <span className="tiny muted">{d.plan.name} · {d.range.label}</span>
        </div>
        <Segmented
          value={d.range.code}
          onChange={setRange}
          options={d.ranges.filter((r) => r.code !== 'custom').map((r) => ({
            value: r.code,
            label: { today: 'Today', mtd: 'Month', qtd: 'Quarter', fytd: 'FY' }[r.code] ?? r.label,
          }))} />
      </div>

      <div className="grid-auto" style={{ marginBottom: 16 }}>
        <div className="card stat tone-good">
          <div className="stat-label">Payout so far</div>
          <div className="stat-value">{rupeesCompact(d.total)}</div>
          <div className="stat-sub">{rupees(d.total)}</div>
        </div>
        {d.bases.map((b) => (
          <div key={b.basis} className="card stat">
            <div className="stat-label">{BASIS[b.basis]?.label ?? b.basis}</div>
            <div className="stat-value">{rupeesCompact(b.total)}</div>
            <div className="stat-sub">
              on {amount(b.production, BASIS[b.basis]?.unit)} {b.basis === 'accounts' ? 'accounts' : ''}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body">
          <p className="small muted" style={{ margin: 0 }}>{d.plan.description}</p>
        </div>
      </div>

      {/* Named before payday, not discovered on the payslip. */}
      {d.at_risk.accounts > 0 && (
        <div className="notice notice-warn" style={{ marginBottom: 14 }}>
          <Icon name="warning" size={17} />
          <span>{d.at_risk.note}</span>
        </div>
      )}

      {d.bases.map((b) => (
        <div key={b.basis} className="card" style={{ marginBottom: 14 }}>
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>
              <Icon name={BASIS[b.basis]?.icon ?? 'payments'} size={16} />{' '}
              {BASIS[b.basis]?.label ?? b.basis}
            </h2>
            <span className="tiny muted">
              {amount(b.production, BASIS[b.basis]?.unit)} produced · {rupeesCompact(b.total)} earned
            </span>
          </div>

          {b.lines.length === 0 ? (
            <div className="card-body">
              <span className="tiny muted">
                Nothing in this basis yet — the first band starts once there is production against it.
              </span>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Band</th><th>Rate</th>
                    <th className="num">Counted in this band</th><th className="num">Earns</th>
                  </tr>
                </thead>
                <tbody>
                  {b.lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        {amount(l.from, BASIS[b.basis]?.unit)}
                        {' – '}
                        {l.to == null ? 'above' : amount(l.to, BASIS[b.basis]?.unit)}
                      </td>
                      <td>{rateLabel(l)}</td>
                      <td className="num">{amount(l.portion, BASIS[b.basis]?.unit)}</td>
                      <td className="num">{rupees(l.amount)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ textAlign: 'right', fontWeight: 600 }}>Total</td>
                    <td className="num" style={{ fontWeight: 600 }}>{rupees(b.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      <div className="card">
        <div className="card-body">
          <p className="tiny muted" style={{ margin: 0 }}>
            Bands are marginal — each pays its own rate on the portion of
            production inside it, so earning more never reduces the total.
            Accounts that stay dormant past {d.plan.clawback_months} months have
            their acquisition fee clawed back. This plan ships as a worked
            example and is meant to be replaced with the firm&apos;s actual
            structure in Setup.
          </p>
        </div>
      </div>
    </div>
  );
}
