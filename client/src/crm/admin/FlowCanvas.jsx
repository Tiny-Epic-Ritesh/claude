import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { Icon } from '../../components/ui.jsx';
import {
  NODE_W, NODE_H, LABEL_H, COL_GAP, PAD, TRIGGER_ID, ICON, TRIGGER_ICON, TONES,
  autoLayout, describe, edgePath, edgeMiddle, exitWords, hasTwoExits, snap,
} from './flowkit.js';

/**
 * The flow, drawn (P3-16), rebuilt against n8n.
 *
 * WHAT WAS TAKEN FROM n8n, AND WHY EACH ONE EARNS ITS PLACE
 *
 * · The node is a square tile holding its icon, with the name and what it does
 *   written *below* it. A wide card ellipsises the very text you were reading.
 *
 * · An exit that leads nowhere gets a stub and a `+`. The old canvas drew the
 *   stub, which reported the problem; n8n's `+` reports it and repairs it in
 *   the same gesture, which is the difference between a diagram and a builder.
 *
 * · Hovering a connection offers to delete it or to drop a card into the middle
 *   of it. There was previously no way at all to unwire two cards on the canvas
 *   — you had to open the card and use a select — which made the drawing a
 *   one-way surface.
 *
 * · The trigger is the first card. What starts a flow was configured in a form
 *   above the picture, which is a form nobody checks. Now it is on the canvas
 *   with everything else and it opens the same drawer.
 *
 * · Cards snap to a grid. It is the reason an n8n workflow somebody dragged
 *   into shape still looks deliberate a month later.
 *
 * WHAT WAS NOT TAKEN
 *
 * n8n's per-node execution panes, data pinning and expression language. There
 * is no per-card sample data in a CRM builder to show, and an expression
 * language in the path that sends WhatsApp to a client is a way to send
 * something nobody reviewed. The badge on a card says how many leads are
 * standing on it, which is the CRM's version of the same reassurance.
 *
 * KEYBOARD
 *
 * Handled by the builder shell above this, because half the shortcuts act on
 * things this component does not own. Dragging is still not reachable from a
 * keyboard; selecting, opening, deleting, connecting through the drawer's
 * selects and moving between cards with the arrow keys all are.
 */

const STICKY_MIN = { w: 140, h: 90 };

const FlowCanvas = forwardRef(function FlowCanvas({
  data, spec, selected, onSelect, onOpen, onAsk, ops, onError,
}, ref) {
  const cards = data.steps;
  const stickies = data.stickies ?? [];
  const surface = useRef(null);

  /* Arranged, or not. There is deliberately no third state.
   *
   * Mixing stored and computed positions is what made a flow disappear: an
   * automation built before the canvas existed has no positions at all, adding
   * one card gave that card a real one, and every other card was then treated
   * as "new" and stacked off the right-hand edge. So the moment any card lacks
   * a position the whole flow is laid out from the graph — which cannot
   * overlap — and saved, so the question is asked once and never again. */
  const arranged = cards.length > 0 && cards.every((c) => c.pos_x !== null && c.pos_x !== undefined);
  const computed = useMemo(() => autoLayout(cards, data.first_step_id), [cards, data.first_step_id]);

  const [pos, setPos] = useState({});
  const posRef = useRef(pos);
  useEffect(() => { posRef.current = pos; }, [pos]);

  /* Written at most once per automation. An effect that saves is an effect that
     can loop, and the reload it triggers would re-enter this one. */
  const backfilled = useRef(null);

  useEffect(() => {
    const next = {};
    for (const c of cards) {
      next[c.id] = arranged ? { x: c.pos_x, y: c.pos_y ?? 0 } : computed[c.id];
    }
    setPos(next);

    if (!arranged && cards.length && backfilled.current !== data.id) {
      backfilled.current = data.id;
      ops.backfillLayout(next);
    }
  }, [cards, computed, arranged, data.id, ops]);

  /* The trigger sits left of the first card. Its position is not stored: it is
     not a step, and a flow re-laid-out by somebody else should still show the
     trigger where the flow begins rather than where a colleague parked it. */
  const triggerPos = useMemo(() => {
    const first = data.first_step_id ? pos[data.first_step_id] : null;
    const leftmost = Math.min(...Object.values(pos).map((p) => p?.x ?? Infinity), Infinity);
    const x = Number.isFinite(leftmost) ? leftmost - NODE_W - COL_GAP : PAD;
    return { x: Math.max(PAD / 2, x), y: first?.y ?? PAD };
  }, [pos, data.first_step_id]);

  const [drag, setDrag] = useState(null);
  const [wire, setWire] = useState(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [hotEdge, setHotEdge] = useState(null);
  const [editingNote, setEditingNote] = useState(null);
  const [spacePan, setSpacePan] = useState(false);

  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const problemsFor = useCallback(
    (id) => data.problems.filter((p) => p.step_id === id),
    [data.problems],
  );

  /* Screen pixels to canvas coordinates. Read through a ref rather than closing
     over the state so its identity never changes — depending on `pan` would
     tear down and re-add the window listeners between one pointermove of a pan
     and the next. */
  const view = useRef({ pan, zoom });
  useEffect(() => { view.current = { pan, zoom }; }, [pan, zoom]);

  const toCanvas = useCallback((clientX, clientY) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    const { pan: p, zoom: z } = view.current;
    return { x: (clientX - box.left - p.x) / z, y: (clientY - box.top - p.y) / z };
  }, []);

  /* ------------------------------------------------------------- extent */

  const extent = useMemo(() => {
    const xs = Object.values(pos).map((p) => p?.x ?? 0).concat(triggerPos.x, ...stickies.map((s) => s.pos_x + s.w));
    const ys = Object.values(pos).map((p) => p?.y ?? 0).concat(triggerPos.y, ...stickies.map((s) => s.pos_y + s.h));
    return {
      w: Math.max(900, Math.max(...xs, 0) + NODE_W + PAD * 2),
      h: Math.max(420, Math.max(...ys, 0) + NODE_H + LABEL_H + PAD * 2),
    };
  }, [pos, triggerPos, stickies]);

  /* Zoom to fit, which n8n binds to "1" and which is the only control that
     rescues somebody who has dragged a card off into the distance. */
  const fit = useCallback(() => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return;
    const z = Math.min(1, Math.max(0.35, Math.min(box.width / extent.w, box.height / extent.h) * 0.94));
    setZoom(Number(z.toFixed(2)));
    setPan({ x: 16, y: 16 });
  }, [extent]);

  useImperativeHandle(ref, () => ({
    fit,
    zoomBy: (d) => setZoom((z) => Math.min(2, Math.max(0.35, +(z + d).toFixed(2)))),
    resetZoom: () => { setZoom(1); setPan({ x: 0, y: 0 }); },
    zoom,
    /* The shell drives the arrow keys, and "the card above this one" is a
       question only the drawn positions can answer. */
    positions: () => posRef.current,
    /* The shell needs somewhere sensible to drop a card or a note when the
       gesture came from a keystroke rather than from a pointer. */
    middle: () => {
      const box = surface.current?.getBoundingClientRect();
      if (!box) return { x: PAD, y: PAD };
      return toCanvas(box.left + box.width / 2, box.top + box.height / 2);
    },
  }), [fit, zoom, toCanvas]);

  /* ------------------------------------------------------------ gestures */

  useEffect(() => {
    if (!drag && !wire && !panning) return undefined;

    const move = (e) => {
      const at = toCanvas(e.clientX, e.clientY);
      if (drag) {
        if (drag.what === 'sticky') {
          setDrag((d) => ({ ...d, live: { x: snap(at.x - d.dx), y: snap(at.y - d.dy) } }));
        } else if (drag.what === 'resizing') {
          setDrag((d) => ({
            ...d,
            live: {
              w: Math.max(STICKY_MIN.w, snap(at.x - d.origin.x)),
              h: Math.max(STICKY_MIN.h, snap(at.y - d.origin.y)),
            },
          }));
        } else {
          /* Everything selected moves together, by the same delta, so a group
             keeps its shape. */
          const dx = snap(at.x - drag.dx) - drag.from.x;
          const dy = snap(at.y - drag.dy) - drag.from.y;
          setPos((cur) => {
            const next = { ...cur };
            for (const id of drag.ids) {
              const start = drag.starts[id];
              if (start) next[id] = { x: start.x + dx, y: start.y + dy };
            }
            return next;
          });
        }
      } else if (wire) {
        const moved = Math.abs(e.clientX - wire.originClient.x) + Math.abs(e.clientY - wire.originClient.y) > 5;
        setWire((w) => ({ ...w, to: at, moved: w.moved || moved }));
      } else if (panning) {
        setPan({ x: e.clientX - panning.x, y: e.clientY - panning.y });
      }
    };

    const up = (e) => {
      if (drag) {
        if (drag.what === 'sticky' && drag.live) {
          ops.saveSticky(drag.id, drag.live, { pos_x: drag.starts.pos_x, pos_y: drag.starts.pos_y }, 'Moved a note');
        } else if (drag.what === 'resizing' && drag.live) {
          ops.saveSticky(drag.id, drag.live, { w: drag.starts.w, h: drag.starts.h }, 'Resized a note');
        } else if (drag.what === 'cards') {
          ops.moveCards(posRef.current, drag.starts);
        }
        setDrag(null);
      }

      if (wire) {
        const landed = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-card]');
        const toId = landed ? Number(landed.dataset.card) : null;

        if (toId && toId !== wire.from) {
          ops.connect(wire.from, wire.exit, toId);
        } else if (!toId) {
          /* Dropped on nothing, or clicked rather than dragged. Both mean the
             same thing — "something goes here" — so both open the panel, at
             where the pointer landed or just right of the port. */
          const at = wire.moved ? toCanvas(e.clientX, e.clientY) : { x: wire.origin.x + 140, y: wire.origin.y - NODE_H / 2 };
          onAsk({ from: wire.from, exit: wire.exit, at });
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
  }, [drag, wire, panning, toCanvas, ops, onAsk]);

  /* Space to pan, the way every canvas since Photoshop has done it. Held rather
     than toggled, and released on blur so alt-tabbing away does not leave the
     canvas stuck in a mode. */
  useEffect(() => {
    const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const down = (e) => { if (e.code === 'Space' && !typing(e.target)) { e.preventDefault(); setSpacePan(true); } };
    const up = (e) => { if (e.code === 'Space') setSpacePan(false); };
    const blur = () => setSpacePan(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => Math.min(2, Math.max(0.35, +(z - Math.sign(e.deltaY) * 0.08).toFixed(2))));
  };

  const startCardDrag = (e, id) => {
    if (e.button !== 0 || spacePan) return;
    e.stopPropagation();
    const at = toCanvas(e.clientX, e.clientY);
    const p = pos[id];
    if (!p) return;

    const ids = selected.cards.includes(id) ? selected.cards : [id];
    if (!selected.cards.includes(id)) onSelect({ cards: [id], sticky: null, trigger: false });

    setDrag({
      what: 'cards',
      ids,
      from: { x: p.x, y: p.y },
      dx: at.x - p.x,
      dy: at.y - p.y,
      starts: Object.fromEntries(ids.map((i) => [i, { ...pos[i] }])),
    });
  };

  const startWire = (e, fromId, exit, origin) => {
    e.stopPropagation();
    e.preventDefault();
    setWire({
      from: fromId, exit, origin, to: origin, moved: false,
      originClient: { x: e.clientX, y: e.clientY },
    });
  };

  /* --------------------------------------------------------------- ports */

  const outPort = useCallback((id, exit) => {
    const p = pos[id];
    if (!p) return null;
    const two = hasTwoExits(byId.get(id)?.kind);
    return {
      x: p.x + NODE_W,
      y: p.y + (two ? (exit === 'else' ? NODE_H * 0.7 : NODE_H * 0.3) : NODE_H / 2),
    };
  }, [pos, byId]);

  const inPort = useCallback((id) => {
    const p = pos[id];
    return p ? { x: p.x, y: p.y + NODE_H / 2 } : null;
  }, [pos]);

  const triggerPort = () => ({ x: triggerPos.x + NODE_W, y: triggerPos.y + NODE_H / 2 });

  /* --------------------------------------------------------------- edges */

  const edges = [];
  if (data.first_step_id && pos[data.first_step_id]) {
    edges.push({
      key: TRIGGER_ID, from: TRIGGER_ID, exit: 'next', tone: 'trigger',
      a: triggerPort(), b: inPort(data.first_step_id),
    });
  } else {
    edges.push({
      key: `${TRIGGER_ID}-open`, from: TRIGGER_ID, exit: 'next', tone: 'trigger', open: true,
      a: triggerPort(), b: { x: triggerPos.x + NODE_W + 46, y: triggerPos.y + NODE_H / 2 },
    });
  }

  for (const c of cards) {
    if (!pos[c.id]) continue;
    const two = hasTwoExits(c.kind);
    for (const exit of ['next', 'else']) {
      if (exit === 'else' && !two) continue;
      if (exit === 'next' && c.kind === 'exit') continue;

      const targetId = exit === 'else' ? c.else_step_id : c.next_step_id;
      const a = outPort(c.id, exit);
      if (targetId && pos[targetId]) {
        edges.push({ key: `${c.id}-${exit}`, from: c.id, exit, tone: exit, a, b: inPort(targetId) });
      } else {
        /* The stub, and the `+` that fixes it. An exit leading nowhere ends the
           flow silently for every lead that reaches it; a blank space where an
           arrow should be is exactly how that goes unnoticed. */
        edges.push({
          key: `${c.id}-${exit}-open`, from: c.id, exit, tone: exit, open: true,
          a, b: { x: a.x + 46, y: a.y },
        });
      }
    }
  }

  /* -------------------------------------------------------------- render */

  const clearSelection = () => onSelect({ cards: [], sticky: null, trigger: false });

  return (
    <div
      className={`flow-surface ${panning ? 'is-panning' : ''} ${spacePan ? 'is-grabby' : ''}`}
      ref={surface}
      onWheel={onWheel}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const onBackdrop = e.target === e.currentTarget || e.target.classList.contains('flow-plane');
        if (!onBackdrop && !spacePan) return;
        if (onBackdrop) clearSelection();
        setEditingNote(null);
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
        {/* --------------------------------------------------- sticky notes */}
        {/* Under everything. A note is context for the flow, and a note that can
            cover a card is a note that hides the thing it is explaining. */}
        {stickies.map((n) => {
          const live = drag?.id === n.id ? drag.live : null;
          const box = {
            left: drag?.what === 'sticky' && live ? live.x : n.pos_x,
            top: drag?.what === 'sticky' && live ? live.y : n.pos_y,
            width: drag?.what === 'resizing' && live ? live.w : n.w,
            height: drag?.what === 'resizing' && live ? live.h : n.h,
          };
          const mine = selected.sticky === n.id;

          return (
            <div
              key={n.id}
              className={`flow-note is-${n.tone} ${mine ? 'is-selected' : ''}`}
              style={box}
              onPointerDown={(e) => {
                if (e.button !== 0 || spacePan || editingNote === n.id) return;
                e.stopPropagation();
                onSelect({ cards: [], sticky: n.id, trigger: false });
                const at = toCanvas(e.clientX, e.clientY);
                setDrag({
                  what: 'sticky', id: n.id, dx: at.x - n.pos_x, dy: at.y - n.pos_y,
                  starts: { pos_x: n.pos_x, pos_y: n.pos_y }, live: null,
                });
              }}
              onDoubleClick={(e) => { e.stopPropagation(); setEditingNote(n.id); }}
            >
              {editingNote === n.id ? (
                <textarea
                  className="flow-note-edit"
                  defaultValue={n.body}
                  autoFocus
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    setEditingNote(null);
                    if (e.target.value !== n.body) ops.saveSticky(n.id, { body: e.target.value }, { body: n.body }, 'Edited a note');
                  }}
                />
              ) : (
                <div className="flow-note-body">{n.body || 'Double-click to write something'}</div>
              )}

              {mine && (
                <div className="flow-note-tools" onPointerDown={(e) => e.stopPropagation()}>
                  {TONES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`flow-tone is-${t} ${n.tone === t ? 'is-on' : ''}`}
                      title={`Colour: ${t}`}
                      onClick={() => ops.saveSticky(n.id, { tone: t }, { tone: n.tone }, 'Recoloured a note')}
                    />
                  ))}
                  <button type="button" className="flow-icon-btn" title="Delete this note" onClick={() => ops.removeSticky(n)}>
                    <Icon name="delete" size={13} />
                  </button>
                </div>
              )}

              <button
                type="button"
                className="flow-note-grip"
                title="Resize"
                aria-label="Resize this note"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setDrag({
                    what: 'resizing', id: n.id, origin: { x: n.pos_x, y: n.pos_y },
                    starts: { w: n.w, h: n.h }, live: null,
                  });
                }}
              />
            </div>
          );
        })}

        {/* --------------------------------------------------------- edges */}
        <svg className="flow-edges" width={extent.w} height={extent.h}>
          <defs>
            <marker id="flow-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
              <path d="M0,0 L9,4.5 L0,9 z" fill="currentColor" />
            </marker>
          </defs>

          {edges.map((e) => (
            <path
              key={e.key}
              className={`flow-edge is-${e.tone}${e.open ? ' is-open' : ''}${hotEdge === e.key ? ' is-hot' : ''}`}
              d={edgePath(e.a, e.b)}
              markerEnd={e.open ? undefined : 'url(#flow-arrow)'}
            />
          ))}

          {/* A fat invisible copy of each real edge. An arrow is two pixels wide
              and nobody can hover two pixels; this is what the pointer actually
              hits. */}
          {edges.filter((e) => !e.open).map((e) => (
            <path
              key={`${e.key}-hit`}
              className="flow-edge-hit"
              d={edgePath(e.a, e.b)}
              onPointerEnter={() => setHotEdge(e.key)}
              onPointerLeave={() => setHotEdge((k) => (k === e.key ? null : k))}
            />
          ))}

          {edges.filter((e) => e.exit === 'else' || (hasTwoExits(byId.get(e.from)?.kind) && e.exit === 'next')).map((e) => (
            <text key={`${e.key}-w`} className="flow-edge-label" x={e.a.x + 9} y={e.a.y - 7}>
              {exitWords(byId.get(e.from)?.kind)[e.exit]}
            </text>
          ))}

          {wire && (
            <path className="flow-edge is-wiring" d={edgePath(wire.origin, wire.to)} />
          )}
        </svg>

        {/* What to do with a connection you are pointing at. HTML rather than
            SVG so the buttons look like every other button in the product. */}
        {edges.filter((e) => !e.open && hotEdge === e.key).map((e) => {
          const mid = edgeMiddle(e.a, e.b);
          return (
            <div
              key={`${e.key}-tools`}
              className="flow-edge-tools"
              style={{ left: mid.x, top: mid.y }}
              onPointerEnter={() => setHotEdge(e.key)}
              onPointerLeave={() => setHotEdge(null)}
            >
              <button
                type="button"
                title="Put a card in the middle of this"
                onClick={() => onAsk({ from: e.from, exit: e.exit, at: { x: mid.x - NODE_W / 2, y: mid.y - NODE_H / 2 }, between: true })}
              >
                <Icon name="add" size={13} />
              </button>
              <button
                type="button"
                title="Unhook this connection"
                onClick={() => { setHotEdge(null); ops.connect(e.from, e.exit, null); }}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          );
        })}

        {/* ---------------------------------------------------- the trigger */}
        <div
          className={`flow-node is-trigger ${selected.trigger ? 'is-selected' : ''} ${data.problems.some((p) => p.field === 'trigger') ? 'is-warn' : ''}`}
          style={{ left: triggerPos.x, top: triggerPos.y, width: NODE_W, height: NODE_H }}
          onPointerDown={(e) => {
            if (e.button !== 0 || spacePan) return;
            e.stopPropagation();
            onSelect({ cards: [], sticky: null, trigger: true });
          }}
          onDoubleClick={() => onOpen({ trigger: true })}
        >
          <div className="flow-tile">
            <Icon name={TRIGGER_ICON[spec.triggers.find((t) => t.key === data.trigger_type)?.family] ?? 'bolt'} size={26} />
          </div>
          <button
            type="button"
            className="flow-port is-out"
            style={{ top: '50%' }}
            title="Drag to the card that runs first"
            onPointerDown={(e) => startWire(e, TRIGGER_ID, 'next', triggerPort())}
          />
          <div className="flow-node-name">
            <strong>{spec.triggers.find((t) => t.key === data.trigger_type)?.label ?? data.trigger_type}</strong>
            <span className="flow-node-sub">what starts this</span>
          </div>
        </div>

        {/* ------------------------------------------------------- the cards */}
        {cards.map((c) => {
          const p = pos[c.id];
          if (!p) return null;
          const problems = problemsFor(c.id);
          const two = hasTwoExits(c.kind);
          const waiting = data.report.waiting_at?.find((w) => w.id === c.id)?.n ?? 0;
          const mine = selected.cards.includes(c.id);

          return (
            <div
              key={c.id}
              data-card={c.id}
              className={[
                'flow-node',
                problems.length ? 'is-warn' : '',
                c.disabled ? 'is-off' : '',
                mine ? 'is-selected' : '',
                drag?.ids?.includes(c.id) ? 'is-dragging' : '',
              ].join(' ')}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
              onPointerDown={(e) => {
                if (e.shiftKey) {
                  e.stopPropagation();
                  onSelect({
                    cards: mine ? selected.cards.filter((i) => i !== c.id) : [...selected.cards, c.id],
                    sticky: null,
                    trigger: false,
                  });
                  return;
                }
                startCardDrag(e, c.id);
              }}
              onDoubleClick={() => onOpen(c)}
            >
              {/* The hover toolbar, n8n's. Hidden until you point at the card,
                  because five icons on every card is a canvas of icons. */}
              <div className="flow-node-tools" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" title="Configure" onClick={() => onOpen(c)}>
                  <Icon name="settings" size={13} />
                </button>
                <button type="button" title="Make a copy" onClick={() => ops.duplicate(c)}>
                  <Icon name="content_copy" size={13} />
                </button>
                {!hasTwoExits(c.kind) && (
                  <button
                    type="button"
                    className={c.disabled ? 'is-on' : ''}
                    title={c.disabled ? 'Switch this card back on' : 'Switch this card off — leads walk past it'}
                    onClick={() => ops.toggleOff(c)}
                  >
                    <Icon name="visibility_off" size={13} />
                  </button>
                )}
                <button type="button" title="Delete this card" onClick={() => ops.remove(c)}>
                  <Icon name="delete" size={13} />
                </button>
              </div>

              <div className="flow-tile">
                <Icon name={ICON[c.kind] ?? 'help'} size={26} />
                {waiting > 0 && <span className="flow-waiting" title={`${waiting} leads are standing here`}>{waiting}</span>}
                {problems.length > 0 && (
                  /* Wrapped rather than titled directly: Icon takes name, size,
                     fill, weight, style and className, so a title handed to it
                     is dropped and the tooltip never appears. */
                  <span className="flow-node-warn" title={problems.map((x) => x.message).join('\n')}>
                    <Icon name="warning" size={13} />
                  </span>
                )}
              </div>

              <span className="flow-port is-in" aria-hidden="true" />

              {c.kind !== 'exit' && (
                <button
                  type="button"
                  className="flow-port is-out"
                  style={{ top: two ? '30%' : '50%' }}
                  title={two ? exitWords(c.kind).next : 'What follows this'}
                  onPointerDown={(e) => startWire(e, c.id, 'next', outPort(c.id, 'next'))}
                />
              )}
              {two && (
                <button
                  type="button"
                  className="flow-port is-out is-else"
                  style={{ top: '70%' }}
                  title={exitWords(c.kind).else}
                  onPointerDown={(e) => startWire(e, c.id, 'else', outPort(c.id, 'else'))}
                />
              )}

              <div className="flow-node-name">
                <strong>{c.label || spec.step_kinds.find((k) => k.kind === c.kind)?.label || c.kind}</strong>
                <span className="flow-node-sub">{c.disabled ? 'switched off' : describe(c, spec)}</span>
              </div>
            </div>
          );
        })}

        {/* The `+` at the end of every exit that leads nowhere. Clicking asks
            what goes there; dragging from it draws a wire, same as the dot. */}
        {edges.filter((e) => e.open).map((e) => (
          <button
            key={`${e.key}-plus`}
            type="button"
            className={`flow-plus is-${e.tone}`}
            style={{ left: e.b.x, top: e.b.y }}
            title="Nothing follows this yet — click to add a card"
            onPointerDown={(ev) => startWire(ev, e.from, e.exit, e.a)}
          >
            <Icon name="add" size={14} />
          </button>
        ))}
      </div>
    </div>
  );
});

export default FlowCanvas;
