/**
 * One product, as a card. Used in three places and written once.
 *
 * The partner portal (what can I sell?), the KYC portal (what am I opening?),
 * and the lead detail (what is this client interested in?) are three questions
 * about the same object. They were three different list renderings; now they are
 * one card with different facts on it.
 *
 * Box, not row — the user's own words. A list of eleven products reads as
 * eleven rows to scroll past. A card reads as a thing you can act on, and it
 * has room for the state, the numbers and the button that go with it.
 */

import { money } from '../api.js';

/**
 * Icons by product code, falling back to category.
 *
 * Presentation only, so it lives in the client. Everything a product *means* —
 * name, features, minimum, risk — comes from the database, where an
 * administrator can change it without a deploy.
 */
const ICON_BY_CODE = {
  EQD: 'trending_up', DP: 'account_balance_wallet', COM: 'oil_barrel', CUR: 'currency_exchange',
  MF: 'pie_chart', SMART: 'auto_awesome', PMS: 'account_balance', FI: 'receipt_long',
  GLOBAL: 'public', INS: 'health_and_safety', RES: 'lab_profile',
  'BG-TRADE': 'candlestick_chart', 'BG-ALGO': 'smart_toy', 'BG-CONNECT': 'api',
  'BG-BASKET': 'shopping_basket', 'BG-SIP': 'calendar_month', 'BG-OPT': 'insights',
  'BG-GLOBAL': 'public', 'BG-MF': 'pie_chart', 'BG-JARVIS': 'neurology',
};

const ICON_BY_CATEGORY = {
  Broking: 'candlestick_chart',
  Investment: 'savings',
  Advisory: 'insights',
  Protection: 'health_and_safety',
};

export const productIcon = (p) =>
  ICON_BY_CODE[p?.code] ?? ICON_BY_CATEGORY[p?.category] ?? 'inventory_2';

/** `pitch_points` is stored as a JSON array; tolerate it arriving as either. */
export function features(p) {
  const raw = p?.pitch_points;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * State → the class and label the whole app shares.
 *
 * Card state comes from the product-card state machine; the KYC portal has no
 * state at all. Both funnel through here so a "Warm" card looks identical
 * wherever it appears.
 */
export const STATE_META = {
  ACTIVE: { cls: 'is-active', pill: 'state-active', label: 'Active' },
  WARM: { cls: 'is-warm', pill: 'state-warm', label: 'Warm' },
  EXPLORING: { cls: 'is-exploring', pill: 'state-exploring', label: 'Exploring' },
  AT_RISK: { cls: 'is-risk', pill: 'state-risk', label: 'At risk' },
  COLD: { cls: 'is-risk', pill: 'state-risk', label: 'Cold' },
  LOST: { cls: 'is-lost', pill: 'state-lost', label: 'Lost' },
  INACTIVE: { cls: '', pill: '', label: 'Not engaged' },
};

export const stateMeta = (s) => STATE_META[s] ?? { cls: '', pill: '', label: s ?? '—' };

/**
 * @param product   the product_types row
 * @param state     product-card state, when this card is attached to a lead
 * @param facts     [{label, value}] shown in the footer strip
 * @param actions   rendered in the action row — usually one primary button
 * @param selected  renders the card as chosen (KYC portal selection)
 * @param onSelect  makes the whole card clickable
 * @param showFeatures  the feature list, for surfaces where the user is choosing
 */
export default function ProductCard({
  product, state, facts = [], actions, selected = false,
  onSelect, showFeatures = false, featureLimit = 3, children,
}) {
  const meta = stateMeta(state);
  const list = showFeatures ? features(product).slice(0, featureLimit) : [];

  const clickable = Boolean(onSelect);
  const Tag = clickable ? 'button' : 'article';

  return (
    <Tag
      {...(clickable ? { type: 'button', onClick: onSelect, 'aria-pressed': selected } : {})}
      className={`glass product-card ${meta.cls} ${selected ? 'is-selected' : ''} ${clickable ? 'is-clickable' : ''}`}
    >
      <div className="product-card-head">
        <span className="product-icon material-symbols-rounded" aria-hidden>{productIcon(product)}</span>
        <div className="product-title">
          <strong>{product.name}</strong>
          <span className="product-cat">{product.category}</span>
        </div>
        {state && meta.label !== '—' && (
          <span className={`state-pill ${meta.pill}`}>{meta.label}</span>
        )}
        {selected && (
          <span className="material-symbols-rounded product-tick" aria-hidden>check_circle</span>
        )}
      </div>

      {list.length > 0 && (
        <ul className="product-features">
          {list.map((f) => (
            <li key={f}>
              <span className="material-symbols-rounded" aria-hidden>check</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}

      {children}

      {facts.length > 0 && (
        <dl className="product-facts">
          {facts.map((f) => (
            <div className="product-fact" key={f.label}>
              <dt>{f.label}</dt>
              <dd style={f.small ? { fontSize: 12.5 } : undefined}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {actions && <div className="product-actions">{actions}</div>}
    </Tag>
  );
}

/** The two facts almost every surface wants, formatted consistently. */
export const minimumFact = (p) => ({
  label: 'Minimum',
  value: p.min_investment ? money(p.min_investment) : 'No minimum',
  small: !p.min_investment,
});

export const riskFact = (p) => ({
  label: 'Risk',
  value: p.risk_category ?? '—',
  small: true,
});
