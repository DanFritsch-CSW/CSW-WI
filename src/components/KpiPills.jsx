export default function KpiPills({ data, color }) {
  const fmtDelta = v => v != null ? (v >= 0 ? `+${parseFloat(v.toFixed(1))}` : `${parseFloat(v.toFixed(1))}`) : '--'

  function Pill({ label, value, delta, isDelta }) {
    return (
      <div className="kpill" style={{ borderTopColor: color, borderTopWidth: 2 }}>
        <span className="kpill-label">{label}</span>
        <span
          className="kpill-value"
          style={isDelta && data.delta != null
            ? { color: data.delta >= 0 ? '#3dba7e' : '#e05a5a' }
            : { color }}
        >{value}</span>
        {delta != null && (
          <span className={`kpill-delta ${delta >= 0 ? 'up' : 'down'}`}>
            {delta >= 0 ? '+' : ''}{delta}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="kpi-stack">
      <div className="kpi-row">
        <Pill label="Appointments" value={data.appts ?? '--'} />
        <Pill label="Inbound"      value={data.inb   ?? '--'} />
        <Pill label="Outbound"     value={data.out   ?? '--'} />
      </div>
      <div className="kpi-row">
        <Pill label="Labor Avail" value={data.labor ?? '--'} delta={data.laborDelta} />
        <Pill label="Daily +/-"   value={fmtDelta(data.delta)} isDelta />
      </div>
    </div>
  )
}
