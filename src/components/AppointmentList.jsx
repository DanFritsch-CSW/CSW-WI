import { useState, useMemo } from 'react'

/**
 * Expandable section showing row-level appointments for the day.
 * Rendered at the bottom of FacilityPanel. Collapsed by default.
 *
 * Columns: Lookup Code | Type | Scheduled Arrival | Notes
 */
export default function AppointmentList({ appointments, loading, facilityCode, date }) {
  const [expanded, setExpanded] = useState(false)

  const count = appointments?.length ?? 0

  const sorted = useMemo(() => {
    if (!Array.isArray(appointments)) return []
    return [...appointments].sort((a, b) => {
      const aTime = a.scheduled_arrival || ''
      const bTime = b.scheduled_arrival || ''
      return aTime.localeCompare(bTime)
    })
  }, [appointments])

  return (
    <section className="appt-list-section">
      <button
        type="button"
        className="appt-list-toggle"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className="appt-list-toggle-chevron" aria-hidden="true">
          {expanded ? '▼' : '▶'}
        </span>
        <span className="appt-list-toggle-label">
          All Appointments
          {!loading && count > 0 && (
            <span className="appt-list-toggle-count"> ({count})</span>
          )}
          {loading && <span className="appt-list-toggle-count"> (loading…)</span>}
        </span>
      </button>

      {expanded && (
        <div className="appt-list-body">
          {loading && (
            <div className="appt-list-empty">Loading appointments…</div>
          )}
          {!loading && count === 0 && (
            <div className="appt-list-empty">
              No appointments scheduled for {facilityCode} on {date}.
            </div>
          )}
          {!loading && count > 0 && (
            <table className="appt-list-table">
              <thead>
                <tr>
                  <th className="appt-list-col-lookup">Lookup Code</th>
                  <th className="appt-list-col-type">Type</th>
                  <th className="appt-list-col-time">Scheduled Arrival</th>
                  <th className="appt-list-col-notes">Notes</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((a, idx) => (
                  <tr key={`${a.lookup_code}-${idx}`}>
                    <td className="appt-list-col-lookup appt-list-mono">
                      {a.lookup_code || '—'}
                    </td>
                    <td className="appt-list-col-type">
                      <TypeBadge type={a.type} />
                    </td>
                    <td className="appt-list-col-time appt-list-mono">
                      {formatArrival(a.scheduled_arrival)}
                    </td>
                    <td className="appt-list-col-notes">
                      {a.notes || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}

function TypeBadge({ type }) {
  if (!type) return <span>—</span>
  const t = type.toLowerCase()
  let cls = 'appt-list-type-badge'
  if (t.includes('inbound'))  cls += ' appt-list-type-badge--inbound'
  else if (t.includes('outbound')) cls += ' appt-list-type-badge--outbound'
  const label = type
    .replace(/^Inbound\b/i, 'In')
    .replace(/^Outbound\b/i, 'Out')
    .replace(/Work-In/i, 'WI')
  return <span className={cls}>{label}</span>
}

function formatArrival(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return iso
  }
}
