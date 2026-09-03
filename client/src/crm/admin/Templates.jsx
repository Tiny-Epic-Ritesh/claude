import { api } from '../../api.js';
import { useApi, Loading } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Templates() {
  const [rows, { loading, reload }] = useApi('/admin/templates');
  if (loading) return <Loading />;
  return (
    <section className="card">
      <div className="card-head"><h2>{rows.length} templates</h2></div>
      <table>
        <thead><tr><th>Name</th><th>Channel</th><th>Body</th><th>Approved</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td style={{ fontWeight: 545 }}>{t.name}</td>
              <td><span className="badge">{t.channel}</span></td>
              <td className="small muted" style={{ maxWidth: 460 }}>{t.body.slice(0, 150)}{t.body.length > 150 ? '…' : ''}</td>
              <td className="num">
                <button className="btn-sm" onClick={async () => { await api.patch(`/admin/templates/${t.id}`, { approved: t.approved ? 0 : 1 }); reload(); }}>
                  {t.approved ? 'Approved' : 'Approve'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* -------------------------------------------------------------- content */
