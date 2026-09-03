import { ROLE_LABEL } from '../../api.js';
import { useApi, Loading } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Sla() {
  const [sla, { loading }] = useApi('/admin/sla');
  const [cats] = useApi('/admin/categories');
  if (loading || !sla) return <Loading />;

  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-head"><h2>SLA policies</h2><span className="tiny muted">Business hours only · per product</span></div>
        <table>
          <thead><tr><th>Product</th><th>Priority</th><th className="num">Response</th><th className="num">Resolution</th></tr></thead>
          <tbody>
            {sla.policies.map((p) => (
              <tr key={p.id}>
                <td className="small">{p.product_name || 'All products'}</td>
                <td><span className="badge">{p.priority}</span></td>
                <td className="num small">{p.response_mins} min</td>
                <td className="num small">{Math.round(p.resolution_mins / 60)} h</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="card-body tiny muted">
          Defaults where no policy exists: {Object.entries(sla.defaults).map(([k, v]) => `${k} ${v.response_mins}m/${Math.round(v.resolution_mins / 60)}h`).join(' · ')}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Ticket categories</h2><span className="tiny muted">Drive auto-assignment</span></div>
        <table>
          <tbody>
            {(cats || []).map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="num"><span className="badge badge-blue">{ROLE_LABEL[c.auto_assign_role] || c.auto_assign_role || 'unassigned'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ templates */
