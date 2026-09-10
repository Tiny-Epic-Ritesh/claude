import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/ui.jsx';
import { ICON } from './flowkit.js';

/**
 * What goes here — n8n's nodes panel, in our vocabulary.
 *
 * WHY THIS REPLACED A ROW OF BUTTONS
 *
 * The old canvas answered "what goes here?" with five buttons, one per step
 * kind. Four of them were fine and the fifth was "Do something", which put a
 * blank action card on the canvas that you then opened to choose between
 * nineteen actions in a grouped select. So the real vocabulary — twenty-three
 * things — was one level down and unsearchable, and the canvas could not tell
 * you what it was capable of.
 *
 * n8n's answer is a searchable panel where the operation is chosen *before* the
 * node lands, so the node arrives already saying what it does. That is the part
 * worth copying, and it is the whole of this file: pick "Send WhatsApp" here
 * and a WhatsApp card appears, rather than an empty one you have to go and
 * fill in.
 *
 * The search is over labels and the words people would actually type, not over
 * the internal type names — somebody looking for "text message" should find
 * Send SMS.
 */

/* Words somebody might reach for that are not in an action's own label. Kept
   deliberately short: a synonym list that tries to cover everything ends up
   matching everything, and a search that always has results is a search nobody
   trusts. */
const ALIASES = {
  whatsapp: 'wa message chat text',
  sms: 'text message mobile',
  email: 'mail send',
  task: 'todo follow up reminder',
  notify: 'alert tell inform',
  nudge: 'remind chase alert',
  webhook: 'http post external endpoint integration',
  update_lead: 'set field change value',
  distribute: 'assign owner route allocate rm',
  add_to_list: 'segment audience membership',
  sub_automation: 'call another flow journey',
  star: 'flag mark attention',
};

export default function NodePanel({ spec, onPick, onClose, heading }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef(null);

  /* One flat list of everything that can be dropped on the canvas, grouped for
     reading but indexed flat so the arrow keys can walk it. */
  const items = useMemo(() => {
    const flow = spec.step_kinds
      .filter((k) => k.kind !== 'action')
      .map((k) => ({
        id: `kind:${k.kind}`,
        group: 'Flow',
        label: k.label,
        hint: k.kind === 'branch' ? 'Two ways out, decided per lead'
          : k.kind === 'wait' ? 'Hold the lead for a fixed time'
            : k.kind === 'wait_activity' ? 'Hold until something happens, or give up'
              : 'Stop here, on purpose',
        icon: ICON[k.kind] ?? 'help',
        terms: `${k.label} ${k.kind}`,
        pick: { kind: k.kind },
      }));

    const actions = spec.actions.map((a) => ({
      id: `action:${a.type}`,
      group: a.category ?? 'Other',
      label: a.label,
      hint: a.flow_only ? 'Only available inside a flow' : null,
      icon: ICON.action,
      terms: `${a.label} ${a.type.replace(/_/g, ' ')} ${ALIASES[a.type] ?? ''}`,
      pick: { kind: 'action', actionType: a.type },
    }));

    return [...flow, ...actions];
  }, [spec]);

  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.terms.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => { setActive(0); }, [query]);

  /* The active row scrolled into view, because arrowing past the fold and
     seeing nothing move is how somebody concludes the keys do not work. */
  useEffect(() => {
    box.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const groups = [];
  for (const item of found) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  const keys = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(found.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (found[active]) onPick(found[active].pick); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <aside className="flow-panel" onKeyDown={keys}>
      <div className="flow-panel-head">
        <strong>{heading ?? 'What goes here?'}</strong>
        <button type="button" className="flow-icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="flow-panel-search">
        <Icon name="search" size={15} />
        <input
          value={query}
          autoFocus
          placeholder="Search cards and actions"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search cards and actions"
        />
      </div>

      <div className="flow-panel-list" ref={box}>
        {!found.length && (
          <p className="tiny muted" style={{ padding: '12px 14px' }}>
            Nothing matches “{query}”. Every action a flow can perform is listed here — if what you
            want is missing it is not built yet, rather than hidden.
          </p>
        )}

        {groups.map((g) => (
          <div key={g.name} className="flow-panel-group">
            <div className="flow-panel-group-name">{g.name}</div>
            {g.items.map((item) => {
              const index = found.indexOf(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`flow-panel-item ${index === active ? 'is-active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onPick(item.pick)}
                >
                  <Icon name={item.icon} size={16} />
                  <span>
                    <strong>{item.label}</strong>
                    {item.hint && <span className="flow-panel-hint">{item.hint}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <p className="flow-panel-foot tiny muted">
        Picking an action puts a card down that already knows what it does. Configure it, or press
        Enter to take the highlighted one.
      </p>
    </aside>
  );
}
