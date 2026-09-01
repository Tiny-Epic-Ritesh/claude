/**
 * Explicit Save and Discard for configuration screens (P2-06).
 *
 * WHY ONLY CONFIGURATION
 *
 * Q-07: putting an explicit save on a Sales RM editing a lead slows the busiest
 * workflow in the product to protect against a mistake that is one undo away.
 * Configuration is the opposite — a wrong masking rule or a hidden tab affects
 * everybody at once, and nobody notices for a week. So this exists for the
 * screens where a mistake is silent and wide, and deliberately nowhere else.
 *
 * WHY A DRAFT RATHER THAN A CONFIRM ON EACH TOGGLE
 *
 * These screens are grids. Setting up a role's navigation means twelve toggles,
 * and a confirm on each one trains people to click through confirms. One
 * decision at the end, with the count of what is about to change, is both less
 * annoying and more informative than twelve.
 *
 * WHAT IT GUARDS
 *
 * A closed tab or a reload, through beforeunload. Navigating away inside the
 * app is guarded by the caller — this hook reports `dirty` and the Setup tab
 * strip refuses to switch while it is true, because a hook cannot intercept a
 * router it does not own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * @param apply  async (changes) => void — writes the whole set, once
 * @param keyOf  (change) => string — identity of a cell, so setting it twice
 *               replaces rather than queues
 */
export function useDraft(apply, keyOf = JSON.stringify) {
  const [changes, setChanges] = useState(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const dirty = changes.size > 0;

  /* The browser's own guard, for a closed tab or a reload. The message is
     ignored by every current browser — they show their own wording — but the
     handler still has to be registered to get the prompt at all. */
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = useCallback((change, value) => {
    setChanges((prev) => {
      const next = new Map(prev);
      const key = keyOf(change);
      /* Back to where it started is not a change. Toggling a switch on and off
         again should leave nothing to save, or the count lies. */
      if (value === undefined) next.delete(key);
      else next.set(key, { ...change, value });
      return next;
    });
  }, [keyOf]);

  const discard = useCallback(() => { setChanges(new Map()); setError(null); }, []);

  const save = useCallback(async () => {
    if (!dirty) return true;
    setSaving(true);
    setError(null);
    try {
      await apply([...changes.values()]);
      setChanges(new Map());
      return true;
    } catch (err) {
      /* The draft is kept on failure. Clearing it would lose the work and give
         no way to retry — and the half that did save is the caller's problem to
         report, not this hook's to hide. */
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [apply, changes, dirty]);

  /** What a cell should show: the pending value if any, else the stored one. */
  const valueOf = useCallback(
    (change, stored) => (changes.has(keyOf(change)) ? changes.get(keyOf(change)).value : stored),
    [changes, keyOf],
  );

  return useMemo(() => ({
    changes: [...changes.values()],
    count: changes.size,
    dirty, saving, error,
    set, discard, save, valueOf,
    clearError: () => setError(null),
  }), [changes, dirty, saving, error, set, discard, save, valueOf]);
}
