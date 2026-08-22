import { useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { dkycApi, mins, rupees } from '../api.js';
import { ErrorBanner, Spinner, Loading } from '../components/ui.jsx';
import { ProgressRing } from '../components/charts.jsx';
import ProductCard, { minimumFact, riskFact } from '../components/ProductCard.jsx';
import BrandLogo from '../components/BrandLogo.jsx';

/**
 * DKYC — Bonanza's self-service account opening portal.
 *
 * Implements the published 16-step journey. The applicant completes it alone;
 * the CRM watches the per-step timers and pulls a Product RM in when they stall.
 * No CRM login is involved — the applicant holds a resume token.
 *
 * WHY THIS SURFACE GETS REAL DESIGN
 * ---------------------------------
 * This is the only screen a prospective client ever sees before they become one.
 * It ran in a 440px column with the products as a plain list — which is the
 * shape of a form, not of a decision. Someone choosing where to put their money
 * is comparing options, and comparison needs cards side by side: what it is,
 * what it costs to start, what it gets them.
 *
 * The 16 steps are grouped rather than listed flat, because "step 9 of 16" tells
 * an applicant nothing while "Bank account, 2 of 3" tells them they are nearly
 * through a section.
 */
export default function DkycPortal() {
  return (
    <div className="portal">
      <header className="portal-head">
        <div className="portal-id">
          <BrandLogo org="BONANZA" height={30} />
          <div>
            <div className="portal-sub">Open your account online</div>
          </div>
        </div>
        <div className="portal-head-actions">
          <span className="trust-chip">
            <span className="material-symbols-rounded" aria-hidden>schedule</span>
            About 15 minutes
          </span>
          <span className="trust-chip">
            <span className="material-symbols-rounded" aria-hidden>encrypted</span>
            Aadhaar &amp; PAN required
          </span>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Start />} />
        <Route path="/resume/:tokenId" element={<Journey />} />
      </Routes>
    </div>
  );
}

/* ---------------------------------------------------------------- start */

const JOURNEY_PREVIEW = [
  ['Basic verification', 'Mobile and email, each confirmed by OTP', 'sms'],
  ['Identity', 'PAN, then Aadhaar KYC fetched from DigiLocker', 'badge'],
  ['About you', 'Personal details, occupation and income band', 'person'],
  ['Bank account', 'Verified instantly by penny drop', 'account_balance'],
  ['Nominee & segments', 'Who inherits, and what you want to trade', 'family_restroom'],
  ['Final steps', 'Selfie, signature and Aadhaar eSign', 'draw'],
];

function Start() {
  const [products, setProducts] = useState(null);
  const [selected, setSelected] = useState(null);
  const [mobile, setMobile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { dkycApi.get('/products').then(setProducts).catch((e) => setError(e.message)); }, []);

  async function start() {
    if (!selected) { setError('Please choose what you would like to open.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await dkycApi.post('/start', { product_type_id: selected, mobile: mobile || undefined });
      navigate(`/dkyc/resume/${res.resume_token}`);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const chosen = products?.find((p) => p.id === selected);

  return (
    <div className="portal-body">
      <section className="dkyc-hero glass">
        <div className="dkyc-hero-text">
          <span className="eyebrow">Account opening</span>
          <h1>Open your Bonanza account in about 15&nbsp;minutes.</h1>
          <p>
            Complete it yourself, online, end to end. You will need your PAN, an Aadhaar-linked
            mobile number and your bank details. Pause whenever you like — the same link brings
            you back to exactly where you stopped.
          </p>
          <ul className="hero-points">
            <li><span className="material-symbols-rounded" aria-hidden>bolt</span>Aadhaar eSign — no paperwork, no courier</li>
            <li><span className="material-symbols-rounded" aria-hidden>verified_user</span>Bank verified instantly by penny drop</li>
            <li><span className="material-symbols-rounded" aria-hidden>support_agent</span>Stuck on a step? We call you, you do not chase us</li>
          </ul>
        </div>
        <div className="dkyc-hero-side">
          <div className="hero-stat"><strong>16</strong><span>guided steps</span></div>
          <div className="hero-stat"><strong>15<em>min</em></strong><span>typical time</span></div>
          <div className="hero-stat"><strong>1</strong><span>working day to activate</span></div>
        </div>
      </section>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <section className="glass section-card">
        <div className="section-head">
          <div>
            <h2><span className="step-num">1</span> What would you like to open?</h2>
            <p>Pick one to begin. You can add other products later from inside your account.</p>
          </div>
        </div>

        {!products ? <Loading /> : (
          <div className="product-grid">
            {products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                showFeatures
                featureLimit={3}
                selected={selected === p.id}
                onSelect={() => { setSelected(p.id); setError(null); }}
                facts={[minimumFact(p), riskFact(p)]}
              />
            ))}
          </div>
        )}
      </section>

      <section className="glass section-card">
        <div className="section-head">
          <div>
            <h2><span className="step-num">2</span> Your mobile number</h2>
            <p>If you have already spoken to a Bonanza representative, use the same number so your application links up with that conversation.</p>
          </div>
        </div>

        <div className="dkyc-start-row">
          <div className="field" style={{ maxWidth: 260, margin: 0 }}>
            <label htmlFor="dkyc-mobile">Mobile number</label>
            <input
              id="dkyc-mobile"
              value={mobile}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="10-digit mobile"
              inputMode="numeric"
            />
          </div>

          <button type="button" className="btn btn-primary btn-lg" onClick={start} disabled={busy || !selected}>
            {busy ? <><Spinner /> Starting…</> : 'Start my application'}
            {!busy && <span className="material-symbols-rounded" aria-hidden>arrow_forward</span>}
          </button>
        </div>

        {/* The button is disabled until a product is chosen; saying so beats a
            dead control the applicant has to guess about. */}
        {!selected && (
          <p className="tiny muted" style={{ margin: 0 }}>
            Choose a product above to continue.
          </p>
        )}
        {chosen && (
          <p className="tiny muted" style={{ margin: 0 }}>
            Opening <strong>{chosen.name}</strong>
            {chosen.min_investment > 0 && <> · minimum {rupees(chosen.min_investment)}</>}
          </p>
        )}
      </section>

      <section className="glass section-card">
        <div className="section-head">
          <div>
            <h2>What you will go through</h2>
            <p>Six sections, sixteen short steps. Nothing is asked twice.</p>
          </div>
        </div>
        <div className="preview-grid">
          {JOURNEY_PREVIEW.map(([title, body, icon], i) => (
            <div key={title} className="preview-card">
              <span className="preview-index">{i + 1}</span>
              <span className="material-symbols-rounded preview-icon" aria-hidden>{icon}</span>
              <strong>{title}</strong>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <TrustPanel />
    </div>
  );
}

/**
 * The reassurance an applicant needs before typing a PAN into a web form.
 *
 * Every claim here is one the business can stand behind: the SEBI registration
 * is real, the data-residency line is the actual policy this system is built
 * to, and the "we call you" promise is implemented by the stall detector.
 */
function TrustPanel() {
  return (
    <section className="trust-panel glass">
      <div className="trust-item">
        <span className="material-symbols-rounded" aria-hidden>gavel</span>
        <div>
          <strong>SEBI-registered broker</strong>
          <p>Bonanza Portfolio Ltd is a registered member of NSE, BSE, MCX and NCDEX, and a CDSL/NSDL depository participant.</p>
        </div>
      </div>
      <div className="trust-item">
        <span className="material-symbols-rounded" aria-hidden>shield_lock</span>
        <div>
          <strong>Your documents stay in India</strong>
          <p>Every record you submit is stored and processed on infrastructure inside India. Nothing is sent overseas.</p>
        </div>
      </div>
      <div className="trust-item">
        <span className="material-symbols-rounded" aria-hidden>lock</span>
        <div>
          <strong>Encrypted at rest</strong>
          <p>PAN, bank details and identity documents are encrypted, and access is logged against a named employee.</p>
        </div>
      </div>
      <div className="trust-item">
        <span className="material-symbols-rounded" aria-hidden>call</span>
        <div>
          <strong>A human when you need one</strong>
          <p>If a step takes longer than expected we notice, and a representative calls you on 022-6153-0000.</p>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- journey */

function Journey() {
  const { tokenId } = useParams();
  const [journey, setJourney] = useState(null);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const tick = useRef(null);

  const load = () => dkycApi.get(`/resume/${tokenId}`).then((j) => { setJourney(j); setElapsed(j.elapsed_s); }).catch((e) => setError(e.message));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tokenId]);

  useEffect(() => {
    tick.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(tick.current);
  }, []);

  /**
   * Sixteen steps in a flat list is a wall. Grouped, it becomes six sections an
   * applicant can see the end of — and the group is already on every step, so
   * this costs nothing but the reduce.
   */
  const groups = useMemo(() => {
    if (!journey) return [];
    const map = new Map();
    for (const s of journey.steps) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group).push(s);
    }
    return [...map.entries()].map(([name, steps]) => ({
      name,
      steps,
      done: steps.every((s) => s.status === 'done'),
      active: steps.some((s) => s.status === 'active' || s.status === 'stalled'),
    }));
  }, [journey]);

  if (error && !journey) return <div className="portal-body"><ErrorBanner error={error} /></div>;
  if (!journey) return <div className="portal-body"><Loading label="Loading your application…" /></div>;

  const step = journey.steps.find((s) => s.code === journey.current_step);

  /* ---- terminal states ---- */
  if (journey.status === 'Complete') return <Done journey={journey} />;

  if (journey.status === 'Abandoned') {
    return (
      <div className="portal-body">
        <section className="glass section-card outcome-card">
          <span className="outcome-icon material-symbols-rounded is-paused" aria-hidden>pause_circle</span>
          <h1>We have paused your application</h1>
          <p className="muted">
            You were on “{journey.steps.find((s) => s.status === 'stalled')?.label || 'a verification step'}” for over an hour,
            so we paused it for your security. Nothing you entered has been lost.
          </p>
          <p>A Bonanza representative will call you shortly to finish it with you.</p>
          <div className="notice" style={{ textAlign: 'left', width: '100%' }}>
            <span className="material-symbols-rounded" aria-hidden>call</span>
            <div>
              Need it sooner? Call <strong>022-6153-0000</strong> and quote application reference{' '}
              <code>{String(journey.resume_token).slice(0, 8).toUpperCase()}</code>.
            </div>
          </div>
        </section>
      </div>
    );
  }

  /* ---- active step ---- */
  const setValue = (name, v) => setValues((prev) => ({ ...prev, [name]: v }));

  const missing = (step?.fields || []).filter((f) => {
    if (!f.required) return false;
    const v = values[f.name];
    return v === undefined || v === '' || (Array.isArray(v) && !v.length) || v === false;
  });

  async function submit(e) {
    e?.preventDefault();
    if (missing.length) { setError(`Please complete: ${missing.map((f) => f.label).join(', ')}`); return; }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = { ...values };
      for (const f of step.fields || []) {
        if (f.transform === 'upper' && typeof payload[f.name] === 'string') payload[f.name] = payload[f.name].toUpperCase();
      }
      const res = await dkycApi.post(`/resume/${tokenId}/step`, { step_code: step.code, payload });
      setValues({});
      setJourney(res.journey);
      if (res.penny_drop_failed) {
        setNotice('We could not verify your bank account automatically. Please upload a bank proof and we will verify it manually.');
      }
    } catch (err) {
      setError(err.message);
      if (err.payload?.abandoned) load();
    } finally { setBusy(false); }
  }

  async function sendOtp(channel, destination) {
    setNotice(null);
    const res = await dkycApi.post(`/resume/${tokenId}/otp`, { channel, destination });
    setNotice(`Verification code sent. ${res.hint}`);
  }

  const overTimer = step && journey.stall && journey.stall.seconds_on_step > (step.timer_s || 180);
  const currentGroup = groups.find((g) => g.active);
  const inGroup = currentGroup ? currentGroup.steps.findIndex((s) => s.code === step?.code) + 1 : 0;

  return (
    <div className="portal-body">
      <div className="journey-layout">
        {/* ---------------------------------------------- the rail */}
        <aside className="journey-rail glass">
          <div className="rail-head">
            <ProgressRing value={journey.steps_done} total={journey.steps_total} size={64} thickness={6} />
            <div>
              <strong>{journey.product?.name}</strong>
              <div className="tiny muted">
                {journey.steps_done} of {journey.steps_total} steps · {mins(elapsed)} so far
              </div>
            </div>
          </div>

          <ol className="group-rail">
            {groups.map((g) => (
              <li key={g.name} className={`${g.done ? 'is-done' : ''} ${g.active ? 'is-active' : ''}`}>
                <span className="step-dot material-symbols-rounded" aria-hidden>
                  {g.done ? 'check' : g.active ? 'radio_button_checked' : 'radio_button_unchecked'}
                </span>
                <div className="group-body">
                  <strong>{g.name}</strong>
                  <div className="group-steps">
                    {g.steps.map((s) => (
                      <span
                        key={s.code}
                        className={`tick ${s.status}`}
                        title={`${s.label} — ${s.status}`}
                        aria-label={`${s.label}: ${s.status}`}
                      />
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <div className="rail-foot">
            <span className="material-symbols-rounded" aria-hidden>bookmark</span>
            <div className="tiny muted">
              Save this link to come back later.
              <code className="resume-link">{window.location.href}</code>
            </div>
          </div>
        </aside>

        {/* ---------------------------------------------- the form */}
        <main className="journey-main">
          <div className="journey-head">
            <div>
              <span className="eyebrow">{step?.group}{inGroup ? ` · ${inGroup} of ${currentGroup.steps.length}` : ''}</span>
              <h1>{step?.label}</h1>
            </div>
            <span className="step-counter">
              <strong>{journey.steps_done + 1}</strong>
              <span>of {journey.steps_total}</span>
            </span>
          </div>

          <div className="journey-progress">
            <div className="journey-progress-fill" style={{ width: `${journey.progress_pct}%` }} />
          </div>

          <ErrorBanner error={error} onDismiss={() => setError(null)} />
          {notice && (
            <div className="notice">
              <span className="material-symbols-rounded" aria-hidden>info</span>
              <div>{notice}</div>
            </div>
          )}
          {overTimer && (
            <div className="warnbox">
              Taking longer than usual on this step? Call <strong>022-6153-0000</strong> and we will complete it with you.
            </div>
          )}

          <section className="glass section-card">
            {step?.note && (
              <div className="notice">
                <span className="material-symbols-rounded" aria-hidden>lightbulb</span>
                <div>{step.note}</div>
              </div>
            )}

            <form onSubmit={submit}>
              {(step?.fields || []).map((f) => (
                <Field
                  key={f.name}
                  field={f}
                  value={values[f.name]}
                  onChange={(v) => setValue(f.name, v)}
                  onSendOtp={() => sendOtp(f.name === 'email_otp' ? 'email' : 'sms', journey.form.email || journey.form.mobile || '')}
                />
              ))}

              <div className="journey-actions">
                <span className="tiny muted">
                  <span className="material-symbols-rounded" aria-hidden>lock</span>
                  Encrypted and stored in India
                </span>
                <button className="btn btn-primary btn-lg" disabled={busy}>
                  {busy ? <><Spinner /> Verifying…</> : journey.steps_done + 1 === journey.steps_total ? 'Finish' : 'Continue'}
                  {!busy && <span className="material-symbols-rounded" aria-hidden>arrow_forward</span>}
                </button>
              </div>
            </form>
          </section>
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- field renderer */

function Field({ field, value, onChange, onSendOtp }) {
  const common = { id: field.name, required: field.required };

  if (field.type === 'consent') {
    return (
      <div className="field">
        <label className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, marginTop: 2 }} />
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{field.label}</span>
        </label>
        <div className="hint">You will be redirected to DigiLocker to authorise the fetch. In this demo the fetch is simulated.</div>
      </div>
    );
  }

  if (field.type === 'otp') {
    return (
      <div className="field">
        <label htmlFor={field.name}>{field.label}</label>
        <div className="row">
          <input {...common} value={value || ''} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="6-digit code" style={{ maxWidth: 200 }} />
          <button type="button" onClick={onSendOtp}>Send code</button>
        </div>
        <div className="hint">Demo build — the code is always <code>123456</code>.</div>
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div className="field">
        <label htmlFor={field.name}>{field.label}</label>
        <select {...common} value={value || ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }

  if (field.type === 'multiselect') {
    const selected = value || [];
    return (
      <div className="field">
        <label>{field.label}</label>
        <div className="row wrap">
          {field.options.map((o) => (
            <button
              key={o}
              type="button"
              className={selected.includes(o) ? 'btn-primary' : ''}
              onClick={() => onChange(selected.includes(o) ? selected.filter((s) => s !== o) : [...selected, o])}
            >
              {o}
            </button>
          ))}
        </div>
        <div className="hint">Choosing derivatives (F&amp;O) requires income proof.</div>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className="field">
        <label htmlFor={field.name}>{field.label}</label>
        <textarea {...common} value={value || ''} onChange={(e) => onChange(e.target.value)} style={{ minHeight: 70 }} />
      </div>
    );
  }

  if (field.type === 'file' || field.type === 'capture') {
    return (
      <div className="field">
        <label>{field.label}</label>
        <div className="card" style={{ padding: 16, textAlign: 'center', borderStyle: 'dashed' }}>
          {value
            ? <div className="row" style={{ justifyContent: 'center' }}><span className="badge badge-green">✓ {String(value)}</span><button type="button" className="btn-sm" onClick={() => onChange('')}>Replace</button></div>
            : (
              <>
                <div className="small muted" style={{ marginBottom: 8 }}>
                  {field.type === 'capture' ? 'We need a live photograph for in-person verification.' : 'Upload a clear photo or PDF.'}
                </div>
                <button type="button" onClick={() => onChange(field.type === 'capture' ? 'selfie-captured.jpg' : 'document-uploaded.pdf')}>
                  {field.type === 'capture' ? 'Open camera' : 'Choose file'}
                </button>
                <div className="hint">Demo build — no file actually leaves your machine.</div>
              </>
            )}
        </div>
      </div>
    );
  }

  const inputType = { tel: 'tel', email: 'email', date: 'date', number: 'number' }[field.type] || 'text';
  return (
    <div className="field">
      <label htmlFor={field.name}>{field.label}</label>
      <input
        {...common}
        type={inputType}
        value={value || ''}
        onChange={(e) => onChange(field.transform === 'upper' ? e.target.value.toUpperCase() : e.target.value)}
        inputMode={field.type === 'tel' ? 'numeric' : undefined}
      />
      {field.help && <div className="hint">{field.help}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- done */

function Done({ journey }) {
  return (
    <div className="portal-body">
      <section className="glass section-card outcome-card">
        <span className="outcome-icon material-symbols-rounded is-done" aria-hidden>task_alt</span>
        <h1>Onboarding successful</h1>
        <p className="muted">
          Your {journey.product?.name} account application is complete and has gone to our operations team.
          You will receive your client code and login details by email within one working day.
        </p>

        <div className="outcome-stats">
          <div className="hero-stat"><strong>{journey.steps_total}</strong><span>steps completed</span></div>
          <div className="hero-stat"><strong>{mins(journey.elapsed_s)}</strong><span>total time</span></div>
          <div className="hero-stat"><strong>1</strong><span>working day to activate</span></div>
        </div>

        <div className="notice" style={{ textAlign: 'left', width: '100%' }}>
          <span className="material-symbols-rounded" aria-hidden>route</span>
          <div>
            <strong>What happens next.</strong> Operations verify your documents, your demat and trading
            accounts are activated, and your relationship manager calls to walk you through the platform.
          </div>
        </div>
      </section>

      <TrustPanel />
    </div>
  );
}
