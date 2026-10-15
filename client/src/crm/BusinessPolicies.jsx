/**
 * Setup → Business policies (QA-13, QA-06).
 *
 * Answers the business gave that it may want to change later: whether a
 * partner may refer the other business's products and how such a referral is
 * paid, how a role's exports carry personal data (QA-06), and how long leads
 * and clients are kept. Held as a draft until Save, and every change is in the
 * configuration audit.
 *
 * OPS-43: an Admin sees and changes their own business's switches; a policy
 * that applies to both businesses is shown to them read-only, because a
 * Superadmin changes it.
 */

import { useDraft } from '../components/useDraft.js';
import PendingBar from '../components/PendingBar.jsx';
import { api, dateTime } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner } from '../components/ui.jsx';

export default function BusinessPolicies() {
  const [data, { loading, error, reload }] = useApi('/setup/policies');

  const draft = useDraft(
    async (changes) => {
      for (const c of changes) {
        // eslint-disable-next-line no-await-in-loop
        await api.put(`/setup/policies/${encodeURIComponent(c.key)}`, { value: c.value });
      }
      reload();
    },
    (c) => c.key,
  );

  if (loading && !data) return <Loading label="Loading business policies…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  const areas = [...new Set(data.policies.map((p) => p.area))];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="notice">
        <Icon name="info" size={17} />
        <span>Decisions the business can change without a release. Nothing applies until you save, and every change is recorded in the audit log.</span>
      </div>

      {areas.map((area) => (
        <section className="card" key={area}>
          <div className="card-head"><h2>{area}</h2></div>
          <div className="card-body stack" style={{ gap: 12 }}>
            {data.policies.filter((p) => p.area === area).map((p) => {
              const value = draft.valueOf({ key: p.key }, p.value);
              const locked = p.may_change === false;
              return (
                <div key={p.key} className="row-between" style={{ alignItems: 'flex-start', gap: 16 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 560 }}>{p.label}</div>
                    <div className="small muted" style={{ maxWidth: '62ch' }}>{p.help}</div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      {p.is_default ? 'Default — nobody has changed this.' : `Last changed by ${p.updated_by_name ?? 'someone'} on ${dateTime(p.updated_at)}.`}
                      {locked && <> {p.locked_reason}.</>}
                    </div>
                  </div>
                  {p.type === 'bool' ? (
                    <label className="row" style={{ gap: 6, flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        id={`policy-${p.key}`}
                        checked={Boolean(value)}
                        disabled={locked}
                        onChange={(e) => draft.set({ key: p.key }, e.target.checked)}
                      />
                      <span className="small">{value ? 'On' : 'Off'}</span>
                    </label>
                  ) : p.type === 'number' ? (
                    /* A number with its unit and its bounds; the server holds the
                       same bounds, so a retention below the legal floor is refused. */
                    <label className="row" style={{ gap: 6, flexShrink: 0 }}>
                      {p.unit === '₹' && <span className="small">₹</span>}
                      <input
                        type="number"
                        id={`policy-${p.key}`}
                        value={value}
                        min={p.min}
                        max={p.max}
                        disabled={locked}
                        onChange={(e) => draft.set({ key: p.key }, e.target.value === '' ? '' : Number(e.target.value))}
                        style={{ width: 110 }}
                      />
                      {p.unit && p.unit !== '₹' && <span className="small">{p.unit}</span>}
                    </label>
                  ) : (
                    <select
                      id={`policy-${p.key}`}
                      value={value}
                      disabled={locked}
                      onChange={(e) => draft.set({ key: p.key }, e.target.value)}
                      style={{ flexShrink: 0 }}
                    >
                      {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <PendingBar draft={draft} what="policy changes" />
    </div>
  );
}
