import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  fetchPrePickStatus, STATUS_META, pickDifficultyLabel, pickDifficultyScore,
  formatArrivalTime,
} from '../lib/prePickStatus.js'
import '../styles/prepick-status.css'

/**
 * Pre-Picked Order Status — Madison-only, Daily view.
 *
 * Shows every outbound appointment for the day with pick-completion status
 * (cases-based, not task-count-based — see fetchPrePickStatus header) and a
 * plain-language pick-difficulty label. Difficulty is driven by whether a
 * pick location mixes multiple lots, not raw pallet count — see
 * netlify/functions/motherduck-prepick-status.cjs for the full definition.
 *
 * No raw scores are ever rendered (per Dan, 2026-07-11) — only the plain-
 * language bands (Easy grab / Some digging / Heavy digging / Not assigned
 * yet). The underlying numbers still drive sort order.
 *
 * Main row label is the project/customer name (gold.truck_appointments
 * .project_name, e.g. "Novonesis - Dry - CSW-Madison"), NOT the carrier —
 * per Dan, 2026-07-13: carrier names like "FORT"/"LESLIE TRANS" aren't
 * useful to highlight, the customer/project is what matters.
 *
 * Priority-customer highlighting (gold star/border, pinned sort, stat
 * card) was added 2026-07-12 and removed 2026-07-13 per Dan — "not needed
 * for the time being." The underlying isPriorityAppt/PRIORITY_CUSTOMERS
 * helper still exists in lib/prePickStatus.js and constants.js if this
 * needs to come back later; it's just unused here now.
 *
 * Stat strip (added 2026-07-12): white cards deliberately NOT themed to
 * match the site's dark background — per Dan, he wants them to pop the
 * same way they did in the JSX mockup preview, not blend in.
 */
export default function PrePickStatus({ facilityId, planDate }) {
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sortMode, setSortMode] = useState('time') // 'time' | 'difficulty'
  const [expandedRow, setExpandedRow] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchPrePickStatus(facilityId, planDate)
      .then(({ appointments: rows }) => { if (!cancelled) setAppointments(rows || []) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [facilityId, planDate])

  const counts = useMemo(() => {
    const total = appointments.length
    const ready = appointments.filter(a => a.status === 'ready').length
    const needsAttention = appointments.filter(a => a.status === 'not-started' || a.status === 'unresolved').length
    const noOrder = appointments.filter(a => a.status === 'placeholder').length
    return { total, ready, needsAttention, noOrder }
  }, [appointments])

  const sorted = useMemo(() => {
    const byTime = [...appointments].sort((a, b) =>
      (a.scheduledArrival || '').localeCompare(b.scheduledArrival || '')
    )
    if (sortMode !== 'difficulty') return byTime
    return [...byTime].sort((a, b) =>
      pickDifficultyScore(b.pickLocations, b.rehandleRisk) -
      pickDifficultyScore(a.pickLocations, a.rehandleRisk)
    )
  }, [appointments, sortMode])

  const toggleSort = useCallback(() => {
    setSortMode(m => (m === 'time' ? 'difficulty' : 'time'))
  }, [])

  const toggleExpand = useCallback((idx) => {
    setExpandedRow(prev => (prev === idx ? null : idx))
  }, [])

  return (
    <div className="pps-section">
      <div className="pps-header">
        <span className="pps-title">Pre-Picked Order Status ({sorted.length})</span>
        <button type="button" className="pps-sort-btn" onClick={toggleSort}>
          Sort: {sortMode === 'time' ? 'Appt time' : 'Pick difficulty'}
        </button>
      </div>

      {!loading && !error && appointments.length > 0 && (
        <div className="pps-stat-strip">
          <div className="pps-stat-card">
            <span className="pps-stat-label">Total Appts</span>
            <span className="pps-stat-value" style={{ color: '#12232E' }}>{counts.total}</span>
          </div>
          <div className="pps-stat-card">
            <span className="pps-stat-label">Ready</span>
            <span className="pps-stat-value" style={{ color: '#1F8A5F' }}>{counts.ready}</span>
          </div>
          <div className="pps-stat-card">
            <span className="pps-stat-label">Needs Attention</span>
            <span className="pps-stat-value" style={{ color: '#C77D22' }}>{counts.needsAttention}</span>
          </div>
          <div className="pps-stat-card">
            <span className="pps-stat-label">No Order</span>
            <span className="pps-stat-value" style={{ color: '#93A1AA' }}>{counts.noOrder}</span>
          </div>
        </div>
      )}

      {loading && <div className="pps-empty">Loading pre-pick status…</div>}
      {!loading && error && <div className="pps-empty">Couldn't load pre-pick status: {error}</div>}
      {!loading && !error && sorted.length === 0 && (
        <div className="pps-empty">No outbound appointments scheduled.</div>
      )}

      {!loading && !error && sorted.map((appt, idx) => {
        const meta = STATUS_META[appt.status] || STATUS_META.placeholder
        const difficulty = pickDifficultyLabel(appt.pickLocations, appt.rehandleRisk)
        const difficultyTone = difficulty === 'Heavy digging' ? 'bad'
          : difficulty === 'Some digging' ? 'warn'
          : difficulty === 'Easy grab' ? 'good'
          : 'neutral'
        const hasProgress = appt.expectedCases != null
        const hasDetail = Boolean(appt.warehouseMismatch) ||
          (appt.pickLocations != null && appt.status !== 'ready')
        const expanded = expandedRow === idx
        const displayName = appt.projectName || appt.carrierName || appt.lookupCode || 'Unknown'

        return (
          <div key={`${appt.lookupCode}-${idx}`}>
            <div
              className="pps-row"
              onClick={() => hasDetail && toggleExpand(idx)}
              style={{ cursor: hasDetail ? 'pointer' : 'default' }}
            >
              <span className="pps-time">{formatArrivalTime(appt.scheduledArrival)}</span>
              <span className={`pps-badge pps-badge--${meta.tone}`}>{meta.label}</span>

              <div className="pps-main">
                <div className="pps-customer">{displayName}</div>
                <div className="pps-order">
                  {appt.orderLookupCode || appt.lookupCode}
                  {appt.carrierName ? ` · ${appt.carrierName}` : ''}
                  {appt.notes ? ` · ${appt.notes}` : ''}
                </div>
              </div>

              {hasProgress && (
                <span className="pps-progress">
                  {Math.round(appt.actualCases)}/{Math.round(appt.expectedCases)}
                </span>
              )}

              {difficulty && (
                <span className={`pps-difficulty pps-difficulty--${difficultyTone}`}>
                  {difficulty}
                </span>
              )}
              {!difficulty && appt.status !== 'ready' && appt.status !== 'placeholder' && appt.status !== 'unresolved' && (
                <span className="pps-difficulty pps-difficulty--neutral">Not assigned yet</span>
              )}

              {hasDetail && <span className="pps-detail-toggle">{expanded ? '▲' : '▼'}</span>}
            </div>

            {expanded && hasDetail && (
              <div className="pps-detail">
                {appt.pickLocations != null && appt.status !== 'ready' && (
                  <div>
                    Picker needs to visit {appt.pickLocations} spot{appt.pickLocations === 1 ? '' : 's'} in the warehouse.
                    {appt.rehandleRisk > 0 && (
                      <> At least one of those spots has multiple lots mixed together ({appt.rehandleRisk} pallets to sort through to find the right one).</>
                    )}
                  </div>
                )}
                {appt.warehouseMismatch && (
                  <div className="pps-detail-flag">
                    Order is tagged to a different facility in Datex (warehouse ID {appt.warehouseMismatch.orderWarehouseId} instead of {appt.warehouseMismatch.expectedWarehouseId}) — likely a data-entry error worth checking before it ships.
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <div className="pps-footnote">
        Pre-picked = 100% of expected cases completed, nothing left to do. Pick difficulty reflects whether a pick location mixes multiple lots — not pallet count.
      </div>
    </div>
  )
}
