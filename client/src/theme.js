/**
 * Theming — light/dark, and the sales-org accent.
 *
 * The whole design system re-tints from two CSS variables, so switching from
 * Bonanza to Bigul is a couple of `setProperty` calls rather than a second
 * stylesheet. The accent is also written to localStorage and re-applied by an
 * inline script in index.html, so the correct brand colour is on screen before
 * React has booted — otherwise a Bigul user sees a green flash on every reload.
 */

const THEME_KEY = 'bnz_theme';
const ACCENT_KEY = 'bnz_org_accent';

/* ------------------------------------------------------------- accent */

/** Derive a readable "ink" for text sitting on the accent-soft wash. */
const darken = (hex, amount = 0.28) => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  const mix = (c) => Math.round(c * (1 - amount));
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
};

const rgba = (hex, alpha) => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * Paint the active sales org's colour across the app.
 * `org` is a row from /api/orgs — { code, accent, accent_dark }.
 */
export function applyOrgAccent(org) {
  if (!org?.accent) return;

  const accent = org.accent;
  const accentDark = org.accent_dark || darken(accent);
  const root = document.documentElement.style;

  root.setProperty('--accent', accent);
  root.setProperty('--accent-dark', accentDark);
  root.setProperty('--accent-soft', rgba(accent, 0.14));
  root.setProperty('--accent-glow', rgba(accent, 0.34));

  document.documentElement.setAttribute('data-org', org.code || '');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', accent);

  try {
    localStorage.setItem(ACCENT_KEY, JSON.stringify({ accent, accentDark }));
  } catch { /* private mode — the colour still applies for this session */ }
}

/* -------------------------------------------------------------- theme */

/** 'light' | 'dark' | 'system' */
export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

export function setTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') {
    root.removeAttribute('data-theme');
    try { localStorage.removeItem(THEME_KEY); } catch { /* ignore */ }
  } else {
    root.setAttribute('data-theme', mode);
    try { localStorage.setItem(THEME_KEY, mode); } catch { /* ignore */ }
  }
  return mode;
}

/** What the user would actually see right now, resolving 'system'. */
export function resolvedTheme() {
  const set = getTheme();
  if (set !== 'system') return set;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const cycleTheme = () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');

/* ------------------------------------------------------------ avatars */

/**
 * A stable colour per person, so the same initials are always the same colour.
 * Hue only — saturation and lightness are fixed so no avatar can come out
 * unreadable or fight the accent for attention.
 */
export function avatarStyle(seed) {
  const text = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return { background: `linear-gradient(145deg, hsl(${hash} 52% 52%), hsl(${(hash + 26) % 360} 54% 40%))` };
}

export const initials = (name) => String(name || '?')
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((w) => w[0])
  .join('')
  .toUpperCase();
