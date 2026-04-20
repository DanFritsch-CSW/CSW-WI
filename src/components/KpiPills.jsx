function fmtDelta(v) {
  if (v == null) return '--'
  return v >= 0 ? `+${parseFloat(v.toFixed(1))}` : `${parseFloat(v.toFixed(1))}`
}

function Pill({ label, value, color, isDelta, delta: deltaVal }) {
  return (
    <div className="kpill" style={{ borderTopColor: color, borderTopWidth: 2 }}>
      <span className="kpill-label">{label}</span>
      <span className="kpill-value" style={{ color }}>{value}</span>
      {deltaVal != null && (
        <span className={`kpill-delta ${deltaVal >= 0 ? 'up' : 'down'}`}>
          {deltaVal >= 0 ? '+' : ''}{deltaVal}
        </span>
      )}
    </div>
  )
}

export default function KpiPills({ data, color }) {
  const deltaColor = data.delta != null
    ? (data.delta >= 0 ? '#3dba7e' : '#e05a5a')
    : color

  return (
    <div className="kpi-stack">

      {/* Row 1 — hero: Total Appointments */}
      <div className="kpi-hero" style={{ borderTopColor: color }}>
        <span className="kpi-hero-label">Total Appointments</span>
        <span className="kpi-hero-value" style={{ color }}>{data.appts ?? '--'}</span>
        <div className="kpi-hero-glow" style={{ background: color }} />
      </div>

      {/* Row 2 — Est Drops · Inbound · Outbound */}
      <div className="kpi-row">
        <Pill label="Est Drops" value={data.drops ?? '--'} color={color} />
        <Pill label="Inbound"   value={data.inb   ?? '--'} color={color} />
        <Pill label="Outbound"  value={data.out   ?? '--'} color={color} />
      </div>

      {/* Row 3 — Labor Available · Daily +/- */}
      <div className="kpi-row">
        <Pill label="Labor Available" value={data.labor ?? '--'} color={color} />
        <Pill label="Daily +/-" value={fmtDelta(data.delta)} color={deltaColor} />
      </div>

    </div>
  )
}
