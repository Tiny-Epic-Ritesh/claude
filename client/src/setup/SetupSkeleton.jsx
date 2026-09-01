/**
 * What a Setup screen looks like while its data is on the way.
 *
 * Every screen showed the word "Loading…" and nothing else, for between one
 * and three seconds. That is long enough to read, and what it says is that
 * something is happening somewhere — not what is coming, not how much of it,
 * and not whether the screen you asked for is the one you are getting.
 *
 * A skeleton in the shape of the answer does three things instead: it says
 * which screen you are on before the data lands, it stops the layout jumping
 * when it does, and it makes the wait read as progress. The cost is that a
 * skeleton which does not match what arrives is worse than none, so these are
 * deliberately generic shapes — rows, cards — rather than a guess at each
 * screen's exact furniture.
 */

/** A block of list rows, which is what most Setup screens resolve into. */
export function SkeletonRows({ rows = 6 }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton skeleton-row" />
      ))}
    </div>
  );
}

/**
 * The default Setup fallback: a panel with a heading bar and rows inside it.
 *
 * `aria-busy` and the visually hidden line are what a screen reader gets —
 * shimmering rectangles mean nothing announced aloud, so the state has to be
 * said in words as well as drawn.
 */
export default function SetupSkeleton({ rows = 6 }) {
  return (
    <div className="setup-block" aria-busy="true">
      <span className="sr-only">Loading this screen</span>
      <div className="setup-block-head">
        <div className="skeleton" style={{ width: 160, height: 15 }} />
      </div>
      <SkeletonRows rows={rows} />
    </div>
  );
}
