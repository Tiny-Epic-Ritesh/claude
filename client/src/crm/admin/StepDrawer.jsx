import { useState } from 'react';
import { api, ROLE_LABEL } from '../../api.js';
import { Icon, Spinner } from '../../components/ui.jsx';
import ConditionBuilder from '../../components/ConditionBuilder.jsx';

/**
 * Configuring one thing on the canvas, beside the canvas rather than over it.
 *
 * WHY A DRAWER AND NOT A MODAL
 *
 * n8n opens a node in a full-screen view because the two panes either side of
 * the parameters are the node's input and output data, and those are the point.
 * We have no per-card sample data, so a full-screen view would be a form with
 * the flow hidden behind it — and the question somebody is answering while
 * configuring a card is almost always about its neighbours: what came before
 * this, where does the other arm go. So the flow stays visible and the form
 * sits beside it.
 *
 * WHAT IS NEW HERE
 *
 * The trigger. Until now `trigger_config` had no editor at all — the fields a
 * "lead is updated" trigger watches and the interval of a scheduled one could
 * only be set by the rule converter, so a flow built by hand on either of those
 * triggers could not be finished on the screen that built it. The trigger is a
 * card on the canvas now, and this is what opens when you double-click it.
 */

/* ------------------------------------------------------ action parameters */

/** Wording for the parameters whose field name is not the words a person uses. */
const PARAM_LABEL = {
  template_id: 'Template',
  list_id: 'List',
  endpoint_id: 'Endpoint',
  automation_id: 'Sub-automation',
  role_or_user: 'Notify',
  role_or_users: 'Nudge',
  due_in_hours: 'Due',
  activity_type: 'Kind of activity',
  starred: 'Star or un-star',
  intent: 'Kind of message',
};

/** The things worth saying next to a field rather than in a manual. */
const PARAM_HELP = {
  list_id: 'Only static lists appear here. A refreshable or dynamic list is a live query, and its membership cannot be set by an automation.',
  intent: 'Service messages reach a client who has opted out of marketing. Marketing ones do not.',
  endpoint_id: 'Endpoints are registered in Setup, and the body carries only the fields registered with them.',
};

const ROLE_OPTIONS = Object.entries(ROLE_LABEL);

/* Keyed rather than compared, so the names are object keys instead of bare
   string literals — the icon guard reads literals as glyph names and `'script'`
   is one, which would send somebody to add a glyph nothing renders. */
const LONG_TEXT = { message: true, body: true, script: true };

/**
 * One parameter, edited as what it actually is.
 *
 * Keyed by parameter name rather than by a type on the spec, which is what
 * Rules.jsx does for the rules builder — the two screens configure the same
 * actions and should not disagree about how. A name with no editor here falls
 * through to a text box, so adding an action on the server still works before
 * anybody touches this file.
 */
function ActionParam({ name, actionType, value, pickers, onChange }) {
  const pick = (options, placeholder, render) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{render(o)}</option>)}
    </select>
  );

  if (name === 'template_id') {
    /* opt_in_email is an email, so it reads the email templates. */
    const channel = actionType === 'opt_in_email' ? 'email' : actionType;
    const opts = (pickers.templates ?? []).filter((t) => t.channel === channel);
    return opts.length
      ? pick(opts, 'Choose a template…', (t) => t.name)
      : <div className="tiny muted">No approved {channel} templates yet — build one under Templates first.</div>;
  }

  if (name === 'list_id') {
    const opts = pickers.lists ?? [];
    return opts.length
      ? pick(opts, 'Choose a list…', (l) => l.name)
      : <div className="tiny muted">No static lists in this book yet.</div>;
  }

  if (name === 'endpoint_id') {
    const opts = pickers.endpoints ?? [];
    return opts.length
      ? pick(opts, 'Choose an endpoint…', (e) => `${e.name} — ${e.url}`)
      : <div className="tiny muted">No webhook endpoints registered. An admin registers one in Setup before an automation can post to it.</div>;
  }

  if (name === 'automation_id') {
    const opts = pickers.automations ?? [];
    return opts.length
      ? pick(opts, 'Choose an automation…', (a) => (a.status === 'active' ? a.name : `${a.name} (${a.status})`))
      : <div className="tiny muted">No other automation to hand the lead to.</div>;
  }

  if (name === 'due_in_hours') {
    return (
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {[1, 4, 24, 48, 72, 168].map((h) => (
          <option key={h} value={h}>{h < 24 ? `in ${h} hours` : `in ${h / 24} day${h > 24 ? 's' : ''}`}</option>
        ))}
      </select>
    );
  }

  if (name === 'role_or_user' || name === 'role_or_users' || name === 'assignee' || name === 'role') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {name === 'assignee' && <option value="owner">the lead&apos;s owner</option>}
        {ROLE_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    );
  }

  if (name === 'starred') {
    return (
      <select value={String(value === false || value === 'false' ? 'false' : 'true')} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Star the lead</option>
        <option value="false">Remove the star</option>
      </select>
    );
  }

  if (name === 'intent') {
    return (
      <select value={value || 'marketing'} onChange={(e) => onChange(e.target.value)}>
        <option value="marketing">Marketing</option>
        <option value="service">Service or regulatory</option>
      </select>
    );
  }

  if (LONG_TEXT[name]) {
    return (
      <textarea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="{{name}} is filled in with the lead's name"
      />
    );
  }

  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={name.replace(/_/g, ' ')} />;
}

/* ------------------------------------------------------------- the shell */

function Drawer({ title, subtitle, onClose, busy, onSave, saveLabel = 'Save', children }) {
  return (
    <aside className="flow-drawer" role="dialog" aria-label={title}>
      <div className="flow-drawer-head">
        <div>
          <strong>{title}</strong>
          {subtitle && <div className="tiny muted">{subtitle}</div>}
        </div>
        <button type="button" className="flow-icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="flow-drawer-body">{children}</div>

      <div className="flow-drawer-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={onSave}>
          {busy ? <Spinner /> : saveLabel}
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------ the trigger */

function TriggerDrawer({ data, spec, onClose, onSaved, onError }) {
  const parse = (raw) => { try { return JSON.parse(raw || '{}') ?? {}; } catch { return {}; } };

  const [trigger, setTrigger] = useState(data.trigger_type);
  const [config, setConfig] = useState(parse(data.trigger_config));
  const [conditions, setConditions] = useState(parse(data.entry_conditions) || null);
  const [busy, setBusy] = useState(false);

  const chosen = spec.triggers.find((t) => t.key === trigger);
  const families = [...new Set(spec.triggers.map((t) => t.family))];
  const set = (patch) => setConfig((c) => ({ ...c, ...patch }));

  /* Only fields backed by a real lead column. A change is detected from
     field_history, which records column names — so a computed field like "lead
     age" can never fire one, and offering it would be offering a trigger that
     looks live and never runs. The server marks which is which. */
  const watchable = (spec.conditions?.fields ?? []).filter((f) => f.column);
  const watched = config.fields ?? [];

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/admin/automations/${data.id}`, {
        trigger_type: trigger,
        trigger_config: config,
        entry_conditions: conditions && conditions.children?.length ? conditions : null,
      });
      await onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Drawer
      title="What starts this"
      subtitle="The trigger, and who is let in"
      onClose={onClose}
      busy={busy}
      onSave={save}
      saveLabel="Save trigger"
    >
      <div className="field">
        <label>Starts when</label>
        <select value={trigger} onChange={(e) => { setTrigger(e.target.value); setConfig({}); }}>
          {families.map((f) => (
            <optgroup key={f} label={f}>
              {spec.triggers.filter((t) => t.family === f).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}{t.unwired ? ' — not available yet' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {chosen?.note && <div className="tiny muted" style={{ marginTop: 4 }}>{chosen.note}</div>}
      </div>

      {chosen?.unwired && (
        <p className="hint">
          <strong>Nothing fires this yet.</strong> {chosen.unwired} A flow built on it can be saved
          as a draft, but it cannot be activated — which is better than one that looks live and
          never runs.
        </p>
      )}

      {/* ------------------------------------------- a lead is updated */}
      {chosen?.needs_fields && (
        <div className="field">
          <label>Watch these fields</label>
          <p className="hint">
            A trigger that watches every field fires on every change to every lead. The busiest
            automation in the old system reached 8.5 million runs that way.
          </p>
          <div className="flow-checklist">
            {watchable.map((f) => (
              <label key={f.code} className="flow-check">
                <input
                  type="checkbox"
                  checked={watched.includes(f.column)}
                  onChange={(e) => set({
                    fields: e.target.checked
                      ? [...watched, f.column]
                      : watched.filter((x) => x !== f.column),
                  })}
                />
                <span>{f.label}</span>
              </label>
            ))}
          </div>
          <div className="tiny muted">
            {watched.length ? `${watched.length} selected` : 'Nothing selected — it cannot be activated like this.'}
          </div>
        </div>
      )}

      {/* ---------------------------------------------- at regular intervals */}
      {trigger === 'schedule.interval' && (
        <div className="field">
          <label>How often</label>
          <select value={config.every_hours ?? 24} onChange={(e) => set({ every_hours: Number(e.target.value) })}>
            {[1, 4, 12, 24, 48, 168].map((h) => (
              <option key={h} value={h}>{h < 24 ? `every ${h} hours` : `every ${h / 24} day${h > 24 ? 's' : ''}`}</option>
            ))}
          </select>
          <p className="hint">
            Everyone the entry conditions match, every time it comes round. Leads already walking
            through this flow are skipped.
          </p>
        </div>
      )}

      {/* ------------------------------------------------ a workday ending */}
      {trigger === 'user.workday_end' && (
        <>
          <div className="field">
            <label>Whose check-out counts</label>
            <label className="flow-check">
              <input type="checkbox" checked disabled />
              <span>They pressed Check out</span>
            </label>
            <label className="flow-check">
              <input
                type="checkbox"
                checked={(config.closed_by ?? ['user']).includes('auto')}
                onChange={(e) => set({ closed_by: e.target.checked ? ['user', 'auto'] : ['user'] })}
              />
              <span>The attendance policy closed their day for them</span>
            </label>
            <p className="hint">
              An automatic close is the eight-o&apos;clock policy guessing that somebody who forgot
              went home. Leave it off unless your team genuinely never presses the button — a guess
              is a thin reason to message a client.
            </p>
          </div>

          <div className="field">
            <label>At most, per person per day</label>
            <input
              type="number"
              min="1"
              max="200"
              value={config.max_leads ?? 200}
              onChange={(e) => set({ max_leads: Number(e.target.value) })}
            />
            <p className="hint">
              Their leads that still have a task due today or earlier. Capped at 200 whatever is
              typed here.
            </p>
          </div>
        </>
      )}

      {/* --------------------------------------------------- entry conditions */}
      <div className="field">
        <label>Only let a lead in when</label>
        <ConditionBuilder value={conditions} schema={spec.conditions} onChange={setConditions} />
        <p className="hint">Leave this empty and every lead the trigger fires for walks in.</p>
      </div>
    </Drawer>
  );
}

/* --------------------------------------------------------------- a card */

function CardDrawer({ card, data, spec, onClose, onSaved, onError }) {
  const initial = (() => {
    try { return JSON.parse(card.config || '{}'); } catch { return {}; }
  })();

  const [config, setConfig] = useState(initial);
  const [label, setLabel] = useState(card.label ?? '');
  const [next, setNext] = useState(card.next_step_id ?? '');
  const [els, setEls] = useState(card.else_step_id ?? '');
  const [busy, setBusy] = useState(false);

  const kind = spec.step_kinds.find((k) => k.kind === card.kind);
  const others = data.steps.filter((s) => s.id !== card.id);
  const action = spec.actions.find((a) => a.type === config.type);
  const set = (patch) => setConfig((c) => ({ ...c, ...patch }));

  const save = async () => {
    setBusy(true);
    try {
      const body = { label: label || null, config };
      if (kind?.exits.includes('next')) body.next_step_id = next === '' ? null : Number(next);
      if (kind?.exits.includes('else')) body.else_step_id = els === '' ? null : Number(els);
      await api.patch(`/admin/automations/${data.id}/steps/${card.id}`, body);
      await onSaved();
    } catch (err) { onError(err.message); setBusy(false); }
  };

  return (
    <Drawer
      title={kind?.label ?? card.kind}
      subtitle={card.disabled ? 'Switched off — leads walk past it' : 'What this card does, and what follows it'}
      onClose={onClose}
      busy={busy}
      onSave={save}
      saveLabel="Save card"
    >
      <div className="field">
        <label>Name it</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind?.label} />
      </div>

      {card.kind === 'action' && (
        <>
          <div className="field">
            <label>Do what</label>
            {/* Grouped, because nineteen actions in one flat list is something
                you scroll rather than read. The categories are the server's. */}
            <select value={config.type ?? ''} onChange={(e) => set({ type: e.target.value, params: {} })}>
              <option value="">Choose…</option>
              {[...new Set(spec.actions.map((a) => a.category ?? 'Other'))].map((cat) => (
                <optgroup key={cat} label={cat}>
                  {spec.actions.filter((a) => (a.category ?? 'Other') === cat).map((a) => (
                    <option key={a.type} value={a.type}>{a.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* The parameters the server says this action takes — read from the
              spec rather than listed here, so the two cannot drift. */}
          {action?.params?.map((param) => (
            <div className="field" key={param}>
              <label>{PARAM_LABEL[param] ?? param.replace(/_/g, ' ')}</label>
              <ActionParam
                name={param}
                actionType={config.type}
                value={config.params?.[param] ?? ''}
                pickers={spec.pickers ?? {}}
                onChange={(v) => set({ params: { ...config.params, [param]: v } })}
              />
              {PARAM_HELP[param] && <div className="tiny muted">{PARAM_HELP[param]}</div>}
            </div>
          ))}
        </>
      )}

      {card.kind === 'wait' && (
        <div className="field-row">
          <div className="field">
            <label>Hours</label>
            <input type="number" min="0" value={config.hours ?? ''} onChange={(e) => set({ hours: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Minutes</label>
            <input type="number" min="0" value={config.minutes ?? ''} onChange={(e) => set({ minutes: Number(e.target.value) })} />
          </div>
        </div>
      )}

      {card.kind === 'wait_activity' && (
        <>
          <div className="field">
            <label>Wait for</label>
            <input
              value={config.activity_type ?? ''}
              onChange={(e) => set({ activity_type: e.target.value })}
              placeholder="Any activity"
            />
          </div>
          <div className="field">
            <label>Give up after (hours)</label>
            <input
              type="number" min="1"
              value={config.timeout_hours ?? 72}
              onChange={(e) => set({ timeout_hours: Number(e.target.value) })}
            />
            <p className="hint">Every wait needs a giving-up point, or a lead who never replies never leaves.</p>
          </div>
        </>
      )}

      {card.kind === 'branch' && (
        <div className="field">
          <label>Carry on when</label>
          <ConditionBuilder
            value={config.conditions}
            schema={spec.conditions}
            onChange={(conditions) => set({ conditions })}
          />
        </div>
      )}

      {card.kind === 'exit' && (
        <div className="field">
          <label>Why it ends here</label>
          <input value={config.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} placeholder="Already a client" />
        </div>
      )}

      {/* ------------------------------------------------------ the wiring */}
      {kind?.exits.length > 0 && <h4 className="muted">Then</h4>}

      {kind?.exits.includes('next') && (
        <div className="field">
          <label>{card.kind === 'branch' ? 'If it matches, go to' : 'Next'}</label>
          <select value={next} onChange={(e) => setNext(e.target.value)}>
            <option value="">nothing — ends the flow here</option>
            {others.map((s) => <option key={s.id} value={s.id}>{s.label || s.kind}</option>)}
          </select>
        </div>
      )}

      {kind?.exits.includes('else') && (
        <div className="field">
          <label>{card.kind === 'branch' ? 'Otherwise, go to' : 'If it never happens, go to'}</label>
          <select value={els} onChange={(e) => setEls(e.target.value)}>
            <option value="">nothing — ends the flow here</option>
            {others.map((s) => <option key={s.id} value={s.id}>{s.label || s.kind}</option>)}
          </select>
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------ the switch */

export default function StepDrawer({ target, data, spec, onClose, onSaved, onError }) {
  if (target?.trigger) {
    return <TriggerDrawer data={data} spec={spec} onClose={onClose} onSaved={onSaved} onError={onError} />;
  }
  /* Read fresh out of `data` rather than trusted from the click. A card can be
     reloaded under an open drawer — somebody else's edit, or the canvas
     rewiring it — and editing a stale copy would write the old exits back. */
  const card = data.steps.find((s) => s.id === target?.id);
  if (!card) return null;
  return <CardDrawer card={card} data={data} spec={spec} onClose={onClose} onSaved={onSaved} onError={onError} />;
}
