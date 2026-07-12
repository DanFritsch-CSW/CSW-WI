import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  fetchPrePickStatus, STATUS_META, pickDifficultyLabel, pickDifficultyScore,
  formatArrivalTime, isPriorityAppt,
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
 * Priority customers/carriers (constants.js PRIORITY_CUSTOMERS, added
 * 2026-07-12) are pinned to the top of the list regardless of sort mode,
 * marked with a gold star + gold row border.
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

  const sorted = useMemo(() => {
    const byTime = [...appointments].sort((a, b) =>
      (a.scheduledArrival || '').localeCompare(b.scheduledArrival || '')
    )
    const applySort = (list) =>
      sortMode === 'difficulty'
        ? [...list].sort((a, b) =>
            pickDifficultyScore(b.pickLocations, b.rehandleRisk) -
            pickDifficultyScore(a.pickLocations, a.rehandleRisk)
          )
        : list

    // Priority customers/carriers pinned to top regardless of sort mode,
    // each group sorted internally by the chosen mode.
    const priorityGroup = byTime.filter((a) => isPriorityAppt(a))
    const restGroup = byTime.filter((a) => !isPriorityAppt(a))
    return [...applySort(priorityGroup), ...applySort(restGroup)]
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
        const priority = isPriorityAppt(appt)

        return (
          <div key={`${appt.lookupCode}-${idx}`}>
            <div
              className={`pps-row${priority ? ' pps-row--priority' : ''}`}
              onClick={() => hasDetail && toggleExpand(idx)}
              style={{ cursor: hasDetail ? 'pointer' : 'default' }}
            >
              <span className="pps-time">{formatArrivalTime(appt.scheduledArrival)}</span>
              <span className={`pps-badge pps-badge--${meta.tone}`}>{meta.label}</span>

              <div className="pps-main">
                <div className="pps-customer">
                  {priority && <span className="pps-priority-star" title="Priority customer/carrier">★</span>}
                  {appt.carrierName || appt.lookupCode || 'Unknown'}
                </div>
                <div className="pps-order">
                  {appt.orderLookupCode || appt.lookupCode}
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
        Pre-picked = 100% of expected cases completed, nothing left to do. Pick difficulty reflects whether a pick location mixes multiple lots — not pallet count. Gold-star orders (priority customers/carriers) are always pinned to the top.
      </div>
    </div>
  )
}
