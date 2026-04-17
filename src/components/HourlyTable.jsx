function fmtHour(h) {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function r1(n) { return Math.round(n * 10) / 10 }

export default function HourlyTable({ hourlyData, color }) {
  if (!hourlyData?.length) return null

  // Sort shift-correctly: 5am first, midnight rows after 11pm
  const sorted = [...hourlyData].sort((a, b) => {
    const sa = a.h < 5 ? a.h + 24 : a.h
    const sb = b.h < 5 ? b.h + 24 : b.h
    return sa - sb
  })

  let cumul = 0
  const rows = sorted.map(r => {
    const final = r1(r.avail - r.req)
    cumul = r1(cumul + final)
    return { ...r, final, cumul }
  })

  const tot = {
    drops:    rows.reduce((s, r) => s + r.drops,    0),
    inb:      rows.reduce((s, r) => s + r.inb,      0),
    out:      rows.reduce((s, r) => s + r.out,      0),
    appts:    rows.reduce((s, r) => s + r.appts,    0),
    req:      r1(rows.reduce((s, r) => s + r.req,      0)),
    rawStaff: r1(rows.reduce((s, r) => s + r.rawStaff, 0)),
    onBreak:  r1(rows.reduce((s, r) => s + r.onBreak,  0)),
    adjStaff: r1(rows.reduce((s, r) => s + r.adjStaff, 0)),
    whAdj:    r1(rows.reduce((s, r) => s + r.whAdj,    0)),
    avail:    r1(rows.reduce((s, r) => s + r.avail,    0)),
    cumul:    rows[rows.length - 1]?.cumul ?? 0,
  }

  const fmtDelta = v => v >= 0 ? `+${v}` : `${v}`

  return (
    <div className="hourly-table-wrap">
      <table className="hourly-table">
        <thead>
          <tr>
            <th>Hour</th>
            <th>Drops</th>
            <th>Inb</th>
            <th>Out</th>
            <th>Appts</th>
            <th>Labor Req</th>
            <th>Raw Staff</th>
            <th>On Break</th>
            <th>Adj Staff</th>
            <th>WH Adj</th>
            <th>Labor Avail</th>
            <th>Final +/-</th>
            <th>Cumul +/-</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.final < 0 ? 'ht-deficit' : ''}>
              <td className="ht-hour">{fmtHour(r.h)}</td>
              <td>{r.drops}</td>
              <td>{r.inb}</td>
              <td>{r.out}</td>
              <td style={{ color }}>{r.appts}</td>
              <td>{r.req}</td>
              <td>{r.rawStaff}</td>
              <td>{r.onBreak}</td>
              <td>{r.adjStaff}</td>
              <td>{r.whAdj}</td>
              <td>{r.avail}</td>
              <td className={r.final < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(r.final)}</td>
              <td className={r.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(r.cumul)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="ht-total">
            <td>Total</td>
            <td>{tot.drops}</td>
            <td>{tot.inb}</td>
            <td>{tot.out}</td>
            <td style={{ color }}>{tot.appts}</td>
            <td>{tot.req}</td>
            <td>{tot.rawStaff}</td>
            <td>{tot.onBreak}</td>
            <td>{tot.adjStaff}</td>
            <td>{tot.whAdj}</td>
            <td>{tot.avail}</td>
            <td></td>
            <td className={tot.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(tot.cumul)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
