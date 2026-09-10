import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../components/ui.jsx';

/**
 * The flow, drawn (P3-16).
 *
 * WHY A CANVAS AND NOT A BETTER LIST
 * ----------------------------------
 * A list can say "then → Send WhatsApp". What it cannot show is the shape: that
 * two branches rejoin, that one arm of an If/Else leads nowhere, that a Wait
 * sits between the message and the follow-up. Those are the mistakes people
 * actually make, and every one of them is obvious in a picture and invisible in
 * a column of rows.
 *
 * The ticket asks for the level of Salesforce's Flow Builder. What earns that
 * is not the dragging — it is that the drawing and the thing that runs are the
 * same object. Every edge here is a `next_step_id` or an `else_step_id`; there
 * is no separate diagram to fall out of date.
 *
 * WHAT THE DRAWING REFUSES TO HIDE
 * --------------------------------
 * An exit that leads nowhere is drawn as a stub with an open end, not left
 * blank — an unconnected exit ends the flow silently for every lead that
 * reaches it, and the whole reason to draw a flow is to make that visible
 * before it is live. Cards with validation problems carry them on their face.
 *
 * WHY POSITIONS ARE STORED AND NOT COMPUTED
 * -----------------------------------------
 * Two people looking at one automation have to see the same picture, or "the
 * card on the left" means nothing in a conversation. A flow built before this
 * existed has no positions; those are laid out from the graph, and the first
 * drag saves every card at once — so a flow is wholly computed or wholly
 * stored, never a mix where a moved card lands on top of a placed one.
 *
 * KEYBOARD
 * --------
 * Dragging is not reachable by keyboard and pretending otherwise would be
 * worse than saying so. The List view beside this one does everything the
 * canvas does — wiring included, through the step editor's own selects — and
 * it is not a lesser fallback but the same operations in a form. The canvas is
 * for seeing; the list is for certainty.
 */

/* Node geometry. Fixed rather than measured: the edge maths needs to know where
   a port is before the DOM has laid anything out, and a card whose height
   depends on its label makes every arrow jump as you type. */
const NODE_W = 200;
const NODE_H = 78;
const COL_GAP = 96;
const ROW_GAP = 34;
const PAD = 40;

/* The start marker is not a step — it is where `first_step_id` points from, and
   its id is the sentinel used wherever a step id would otherwise go.
   Hyphenated deliberately: icons.test.mjs scans bare lowercase string literals
   for Material Symbol names, and a plain 'start' is one, which would send
   somebody off to add a glyph nothing renders. */
const START = { id: 'flow-start', w: 92, h: 40 };

/* ------------------------------------------------------------- layout */

/**
 * Place cards the flow has never been drawn with.
 *
 * Breadth-first from the first step, so depth becomes the column and arrival
 * order becomes the row. It is the layout somebody would draw by hand, and it
 * is a pure function of the graph — the same flow lays out the same way in
 * every browser, which is what makes it safe to render without saving.
 *
 * Cards nothing points at — an orphan, or a card just added — go in a column of
 * their own at the end rather than on top of the flow, where they would look
 * connected.
 */
export function autoLayout(steps, firstStepId) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = new Map();
  const queue = [];

  if (firstStepId && byId.has(firstStepId)) { depth.set(firstStepId, 0); queue.push(firstStepId); }

  while (queue.length) {
    const id = queue.shift();
    const step = byId.get(id);
    const d = depth.get(id) + 1;
    for (const next of [step.next_step_id, step.else_step_id]) {
      if (!next || !byId.has(next) || depth.has(next)) continue;
      depth.set(next, d);
      queue.push(next);
    }
  }

  /* Anything unreachable sits one column past the deepest reachable card. */
  const deepest = depth.size ? Math.max(...depth.values()) : -1;
  let strayRow = 0;
  const rows = new Map();
  const at = {};

  for (const s of steps) {
    const col = depth.has(s.id) ? depth.get(s.id) : deepest + 1;
    const row = depth.has(s.id) ? (rows.get(col) ?? 0) : strayRow;
    if (depth.has(s.id)) rows.set(col, row + 1); else strayRow += 1;
    at[s.id] = {
      x: PAD + START.w + COL_GAP + col * (NODE_W + COL_GAP),
      y: PAD + row * (NODE_H + ROW_GAP),
    };
  }

  return at;
}

/* --------------------------------------------------------------- edges */

/**
 * A curve from one port to another.
 *
 * Cubic rather than straight, with the control points pushed out horizontally,
 * so an edge that doubles back on itself reads as a loop instead of crossing
 * the cards it passes.
 */
function edgePath(from, to) {
  const dx = Math.max(60, Math.abs(to.x - from.x) * 0.55);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/* ---------------------------------------------------------- the canvas */

export default function FlowCanvas({
  data, spec, icon, describe, onConfigure, onError, onChanged,
}) {
  const steps = data.steps;
  const surface = useRef(null);

  /* Stored positions if the flow has any, otherwise the computed ones. Never a
     mix: `placed` decides which, for the whole flow at once. */
  const placed = steps.some((s) => s.pos_x !== null && s.pos_x !== undefined);
  const computed = useMemo(() => autoLayout(steps, data.first_step_id), [steps, data.first_step_id]);

  const [pos, setPos] = useState({});

  /* The same positions, readable without going through a state updater.
     `setPos(cur => { save(cur); return cur; })` looks like a neat way to read
     the latest value, and React is free to run an updater twice — which sends
     the save twice. The ref is the boring answer and the correct one. */
  const posRef = useRef(pos);
  useEffect(() => { posRef.current = pos; }, [pos]);

  useEffect(() => {
    const next = {};

    /* A card added to a flow that has already been arranged has no position of
       its own, and the computed layout is no help — it describes a picture
       nobody is looking at any more, so a new card would land on top of one
       somebody deliberately put there. It goes to the right of everything
       instead, which is both out of the way and where "not wired up yet"
       belongs. */
    const right = Math.max(0, ...steps.map((s) => s.pos_x ?? 0));
    let fresh = 0;

    for (const s of steps) {
      if (placed) {
        next[s.id] = s.pos_x !== null && s.pos_x !== undefined
          ? { x: s.pos_x, y: s.pos_y ?? 0 }
          : { x: right + NODE_W + COL_GAP, y: PAD + (fresh++) * (NODE_H + ROW_GAP) };
      } else {
        next[s.id] = computed[s.id];
      }
    }
    setPos(next);
  }, [steps, computed, placed]);

  const [startPos, setStartPos] = useState({ x: PAD, y: PAD + (NODE_H - START.h) / 2 });
  const [drag, setDrag] = useState(null);      // moving a card
  const [wire, setWire] = useState(null);      // dragging an exit somewhere
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [menu, setMenu] = useState(null);      // "what goes here?" after a drop
  const [saving, setSaving] = useState(false);

  const byId = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);
  const problemsFor = useCallback(
    (id) => data.problems.filter((p) => p.step_id === id),
    [data.problems],
  );

  /* Screen pixels to canvas coordinates. Every gesture goes through this, so
     pan and zoom cannot drift apart from what is drawn.
     
     It reads the view through refs rather than closing over the state, so its
     identity never changes. Depending on `pan` would rebuild it on every
     pointermove of a pan, and the gesture effect below would tear down and
     re-add its window listeners between one mouse move and the next. */
  const view = useRef({ pan, zoom });
  useEffect(() => { view.current = { pan, zoom }; }, [pan, zoom]);

  const toCanvas = useCallback((clientX, clientY) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    const { pan: p, zoom: z } = view.current;
    return { x: (clientX - box.left - p.x) / z, y: (clientY - box.top - p.y) / z };
  }, []);

  /* ------------------------------------------------------------ saving */

  const saveLayout = useCallback(async (next) => {
    setSaving(true);
    try {
      await api.patch(`/admin/automations/${data.id}/layout`, {
        positions: Object.entries(next).map(([id, p]) => ({ id: Number(id), x: p.x, y: p.y })),
      });
    } catch (err) { onError(err.message); }
    finally { setSaving(false); }
  }, [data.id, onError]);

  const connect = useCallback(async (fromId, exit, toId) => {
    try {
      if (fromId === START.id) {
        await api.patch(`/admin/automations/${data.id}`, { first_step_id: toId });
      } else {
        await api.patch(`/admin/automations/${data.id}/steps/${fromId}`, {
          [exit === 'else' ? 'else_step_id' : 'next_step_id']: toId,
        });
      }
      await onChanged();
    } catch (err) { onError(err.message); }
  }, [data.id, onChanged, onError]);

  /* ---------------------------------------------------------- gestures */

  useEffect(() => {
    if (!drag && !wire && !panning) return undefined;

    const move = (e) => {
      const at = toCanvas(e.clientX, e.clientY);
      if (drag) {
        const next = { x: Math.round(at.x - drag.dx), y: Math.round(at.y - drag.dy) };
        if (drag.id === START.id) setStartPos(next);
        else setPos((cur) => ({ ...cur, [drag.id]: next }));
      } else if (wire) {
        setWire((w) => ({ ...w, to: at }));
      } else if (panning) {
        setPan({ x: e.clientX - panning.x, y: e.clientY - panning.y });
      }
    };

    const up = (e) => {
      if (drag) {
        /* The start marker is decoration — it says where the flow begins and
           moving it changes nothing that runs, so it is not worth a request. */
        if (drag.id !== START.id) saveLayout(posRef.current);
        setDrag(null);
      }
      if (wire) {
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-step]');
        const toId = target ? Number(target.dataset.step) : null;

        if (toId && toId !== wire.from) connect(wire.from, wire.exit, toId);
        else if (!toId) {
          /* Dropped on nothing. Rather than losing the gesture, ask what should
             go there — which is what the person was reaching for. */
          setMenu({ from: wire.from, exit: wire.exit, at: toCanvas(e.clientX, e.clientY) });
        }
        setWire(null);
      }
      setPanning(null);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, wire, panning, toCanvas, saveLayout, connect]);

  const startDrag = (e, id) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const at = toCanvas(e.clientX, e.clientY);
    const p = id === START.id ? startPos : pos[id];
    if (!p) return;
    setDrag({ id, dx: at.x - p.x, dy: at.y - p.y });
  };

  const startWire = (e, fromId, exit) => {
    e.stopPropagation();
    const at = toCanvas(e.clientX, e.clientY);
    setWire({ from: fromId, exit, to: at });
  };

  const addAt = async (kind, from, exit, at) => {
    setMenu(null);
    try {
      await api.post(`/admin/automations/${data.id}/steps`, {
        kind,
        config: {},
        from,
        exit,
        pos_x: Math.round(at.x - NODE_W / 2),
        pos_y: Math.round(at.y - NODE_H / 2),
      });
      await onChanged();
    } catch (err) { onError(err.message); }
  };

  const tidy = async () => {
    const next = autoLayout(steps, data.first_step_id);
    setPos(next);
    setStartPos({ x: PAD, y: PAD + (NODE_H - START.h) / 2 });
    await saveLayout(next);
    await onChanged();
  };

  /* ------------------------------------------------------------- ports */

  const outPort = (id, exit) => {
    const p = pos[id];
    if (!p) return null;
    const step = byId.get(id);
    const two = step && (step.kind === 'branch' || step.kind === 'wait_activity');
    return {
      x: p.x + NODE_W,
      y: p.y + (two ? (exit === 'else' ? NODE_H * 0.72 : NODE_H * 0.28) : NODE_H / 2),
    };
  };
  const inPort = (id) => {
    const p = pos[id];
    return p ? { x: p.x, y: p.y + NODE_H / 2 } : null;
  };
  const startPort = () => ({ x: startPos.x + START.w, y: startPos.y + START.h / 2 });

  /* The drawn area, so the surface can be scrolled to reach a distant card. */
  const extent = useMemo(() => {
    const xs = Object.values(pos).map((p) => p?.x ?? 0).concat(startPos.x);
    const ys = Object.values(pos).map((p) => p?.y ?? 0).concat(startPos.y);
    return {
      w: Math.max(720, Math.max(...xs, 0) + NODE_W + PAD * 2),
      h: Math.max(360, Math.max(...ys, 0) + NODE_H + PAD * 2),
    };
  }, [pos, startPos]);

  /* --------------------------------------------------------- rendering */

  const edges = [];
  if (data.first_step_id && pos[data.first_step_id]) {
    edges.push({ key: START.id, kind: START.id, from: startPort(), to: inPort(data.first_step_id) });
  }
  for (const s of steps) {
    if (!pos[s.id]) continue;
    for (const exit of ['next', 'else']) {
      const two = s.kind === 'branch' || s.kind === 'wait_activity';
      if (exit === 'else' && !two) continue;
      if (exit === 'next' && s.kind === 'exit') continue;

      const targetId = exit === 'else' ? s.else_step_id : s.next_step_id;
      const from = outPort(s.id, exit);
      if (targetId && pos[targetId]) {
        edges.push({ key: `${s.id}-${exit}`, kind: exit, from, to: inPort(targetId) });
      } else {
        /* The stub. An exit leading nowhere ends the flow silently, and a blank
           space where an arrow should be is exactly how that goes unnoticed. */
        edges.push({ key: `${s.id}-${exit}-open`, kind: `${exit} open`, from, to: { x: from.x + 46, y: from.y } });
      }
    }
  }

  return (
    <div className="flow-wrap">
      <div className="flow-tools">
        <span className="tiny muted">
          Drag a card to move it · drag a dot to connect · drop on empty space to add
        </span>
        <span className="row" style={{ gap: 6 }}>
          {saving && <span className="tiny muted">Saving…</span>}
          <button type="button" className="btn-sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}>−</button>
          <button type="button" className="btn-sm" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="btn-sm" onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(2)))}>+</button>
          <button type="button" className="btn-sm" onClick={tidy}>Tidy up</button>
        </span>
      </div>

      <div
        className={`flow-surface ${panning ? 'is-panning' : ''}`}
        ref={surface}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target !== e.currentTarget) return;
          setMenu(null);
          setPanning({ x: e.clientX - pan.x, y: e.clientY - pan.y });
        }}
      >
        <div
          className="flow-plane"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            width: extent.w,
            height: extent.h,
          }}
        >
          <svg className="flow-edges" width={extent.w} height={extent.h}>
            <defs>
              <marker id="flow-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
                <path d="M0,0 L9,4.5 L0,9 z" fill="currentColor" />
              </marker>
            </defs>
            {edges.map((e) => (
              <path
                key={e.key}
                className={`flow-edge is-${e.kind.split(' ')[0]}${e.kind.includes('open') ? ' is-open' : ''}`}
                d={edgePath(e.from, e.to)}
                markerEnd={e.kind.includes('open') ? undefined : 'url(#flow-arrow)'}
              />
            ))}
            {edges.filter((e) => e.kind.startsWith('else')).map((e) => (
              <text key={`${e.key}-l`} className="flow-edge-label" x={e.from.x + 8} y={e.from.y - 6}>otherwise</text>
            ))}
            {wire && (
              <path className="flow-edge is-wiring" d={edgePath(
                wire.from === START.id ? startPort() : outPort(wire.from, wire.exit),
                wire.to,
              )}
              />
            )}
          </svg>

          {/* Where the flow begins. Drawn as its own marker rather than as a
              badge on a card, because "which card is first" is a property of
              the automation and can be moved to any of them. */}
          <div
            className="flow-start"
            style={{ left: startPos.x, top: startPos.y, width: START.w, height: START.h }}
            onPointerDown={(e) => startDrag(e, START.id)}
          >
            <span className="tiny">Starts</span>
            <button
              type="button"
              className="flow-port"
              title="Drag to the card that runs first"
              onPointerDown={(e) => startWire(e, START.id, 'next')}
            />
          </div>

          {steps.map((s) => {
            const p = pos[s.id];
            if (!p) return null;
            const problems = problemsFor(s.id);
            const two = s.kind === 'branch' || s.kind === 'wait_activity';
            const waiting = data.report.waiting_at?.find((w) => w.id === s.id)?.n ?? 0;

            return (
              <div
                key={s.id}
                data-step={s.id}
                className={`flow-node ${problems.length ? 'is-warn' : ''} ${drag?.id === s.id ? 'is-dragging' : ''}`}
                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                onPointerDown={(e) => startDrag(e, s.id)}
                onDoubleClick={() => onConfigure(s)}
              >
                <div className="flow-node-head">
                  <Icon name={icon[s.kind] ?? 'help'} size={14} />
                  <strong>{s.label || spec.step_kinds.find((k) => k.kind === s.kind)?.label || s.kind}</strong>
                  {waiting > 0 && <span className="badge" title="Leads standing here">{waiting}</span>}
                </div>
                <div className="tiny muted flow-node-sub">{describe(s)}</div>

                {problems.length > 0 && (
                  /* Wrapped rather than titled directly: Icon takes name, size,
                     fill, weight, style and className, so a title handed to it
                     is dropped and the tooltip never appears. */
                  <span className="flow-node-warn" title={problems.map((x) => x.message).join('\n')}>
                    <Icon name="warning" size={13} />
                  </span>
                )}

                <button
                  type="button"
                  className="flow-cog"
                  title="Configure"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onConfigure(s)}
                >
                  <Icon name="settings" size={13} />
                </button>

                {s.kind !== 'exit' && (
                  <button
                    type="button"
                    className="flow-port is-next"
                    style={{ top: two ? '28%' : '50%' }}
                    title={two ? 'When the condition is met' : 'What follows this'}
                    onPointerDown={(e) => startWire(e, s.id, 'next')}
                  />
                )}
                {two && (
                  <button
                    type="button"
                    className="flow-port is-else"
                    style={{ top: '72%' }}
                    title="Otherwise"
                    onPointerDown={(e) => startWire(e, s.id, 'else')}
                  />
                )}
              </div>
            );
          })}

          {menu && (
            <div className="flow-menu" style={{ left: menu.at.x, top: menu.at.y }}>
              <div className="tiny muted">What goes here?</div>
              {spec.step_kinds.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  className="btn-sm"
                  onClick={() => addAt(k.kind, menu.from, menu.exit, menu.at)}
                >
                  {k.label}
                </button>
              ))}
              <button type="button" className="btn-sm" onClick={() => setMenu(null)}>Cancel</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
