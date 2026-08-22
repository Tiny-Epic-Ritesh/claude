/**
 * The action menu, shared by the lead list and the lead record.
 *
 * WHAT IT IS
 * ----------
 * The single place that answers "what can I do to this lead?" — modelled on the
 * dropdown Salesforce puts on every row and LeadSquared puts on every lead. One
 * component, two surfaces, so an action added here appears in both and can only
 * be wrong in one place.
 *
 * THREE GATES, IN ORDER
 * ---------------------
 *   1. Capability   does this role hold the permission? If not, the item is not
 *                   rendered. Superadmin and Admin hold everything by default.
 *   2. Consent      may we contact this person on this channel, for this
 *                   reason? A blocked action is shown greyed with the reason,
 *                   not hidden — an RM needs to know the client opted out,
 *                   otherwise they will go and ring them from a mobile.
 *   3. The API      re-checks both, every time. This component is convenience,
 *                   never the control. Bulk paths, imports and automations do
 *                   not pass through here at all.
 *
 * WHY BLOCKED ITEMS STAY VISIBLE
 * ------------------------------
 * Hiding "Send WhatsApp" because someone opted out teaches an RM nothing and
 * looks like a bug. Showing it disabled, with "Kabir opted out of marketing
 * messages", tells them what happened and what their options are.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Every action the menu can offer.
 *
 *   needs        capability required; null means everyone signed in
 *   channel      which contactability entry gates it, if any
 *   intent       marketing or service — decides whether an opt-out blocks it
 *   group        separator grouping, in the order listed
 *   danger       renders in the destructive tone
 *   detailOnly   not offered from a list row (needs the full record)
 */
export const LEAD_ACTIONS = [
  // Reach out
  { key: 'call', label: 'Call', icon: 'call', needs: 'lead.contact', channel: 'call', intent: 'service', group: 'contact' },
  { key: 'whatsapp', label: 'Send WhatsApp', icon: 'chat', needs: 'lead.contact', channel: 'whatsapp', intent: 'marketing', group: 'contact' },
  { key: 'sms', label: 'Send SMS', icon: 'sms', needs: 'lead.contact', channel: 'sms', intent: 'marketing', group: 'contact' },
  { key: 'email', label: 'Send email', icon: 'mail', needs: 'lead.contact', channel: 'email', intent: 'marketing', group: 'contact' },

  // Record what happened
  { key: 'activity', label: 'Log an activity', icon: 'edit_note', needs: 'lead.contact', group: 'record' },
  { key: 'task', label: 'Create task / follow-up', icon: 'add_task', needs: null, group: 'record' },
  { key: 'case', label: 'Raise a case', icon: 'support_agent', needs: 'ticket.create', group: 'record' },

  // Move the deal
  { key: 'card', label: 'Add a product interest', icon: 'inventory_2', needs: 'card.mark.exploring', group: 'deal' },
  { key: 'kyc', label: 'Start KYC journey', icon: 'verified_user', needs: 'kyc.manage', group: 'deal' },
  { key: 'stage', label: 'Change stage', icon: 'flag', needs: 'lead.stage.change', group: 'deal' },

  // Ownership and routing
  { key: 'owner', label: 'Change owner', icon: 'person_pin', needs: 'lead.reassign', group: 'route' },
  { key: 'dialler', label: 'Push to autodialler', icon: 'dialpad', needs: 'lead.contact', channel: 'call', intent: 'service', group: 'route' },

  // Record management
  { key: 'edit', label: 'Edit lead', icon: 'edit', needs: 'lead.edit', group: 'manage', detailOnly: true },
  { key: 'delete', label: 'Delete lead', icon: 'delete', needs: 'lead.delete', group: 'manage', danger: true },
];

const GROUP_ORDER = ['contact', 'record', 'deal', 'route', 'manage'];

/**
 * Work out what this user may do to this lead, and why not where they may not.
 *
 * `contactability` comes from the lead payload; a list row may not carry it, in
 * which case channel actions are offered and the API decides. Offering an
 * action that might fail beats hiding one that would have worked — the failure
 * is a clear message, the absence is a mystery.
 */
export function resolveActions(lead, permissions, { listMode = false } = {}) {
  const held = new Set(permissions ?? []);

  return LEAD_ACTIONS
    .filter((a) => !(listMode && a.detailOnly))
    .filter((a) => a.needs === null || held.has(a.needs))
    .map((a) => {
      const gate = a.channel ? lead?.contactability?.[a.channel] : null;
      if (!gate) return { ...a, blocked: false };

      const allowed = a.intent === 'service' ? gate.service : gate.marketing;
      return { ...a, blocked: !allowed, blockedReason: allowed ? null : gate.reason };
    });
}

/* ------------------------------------------------------------- the menu */

export default function ActionMenu({
  lead, permissions, onAction, listMode = false,
  label = 'Actions', compact = false, align = 'end',
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const actions = resolveActions(lead, permissions, { listMode });

  // Close on outside click and on Escape. Both, because a menu that traps the
  // page is worse than no menu.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!actions.length) return null;

  const grouped = GROUP_ORDER
    .map((g) => actions.filter((a) => a.group === g))
    .filter((rows) => rows.length);

  return (
    <div className="action-menu" ref={wrapRef}>
      <button
        type="button"
        className={compact ? 'btn btn-ghost btn-icon' : 'btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? label : undefined}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        {compact
          ? <span className="material-symbols-rounded">more_vert</span>
          : <><span className="material-symbols-rounded">bolt</span>{label}
            <span className="material-symbols-rounded caret">expand_more</span></>}
      </button>

      {open && (
        <div className={`popover action-popover align-${align}`} role="menu">
          {grouped.map((rows, gi) => (
            <div key={rows[0].group} className="action-group">
              {gi > 0 && <div className="action-sep" />}
              {rows.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  role="menuitem"
                  className={`action-item ${a.danger ? 'is-danger' : ''} ${a.blocked ? 'is-blocked' : ''}`}
                  disabled={a.blocked}
                  title={a.blockedReason ?? undefined}
                  onClick={(e) => { e.stopPropagation(); setOpen(false); onAction(a.key, lead); }}
                >
                  <span className="material-symbols-rounded">{a.icon}</span>
                  <span className="action-label">
                    {a.label}
                    {/* The reason, not just the greying. An RM who cannot see
                        why will assume the CRM is broken and use their mobile. */}
                    {a.blocked && <span className="action-why">{a.blockedReason}</span>}
                  </span>
                  {a.blocked && <span className="material-symbols-rounded action-lock">block</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ bulk selection */

/**
 * Actions that make sense on many leads at once.
 *
 * Deliberately fewer than the single-lead menu. "Start KYC journey" on 200
 * leads is not a bulk operation anyone wants, and a menu that offers it invites
 * the mistake.
 */
export const BULK_ACTIONS = [
  { key: 'bulk_owner', label: 'Reassign owner', icon: 'person_pin', needs: 'lead.reassign' },
  { key: 'bulk_dialler', label: 'Push to autodialler', icon: 'dialpad', needs: 'lead.contact' },
  { key: 'bulk_whatsapp', label: 'Send WhatsApp', icon: 'chat', needs: 'lead.contact' },
  { key: 'bulk_stage', label: 'Change stage', icon: 'flag', needs: 'lead.stage.change' },
];

export function BulkBar({ count, permissions, onAction, onClear }) {
  const held = new Set(permissions ?? []);
  const actions = BULK_ACTIONS.filter((a) => held.has(a.needs));
  if (!count) return null;

  return (
    <div className="bulk-bar glass">
      <span className="bulk-count">
        <strong>{count}</strong> lead{count === 1 ? '' : 's'} selected
      </span>
      <div className="bulk-actions">
        {actions.map((a) => (
          <button key={a.key} type="button" className="btn btn-sm" onClick={() => onAction(a.key)}>
            <span className="material-symbols-rounded">{a.icon}</span>{a.label}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>Clear</button>
    </div>
  );
}
