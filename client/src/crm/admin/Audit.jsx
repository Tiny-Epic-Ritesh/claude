import { dateTime } from '../../api.js';
import { useApi, Loading } from '../../components/ui.jsx';

/*
 * Lifted out of Admin.jsx, which held eleven Setup screens in one file and so
 * shipped all eleven to anyone who opened any one of them. The code is
 * unchanged by the move; only the imports are new.
 */

export function Audit() {
  const [rows, { loading }] = useApi('/admin/audit');
  if (loading) return <Loading />;
  return (
    <section className="card">
      <div className="card-head"><h2>Audit log</h2><span className="tiny muted">Last 300 events</span></div>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td>
              <td className="small">{a.user_name || 'system'}</td>
              <td><span className="badge">{a.action}</span></td>
              <td className="small muted">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ''}</td>
              <td className="tiny muted" style={{ maxWidth: 380, wordBreak: 'break-word' }}>{a.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* --------------------------------------------------------- connectors */

/**
 * Meta — Facebook and Instagram.
 *
 * The screen exists to answer two questions honestly: what is actually wired,
 * and which capability is switched off on purpose rather than by omission.
 * A connector page that shows four green ticks when nothing is configured is
 * how integrations get signed off before they work.
 */
