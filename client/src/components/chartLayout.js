/**
 * Bar chart geometry, kept out of the component so it can be tested.
 *
 * P2-17: bar labels overlapped. The band was a fixed 56px while the label is
 * 10px proportional sans, so "Campaign — WhatsApp" wanted about a hundred
 * pixels, got fifty-six, and ran into both neighbours. "Referral" and "IPO
 * enquiry" sat on top of each other for the same reason.
 *
 * Plain JavaScript rather than JSX so the unit tests can import it. The rule is
 * the part worth guarding — a component that renders is not proof that two
 * words do not collide, and a browser is the only place that would otherwise
 * notice.
 */

/** Average glyph width of the 10px sans the bar labels are set in. */
export const LABEL_CHAR_PX = 5.4;

/** Never narrower than this, however short the labels. */
export const MIN_BAND = 56;

/**
 * Capped, or one pathological label stretches every band on the chart and the
 * reader scrolls past eight columns of whitespace to reach the ninth.
 */
export const MAX_BAND = 150;

export const labelWidth = (label) => String(label ?? '').length * LABEL_CHAR_PX;

/**
 * How much horizontal room each bar gets.
 *
 * Sized from the longest label, because the widest label is what decides
 * whether any two collide. The chart already scrolls horizontally, so a wide
 * band costs a scroll on a narrow window rather than a collision on every one.
 */
export function bandWidth(labels = []) {
  const widest = labels.length ? Math.max(...labels.map(labelWidth)) : 0;
  return Math.min(Math.max(MIN_BAND, widest + 14), MAX_BAND);
}

/** How many characters fit in a band before the text has to be trimmed. */
export const maxChars = (band) => Math.floor((band - 8) / LABEL_CHAR_PX);

/**
 * The label as it will be drawn.
 *
 * Anything past the cap is trimmed rather than allowed to collide. The whole
 * label stays in the tooltip, so nothing is actually lost.
 */
export function fitLabel(label, band) {
  const text = String(label ?? '');
  const limit = maxChars(band);
  return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 1))}…`;
}
