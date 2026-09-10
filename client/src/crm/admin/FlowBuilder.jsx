import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Loading, Icon, Modal, ErrorBanner, Spinner } from '../../components/ui.jsx';
import FlowCanvas from './FlowCanvas.jsx';
import NodePanel from './NodePanel.jsx';
import StepDrawer from './StepDrawer.jsx';
import { NODE_W, NODE_H, TRIGGER_ID, makeUndoStack, snap } from './flowkit.js';

/**
 * The builder, as a screen rather than a dialog (P3-16).
 *
 * WHY IT LEFT THE MODAL
 *
 * A flow of fifteen cards does not fit in 1,180 pixels, and the canvas was the
 * only part of this product that had to fight for room. n8n gives the canvas
 * the window; this gives it the page, inside the Setup shell so the navigation
 * and the permission model stay the ones every other configuration screen uses.
 *
 * WHAT THIS FILE OWNS
 *
 * Every write. The canvas draws and gestures; the mutations live here, in one
 * `ops` object, because each one has to record how to reverse itself and undo
 * spread across two files is undo that quietly stops covering half the
 * gestures.
 *
 * The keyboard is here too, for the same reason: half the shortcuts act on
 * things the canvas does not own — the drawer, the panel, the automation's own
 * status.
 */

/* ---------------------------------------------------------------- shell */

export default function FlowBuilder({ id, spec, onBack }) {
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const [selected, setSelected] = useState({ cards: [], sticky: null, trigger: false });
  const [drawer, setDrawer] = useState(null);       // { trigger: true } | { id }
  const [asking, setAsking] = useState(null);       // where a new card should land
  const [commanding, setCommanding] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [flash, setFlash] = useState(null);

  const canvas = useRef(null);
  const undoStack = useRef(makeUndoStack()).current;
  const [undoTick, setUndoTick] = useState(0);      // so the buttons re-render
  const clipboard = useRef(null);

  const load = useCallback(async () => {
    try { setData(await api.get(`/admin/automations/${id}`)); }
    catch (err) { setProblem(err.message); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  /* A one-line "that worked" for gestures with no visible result of their own —
     an undo, mostly, where the change is that something went back. */
  const say = useCallback((text) => {
    setFlash(text);
    setTimeout(() => setFlash((f) => (f === text ? null : f)), 2200);
  }, []);

  const record = useCallback((entry) => {
    undoStack.did(entry);
    setUndoTick((n) => n + 1);
  }, [undoStack]);

  /* ------------------------------------------------------------- writing */

  const saveLayout = useCallback(async (positions) => {
    setSaving(true);
    try {
      await api.patch(`/admin/automations/${id}/layout`, {
        positions: Object.entries(positions).map(([sid, p]) => ({ id: Number(sid), x: p.x, y: p.y })),
      });
    } catch (err) { setProblem(err.message); }
    finally { setSaving(false); }
  }, [id]);

  const ops = useMemo(() => {
    const patchCard = (cardId, body) => api.patch(`/admin/automations/${id}/steps/${cardId}`, body);

    const setExit = async (fromId, exit, toId) => {
      if (fromId === TRIGGER_ID) {
        await api.patch(`/admin/automations/${id}`, { first_step_id: toId });
      } else {
        await patchCard(fromId, { [exit === 'else' ? 'else_step_id' : 'next_step_id']: toId });
      }
    };

    const currentTarget = (fromId, exit) => {
      if (fromId === TRIGGER_ID) return data?.first_step_id ?? null;
      const card = data?.steps.find((s) => s.id === fromId);
      return (exit === 'else' ? card?.else_step_id : card?.next_step_id) ?? null;
    };

    return {
      /* The canvas found a flow that had never been arranged and laid it out.
         Saved, but not recorded: nobody did this, so there is nothing to undo,
         and an undo entry for it would put the flow back in the half-placed
         state it was just rescued from. */
      backfillLayout(positions) { return saveLayout(positions); },

      async moveCards(now, starts) {
        const before = { ...now, ...starts };
        await saveLayout(now);
        record({
          label: 'the move',
          undo: async () => { await saveLayout(before); await load(); },
          redo: async () => { await saveLayout(now); await load(); },
        });
      },

      async connect(fromId, exit, toId) {
        const was = currentTarget(fromId, exit);
        if (was === toId) return;
        try {
          await setExit(fromId, exit, toId);
          await load();
          record({
            label: toId ? 'the connection' : 'unhooking that',
            undo: async () => { await setExit(fromId, exit, was); await load(); },
            redo: async () => { await setExit(fromId, exit, toId); await load(); },
          });
        } catch (err) { setProblem(err.message); }
      },

      /**
       * A new card, wired to whatever asked for it.
       *
       * `between` is the `+` on an existing connection: the new card takes over
       * that exit and inherits what it used to point at, so dropping a Wait in
       * the middle of a flow does not sever it.
       */
      async addCard({ kind, actionType, from, exit, at, between }) {
        const inherited = between ? currentTarget(from, exit) : null;
        try {
          const made = await api.post(`/admin/automations/${id}/steps`, {
            kind,
            config: actionType ? { type: actionType, params: {} } : {},
            from: from ?? undefined,
            exit,
            pos_x: at ? snap(at.x) : undefined,
            pos_y: at ? snap(at.y) : undefined,
          });
          if (inherited) await patchCard(made.id, { next_step_id: inherited });
          await load();
          setSelected({ cards: [made.id], sticky: null, trigger: false });

          record({
            label: 'that card',
            /* A card made a moment ago has no run history, so deleting it
               really is the inverse. That is not true of a card that has been
               live, which is why `remove` below is not undoable. */
            undo: async () => {
              await api.del(`/admin/automations/${id}/steps/${made.id}`);
              if (from) await setExit(from, exit, inherited ?? null);
              await load();
            },
            redo: async () => {
              const again = await api.post(`/admin/automations/${id}/steps`, {
                kind, config: actionType ? { type: actionType, params: {} } : {},
                from: from ?? undefined, exit,
                pos_x: at ? snap(at.x) : undefined, pos_y: at ? snap(at.y) : undefined,
              });
              if (inherited) await patchCard(again.id, { next_step_id: inherited });
              await load();
            },
          });
          return made;
        } catch (err) { setProblem(err.message); return null; }
      },

      remove(card) {
        /* Asked rather than done, because it cannot be taken back: a step id
           appears in `automation_run_step` for every lead that has walked
           through it, so the card can only be re-created with a new id —
           leaving the run history pointing at something gone. */
        setConfirming(card);
      },

      async reallyRemove(card) {
        try {
          await api.del(`/admin/automations/${id}/steps/${card.id}`);
          /* Everything on the stack could name this card. Rather than let an
             undo fail halfway through, the history goes with it. */
          undoStack.clear();
          setUndoTick((n) => n + 1);
          setSelected({ cards: [], sticky: null, trigger: false });
          setConfirming(null);
          await load();
          say('Card deleted. That one cannot be undone.');
        } catch (err) { setProblem(err.message); setConfirming(null); }
      },

      async toggleOff(card) {
        const to = !card.disabled;
        try {
          await patchCard(card.id, { disabled: to });
          await load();
          record({
            label: to ? 'switching that off' : 'switching that on',
            undo: async () => { await patchCard(card.id, { disabled: !to }); await load(); },
            redo: async () => { await patchCard(card.id, { disabled: to }); await load(); },
          });
        } catch (err) { setProblem(err.message); }
      },

      async duplicate(card) {
        try {
          const copy = await api.post(`/admin/automations/${id}/steps/${card.id}/duplicate`);
          await load();
          setSelected({ cards: [copy.id], sticky: null, trigger: false });
          record({
            label: 'the copy',
            undo: async () => { await api.del(`/admin/automations/${id}/steps/${copy.id}`); await load(); },
            redo: async () => { await api.post(`/admin/automations/${id}/steps/${card.id}/duplicate`); await load(); },
          });
        } catch (err) { setProblem(err.message); }
      },

      async addSticky(at) {
        try {
          const made = await api.post(`/admin/automations/${id}/stickies`, {
            body: '', pos_x: snap(at.x), pos_y: snap(at.y),
          });
          await load();
          setSelected({ cards: [], sticky: made.id, trigger: false });
          record({
            label: 'the note',
            undo: async () => { await api.del(`/admin/automations/${id}/stickies/${made.id}`); await load(); },
            redo: async () => { await api.post(`/admin/automations/${id}/stickies`, { body: made.body, pos_x: made.pos_x, pos_y: made.pos_y }); await load(); },
          });
        } catch (err) { setProblem(err.message); }
      },

      async saveSticky(stickyId, patch, was, label) {
        const body = patch.x !== undefined ? { pos_x: patch.x, pos_y: patch.y } : patch;
        try {
          await api.patch(`/admin/automations/${id}/stickies/${stickyId}`, body);
          await load();
          record({
            label: (label ?? 'that').toLowerCase(),
            undo: async () => { await api.patch(`/admin/automations/${id}/stickies/${stickyId}`, was); await load(); },
            redo: async () => { await api.patch(`/admin/automations/${id}/stickies/${stickyId}`, body); await load(); },
          });
        } catch (err) { setProblem(err.message); }
      },

      async removeSticky(note) {
        try {
          await api.del(`/admin/automations/${id}/stickies/${note.id}`);
          await load();
          /* A note has no run history, so re-creating it really does put it
             back — only its id changes, and nothing refers to that. */
          record({
            label: 'deleting the note',
            undo: async () => {
              await api.post(`/admin/automations/${id}/stickies`, {
                body: note.body, pos_x: note.pos_x, pos_y: note.pos_y, w: note.w, h: note.h, tone: note.tone,
              });
              await load();
            },
            redo: async () => { await load(); },
          });
        } catch (err) { setProblem(err.message); }
      },
    };
  }, [id, data, load, saveLayout, record, undoStack, say]);

  /* ---------------------------------------------------------- the status */

  const setStatus = async (action) => {
    setBusy(true);
    try { await api.post(`/admin/automations/${id}/${action}`); await load(); }
    catch (err) { setProblem(err.message); }
    finally { setBusy(false); }
  };

  const tidy = useCallback(async () => {
    if (!data) return;
    const { autoLayout } = await import('./flowkit.js');
    const before = Object.fromEntries(data.steps.map((s) => [s.id, { x: s.pos_x ?? 0, y: s.pos_y ?? 0 }]));
    const next = autoLayout(data.steps, data.first_step_id);
    await saveLayout(next);
    await load();
    record({
      label: 'tidying up',
      undo: async () => { await saveLayout(before); await load(); },
      redo: async () => { await saveLayout(next); await load(); },
    });
  }, [data, saveLayout, load, record]);

  const doUndo = useCallback(async () => {
    const label = await undoStack.undo();
    setUndoTick((n) => n + 1);
    if (label) say(`Undid ${label}.`);
  }, [undoStack, say]);

  const doRedo = useCallback(async () => {
    const label = await undoStack.redo();
    setUndoTick((n) => n + 1);
    if (label) say(`Put ${label} back.`);
  }, [undoStack, say]);

  /* ------------------------------------------------------------ commands */

  const commands = useMemo(() => [
    { name: 'Add a card', keys: 'N', run: () => setAsking({ at: canvas.current?.middle() }) },
    { name: 'Add a note', keys: 'Shift S', run: () => ops.addSticky(canvas.current?.middle() ?? { x: 40, y: 40 }) },
    { name: 'Tidy up the layout', keys: null, run: tidy },
    { name: 'Zoom to fit', keys: '1', run: () => canvas.current?.fit() },
    { name: 'Reset the zoom', keys: '0', run: () => canvas.current?.resetZoom() },
    { name: 'Undo the last change', keys: 'Ctrl Z', run: doUndo },
    { name: 'Redo', keys: 'Ctrl Shift Z', run: doRedo },
    { name: 'Configure what starts this', keys: null, run: () => setDrawer({ trigger: true }) },
    data?.status === 'active'
      ? { name: 'Pause this automation', keys: null, run: () => setStatus('pause') }
      : { name: 'Activate this automation', keys: null, run: () => setStatus('activate') },
    { name: 'Back to the list', keys: null, run: onBack },
  ].filter(Boolean), [ops, tidy, doUndo, doRedo, data?.status, onBack]);

  /* ------------------------------------------------------------ keyboard */

  const selectedCards = useMemo(
    () => selected.cards.map((cid) => data?.steps.find((s) => s.id === cid)).filter(Boolean),
    [selected.cards, data],
  );

  useEffect(() => {
    if (!data) return undefined;

    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      const mod = e.ctrlKey || e.metaKey;
      const only = selectedCards[0];

      /* Always available, even with a panel open. */
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setCommanding((c) => !c); return; }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
        return;
      }
      if (e.key === 'Escape') {
        if (commanding) setCommanding(false);
        else if (asking) setAsking(null);
        else if (drawer) setDrawer(null);
        else setSelected({ cards: [], sticky: null, trigger: false });
        return;
      }

      /* The rest belong to the canvas, so a panel with focus in it wins. */
      if (asking || drawer || commanding || confirming) return;

      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected({ cards: data.steps.map((s) => s.id), sticky: null, trigger: false });
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') { clipboard.current = only ?? null; return; }
      if (mod && e.key.toLowerCase() === 'v') { if (clipboard.current) ops.duplicate(clipboard.current); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (only) ops.duplicate(only); return; }
      if (mod) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (selected.sticky) {
          const note = data.stickies?.find((n) => n.id === selected.sticky);
          if (note) ops.removeSticky(note);
        } else if (only) ops.remove(only);
        return;
      }
      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        if (selected.trigger) setDrawer({ trigger: true });
        else if (only) setDrawer({ id: only.id });
        return;
      }
      if (e.key.toLowerCase() === 'd') { if (only && !['branch', 'wait_activity'].includes(only.kind)) ops.toggleOff(only); return; }
      if (e.key.toLowerCase() === 'n' || e.key === 'Tab') {
        e.preventDefault();
        setAsking({ at: canvas.current?.middle() });
        return;
      }
      if (e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        ops.addSticky(canvas.current?.middle() ?? { x: 40, y: 40 });
        return;
      }
      if (e.key === '+' || e.key === '=') { canvas.current?.zoomBy(0.1); return; }
      if (e.key === '-' || e.key === '_') { canvas.current?.zoomBy(-0.1); return; }
      if (e.key === '0') { canvas.current?.resetZoom(); return; }
      if (e.key === '1') { canvas.current?.fit(); return; }

      /* Walking the flow with the arrow keys. Right and left follow the wiring,
         which is what "next" means here; up and down move between whatever else
         is drawn in the same column, which is what the eye does. */
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const at = canvas.current?.positions() ?? {};
        let goTo = null;

        if (!only) {
          goTo = data.first_step_id;
        } else if (e.key === 'ArrowRight') {
          goTo = only.next_step_id ?? only.else_step_id ?? null;
        } else if (e.key === 'ArrowLeft') {
          goTo = data.steps.find((s) => s.next_step_id === only.id || s.else_step_id === only.id)?.id ?? null;
          if (!goTo && data.first_step_id === only.id) { setSelected({ cards: [], sticky: null, trigger: true }); return; }
        } else {
          const mine = at[only.id];
          if (!mine) return;
          const column = data.steps
            .filter((s) => s.id !== only.id && at[s.id] && Math.abs(at[s.id].x - mine.x) < NODE_W)
            .sort((a, b) => at[a.id].y - at[b.id].y);
          goTo = e.key === 'ArrowDown'
            ? column.find((s) => at[s.id].y > mine.y)?.id
            : [...column].reverse().find((s) => at[s.id].y < mine.y)?.id;
        }

        if (goTo) setSelected({ cards: [goTo], sticky: null, trigger: false });
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, selected, selectedCards, ops, asking, drawer, commanding, confirming, doUndo, doRedo]);

  /* -------------------------------------------------------------- render */

  if (!data) return <Loading />;

  const general = data.problems.filter((p) => !p.step_id);

  return (
    <div className="flow-page">
      {problem && <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />}

      {/* ---------------------------------------------------------- head */}
      <div className="flow-head">
        <button type="button" className="btn-sm" onClick={onBack}>
          <Icon name="arrow_back" size={15} /> All automations
        </button>

        <div className="flow-head-name">
          <strong>{data.name}</strong>
          <span className="tiny muted">
            {data.sales_org} · {data.report.entered} entered · {data.report.waiting} inside now
            {data.report.failed ? ` · ${data.report.failed} failed` : ''}
          </span>
        </div>

        <span className={`state-pill ${
          data.status === 'active' ? 'state-active' : data.status === 'paused' ? 'state-risk' : 'state-exploring'
        }`}
        >
          {data.status}
        </span>

        {data.status !== 'active' ? (
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || data.problems.length > 0}
            title={data.problems.length ? 'Fix the problems first' : 'Start it'}
            onClick={() => setStatus('activate')}
          >
            {busy ? <Spinner /> : 'Activate'}
          </button>
        ) : (
          <button className="btn btn-sm" disabled={busy} onClick={() => setStatus('pause')}>Pause</button>
        )}
      </div>

      {data.problems.length > 0 && (
        <div className="notice notice-warn flow-notice">
          <Icon name="warning" />
          <div>
            <strong>
              {data.problems.length} thing{data.problems.length === 1 ? '' : 's'} to fix before this can run.
            </strong>
            {general.map((p) => <div key={p.message} className="tiny">{p.message}</div>)}
            {data.problems.some((p) => p.step_id) && (
              <div className="tiny">The rest are marked on the cards themselves.</div>
            )}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------- toolbar */}
      <div className="flow-tools">
        <span className="row" style={{ gap: 6 }}>
          <button type="button" className="btn-sm" onClick={() => setAsking({ at: canvas.current?.middle() })}>
            <Icon name="add" size={15} /> Add a card
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => ops.addSticky(canvas.current?.middle() ?? { x: 40, y: 40 })}
          >
            <Icon name="sticky_note_2" size={15} /> Note
          </button>
          <button type="button" className="btn-sm" onClick={tidy}>Tidy up</button>
        </span>

        <span className="row" style={{ gap: 6 }}>
          {flash && <span className="tiny muted">{flash}</span>}
          {saving && <span className="tiny muted">Saving…</span>}
          <button type="button" className="btn-sm" disabled={!undoStack.canUndo} onClick={doUndo} title="Ctrl+Z">
            Undo
          </button>
          <button type="button" className="btn-sm" disabled={!undoStack.canRedo} onClick={doRedo} title="Ctrl+Shift+Z">
            Redo
          </button>
          <button type="button" className="btn-sm" onClick={() => canvas.current?.zoomBy(-0.1)} aria-label="Zoom out">−</button>
          <button type="button" className="btn-sm" onClick={() => canvas.current?.fit()} title="Zoom to fit — 1">Fit</button>
          <button type="button" className="btn-sm" onClick={() => canvas.current?.zoomBy(0.1)} aria-label="Zoom in">+</button>
          <button type="button" className="btn-sm" onClick={() => setCommanding(true)} title="Ctrl+K">
            <Icon name="search" size={15} /> Commands
          </button>
        </span>
      </div>

      {/* --------------------------------------------------------- canvas */}
      <div className="flow-stage">
        <FlowCanvas
          ref={canvas}
          data={data}
          spec={spec}
          selected={selected}
          onSelect={setSelected}
          onOpen={(target) => setDrawer(target.trigger ? { trigger: true } : { id: target.id })}
          onAsk={setAsking}
          ops={ops}
          onError={setProblem}
        />

        {asking && (
          <NodePanel
            spec={spec}
            heading={asking.from ? 'What goes here?' : 'Add a card'}
            onClose={() => setAsking(null)}
            onPick={async (pick) => {
              const at = asking.at ?? canvas.current?.middle() ?? { x: 60, y: 60 };
              setAsking(null);
              const made = await ops.addCard({
                ...pick,
                from: asking.from,
                exit: asking.exit,
                between: asking.between,
                at: { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 },
              });
              /* Straight into its settings. A card that needs configuring and
                 does not ask is a card somebody activates unconfigured. */
              if (made) setDrawer({ id: made.id });
            }}
          />
        )}

        {drawer && (
          <StepDrawer
            target={drawer}
            data={data}
            spec={spec}
            onClose={() => setDrawer(null)}
            onSaved={async () => { setDrawer(null); await load(); }}
            onError={setProblem}
          />
        )}
      </div>

      <p className="tiny muted flow-legend">
        Drag a card to move it · drag a dot to connect · click a <strong>+</strong> to add ·
        hover a line to unhook it · double-click to configure · <kbd>Ctrl</kbd>+<kbd>K</kbd> for everything else
      </p>

      {/* ---------------------------------------------------- command bar */}
      {commanding && <CommandBar commands={commands} onClose={() => setCommanding(false)} />}

      {/* ------------------------------------------------------- confirms */}
      {confirming && (
        <Modal
          title="Delete this card?"
          subtitle={confirming.label || confirming.kind}
          onClose={() => setConfirming(null)}
        >
          <p>
            Anything pointing at it will be repointed at whatever followed it, so the flow does not
            break. But this one cannot be undone: every lead that has walked through this card has
            its id in the run history, so it can only be re-created as a different card.
          </p>
          {!['branch', 'wait_activity'].includes(confirming.kind) && (
            <p className="hint">
              If you are taking it out to see what the flow does without it, switch it off instead —
              the card stays, keeps its settings, and leads walk straight past it.
            </p>
          )}
          <div className="row-between" style={{ marginTop: 12 }}>
            {!['branch', 'wait_activity'].includes(confirming.kind) ? (
              <button
                className="btn btn-ghost"
                onClick={() => { const c = confirming; setConfirming(null); ops.toggleOff(c); }}
              >
                Switch it off instead
              </button>
            ) : <span />}
            <span className="row" style={{ gap: 6 }}>
              <button className="btn btn-ghost" onClick={() => setConfirming(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => ops.reallyRemove(confirming)}>Delete it</button>
            </span>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- command bar */

/**
 * Ctrl+K, and the shortcut sheet at the same time.
 *
 * n8n has both a command bar and a documented list of shortcuts. One surface
 * does both jobs here: every command shows the key that runs it, so the way to
 * learn the keyboard is to use the thing you reach for when you have forgotten
 * it.
 */
function CommandBar({ commands, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const found = commands.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { setActive(0); }, [query]);

  return (
    <div className="flow-cmd-backdrop" onPointerDown={onClose}>
      <div className="flow-cmd" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flow-cmd-search">
          <Icon name="search" size={16} />
          <input
            autoFocus
            value={query}
            placeholder="What do you want to do?"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(found.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); const c = found[active]; if (c) { onClose(); c.run(); } }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
          />
        </div>
        <div className="flow-cmd-list">
          {found.map((c, i) => (
            <button
              key={c.name}
              type="button"
              className={`flow-cmd-item ${i === active ? 'is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => { onClose(); c.run(); }}
            >
              <span>{c.name}</span>
              {c.keys && <span className="flow-cmd-keys">{c.keys.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</span>}
            </button>
          ))}
          {!found.length && <p className="tiny muted" style={{ padding: 12 }}>Nothing matches that.</p>}
        </div>
      </div>
    </div>
  );
}
