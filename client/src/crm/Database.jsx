/**
 * Database size, per book and per object (P2-19).
 *
 * THE HONESTY PROBLEM THIS SCREEN HAS
 *
 * The total and the per-object bytes are real — SQLite reports actual page
 * usage. The per-business split is not: both books share the same pages, and
 * apportioning by row share is the closest anyone can get without reading every
 * row. So every per-business figure on this screen is marked as an estimate,
 * every time, rather than once in a footnote nobody reads.
 *
 * That matters because a number that looks precise and is not will eventually
 * end up in a capacity plan or a licensing conversation. An obviously rounded
 * number is less useful and much safer.
 *
 * The screen also shows what is NOT an object — logs, sessions, configuration
 * history. On a young database that is most of the file, and leaving it out
 * would make the per-object figures add up to far less than the total. The
 * first question anybody asks about a size report is why the numbers do not add
 * up.
 */

import { useApi, Loading, ErrorBanner, Icon } from '../components/ui.jsx';

const mb = (b) => {
  const n = Number(b) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

export default function Database() {
  const [data, { loading, error }] = useApi('/setup/database');
  if (loading || !data) return <Loading />;
  if (error) return <ErrorBanner error={error} />;

  const objectBytes = data.objects.reduce((s, o) => s + o.bytes, 0);
  const otherBytes = data.other.reduce((s, o) => s + o.bytes, 0);
  const biggestOther = data.other[0];

  return (
    <section className="stack" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-head">
          <div>
            <h2>{mb(data.total.total)} in use</h2>
            <span className="tiny muted">
              {data.total.pages.toLocaleString('en-IN')} pages of {data.total.page_size} bytes
            </span>
          </div>
        </div>

        <dl className="setup-facts">
          <div><dt>Objects</dt><dd>{mb(objectBytes)}</dd></div>
          <div><dt>Logs, history, sessions</dt><dd>{mb(otherBytes)}</dd></div>
          <div>
            <dt>Reclaimable</dt>
            <dd>
              {mb(data.total.reclaimable)}
              {/* Space the file holds and is not using. Worth naming, because
                  a database that has stopped growing but is not shrinking looks
                  like a measurement error until you know this exists. */}
              {data.total.reclaimable > data.total.total * 0.2 && (
                <div className="tiny muted">Freed by deletes; a VACUUM returns it to the disk.</div>
              )}
            </dd>
          </div>
          <div>
            <dt>Growth</dt>
            <dd>
              {data.growth.per_day === null
                ? <span className="muted">Not enough history yet</span>
                : <>{mb(data.growth.per_day)}/day over {data.growth.over_days} days</>}
              {data.growth.per_lead && (
                <div className="tiny muted">≈ {mb(data.growth.per_lead)} per lead, all in</div>
              )}
            </dd>
          </div>
        </dl>

        {/* The projection people actually want, and the reason it is offered
            rather than left to be worked out on a napkin wrongly. */}
        {data.growth.per_lead && (
          <p className="tiny muted" style={{ margin: '10px 0 0' }}>
            At {mb(data.growth.per_lead)} per lead, the 495,118 leads in the legacy system
            would be roughly <strong>{mb(data.growth.per_lead * 495118)}</strong> — a rough
            figure from a small sample, not a capacity plan.
          </p>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>By object</h2>
            <span className="tiny muted">{data.split_note}</span>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Object</th><th className="num">Size</th><th className="num">Rows</th>
              {data.orgs.map((o) => <th key={o} className="num">{o} <em className="tiny muted">est.</em></th>)}
            </tr>
          </thead>
          <tbody>
            {data.objects.map((o) => (
              <tr key={o.object}>
                <td>
                  <div style={{ fontWeight: 550 }}>{o.label}</div>
                  <div className="tiny muted api-name">{o.table}</div>
                </td>
                <td className="num">{mb(o.bytes)}</td>
                <td className="num">{o.rows.toLocaleString('en-IN')}</td>
                {data.orgs.map((org) => (
                  <td key={org} className="num">
                    {o.estimated_bytes_by_org
                      ? <>{mb(o.estimated_bytes_by_org[org] ?? 0)}
                          <div className="tiny muted">{(o.by_org[org] ?? 0).toLocaleString('en-IN')} rows</div></>
                      /* A table with no sales_org column belongs to whatever it
                         hangs off. Saying "—" is honest; splitting it would be
                         inventing a number. */
                      : <span className="muted">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Everything else</h2>
            <span className="tiny muted">
              Logs, history and sessions — most of a young database, and none of it client records
            </span>
          </div>
        </div>

        {biggestOther && biggestOther.bytes > objectBytes && (
          <div className="glass notice notice-warn">
            <Icon name="warning" size={16} />
            <div>
              <strong>{biggestOther.table}</strong> is larger than every object put together
              ({mb(biggestOther.bytes)}). Check its retention period on the Logs screen — a log
              with no ceiling eventually costs more than the data it describes.
            </div>
          </div>
        )}

        <table>
          <thead><tr><th>Table</th><th className="num">Size</th></tr></thead>
          <tbody>
            {data.other.slice(0, 12).map((o) => (
              <tr key={o.table}>
                <td className="api-name small">{o.table}</td>
                <td className="num">{mb(o.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
