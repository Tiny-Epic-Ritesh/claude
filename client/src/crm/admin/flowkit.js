/**
 * The vocabulary the flow builder is drawn from (P3-16).
 *
 * Shared by the canvas, the builder shell and the list, because all three name
 * the same cards and a second copy of "what a Wait card is called" is a second
 * copy that drifts.
 *
 * WHERE THE SHAPES COME FROM
 *
 * n8n, deliberately and by measurement rather than memory: a node there is a
 * square tile holding only its icon, with the name *below* it and the operation
 * under that in grey. It reads better than a wide card at a glance, because at
 * a glance you are looking for the shape of the flow and not for the wording of
 * one card — and when you do want the wording it is full-width text under the
 * tile instead of something ellipsised inside a 200px box.
 *
 * The one thing not copied is n8n's icon-only tile. n8n's icon is a brand —
 * Slack, Gmail, Postgres — and carries the whole meaning. Ours is a category,
 * and "an envelope" does not distinguish the welcome email from the dormancy
 * one. So the tile carries the icon and the two lines under it carry the name
 * and what it is configured to do, which is the part somebody is actually
 * checking.
 */

/* ------------------------------------------------------------- geometry */

/* Fixed rather than measured: the edge maths has to know where a port is before
   the DOM has laid anything out, and a tile whose height depends on its label
   makes every arrow jump as you type. The name and subtitle hang below the tile
   and are excluded from the hit box, which is why NODE_H is the tile alone. */
export const NODE_W = 108;
export const NODE_H = 108;
export const LABEL_H = 46;          // the name and subtitle under the tile
export const COL_GAP = 112;
export const ROW_GAP = 62;
export const PAD = 48;

/* n8n places nodes on a grid and it is the reason a workflow somebody dragged
   into shape still looks deliberate. Same idea, our spacing. */
export const GRID = 20;
export const snap = (n) => Math.round(n / GRID) * GRID;

/* The trigger. Not a step — it is the automation's own row — but it is drawn as
   the first card because that is where somebody looks for "what starts this",
   and a trigger configured in a form above the picture is a trigger nobody
   checks. Its id is the sentinel used wherever a step id would otherwise go.

   Hyphenated deliberately: icons.test.mjs reads bare lowercase string literals
   as Material Symbol names, and a plain 'start' is one. */
export const TRIGGER_ID = 'flow-trigger';

/* ---------------------------------------------------------------- icons */

/* Every one of these is in client/icon-subset.txt. An icon outside the subset
   renders as its own ligature text — "alt_route" in the middle of the flow — so
   the names here are chosen from what is bundled rather than from what Material
   Symbols happens to offer. */
export const ICON = {
  action: 'bolt',
  branch: 'route',
  wait: 'schedule',
  wait_activity: 'hourglass_empty',
  exit: 'flag',
};

/* What a trigger family looks like. Keyed on the family the server sends. */
export const TRIGGER_ICON = {
  Lead: 'person',
  Activity: 'timeline',
  Task: 'task_alt',
  User: 'badge',
  Schedule: 'schedule',
  Composition: 'account_tree',
};

/* The four note colours, resolved to CSS custom properties by styles.css. A
   free-form colour would put a hex value nobody can read into an audit export,
   which is why the server stores one of these four and nothing else. */
export const TONES = ['sand', 'sky', 'moss', 'rose'];

/* ------------------------------------------------------------- describing */

export const parseConfig = (raw) => {
  try { return JSON.parse(raw || '{}') ?? {}; } catch { return {}; }
};

/** A one-line description of what a card is configured to do. */
export function describe(card, spec) {
  const config = parseConfig(card.config);

  switch (card.kind) {
    case 'action': {
      if (!config.type) return 'no action chosen';
      return spec?.actions?.find((a) => a.type === config.type)?.label ?? config.type;
    }
    case 'wait': return config.hours || config.minutes
      ? `waits ${config.hours ? `${config.hours}h` : ''}${config.minutes ? ` ${config.minutes}m` : ''}`.trim()
      : 'no delay set';
    case 'wait_activity': return `up to ${config.timeout_hours ?? 72}h for ${config.activity_type || 'any activity'}`;
    case 'branch': return config.conditions ? 'checks a condition' : 'no condition set';
    case 'exit': return config.reason ? `ends: ${config.reason}` : 'ends the flow';
    default: return '';
  }
}

/** What the two exits of a two-armed card are called, in this card's words. */
export function exitWords(kind) {
  if (kind === 'wait_activity') return { next: 'it happened', else: 'it never did' };
  return { next: 'yes', else: 'otherwise' };
}

export const hasTwoExits = (kind) => kind === 'branch' || kind === 'wait_activity';

/* ------------------------------------------------------------- the layout */

/**
 * Place cards the flow has never been drawn with.
 *
 * Breadth-first from the first step, so depth becomes the column and arrival
 * order becomes the row. It is the layout somebody would draw by hand, and it
 * is a pure function of the graph — the same flow lays out the same way in
 * every browser, which is what makes it safe to render without saving.
 *
 * Cards nothing points at — an orphan, or one just added — go in a column of
 * their own at the end rather than on top of the flow, where they would look
 * connected.
 */
export function autoLayout(cards, firstStepId) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const depth = new Map();
  const queue = [];

  if (firstStepId && byId.has(firstStepId)) { depth.set(firstStepId, 0); queue.push(firstStepId); }

  while (queue.length) {
    const id = queue.shift();
    const card = byId.get(id);
    const d = depth.get(id) + 1;
    for (const onward of [card.next_step_id, card.else_step_id]) {
      if (!onward || !byId.has(onward) || depth.has(onward)) continue;
      depth.set(onward, d);
      queue.push(onward);
    }
  }

  const deepest = depth.size ? Math.max(...depth.values()) : -1;
  let strayRow = 0;
  const rows = new Map();
  const at = {};

  for (const c of cards) {
    const col = depth.has(c.id) ? depth.get(c.id) : deepest + 1;
    const row = depth.has(c.id) ? (rows.get(col) ?? 0) : strayRow;
    if (depth.has(c.id)) rows.set(col, row + 1); else strayRow += 1;
    at[c.id] = {
      x: snap(PAD + NODE_W + COL_GAP + col * (NODE_W + COL_GAP)),
      y: snap(PAD + row * (NODE_H + LABEL_H + ROW_GAP)),
    };
  }

  return at;
}

/* ---------------------------------------------------------------- edges */

/**
 * A curve from one port to another.
 *
 * Cubic with the control points pushed out horizontally, the way n8n draws
 * them, so an edge that doubles back on itself reads as a loop instead of
 * crossing the cards it passes.
 */
export function edgePath(from, to) {
  const dx = Math.max(60, Math.abs(to.x - from.x) * 0.55);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/** Roughly where an edge's own controls should sit. Good enough for a hit box. */
export function edgeMiddle(from, to) {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

/* ------------------------------------------------------------------ undo */

/**
 * Undo, for a builder that saves as you go.
 *
 * n8n edits a workflow in memory and saves it whole on Ctrl+S, so its undo is
 * just a stack of past documents. This builder writes every gesture to the
 * server as it happens — which is the right trade for a screen people leave
 * open all day, and it means undo has to be the *inverse request* rather than
 * an older copy of the document.
 *
 * WHAT IS DELIBERATELY NOT UNDOABLE
 *
 * Deleting a card. A step id appears in `automation_run_step` for every lead
 * that has ever walked through it, so a card cannot be un-deleted — only
 * re-created, with a new id, leaving the run history pointing at something gone
 * while an identical-looking card sits on the canvas. That is worse than not
 * offering it. Deleting asks first instead, and offers to switch the card off,
 * which is reversible and usually what was meant.
 */
export function makeUndoStack(limit = 60) {
  let past = [];
  let future = [];

  return {
    /** @param entry {{ label: string, undo: Function, redo: Function }} */
    did(entry) {
      past = [...past.slice(-(limit - 1)), entry];
      future = [];
    },
    clear() { past = []; future = []; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get lastLabel() { return past[past.length - 1]?.label ?? null; },
    get nextLabel() { return future[future.length - 1]?.label ?? null; },
    async undo() {
      const entry = past[past.length - 1];
      if (!entry) return null;
      past = past.slice(0, -1);
      future = [...future, entry];
      await entry.undo();
      return entry.label;
    },
    async redo() {
      const entry = future[future.length - 1];
      if (!entry) return null;
      future = future.slice(0, -1);
      past = [...past, entry];
      await entry.redo();
      return entry.label;
    },
  };
}
