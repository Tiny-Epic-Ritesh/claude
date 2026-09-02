/**
 * Lead Lists.
 *
 * The three kinds differ in exactly one way — when membership is decided — so
 * the card says that in words rather than making people learn a vocabulary.
 * A dynamic list is also marked as unusable for campaigns on the card itself,
 * because the alternative is someone discovering it at send time.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, shortDate, dateTime } from '../api.js';
import { useApi, Icon, Loading, ErrorBanner, Empty, Modal } from '../components/ui.jsx';
import ConditionBuilder from '../components/ConditionBuilder.jsx';

const KIND_BADGE = {
  static: 'badge-blue',
  refreshable: 'badge-green',
  dynamic: 'badge-amber',
};

export default function LeadLists({ session }) {
  const navigate = useNavigate();
  const [lists, { loading, error, reload }] = useApi('/lists');
  const [meta] = useApi('/lists/meta');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  const refresh = async (id) => {
    setBusy(id); setProblem(null);
    try { await api.post(`/lists/${id}/refresh`); reload(); }
    catch (e) { setProblem(e.message); }
    finally { setBusy(null); }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Lead Lists</h1>
          <p className="muted">
            A list is a saved question. What changes between kinds is when the answer is worked out.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <Icon name="add" size={16} /> New list
        </button>
      </div>

      <ErrorBanner error={problem || error} onDismiss={() => setProblem(null)} />
      {loading && <Loading label="Loading lists…" />}

      {!loading && lists && lists.length === 0 && (
        <Empty>No lists yet. Build one from a filter, or save a search from the Leads tab.</Empty>
      )}

      <div className="grid-auto">
        {(lists ?? []).map((l) => (
          <div key={l.id} className="card">
            <div className="card-head">
              <h2 style={{ fontSize: 16 }}>{l.name}</h2>
              <span className={`badge ${KIND_BADGE[l.kind] || ''}`}>{l.kind_label}</span>
            </div>
            <div className="card-body stack" style={{ gap: 9 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="stat-value" style={{ fontSize: 26 }}>{l.member_count}</span>
                <span className="tiny muted">
                  lead{l.member_count === 1 ? '' : 's'} you can see
                </span>
              </div>

              {l.description && <div className="small muted">{l.description}</div>}

              {/* A refreshable list is only trustworthy if it says when it last
                  ran, so this is on the card rather than buried in detail. */}
              {l.kind === 'refreshable' && (
                <div className="tiny muted">
                  {l.last_refreshed_at
                    ? `Last refreshed ${dateTime(l.last_refreshed_at)}`
                    : 'Never refreshed'}
                  {l.refreshed_by_name ? ` by ${l.refreshed_by_name}` : ''}
                </div>
              )}
              {l.refresh_error && (
                <div className="small" style={{ color: 'var(--danger)' }}>
                  <Icon name="warning" size={14} /> {l.refresh_error}
                </div>
              )}

              {/* Said here, not discovered at send time. */}
              {l.kind === 'dynamic' && (
                <div className="tiny muted">
                  <Icon name="block" size={13} /> Cannot be used for a campaign — membership shifts as it is read.
                </div>
              )}

              <div className="row wrap" style={{ gap: 6 }}>
                <button className="btn-sm" onClick={() => navigate(`/lists/${l.id}`)}>Open</button>
                {l.kind === 'refreshable' && (
                  <button className="btn-ghost btn-sm" disabled={busy === l.id}
                    onClick={() => refresh(l.id)}>
                    {busy === l.id ? 'Refreshing…' : 'Refresh now'}
                  </button>
                )}
                <span className="tiny muted" style={{ marginLeft: 'auto' }}>
                  {l.owner_name || '—'} · {shortDate(l.created_at)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {creating && (
        <NewList meta={meta} onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); reload(); navigate(`/lists/${id}`); }} />
      )}
    </div>
  );
}

/**
 * Creating a list is mostly choosing a kind, so the kind picker explains each
 * one where the choice is made rather than in documentation nobody opens.
 */
function NewList({ meta, onClose, onCreated }) {
  const [name, setName] = useState('');
  /* A live query is the default, per the audit: "make saved queries the default
     and snapshots an explicit, expiring, audited artefact". A snapshot is wrong
     the day after it is made, and 4,810 of them is what happens when it is as
     easy to freeze a list as to keep it live. */
  /* Preselected from the server rather than hardcoded here. The API applies the
     same default to a request that omits the kind, and two copies of that
     decision would eventually disagree about which one the product has. */
  const [kind, setKind] = useState(null);
  const [criteria, setCriteria] = useState(null);
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Until meta arrives there is nothing to preselect; the radios render unset
  // for that one frame rather than flashing a kind the server might not agree
  // with.
  useEffect(() => {
    if (kind === null && meta?.default_kind) setKind(meta.default_kind);
  }, [kind, meta?.default_kind]);

  const chosen = (meta?.kinds ?? []).find((k) => k.code === kind);
  const isSnapshot = Boolean(chosen?.snapshot);
  const needsFilter = !isSnapshot;

  // The default expiry is offered rather than imposed, but it is filled in so
  // the common case is one click rather than a date somebody has to invent.
  useEffect(() => {
    if (isSnapshot && !expires && meta?.default_expiry) setExpires(meta.default_expiry);
  }, [isSnapshot, expires, meta?.default_expiry]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const created = await api.post('/lists', {
        name,
        kind,
        criteria: needsFilter ? criteria : null,
        snapshot_reason: isSnapshot ? reason : null,
        expires_at: isSnapshot ? expires : null,
      });
      onCreated(created.id);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="New list" onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <ErrorBanner error={error} />

        <div className="field">
          <label htmlFor="list-name">Name</label>
          <input id="list-name" value={name} autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="Warm leads, no contact in 7 days" />
        </div>

        <div className="stack" style={{ gap: 7 }}>
          <span className="field-label">Kind</span>
          {(meta?.kinds ?? []).map((k) => (
            <label key={k.code} className={`pick ${kind === k.code ? 'is-on' : ''}`}>
              <input type="radio" name="kind" value={k.code}
                checked={kind === k.code} onChange={() => setKind(k.code)} />
              <span>
                <span className="pick-title">{k.label}</span>
                <span className="pick-help">{k.help}</span>
              </span>
            </label>
          ))}
        </div>

        {needsFilter && (
          <div className="field">
            <span className="field-label">Who is in it</span>
            {/* The engine has always taken nested AND/OR over 27 fields. This
                screen offered one stage, which is why anything real was done in
                Excel and re-imported — the habit the audit traces 4,810 lists
                back to. */}
            <ConditionBuilder value={criteria} schema={meta?.schema} onChange={setCriteria} />
          </div>
        )}

        {isSnapshot && (
          /* A snapshot has to say why it is frozen and when it lapses. These are
             the two questions nobody could answer about the legacy tenant's
             lists, and asking them here is what stops the pile forming. */
          <div className="stack" style={{ gap: 10 }}>
            <div className="field">
              <label htmlFor="list-reason">Why is this frozen?</label>
              <input
                id="list-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Audit evidence for the Q3 campaign"
              />
              <span className="tiny muted">
                A snapshot is wrong the day after it is made. If it does not need to be
                frozen, a live list stays correct on its own.
              </span>
            </div>
            <div className="field">
              <label htmlFor="list-expiry">Expires on</label>
              <input id="list-expiry" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
              <span className="tiny muted">Archived automatically after this date. Never deleted.</span>
            </div>
          </div>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary"
            disabled={saving || !name.trim() || (needsFilter && !criteria) || (isSnapshot && (!reason.trim() || !expires))}>
            {saving ? 'Creating…' : 'Create list'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
