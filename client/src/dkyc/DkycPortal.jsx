import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
/* QA-13 (Ritesh, 13 Oct): a page per business. /dkyc is Bonanza's and
   /dkyc?business=bigul is Bigul's; a resumed application is its product's
   business's, whichever link it was started from. */
const BrandContext = createContext({ brand: { code: 'BONANZA', name: 'Bonanza', legal_name: 'Bonanza Portfolio Ltd.' }, setBrand: () => {} });
const useBrand = () => useContext(BrandContext);

/** The legal entity, for the regulatory line: "Bonanza Portfolio Ltd. (Bigul)" is offered by "Bonanza Portfolio Ltd.". */
const entityOf = (brand) => String(brand?.legal_name ?? 'Bonanza Portfolio Ltd.').replace(/\s*\(.*\)\s*$/, '');

/**
 * The business's own help line and its hours, from the business's record.
 *
 * Both pages used to print one number, written into this file, which was
 * neither business's published line. A business with no number on record says
 * "us" rather than inventing one.
 */
function HelpLine() {
  const { brand } = useBrand();
  if (!brand.support_phone) return <>us</>;
  return (
    <>
      <strong>{brand.support_phone}</strong>
      {brand.support_hours && <> ({brand.support_hours})</>}
    </>
  );
}

export default function DkycPortal() {
  const [brand, setBrand] = useState({ code: 'BONANZA', name: 'Bonanza', legal_name: 'Bonanza Portfolio Ltd.' });
  return (
    <BrandContext.Provider value={{ brand, setBrand }}>
    <div className="portal">
      <header className="portal-head">
        <div className="portal-id">
          <BrandLogo org={brand.code} height={30} />
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
    </BrandContext.Provider>
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
  const { brand, setBrand } = useBrand();
  const [params] = useSearchParams();
  const business = (params.get('business') || 'BONANZA').toUpperCase();
  const [products, setProducts] = useState(null);
  const [selected, setSelected] = useState(null);
  const [mobile, setMobile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    dkycApi.get(`/business?business=${business}`).then(setBrand).catch((e) => setError(e.message));
    dkycApi.get(`/products?business=${business}`).then(setProducts).catch((e) => setError(e.message));
  }, [business, setBrand]);

  async function start() {
    if (!selected) { setError('Please choose what you would like to open.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await dkycApi.post('/start', { product_type_id: selected, mobile: mobile || undefined, business: brand.code });
      navigate(`/dkyc/resume/${res.resume_token}`);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const chosen = products?.find((p) => p.id === selected);

  return (
    <div className="portal-body">
      <section className="dkyc-hero glass">
        <div className="dkyc-hero-text">
          <span className="eyebrow">Account opening</span>
          <h1>Open your {brand.name} account in about 15&nbsp;minutes.</h1>
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
            <p>If you have already spoken to a {brand.name} representative, use the same number so your application links up with that conversation.</p>
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
  const { brand } = useBrand();
  return (
    <section className="trust-panel glass">
      <div className="trust-item">
        <span className="material-symbols-rounded" aria-hidden>gavel</span>
        <div>
          <strong>SEBI-registered broker</strong>
          <p>
            {brand.code === 'BONANZA' ? entityOf(brand) : `${brand.name} is offered by ${entityOf(brand)}, which`} is a registered member of NSE, BSE, MCX and NCDEX, and a CDSL/NSDL depository participant.
          </p>
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
          <p>If a step takes longer than expected we notice, and a representative calls you. To reach us yourself, call <HelpLine />.</p>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- journey */

function Journey() {
  const { brand, setBrand } = useBrand();
  const { tokenId } = useParams();
  const [journey, setJourney] = useState(null);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const tick = useRef(null);

  const load = () => dkycApi.get(`/resume/${tokenId}`).then((j) => {
    setJourney(j);
    setElapsed(j.elapsed_s);
    if (j.business) setBrand(j.business);
  }).catch((e) => setError(e.message));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tokenId]);

  /* QA-34. A step opens with what the application already holds for it -- the
     mobile it was started with, or an answer given before a resume -- so the
     applicant confirms it instead of typing it again. Never a code or a file. */
  const stepCode = journey?.current_step;
  useEffect(() => {
    if (!journey) return;
    const current = journey.steps.find((s) => s.code === stepCode);
    const seed = {};
    for (const f of current?.fields ?? []) {
      if (['otp', 'file', 'consent'].includes(f.type)) continue;
      if (journey.form?.[f.name] !== undefined && journey.form[f.name] !== null) seed[f.name] = journey.form[f.name];
    }
    setValues(seed);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [stepCode]);

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
          <p>A {brand.name} representative will call you shortly to finish it with you.</p>
          <div className="notice" style={{ textAlign: 'left', width: '100%' }}>
            <span className="material-symbols-rounded" aria-hidden>call</span>
            <div>
              Need it sooner? Call <HelpLine /> and quote application reference{' '}
              <code>{String(journey.resume_token).slice(0, 8).toUpperCase()}</code>.
            </div>
          </div>
        </section>
      </div>
    );
  }

  /* Sent back, with no step named.
   *
   * The portal raises objections without saying which of our steps is wrong,
   * so there is nothing for the applicant to fill in yet -- but there IS
   * something to tell them, and the reason is the whole point of an objection.
   * Saying "being verified" here would be the version that makes people ring
   * the branch. */
  if (journey.objection && (!step || step.waits)) return <Objected journey={journey} />;

  /* The applicant's part is over.
   *
   * The step they are on is one they cannot fill in -- Bonanza reviews the
   * application and then the depository confirms it. Falling through to the
   * form branch below would draw a form with no fields in it. */
  if (step?.waits) return <Submitted journey={journey} />;

  /* ---- active step ---- */
  const setValue = (name, v) => setValues((prev) => ({ ...prev, [name]: v }));

  /* A field shown only for one answer -- the nominees for "Add nominee", the
     declaration for "Opt out" -- is drawn and required only then. */
  const isShown = (f) => !f.shown_when || values[f.shown_when.field] === f.shown_when.equals;
  const shownFields = (step?.fields || []).filter(isShown);
  const missing = shownFields.filter((f) => {
    if (!f.required && !f.required_when_shown) return false;
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
      // Every problem at once, so three nominees' mistakes are not found one submit at a time.
      const problems = err.payload?.problems ?? [];
      setError(problems.length > 1 ? problems.map((p) => p.message).join(' · ') : err.message);
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
              Taking longer than usual on this step? Call <HelpLine /> and we will complete it with you.
            </div>
          )}
          {/* Why they are back on a step they already did. Without this the
              resume link reopens a filled-in form for no stated reason, which
              reads as the application having been lost. */}
          {journey.objection && (
            <div className="warnbox">
              <strong>One thing needs correcting.</strong> {journey.objection.text}
              <div className="tiny" style={{ marginTop: 4 }}>
                Everything else you sent is saved. Correct this step and your application goes
                straight back for checking.
              </div>
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
              {shownFields.map((f) => (
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
        {field.name === 'digilocker_consent' && (
          <div className="hint">You will be redirected to DigiLocker to authorise the fetch. In this demo the fetch is simulated.</div>
        )}
      </div>
    );
  }

  if (field.type === 'nominees') return <NomineesField field={field} value={value} onChange={onChange} />;

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
        /* QA-34. The step declares these and only `required` was passed on.
           A courtesy -- the server checks the same rules. */
        pattern={field.pattern}
        title={field.help}
        min={field.min}
        max={field.type === 'date' ? new Date().toISOString().slice(0, 10) : field.max}
      />
      {field.help && <div className="hint">{field.help}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- nominees */

const EMPTY_NOMINEE = {
  name: '', relationship: '', id_type: 'PAN', id_number: '', address: '', mobile: '', email: '',
  minor: false, dob: '', guardian_name: '', guardian_relation: '', share: '', may_operate: false, operate_limit_pct: '',
};

/**
 * Up to ten nominees, as SEBI's January 2025 circular allows.
 *
 * Each nominee is a small form of its own: who they are, one identity number
 * (the number only, never the document), how to reach them, and their share.
 * A minor nominee also needs a date of birth, and can have a guardian. Shares
 * are all given and add up to 100, or all left blank and split equally; the
 * running total says which. The server checks all of it again.
 */
function NomineesField({ field, value, onChange }) {
  const list = Array.isArray(value) && value.length ? value : [EMPTY_NOMINEE];
  const max = field.max ?? 10;

  /* Choosing "Add nominee" starts with one nominee to fill in. */
  useEffect(() => {
    if (!Array.isArray(value) || !value.length) onChange([{ ...EMPTY_NOMINEE }]);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const update = (i, patch) => onChange(list.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  // One nominee at most may operate the account; choosing one clears the rest.
  const setOperator = (i, on) => onChange(list.map((n, j) => ({ ...n, may_operate: j === i ? on : (on ? false : n.may_operate) })));
  const given = list.filter((n) => String(n.share ?? '').trim() !== '');
  const total = Math.round(given.reduce((s, n) => s + Number(n.share || 0), 0) * 100) / 100;

  return (
    <div className="field nominees">
      <label>{field.label}</label>
      {list.map((n, i) => {
        const id = (k) => `nominee-${i}-${k}`;
        /* `{ key, label, ...props }`: an object, so a field called "share" is
           not read by the icon check as a request for the share icon. */
        const input = ({ key: k, label, ...props }) => (
          <div className="field">
            <label htmlFor={id(k)}>{label}</label>
            <input id={id(k)} value={n[k] ?? ''} onChange={(e) => update(i, { [k]: e.target.value })} {...props} />
          </div>
        );
        return (
          <fieldset key={i} className="card" style={{ padding: 14, marginBottom: 12 }}>
            <legend className="row" style={{ gap: 8 }}>
              <strong>Nominee {i + 1}</strong>
              {list.length > 1 && (
                <button type="button" className="btn-sm" onClick={() => onChange(list.filter((_, j) => j !== i))}>Remove</button>
              )}
            </legend>
            {input({ key: 'name', label: 'Full name' })}
            <div className="field">
              <label htmlFor={id('relationship')}>Relationship to you</label>
              <select id={id('relationship')} value={n.relationship} onChange={(e) => update(i, { relationship: e.target.value })}>
                <option value="">Select…</option>
                {(field.relationships ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={id('id_type')}>Identity number</label>
              <div className="row">
                <select id={id('id_type')} value={n.id_type} onChange={(e) => update(i, { id_type: e.target.value, id_number: '' })} style={{ maxWidth: 230 }}>
                  {(field.id_types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input aria-label={`Nominee ${i + 1} ${n.id_type} number`} value={n.id_number}
                  onChange={(e) => update(i, { id_number: e.target.value.toUpperCase() })}
                  inputMode={n.id_type.startsWith('Aadhaar') ? 'numeric' : undefined}
                  maxLength={n.id_type.startsWith('Aadhaar') ? 4 : 20}
                  placeholder={n.id_type === 'PAN' ? 'ABCDE1234F' : n.id_type.startsWith('Aadhaar') ? 'Last 4 digits' : 'MH1420110062821'} />
              </div>
              <div className="hint">The number only. You do not need to upload the document.</div>
            </div>
            <div className="field">
              <label htmlFor={id('address')}>Postal address</label>
              <textarea id={id('address')} value={n.address} onChange={(e) => update(i, { address: e.target.value })} style={{ minHeight: 56 }} />
            </div>
            <div className="row wrap" style={{ gap: 12 }}>
              {input({ key: 'mobile', label: 'Mobile number', type: 'tel', inputMode: 'numeric', maxLength: 10 })}
              {input({ key: 'email', label: 'Email address', type: 'email' })}
            </div>
            <label className="row" style={{ gap: 8, margin: '6px 0' }}>
              <input type="checkbox" checked={!!n.minor} onChange={(e) => update(i, { minor: e.target.checked, may_operate: e.target.checked ? false : n.may_operate })} />
              <span>This nominee is under 18</span>
            </label>
            {n.minor && (
              <div className="row wrap" style={{ gap: 12 }}>
                {input({ key: 'dob', label: 'Date of birth', type: 'date', max: new Date().toISOString().slice(0, 10) })}
                {input({ key: 'guardian_name', label: 'Guardian (optional)' })}
                {input({ key: 'guardian_relation', label: 'Guardian\'s relationship to the nominee (optional)' })}
              </div>
            )}
            {input({ key: 'share', label: 'Share (%)', type: 'number', min: 0.01, max: 100, step: 0.01, placeholder: 'Leave blank to split equally' })}
            {!n.minor && (
              <>
                <label className="row" style={{ gap: 8, margin: '6px 0' }}>
                  <input type="checkbox" checked={!!n.may_operate} onChange={(e) => setOperator(i, e.target.checked)} />
                  <span>May operate my account if I become physically incapacitated (optional)</span>
                </label>
                {n.may_operate && input({ key: 'operate_limit_pct', label: 'Up to this share of my holdings (%)', type: 'number', min: 1, max: 100, placeholder: 'Leave blank for no limit' })}
              </>
            )}
          </fieldset>
        );
      })}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="hint">
          {given.length === 0
            ? `Shares split equally: ${Math.round(10000 / list.length) / 100}% each.`
            : given.length === list.length ? `Shares add up to ${total}%${total === 100 ? '.' : ' — they must add up to 100%.'}`
              : 'Give every nominee a share, or leave every share blank to split equally.'}
        </span>
        {list.length < max && (
          <button type="button" onClick={() => onChange([...list, { ...EMPTY_NOMINEE }])}>Add another nominee</button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- done */

/**
 * Sent back, with no step for the applicant to redo.
 *
 * They are told what is wrong and that somebody will call: an objection the
 * portal raised names a reason, not one of our steps, so there is nothing to
 * put in front of them until a reviewer decides what has to change.
 */
function Objected({ journey }) {
  const { brand } = useBrand();
  return (
    <div className="portal-body">
      <section className="glass section-card outcome-card">
        <span className="outcome-icon material-symbols-rounded is-paused" aria-hidden>help</span>
        <h1>We need to check one thing</h1>
        <p className="muted">{journey.objection?.text}</p>
        <p>
          Nothing you sent has been lost, and your application has not been rejected.
          A {brand.name} representative will call you to put this right.
        </p>

        <div className="notice" style={{ textAlign: 'left', width: '100%' }}>
          <span className="material-symbols-rounded" aria-hidden>call</span>
          <div>
            Want to sort it now? Call <HelpLine /> and quote application reference{' '}
            <code>{String(journey.resume_token).slice(0, 8).toUpperCase()}</code>.
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Everything is in, and somebody else is holding it.
 *
 * Deliberately not the "Onboarding successful" screen: the account is not open
 * yet, and telling an applicant it is would be the one thing on this surface
 * they would remember. It says what we have, what happens next, and how to
 * reach somebody -- and it does not quote an internal verification state.
 */
function Submitted({ journey }) {
  return (
    <div className="portal-body">
      <section className="glass section-card outcome-card">
        <span className="outcome-icon material-symbols-rounded is-waiting" aria-hidden>fact_check</span>
        <h1>We have everything we need</h1>
        <p className="muted">
          Your {journey.product?.name} application is submitted and being verified.
          There is nothing more for you to do.
        </p>

        <div className="outcome-stats">
          <div className="hero-stat"><strong>{journey.steps_done}</strong><span>steps completed</span></div>
          <div className="hero-stat"><strong>{mins(journey.elapsed_s)}</strong><span>your time</span></div>
          <div className="hero-stat"><strong>1</strong><span>working day to verify</span></div>
        </div>

        <div className="notice" style={{ textAlign: 'left', width: '100%' }}>
          <span className="material-symbols-rounded" aria-hidden>schedule</span>
          <div>
            <strong>What happens next.</strong> Our operations team checks your documents and the
            depository confirms your demat account. You will receive your client code and login
            details by email once that is done.
          </div>
        </div>

        <div className="notice" style={{ textAlign: 'left', width: '100%' }}>
          <span className="material-symbols-rounded" aria-hidden>call</span>
          <div>
            Any questions? Call <HelpLine /> and quote application reference{' '}
            <code>{String(journey.resume_token).slice(0, 8).toUpperCase()}</code>.
          </div>
        </div>
      </section>
    </div>
  );
}

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
