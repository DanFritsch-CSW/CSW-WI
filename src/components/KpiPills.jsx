export default function KpiPills({ data, color }) {
  const fmtDelta = v => v != null ? (v >= 0 ? `+${v}` : `${v}`) : '--'
  const pills = [
    { label: 'Appointments', value: data.appts ?? '--', delta: null },
    { label: 'Inbound',      value: data.inb   ?? '--', delta: null },
    { label: 'Outbound',     value: data.out   ?? '--', delta: null },
    { label: 'Labor Avail',  value: data.labor ?? '--', delta: data.laborDelta },
    { label: 'Utilization',  value: data.util  != null ? `${data.util}%` : '--', delta: null },
    { label: 'Daily +/-',    value: fmtDelta(data.delta), delta: null, isDelta: true },
  ]

  return (
    <div className="kpi-row">
      {pills.map(p => (
        <div className="kpill" key={p.label} style={{ borderTopColor: color, borderTopWidth: 2 }}>
          <span className="kpill-label">{p.label}</span>
          <span
            className="kpill-value"
            style={p.isDelta && data.delta != null
              ? { color: data.delta >= 0 ? '#3dba7e' : '#e05a5a' }
              : { color }}
          >{p.value}</span>
          {p.delta != null && (
            <span className={`kpill-delta ${p.delta >= 0 ? 'up' : 'down'}`}>
              {p.delta >= 0 ? '+' : ''}{p.delta}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
