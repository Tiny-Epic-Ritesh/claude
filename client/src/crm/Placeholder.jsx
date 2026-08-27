/**
 * Scaffold for tabs whose module is not built yet.
 *
 * The App Launcher advertises the full navigation on purpose — it is the thing
 * that makes the product legible to management, and hiding half of it would
 * misrepresent the plan. But a tab that lands on "Not found" reads as broken
 * rather than unbuilt, so each one states what it will hold and what already
 * works behind it.
 *
 * This file should shrink to nothing as the modules land. If it stops
 * shrinking, that is worth noticing.
 */

import { Link } from 'react-router-dom';
import { Icon } from '../components/ui.jsx';

const MODULES = {
  pipeline: {
    icon: 'view_kanban',
    title: 'Pipeline',
    blurb: 'Kanban across the product-card states, drag to advance, with the 14-stage onboarding journey beneath it.',
    built: ['Card state machine and colour markers', 'Stage transitions with audit trail', 'Per-product funnel reporting'],
    ready: '/reports',
    readyLabel: 'Funnel is live in Reports',
  },
  clients: {
    icon: 'people',
    title: 'Clients',
    blurb: 'Converted clients by segment — Retail, HNI, Ultra-HNI — with AUM, dormancy bands and the onboarding funnel.',
    built: ['Active products and AUM per lead', 'Dormancy and ageing bands', 'Client-level activity history'],
    ready: '/leads',
    readyLabel: 'Records are live in Leads',
  },
  calendar: {
    icon: 'calendar_month',
    title: 'Calendar',
    blurb: 'Meetings, callbacks and SLA deadlines on one timeline, with click-to-call from the day view.',
    built: ['Tasks with due dates and priority', 'SLA response and resolution clocks'],
    ready: '/tasks',
    readyLabel: 'Due work is live in Tasks',
  },
  products: {
    icon: 'inventory_2',
    title: 'Products',
    blurb: 'Per-product desks — pitch points, objection handling, performance and the pipeline carrying each one.',
    built: ['Full catalogue per sales org', 'Pitch and objection content', 'Product-level funnel and conversion'],
    ready: '/admin',
    readyLabel: 'Catalogue is editable in Setup',
  },
  ccm: {
    icon: 'recent_actors',
    title: 'Common Client Master',
    blurb: 'Firm-wide directory to check before onboarding, so nobody re-approaches an existing client or duplicates an account.',
    built: ['Duplicate guard on mobile at create and import', 'Partner and RM attribution per lead'],
    ready: '/data',
    readyLabel: 'Duplicate checking runs on import',
  },
  team: {
    icon: 'groups',
    title: 'My Team',
    blurb: 'Team mapping as a list and an org tree, with clients, AUM and revenue per person.',
    built: ['Manager hierarchy on every user', 'Team-scoped reporting and leaderboard'],
    ready: '/reports',
    readyLabel: 'Team performance is live in Reports',
  },
  revenue: {
    icon: 'leaderboard',
    title: 'Revenue Board',
    blurb: 'Earnings, points, branch rank, product-wise AUM and the untapped products worth opening.',
    built: ['Revenue and AUM aggregation per product', 'Partner commission ledger'],
    ready: '/reports',
    readyLabel: 'Revenue figures are live in Reports',
  },
  kra: {
    icon: 'article',
    title: 'KRA Scorecard',
    blurb: 'Metric-level scoring across acquisition, broking, investments, advisory and retention — Direct, Associate and Earned.',
    built: ['Activity and conversion capture per RM', 'Cross-org attribution for staff working both books'],
    ready: '/reports',
    readyLabel: 'Underlying numbers are in Reports',
  },
  incentives: {
    icon: 'account_balance_wallet',
    title: 'Incentives',
    blurb: 'Payout statements, accruals and the points ledger, per period and per product.',
    built: ['Commission accrual and payout status', 'Period-based statements'],
    ready: '/partners',
    readyLabel: 'Partner commission is live',
  },
  campaigns: {
    icon: 'campaign',
    title: 'Campaigns',
    blurb: 'Campaign builder with audience, channel, template and send — plus open and click attribution back to the lead.',
    built: ['Campaign records with channel and list', 'Send through the WhatsApp adapter', 'Template library with approval'],
    ready: '/admin',
    readyLabel: 'Campaigns are manageable in Setup',
  },
  content: {
    icon: 'auto_stories',
    title: 'Marketing Hub',
    blurb: 'Compliance documents, SEBI circulars, brochures and creatives, with version and expiry tracking.',
    built: ['Content library with expiry and ownership', 'In-call pitch panel'],
    ready: '/admin',
    readyLabel: 'Content is manageable in Setup',
  },
  lists: {
    icon: 'format_list_bulleted',
    title: 'Lead Lists',
    blurb: 'Saved working lists, shareable to a role or a colleague, and pushable straight into the dialler.',
    built: ['List creation and membership', 'Role-based sharing', 'Push to autodialler'],
    ready: '/leads',
    readyLabel: 'Lists can be built from Leads',
  },
  dashboards: {
    icon: 'space_dashboard',
    title: 'Dashboards',
    blurb: 'Drag-and-drop dashboard builder with configurable components over any saved report.',
    built: ['Eight scoped report endpoints', 'Role-aware aggregation'],
    ready: '/reports',
    readyLabel: 'Reports are live',
  },
};

export default function Placeholder({ moduleKey }) {
  const m = MODULES[moduleKey] ?? {
    icon: 'construction',
    title: 'Module',
    blurb: 'This module is planned but not built yet.',
    built: [],
    ready: '/',
    readyLabel: 'Back to Home',
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="row" style={{ gap: 10 }}>
            <Icon name={m.icon} size={26} style={{ color: 'var(--accent-dark)' }} />
            {m.title}
          </h1>
          <p>{m.blurb}</p>
        </div>
        <span className="badge badge-amber">In build</span>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>What already works behind this</h2>
          <span className="tiny muted">The data and rules exist — this is the surface for them</span>
        </div>
        <div className="card-body">
          {m.built.length ? (
            <ul style={{ listStyle: 'none', display: 'grid', gap: 9 }}>
              {m.built.map((b) => (
                <li key={b} className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
                  <Icon name="check_circle" size={17} style={{ color: 'var(--ok)', marginTop: 1 }} />
                  <span className="small">{b}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">Nothing built for this module yet.</p>
          )}

          <div className="divider" />

          <Link className="btn-primary" to={m.ready}>
            <Icon name="arrow_forward" size={16} /> {m.readyLabel}
          </Link>
        </div>
      </section>
    </>
  );
}
