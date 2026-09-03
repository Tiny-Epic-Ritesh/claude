import { useApi, Loading } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Journeys() {
  const [data, { loading }] = useApi('/admin/kyc/journeys');
  if (loading || !data) return <Loading />;

  return (
    <div className="stack">
      <div className="notice">
        The journey composer picks which of the {data.master_steps.length} master steps apply to each product, in what order,
        with per-step timers. Conditional steps (bank proof, income proof) only appear when the applicant's data triggers them.
      </div>
      {data.journeys.map((j) => (
        <section className="card" key={j.product.id}>
          <div className="card-head">
            <h2>{j.product.name}</h2>
            <span className="badge">{j.steps.length} steps</span>
          </div>
          <div className="card-body">
            <div className="row wrap" style={{ gap: 5 }}>
              {j.steps.map((s, i) => {
                const master = data.master_steps.find((m) => m.code === s.step_code);
                return (
                  <span key={s.step_code} className={`badge ${s.conditional_on ? 'badge-amber' : ''}`} title={s.conditional_on ? `Conditional: ${s.conditional_on}` : ''}>
                    {i + 1}. {master?.label || s.step_code}
                  </span>
                );
              })}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- rules */
