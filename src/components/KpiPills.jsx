function fmtDelta(v) {
  if (v == null) return '--'
  return v >= 0 ? `+${parseFloat(v.toFixed(1))}` : `${parseFloat(v.toFixed(1))}`
}

function r1(n) { return Math.round(n * 10) / 10 }

function fmtTime(date) {
  if (!date) return null
  const h = date.getHours()
  const m = date.getMinutes()
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`
}

function Pill({ label, value, color, delta: deltaVal, highlight }) {
  return (
    <div className="kpill" style={{ borderTopColor: color, borderTopWidth: 2, ...(highlight ? { background: 'var(--brand-bg)', borderColor: 'var(--brand-dim)' } : {}) }}>
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

  // Labor After Adjustments = totalHours + total adjustments
  const laborAfterAdj = data.totalHours != null
    ? r1(data.totalHours + (data.totalAdj ?? 0))
    : null

  // Color for Labor After Adj vs Labor Req comparison
  const adjColor = (laborAfterAdj != null && data.laborReq != null)
    ? (laborAfterAdj >= data.laborReq ? '#3dba7e' : '#e05a5a')
    : color

  const timeLabel = fmtTime(data.fetchedAt)

  // Total appointments is always an integer — fractions of appointments don't exist.
  const totalAppts = data.appts != null ? Math.round(data.appts) : '--'

  return (
    <div className="kpi-stack">

      {/* Row 1 — hero: Total Appointments */}
      <div className="kpi-hero" style={{ borderTopColor: color }}>
        <span className="kpi-hero-label">Total Appointments</span>
        <span className="kpi-hero-value" style={{ color }}>{totalAppts}</span>
        {timeLabel && <span className="kpi-hero-fetched">Data as of {timeLabel}</span>}
        <div className="kpi-hero-glow" style={{ background: color }} />
      </div>

      {/* Row 2 — Est Drops · Inbound · Outbound */}
      <div className="kpi-row">
        <Pill label="Est Drops" value={data.drops ?? '--'} color={color} />
        <Pill label="Inbound"   value={data.inb   ?? '--'} color={color} />
        <Pill label="Outbound"  value={data.out   ?? '--'} color={color} />
      </div>

      {/* Row 3 — Warehousemen · Total Hrs Available · Daily +/- */}
      <div className="kpi-row">
        <Pill label="Warehousemen"        value={data.labor      ?? '--'} color={color} />
        <Pill label="Total Hrs Avail"     value={data.totalHours ?? '--'} color={color} />
        <Pill label="Daily +/-"           value={fmtDelta(data.delta)}    color={deltaColor} />
      </div>

      {/* Row 4 — Labor Req Total · Labor After Adj */}
      <div className="kpi-row">
        <Pill label="Labor Req Total"    value={data.laborReq     != null ? r1(data.laborReq)  : '--'} color={color} />
        <Pill label="Labor After Adj"    value={laborAfterAdj     != null ? laborAfterAdj      : '--'} color={adjColor} />
      </div>

    </div>
  )
}
