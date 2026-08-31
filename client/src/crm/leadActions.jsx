/**
 * Lead actions — one handler set, shared by the lead record and the lead list.
 *
 * Kept out of both pages so an action cannot behave one way on a row and
 * another way on the record, which is exactly how the two drift apart.
 */

import { useState } from 'react';
import { api, appUrl } from '../api.js';
import { Icon, Spinner } from '../components/ui.jsx';

/* ------------------------------------------------------- lead actions */

/**
 * One handler for every action the menu can fire, shared by the record and the
 * list. Actions that need no input fire straight away; the rest open a modal.
 *
 * Click-to-call goes through CUBE rather than a `tel:` link, deliberately: the
 * switch dials the RM's extension first and only then the client, so the call
 * is recorded, logged against the lead, and the RM is never showing a client
 * their personal number.
 */
export function useLeadActions({ session, reload, onError, onNotice }) {
  const [modal, setModal] = useState(null);   // { kind, lead }
  const [dialling, setDialling] = useState(null);

  async function call(lead) {
    setDialling(lead.id);
    try {
      const res = await api.post(`/leads/${lead.id}/call`, {});
      onNotice?.(res.message ?? `Connecting you to ${lead.name}. Answer your handset.`);
    } catch (err) {
      // A refusal here is usually consent or a dead number, and the message
      // says which. It is the RM's problem to act on, not a server fault.
      onError?.(err.message);
    } finally {
      setDialling(null);
    }
  }

  function run(key, lead) {
    switch (key) {
      case 'call': return call(lead);
      case 'whatsapp': return setModal({ kind: 'message', channel: 'whatsapp', lead });
      case 'sms': return setModal({ kind: 'message', channel: 'sms', lead });
      /* P2-08. Email opens the composer, not the plain message modal.
         The modal was built for WhatsApp and SMS, where there is nothing
         to attach and no collateral to pick, so an RM reaching email from
         a product card got a bare textarea while the same person reaching
         it from the lead's address got attachments and the content
         library. Same act, two different products. */
      case 'email': return setModal({ kind: 'email', lead });
      case 'activity': return setModal({ kind: 'activity', lead });
      case 'task': return setModal({ kind: 'task', lead });
      case 'case': return setModal({ kind: 'case', lead });
      case 'card': return setModal({ kind: 'card', lead });
      case 'stage': return setModal({ kind: 'stage', lead });
      case 'owner': return setModal({ kind: 'owner', lead });
      case 'kyc': return startKyc(lead);
      case 'dialler': return pushToDialler(lead);
      case 'edit': return setModal({ kind: 'edit', lead });
      case 'delete': return setModal({ kind: 'delete', lead });
      default: return undefined;
    }
  }

  async function startKyc(lead) {
    try {
      const j = await api.post('/kyc/journeys', { lead_id: lead.id });
      window.open(appUrl(`/dkyc/resume/${j.resume_token}`), '_blank', 'noopener');
      onNotice?.('KYC journey started — the applicant link is open in a new tab.');
      reload?.();
    } catch (err) { onError?.(err.message); }
  }

  async function pushToDialler(lead) {
    try {
      await api.post('/autodialler', { lead_ids: [lead.id] });
      onNotice?.(`${lead.name} pushed to the dial campaign.`);
    } catch (err) { onError?.(err.message); }
  }

  /**
   * Bulk actions on a selection.
   *
   * Deliberately narrower than the single-lead menu, and every one of them
   * still passes through the same API guards — the consent check runs per lead
   * on the server, so a bulk WhatsApp to 200 leads silently skips the ones who
   * opted out rather than sending to them.
   */
  async function runBulk(key, ids) {
    if (!ids.length) return undefined;
    switch (key) {
      case 'bulk_dialler':
        try {
          const res = await api.post('/autodialler', { lead_ids: ids });
          onNotice?.(`${res.pushed ?? ids.length} leads pushed to the dial campaign.`);
        } catch (err) { onError?.(err.message); }
        return undefined;
      case 'bulk_owner': return setModal({ kind: 'bulk_owner', ids });
      case 'bulk_stage': return setModal({ kind: 'bulk_stage', ids });
      case 'bulk_whatsapp': return setModal({ kind: 'bulk_message', channel: 'whatsapp', ids });
      default: return undefined;
    }
  }

  /** Turn a search result into a lead list a campaign can send to. */
  async function saveAsList(where) {
    const name = window.prompt('Name this list');
    if (!name?.trim()) return;
    try {
      const r = await api.post('/search-advanced/lead/to-list', { name: name.trim(), where });
      onNotice?.(`"${r.name}" created with ${r.members} lead${r.members === 1 ? '' : 's'}.`);
    } catch (err) { onError?.(err.message); }
  }

  /**
   * Export the current result to CSV.
   *
   * Goes through fetch rather than the api helper because the response is a
   * file, not JSON. The server gates it on a capability and logs every export
   * with its row count and filter — this only decides where the file lands.
   */
  async function exportCsv(entity, where) {
    try {
      const res = await fetch(`/api/search-advanced/${entity}/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('bnz_crm_token')}`,
        },
        body: JSON.stringify({ where }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${entity}-export.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onNotice?.('Export downloaded. This export is recorded in the audit log.');
    } catch (err) { onError?.(err.message); }
  }

  return { run, runBulk, saveAsList, exportCsv, modal, setModal, dialling };
}

/**
 * The mobile number, as a dial button.
 *
 * Shown wherever a number is shown. It is a `<button>` rather than a link so it
 * never navigates, and it stops propagation so clicking it inside a lead row
 * dials instead of opening the record — which is the whole point.
 */
export function CallNumber({ lead, permissions, onCall, dialling, masked }) {
  const can = (permissions ?? []).includes('lead.contact');
  const blocked = lead.contactability?.call && !lead.contactability.call.service;

  if (!lead.mobile) return <span className="muted">no mobile</span>;
  if (!can) return <span className="phone-plain">{lead.mobile}</span>;

  return (
    <button
      type="button"
      className={`phone-link ${blocked ? 'is-blocked' : ''}`}
      disabled={blocked || dialling}
      title={blocked ? lead.contactability.call.reason : `Call ${lead.name} on CUBE`}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onCall(lead); }}
    >
      {dialling
        ? <Spinner />
        : <Icon name={blocked ? 'phone_disabled' : 'call'} size={14} />}
      <span>{lead.mobile}</span>
      {masked && <Icon name="lock" size={11} />}
    </button>
  );
}

/**
 * A lead's email address, as a control (ENH-06).
 *
 * Deliberately shaped like CallNumber: the two sit next to each other on every
 * lead, and an RM should not have to learn that one of them is a button and the
 * other is decoration.
 *
 * Consent is reflected in the control rather than enforced after the click, for
 * the same reason it is everywhere else -- a disabled control with a reason
 * teaches something, and a failing one teaches distrust.
 */
export function EmailLink({ lead, permissions, onEmail, masked }) {
  const can = (permissions ?? []).includes('lead.contact');
  const blocked = lead.contactability?.email && !lead.contactability.email.service;

  if (!lead.email) return <span className="muted">no email</span>;
  if (!can) return <span className="phone-plain">{lead.email}</span>;

  return (
    <button
      type="button"
      className={`phone-link ${blocked ? 'is-blocked' : ''}`}
      disabled={blocked}
      title={blocked ? lead.contactability.email.reason : `Email ${lead.name}`}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onEmail(lead); }}
    >
      <Icon name={blocked ? 'unsubscribe' : 'mail'} size={14} />
      <span>{lead.email}</span>
      {masked && <Icon name="lock" size={11} />}
    </button>
  );
}
