/**
 * My Team — the reporting line, and how each person is doing.
 *
 * Two views of one set of people. The tree answers "who reports to whom", which
 * is a question about structure; the table answers "who needs help this week",
 * which is a question about work. Neither substitutes for the other, so both
 * are here rather than one being a toggle nobody finds.
 *
 * Overdue is the column a supervisor actually scans, so it is the one that
 * carries colour.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rupeesCompact, ROLE_LABEL } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Avatar } from '../components/ui.jsx';

export default function Team() {
  const [data, { loading, error }] = useApi('/team');
  const [view, setView] = useState('list');
  const navigate = useNavigate();

  if (loading && !data) return <Loading label="Loading your team…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  if (!data.members.length) {
    return (
      <div>
        <div className="page-head"><div><h1>My Team</h1></div></div>
        <Empty>Nobody reports to you yet.</Empty>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>My Team</h1>
          <p className="muted">
            {data.scope === 'org'
              ? 'Everyone in the businesses you administer.'
              : 'You and everyone who reports to you, at any depth.'}
          </p>
        </div>
        <div className="tabs" style={{ marginBottom: 0, display: 'inline-flex' }}>
          {[['list', 'List'], ['tree', 'Reporting line']].map(([k, label]) => (
            <button key={k} className={`tab ${view === k ? 'active' : ''}`}
              onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="grid-auto" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="stat-label">People</div>
          <div className="stat-value">{data.totals.people}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Leads held</div>
          <div className="stat-value">{data.totals.leads}</div>
          <div className="stat-sub">{data.totals.clients} live accounts</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Brokerage YTD</div>
          <div className="stat-value">{rupeesCompact(data.totals.brokerage)}</div>
        </div>
        <div className={`card stat ${data.totals.overdue ? 'tone-warn' : ''}`}>
          <div className="stat-label">Overdue tasks</div>
          <div className="stat-value">{data.totals.overdue}</div>
          <div className="stat-sub">Across the whole team</div>
        </div>
      </div>

      {view === 'list' ? (
        <div className="card">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th><th>Reports to</th>
                  <th className="num">Leads</th><th className="num">Converts</th>
                  <th className="num">Accounts</th><th className="num">Brokerage</th>
                  <th className="num">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((m) => (
                  <tr key={m.id} className="row-link"
                    onClick={() => navigate(`/leads?owner_id=${m.id}`)}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <Avatar name={m.name} size={28} />
                        <div style={{ minWidth: 0 }}>
                          <div>{m.name}</div>
                          <div className="small muted">
                            {ROLE_LABEL[m.role] || m.role}{m.branch ? ` · ${m.branch}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="muted">{m.manager_name || '—'}</td>
                    <td className="num">{m.leads}</td>
                    {/* Null, not zero — nobody with no leads has a conversion rate. */}
                    <td className="num">{m.conversion_pct == null ? '—' : `${m.conversion_pct}%`}</td>
                    <td className="num">{m.clients}</td>
                    <td className="num">{rupeesCompact(m.brokerage)}</td>
                    <td className="num">
                      {m.overdue > 0
                        ? <span className="badge badge-amber">{m.overdue}</span>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-body stack" style={{ gap: 4 }}>
            {data.tree.map((root) => <Node key={root.id} node={root} depth={0} onOpen={navigate} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function Node({ node, depth, onOpen }) {
  const [open, setOpen] = useState(depth < 2);
  const has = node.reports.length > 0;

  return (
    <div>
      <div className="row" style={{ gap: 8, paddingLeft: depth * 22, minHeight: 38 }}>
        {has ? (
          <button type="button" className="btn-ghost btn-icon btn-sm"
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? 'expand_more' : 'chevron_right'} size={16} />
          </button>
        ) : <span style={{ width: 28, flex: '0 0 28px' }} />}

        <Avatar name={node.name} size={26} />
        <button type="button" className="btn-ghost btn-sm" style={{ textAlign: 'left' }}
          onClick={() => onOpen(`/leads?owner_id=${node.id}`)}>
          {node.name}
        </button>
        <span className="tiny muted">{ROLE_LABEL[node.role] || node.role}</span>
        <span className="tiny muted">· {node.leads} leads</span>
        {node.overdue > 0 && <span className="badge badge-amber">{node.overdue} overdue</span>}
      </div>
      {open && node.reports.map((r) => <Node key={r.id} node={r} depth={depth + 1} onOpen={onOpen} />)}
    </div>
  );
}
