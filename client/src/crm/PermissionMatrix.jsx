/**
 * Who can do what, every role at once.
 *
 * Editing is one role at a time; "who can export a client list" is every role
 * at once, and an auditor only ever asks the second.
 *
 * THE BUG THIS REPLACES
 * The old grid coloured its cells `var(--green)` for granted and `var(--border)`
 * for not — and neither token exists. Both resolved to nothing, so both states
 * inherited the same colour and every cell looked identical. A matrix where
 * granted and denied are indistinguishable is not a dense matrix, it is a
 * decorative one.
 *
 * It also listed raw codes (`lead.view.all`) in one flat alphabetical run of
 * 48, with the role names turned on their side. Grouped by category with the
 * label first, and filterable, because the question is almost never "show me
 * all 48" — it is "who can do the KYC ones".
 */

import { Fragment, useMemo, useState } from 'react';
import { useApi, Icon, Empty } from '../components/ui.jsx';
import SetupSkeleton from '../setup/SetupSkeleton.jsx';

export default function PermissionMatrix({ caps }) {
  const [data, { loading }] = useApi('/admin/roles');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(null);
  const [onlyGranted, setOnlyGranted] = useState(false);

  /* The catalogue gives each code a label, a category and whether it is
     sensitive. The matrix gives which roles hold it. Neither is useful alone:
     one is a list of codes, the other a list of names. */
  const rows = useMemo(() => {
    if (!data || !caps) return [];
    const out = [];
    for (const c of caps.categories ?? []) {
      for (const cap of c.capabilities) {
        out.push({
          code: cap.code,
          label: cap.label ?? cap.code,
          category: c.category,
          sensitive: Boolean(cap.sensitive),
          holders: data.matrix[cap.code] ?? [],
        });
      }
    }
    return out;
  }, [data, caps]);

  const categories = useMemo(() => {
    const m = new Map();
    for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return [...m];
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (category && r.category !== category) return false;
      if (onlyGranted && r.holders.length === 0) return false;
      if (!q) return true;
      return r.label.toLowerCase().includes(q) || r.code.toLowerCase().includes(q);
    });
  }, [rows, query, category, onlyGranted]);

  if (loading || !data) return <SetupSkeleton rows={8} />;

  /* A capability nobody holds is worth seeing: either it is dead weight in the
     catalogue, or somebody has been locked out of something the product still
     enforces. */
  const orphans = rows.filter((r) => r.holders.length === 0).length;

  let lastCategory = null;

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Who can do what</h2>
          <span className="tiny muted">
            Every role at once — enforced at the API, not hidden in the interface
          </span>
        </div>
      </div>

      <div className="card-body stack" style={{ gap: 10 }}>
        <div className="filter-search" style={{ maxWidth: '22rem' }}>
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter permissions"
            aria-label="Filter permissions"
          />
          {query && (
            <button type="button" className="filter-clear" onClick={() => setQuery('')} aria-label="Clear">
              <Icon name="close" size={15} />
            </button>
          )}
        </div>

        <div className="filter-row">
          {categories.map(([name, n]) => (
            <button
              key={name}
              type="button"
              className={`filter-chip${category === name ? ' is-on' : ''}`}
              aria-pressed={category === name}
              onClick={() => setCategory(category === name ? null : name)}
            >
              {name}
              <span className="filter-count">{n}</span>
            </button>
          ))}
          {orphans > 0 && (
            <button
              type="button"
              className={`filter-chip${onlyGranted ? ' is-on' : ''}`}
              aria-pressed={onlyGranted}
              onClick={() => setOnlyGranted((v) => !v)}
              title="Hide permissions no role currently holds"
            >
              Granted only
              <span className="filter-count">{rows.length - orphans}</span>
            </button>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty>No permission matches that.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table matrix perm-matrix">
            <thead>
              <tr>
                <th className="matrix-corner">Permission</th>
                {data.roles.map((r) => (
                  <th key={r.code} className="matrix-role" title={r.label}><span>{r.label}</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const heading = row.category !== lastCategory ? row.category : null;
                lastCategory = row.category;
                return (
                  <Fragment key={row.code}>
                    {heading && (
                      <tr className="matrix-section">
                        <th scope="row" colSpan={data.roles.length + 1}>{heading}</th>
                      </tr>
                    )}
                    <tr>
                      <th scope="row" className="matrix-tab">
                        <span className="perm-label">
                          {row.label}
                          {row.sensitive && <span className="badge badge-amber">Sensitive</span>}
                        </span>
                        {/* Both identifiers, always: the label is what an
                            administrator recognises, the code is what appears
                            in a refusal message and in the audit log. */}
                        <code className="api-name">{row.code}</code>
                      </th>
                      {data.roles.map((r) => {
                        const has = row.holders.includes(r.code);
                        return (
                          <td key={r.code} className="matrix-cell">
                            <span
                              className={`perm-dot${has ? ' is-on' : ''}`}
                              role="img"
                              aria-label={`${r.label}: ${has ? 'granted' : 'not granted'}`}
                            >
                              <Icon name={has ? 'check' : 'remove'} size={14} />
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
