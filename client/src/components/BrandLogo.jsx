/**
 * The brand mark.
 *
 * Two businesses, two themes, four files. Which one shows is decided by the
 * active sales org and the viewer's theme, and both decisions are made in CSS
 * rather than JavaScript.
 *
 * WHY BOTH VARIANTS RENDER
 * ------------------------
 * The theme has three states: an explicit `data-theme` on the root, or nothing
 * at all, in which case `prefers-color-scheme` decides. Reading that in JS means
 * reading it after paint, which means a dark-mode user watches a black wordmark
 * flash before it swaps. Rendering both and letting a media query hide one
 * costs a few KB of markup and is correct on the first frame.
 *
 * WHY NOT ONE RECOLOURABLE SVG
 * ----------------------------
 * Both logos are multi-colour by design — Bonanza is green and blue, Bigul
 * carries a teal and an indigo accent. Forcing them to `currentColor` would
 * throw away the brand. These are the shipped files, unmodified.
 */

import bonanzaLight from '../assets/bonanza-logo.svg';
import bonanzaDark from '../assets/bonanza-logo-white.svg';
import bigulLight from '../assets/bigul-logo.svg';
import bigulDark from '../assets/bigul-logo-white.svg';

const BRANDS = {
  BONANZA: { light: bonanzaLight, dark: bonanzaDark, name: 'Bonanza Portfolio Ltd', ratio: 231 / 89 },
  BIGUL: { light: bigulLight, dark: bigulDark, name: 'Bigul', ratio: 134 / 45 },
};

/** Tolerates a code, a name, or nothing at all. */
export function brandFor(org) {
  const key = String(org ?? '').toUpperCase();
  if (key.includes('BIGUL')) return BRANDS.BIGUL;
  return BRANDS.BONANZA;
}

/**
 * @param org     sales-org code — 'BONANZA' | 'BIGUL'. Anything else is Bonanza.
 * @param height  rendered height in px; width follows the logo's own ratio.
 * @param label   accessible name. Defaults to the brand's full legal name.
 */
export default function BrandLogo({ org, height = 28, label, className = '' }) {
  const brand = brandFor(org);
  const alt = label ?? brand.name;

  return (
    <span
      className={`brand-logo ${className}`}
      style={{ height, width: Math.round(height * brand.ratio) }}
      role="img"
      aria-label={alt}
    >
      <img src={brand.light} alt="" className="on-light" aria-hidden />
      <img src={brand.dark} alt="" className="on-dark" aria-hidden />
    </span>
  );
}

/**
 * The square badge, for places a wordmark cannot fit — a collapsed sidebar, an
 * avatar slot, a favicon-sized corner.
 *
 * A monogram rather than a cropped logo: cropping a wordmark to its first
 * letter is how brand guidelines get broken, and neither company ships a square
 * mark this product can legitimately use.
 */
export function BrandBadge({ org, size = 30, className = '' }) {
  const brand = brandFor(org);
  const letter = brand === BRANDS.BIGUL ? 'B' : 'B';

  return (
    <span
      className={`brand-badge ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.47) }}
      role="img"
      aria-label={brand.name}
    >
      {letter}
    </span>
  );
}
