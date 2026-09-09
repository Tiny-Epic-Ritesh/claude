import { useEffect, useState } from 'react';
import { api, ROLE_LABEL } from '../../api.js';
import { Modal, Icon, Spinner, Empty, ErrorBanner, Loading } from '../../components/ui.jsx';

/**
 * Handing a book over when somebody leaves (P3-19).
 *
 * The screen exists because the decision is made in a hurry, by somebody who
 * is not the person who built the book, usually on a last afternoon. So it
 * answers three questions in order and refuses to move anything until all
 * three are answered: what is there, who gets it, and what will that look like.
 *
 * The preview is the server's own plan rather than a count computed here. The
 * same function produces the numbers shown and the moves executed, so the
 * figures somebody approves are the figures that run — a preview that can
 * differ from its own execution is worse than none, because it is believed.
 */
export function Handover({ user, onClose, onDone }) {
  const [book, setBook] = useState(null);
  const [problem, setProblem] = useState(null);

  const [include, setInclude] = useState([]);
  const [targets, setTargets] = useState([]);
  const [strategy, setStrategy] = useState('single');
  const [reason, setReason] = useState('');

  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/setup/users/${user.id}/book`)
      .then((b) => {
        setBook(b);
        /* Everything with something in it, ticked. The common case is a whole
           book moving; unticking a line is a deliberate exception. */
        setInclude(b.objects.filter((o) => o.count > 0).map((o) => o.key));
      })
      .catch((err) => setProblem(err.message));
  }, [user.id]);

  /* The preview follows the choices rather than waiting for a button, because
     a preview somebody has to ask for is a preview somebody skips. */
  useEffect(() => {
    if (!targets.length || !include.length) { setPreview(null); return undefined; }
    const timer = setTimeout(async () => {
      try {
        setPreview(await api.post(`/setup/users/${user.id}/handover/preview`, { targets, include, strategy }));
        setProblem(null);
      } catch (err) { setPreview(null); setProblem(err.message); }
    }, 250);
    return () => clearTimeout(timer);
  }, [user.id, targets, include, strategy]);

  const run = async () => {
    setBusy(true);
    try {
      const out = await api.post(`/setup/users/${user.id}/handover`, { targets, include, strategy, reason });
      onDone(out);
    } catch (err) { setProblem(err.message); setBusy(false); }
  };

  if (!book) {
    /* A failed load has to say so. Returning <Loading /> whenever `book` is
       null spins forever on a refusal — which is exactly what a handover of
       somebody in another book does, and it reads as the screen being broken
       rather than as the answer it is. */
    return (
      <Modal title="Hand over the book" onClose={onClose}>
        {problem ? <ErrorBanner error={problem} /> : <Loading />}
      </Modal>
    );
  }

  const nothing = book.objects.every((o) => o.count === 0);
  const toggle = (list, setList, value) => setList(
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
  );

  return (
    <Modal title={`Hand over ${user.name}'s book`} subtitle={user.sales_org} onClose={onClose} wide>
      {problem && <ErrorBanner error={problem} onDismiss={() => setProblem(null)} />}

      {nothing ? (
        <Empty>{user.name} holds nothing that needs handing over.</Empty>
      ) : (
        <div className="tmpl-build">
          <div className="stack" style={{ gap: 2 }}>
            {/* ---------------------------------------------- what is there */}
            <h4 className="muted">What they hold</h4>

            <div className="stack" style={{ gap: 1 }}>
              {book.objects.filter((o) => o.count > 0).map((o) => (
                <label key={o.key} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={include.includes(o.key)}
                    onChange={() => toggle(include, setInclude, o.key)}
                  />
                  <div>
                    <strong>{o.count.toLocaleString('en-IN')}</strong> {o.label.toLowerCase()}
                    {o.hint && <div className="tiny muted">{o.hint}</div>}
                  </div>
                </label>
              ))}
            </div>

            {book.left_behind.length > 0 && (
              /* Said rather than moved. A private dashboard or a personal
                 template is the departing person's own working notes, and
                 handing those to a colleague is a different decision from
                 handing over clients — but it should not be a silent one. */
              <p className="hint">
                Staying with {user.name}:{' '}
                {book.left_behind.map((o) => `${o.count} ${o.label.toLowerCase()}`).join(', ')}.
              </p>
            )}

            {/* ------------------------------------------------- who gets it */}
            <h4 className="muted">Who takes it</h4>

            <div className="field">
              <label>Split it</label>
              <div className="row" style={{ gap: 4 }}>
                <button
                  type="button"
                  className={`btn-sm ${strategy === 'single' ? 'is-on' : ''}`}
                  onClick={() => setStrategy('single')}
                >
                  All to one person
                </button>
                <button
                  type="button"
                  className={`btn-sm ${strategy === 'round_robin' ? 'is-on' : ''}`}
                  onClick={() => setStrategy('round_robin')}
                >
                  Share evenly
                </button>
              </div>
            </div>

            <div className="stack" style={{ gap: 1, maxHeight: 200, overflowY: 'auto' }}>
              {book.candidates.map((c) => (
                <label key={c.id} className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <input
                    type={strategy === 'single' ? 'radio' : 'checkbox'}
                    name="handover-target"
                    checked={targets.includes(c.id)}
                    onChange={() => (strategy === 'single'
                      ? setTargets([c.id])
                      : toggle(targets, setTargets, c.id))}
                  />
                  <span>{c.name}</span>
                  {/* What they already carry, because "share evenly" between
                      someone on 40 leads and someone on 900 is not even. */}
                  <span className="tiny muted">{ROLE_LABEL[c.role] ?? c.role} · {c.leads} leads</span>
                </label>
              ))}
            </div>

            <div className="field">
              <label>Why</label>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Left the firm, 9 September"
              />
              <p className="hint">Written onto every lead that moves, so the new owner can see why they have it.</p>
            </div>
          </div>

          {/* ------------------------------------------------- what happens */}
          <div className="stack" style={{ gap: 2 }}>
            <h4 className="muted">What will happen</h4>
            <Preview preview={preview} book={book} targets={targets} />
          </div>
        </div>
      )}

      <div className="row-between" style={{ marginTop: 12 }}>
        <span className="tiny muted">
          {preview ? `${preview.total.toLocaleString('en-IN')} records move. This can be undone.` : ''}
        </span>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !preview?.total} onClick={run}>
            {busy ? <Spinner /> : <Icon name="swap_horiz" size={16} />} Hand over
          </button>
        </span>
      </div>
    </Modal>
  );
}

/** The plan, per object and per person. */
function Preview({ preview, book, targets }) {
  if (!targets.length) return <Empty>Choose who takes the book.</Empty>;
  if (!preview) return <Loading />;
  if (!preview.total) return <Empty>Nothing selected would move.</Empty>;

  const nameOf = (id) => book.candidates.find((c) => c.id === id)?.name ?? `#${id}`;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>What</th>
            {preview.targets.map((t) => <th key={t} className="num">{nameOf(t)}</th>)}
          </tr>
        </thead>
        <tbody>
          {preview.objects.filter((o) => o.total > 0).map((o) => (
            <tr key={o.key}>
              <td>{o.label}</td>
              {preview.targets.map((t) => (
                <td key={t} className="num">
                  {o.split.find((s) => s.to === t)?.n ?? 0}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td><strong>Total</strong></td>
            {preview.targets.map((t) => (
              <td key={t} className="num">
                <strong>
                  {preview.objects.reduce((n, o) => n + (o.split.find((s) => s.to === t)?.n ?? 0), 0)}
                </strong>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
