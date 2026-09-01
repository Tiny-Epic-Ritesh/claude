/**
 * Setup home.
 *
 * A landing page earns its place only if it answers something the sidebar
 * cannot. The sidebar is already the list of shortcuts, so repeating it here as
 * a grid of tiles would be a page that costs a click and says nothing.
 *
 * What an administrator actually arrives wanting to know is one of two things:
 * is something wrong that I have not noticed, and did somebody else already
 * change this. So that is what this page is — findings first, then the recent
 * configuration changes, then the shape of the system for a sense of scale.
 *
 * Findings are real defects with real consequences, never nags. A home page
 * that cries about optional descriptions gets ignored, and then it is ignored
 * on the day it says something that mattered.
 */

import { Link } from 'react-router-dom';
import { useApi, ErrorBanner, Icon } from '../components/ui.jsx';
import SetupSkeleton from './SetupSkeleton.jsx';
import { sectionByKey, sectionsFor, GROUPS } from './registry.js';

const AREA_LABEL = {
  entity: 'Object', field: 'Field', role: 'Role', tabs: 'Navigation',
  kra: 'Targets', incentives: 'Incentives', sla: 'SLA', product: 'Product',
  rule: 'Rule', template: 'Template', user: 'User',
};

const when = (iso) => {
  if (!iso) return '';
  const then = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

export default function SetupHome({ session }) {
  const [data, { loading, error }] = useApi('/setup/health');
  const available = sectionsFor(session.permissions);
  const canOpen = (key) => available.some((s) => s.key === key);

  /* The page head is drawn immediately and the panels arrive under it, rather
     than the whole screen being replaced by a spinner and then jumping. */
  if (loading) return <SetupSkeleton rows={7} />;

  return (
    <div className="setup-page">
      <header className="setup-page-head">
        <div>
          <h1>Setup</h1>
          <p className="muted">
            Configuration is data, not code. Everything here takes effect immediately —
            no deploy, no downtime.
          </p>
        </div>
      </header>

      {error && <ErrorBanner error={error} />}

      {/* ------------------------------------------------ needs attention */}
      <section className="setup-block">
        <div className="setup-block-head">
          <h2>Needs attention</h2>
          {data?.findings?.length > 0 && (
            <span className="tiny muted">
              {data.findings.length} thing{data.findings.length === 1 ? '' : 's'} worth a look
            </span>
          )}
        </div>

        {!data?.findings?.length ? (
          <div className="setup-allclear">
            <Icon name="task_alt" size={20} />
            <div>
              <strong>Nothing to fix.</strong>
              <span className="tiny muted">
                No unowned fields, no empty picklists, no values stranded on records,
                and every log has a retention period.
              </span>
            </div>
          </div>
        ) : (
          <ul className="finding-list">
            {data.findings.map((f, i) => {
              const target = sectionByKey(f.section);
              const openable = target && canOpen(f.section);
              return (
                <li key={`${f.section}-${i}`} className={`finding finding-${f.severity}`}>
                  <Icon name={f.severity === 'warn' ? 'warning' : 'info'} size={17} />
                  <div className="finding-body">
                    <strong>{f.title}</strong>
                    <span className="tiny muted">{f.detail}</span>
                  </div>
                  {/* Every finding names the screen that fixes it. A warning
                      you have to go and hunt for is half a warning. */}
                  {openable && (
                    <Link to={`/setup/${f.section}`} className="btn btn-ghost btn-sm">
                      {target.label}
                      <Icon name="arrow_forward" size={15} />
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="setup-columns">
        {/* -------------------------------------------- recently changed */}
        {data?.recent?.length > 0 && (
          <section className="setup-block">
            <div className="setup-block-head">
              <h2>Recently changed</h2>
              {canOpen('audit') && <Link className="tiny" to="/setup/audit">Full audit log</Link>}
            </div>
            <ul className="change-list">
              {data.recent.map((c) => (
                <li key={c.id}>
                  <div>
                    <strong>{AREA_LABEL[c.area] ?? c.area}</strong>
                    {' '}
                    <code className="api-name">{c.target}</code>
                  </div>
                  <span className="tiny muted">
                    {c.action} by {c.who ?? 'a system process'} · {when(c.at)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ---------------------------------------------------- the shape */}
        <section className="setup-block">
          <div className="setup-block-head"><h2>What is configured</h2></div>
          <dl className="setup-counts">
            <div><dt>Users</dt><dd>{data?.counts?.users ?? '—'}</dd></div>
            <div><dt>Roles</dt><dd>{data?.counts?.roles ?? '—'}</dd></div>
            <div><dt>Objects</dt><dd>{data?.counts?.objects ?? '—'}</dd></div>
            <div><dt>Fields</dt><dd>{data?.counts?.fields ?? '—'}</dd></div>
            <div><dt>Active rules</dt><dd>{data?.counts?.rules ?? '—'}</dd></div>
          </dl>
          <p className="tiny muted" style={{ margin: '0 16px 14px' }}>
            Counts are for the businesses you work in.
          </p>
        </section>
      </div>

      {/* ------------------------------------------------------ the map */}
      <section className="setup-block">
        <div className="setup-block-head">
          <h2>Everything you can configure</h2>
          <span className="tiny muted">Press <kbd>/</kbd> to search</span>
        </div>
        {/* Group name in its own column, screens beside it.
        
            The settings-index pattern Stripe, GitHub and Salesforce Setup all
            use, and it fixes a real inversion: the heading was 10.5px uppercase
            while the item titles under it were 13px semibold, so the thing
            being headed looked more important than the heading. Grouping is
            structural here rather than typographic, which means the header
            cannot be misread as another item in the list however it is
            styled. */}
        <div className="setup-map">
          {GROUPS
            .map((g) => ({ ...g, items: available.filter((s) => s.group === g.key) }))
            .filter((g) => g.items.length)
            .map((g) => (
              <section key={g.key} className="setup-map-group">
                <div className="setup-map-label">
                  <h3>{g.label}</h3>
                  <span className="tiny muted">
                    {g.items.length} screen{g.items.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className="setup-map-items">
                  {g.items.map((s) => (
                    <li key={s.key}>
                      <Link to={`/setup/${s.key}`}>
                        <Icon name={s.icon} size={16} />
                        <span>
                          <strong>{s.label}</strong>
                          <span className="tiny muted">{s.blurb}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      </section>
    </div>
  );
}
