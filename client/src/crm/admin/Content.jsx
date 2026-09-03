import { shortDate, ROLE_LABEL } from '../../api.js';
import { useApi, Loading } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

/* -------------------------------------------------------------- content */

export function Content() {
  const [rows, { loading }] = useApi('/admin/content');
  if (loading) return <Loading />;
  return (
    <section className="card">
      <div className="card-head"><h2>Content library</h2><span className="tiny muted">Surfaces in the in-call pitch panel</span></div>
      <table>
        <thead><tr><th>Item</th><th>Type</th><th>Product</th><th>Owner role</th><th>Expiry</th><th className="num">Sends</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td style={{ fontWeight: 545 }}>{c.name}<div className="tiny muted">v{c.version}{c.kyc_step_code ? ` · step ${c.kyc_step_code}` : ''}</div></td>
              <td><span className="badge">{c.type}</span></td>
              <td className="small">{c.product_name || '—'}</td>
              <td className="small muted">{ROLE_LABEL[c.owner_role] || c.owner_role}</td>
              <td>
                {c.expired ? <span className="badge badge-red">Expired</span>
                  : c.expiring_soon ? <span className="badge badge-amber">{shortDate(c.expiry_date)}</span>
                    : <span className="small muted">{shortDate(c.expiry_date)}</span>}
              </td>
              <td className="num">{c.send_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
