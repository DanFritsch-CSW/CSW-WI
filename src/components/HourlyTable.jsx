function fmtHour(h) {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function r1(n) { return Math.round(n * 10) / 10 }
function fmtDelta(v) { return v >= 0 ? `+${v}` : `${v}` }

export default function HourlyTable({ hourlyData, estDrops = {}, color }) {
  if (!hourlyData?.length) return null

  const sorted = [...hourlyData].sort((a, b) => {
    const sa = a.h < 5 ? a.h + 24 : a.h
    const sb = b.h < 5 ? b.h + 24 : b.h
    return sa - sb
  })

  let cumul = 0
  const rows = sorted.map(r => {
    const final = r1(r.avail - r.req)
    cumul = r1(cumul + final)
    return { ...r, final, cumul, est: estDrops[r.h] ?? null }
  })

  const tot = {
    est:   rows.reduce((s, r) => s + (r.est ?? 0), 0),
    inb:   rows.reduce((s, r) => s + r.inb,   0),
    out:   rows.reduce((s, r) => s + r.out,   0),
    appts: rows.reduce((s, r) => s + r.appts, 0),
    req:   r1(rows.reduce((s, r) => s + r.req,   0)),
    avail: r1(rows.reduce((s, r) => s + r.avail, 0)),
    cumul: rows[rows.length - 1]?.cumul ?? 0,
  }

  return (
    <div className="hourly-table-wrap">
      <table className="hourly-table">
        <thead>
          <tr>
            <th>Hour</th>
            <th className="ht-est-col">EST Drops</th>
            <th>Inb</th>
            <th>Out</th>
            <th>Appts</th>
            <th>Labor Req</th>
            <th>Labor Avail</th>
            <th>Final +/-</th>
            <th>Cumul +/-</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.final < 0 ? 'ht-deficit' : ''}>
              <td className="ht-hour">{fmtHour(r.h)}</td>
              <td className="ht-est-col">
                {r.est !== null ? r.est : <span className="ht-est-empty">—</span>}
              </td>
              <td>{r.inb}</td>
              <td>{r.out}</td>
              <td style={{ color }}>{r.appts}</td>
              <td>{r.req}</td>
              <td>{r1(r.avail)}</td>
              <td className={r.final < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(r.final)}</td>
              <td className={r.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(r.cumul)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="ht-total">
            <td>Total</td>
            <td className="ht-est-col">{tot.est}</td>
            <td>{tot.inb}</td>
            <td>{tot.out}</td>
            <td style={{ color }}>{tot.appts}</td>
            <td>{tot.req}</td>
            <td>{tot.avail}</td>
            <td></td>
            <td className={tot.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(tot.cumul)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
