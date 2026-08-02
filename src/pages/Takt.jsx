import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchTaktDaily, fetchTaktDailyByFacility } from '../lib/takt.js'
import NotifySettingsPanel from '../components/NotifySettingsPanel.jsx'
import '../styles/view-tabs.css'

// Takt — new top-level tab (added 2026-08-02), replacing Recruiting's old
// nav slot (Recruiting moved into the HR tab same session). Ungated per
// Dan's call — this is meant to be shown around, not locked down.
//
// Shows today's facility-level Efficiency/Utilization/Performance (same
// gold.takt_productivity_v2_agg formula validated for the Manager tab's
// Takt metric — see motherduck-takt-daily.cjs header), with a Mon–Sun
// week picker mirroring LaborPlanning.jsx's date nav. Click a facility
// card to drill into the full employee roster for that facility+day,
// sorted Performance highest → lowest (full roster, not just
// underperformers, per Dan's explicit call).
//
// KNOWN DATA LAG: the underlying table doesn't always have same-day rows
// yet (confirmed live 2026-08-02 — some facilities lag a partial day).
// Facilities with no rows for the selected date show "No data yet"
// rather than silently falling back to an earlier date.
//
// NOTIFY (added 2026-08-02, later same day): one NotifySettingsPanel per
// facility (drill-down view) plus one facility='all' panel on the main
// grid for a senior-leadership rollup. Backed by
// netlify/functions/takt-digest-run.cjs / takt-digest-test.cjs /
// lib/takt-digest-shared.cjs. Per Dan's explicit call, these digests
// ALWAYS summarize yesterday's numbers regardless of configured send
// time — see lib/takt-digest-shared.cjs header for why.

function todayISO() { return new Date().toISOString().slice(0, 10) }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00')
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().slice(0, 10)
}
function formatMDD(iso) {
  const d = new Date(iso + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function pctColor(pct) {
  if (pct == null) return 'var(--text-dim)'
  if (pct >= 100) return 'var(--green)'
  if (pct >= 85) return 'var(--brand)'
  if (pct >= 70) return 'var(--amber, #d4b84a)'
  return 'var(--red)'
}
function fmtPct(pct) { return pct == null ? '—' : `${pct.toFixed(1)}%` }

export default function Takt() {
  const [searchParams, setSearchParams] = useSearchParams()
  const planDate = searchParams.get('date') || todayISO()
  const drillFacility = searchParams.get('fac') || null

  function selectDate(date) { setSearchParams(prev => { prev.set('date', date); return prev }, { replace: true }) }
  function stepWeek(n) { selectDate(addDays(planDate, n)) }
  function openFacility(facId) { setSearchParams(prev => { prev.set('fac', facId); return prev }) }
  function closeFacility() { setSearchParams(prev => { prev.delete('fac'); return prev }) }

  const [facilities, setFacilities] = useState(null)
  const [error, setError] = useState(null)
  const [employees, setEmployees] = useState(null)
  const [employeesError, setEmployeesError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setFacilities(null)
    setError(null)
    fetchTaktDaily(planDate)
      .then(d => { if (!cancelled) setFacilities(d.facilities) })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [planDate])

  useEffect(() => {
    if (!drillFacility) { setEmployees(null); return }
    let cancelled = false
    setEmployees(null)
    setEmployeesError(null)
    fetchTaktDailyByFacility(planDate, drillFacility)
      .then(d => { if (!cancelled) setEmployees(d.employees) })
      .catch(e => { if (!cancelled) setEmployeesError(e.message) })
    return () => { cancelled = true }
  }, [planDate, drillFacility])

  const today = todayISO()
  const weekStart = mondayOf(planDate)
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const facMeta = FACILITY_LIST.find(f => f.id === drillFacility)
  const facRollup = facilities?.find(f => f.facility === drillFacility)

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title"><span className="page-title-gold">Takt</span> Performance</div>
          <div className="page-subtitle">Efficiency × Utilization, by facility · CSW 3PL</div>
        </div>
        <div className="day-selector">
          <button className="day-btn" onClick={() => stepWeek(-7)} style={{ padding: '6px 10px', fontSize: 14 }}>‹</button>
          <div style={{ display: 'flex', gap: 4 }}>
            {weekDays.map((iso, idx) => {
              const isActive = iso === planDate
              const isTodayTab = iso === today
              return (
                <button
                  key={iso}
                  className="day-btn"
                  onClick={() => selectDate(iso)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: 1, padding: '4px 10px', minWidth: 50, position: 'relative',
                    ...(isActive ? { borderColor: 'var(--brand)', color: 'var(--brand)', fontWeight: 600 } : { color: 'var(--text-secondary)' }),
                  }}
                >
                  <span style={{ fontSize: 10, opacity: 0.7 }}>{DAY_LABELS[idx]}</span>
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{formatMDD(iso)}</span>
                  {isTodayTab && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--brand)', position: 'absolute', bottom: 2 }} />
                  )}
                </button>
              )
            })}
          </div>
          <button className="day-btn" onClick={() => stepWeek(7)} style={{ padding: '6px 10px', fontSize: 14 }}>›</button>
          <input type="date" className="day-input" value={planDate} onChange={e => selectDate(e.target.value)} />
        </div>
      </div>

      {error && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">Couldn't load Takt data: {error}</span>
        </div>
      )}

      {!drillFacility ? (
        <>
          <NotifySettingsPanel
            facility="all"
            dashboardType="takt"
            functionName="takt-digest-test"
            manualTestBody={{ facility: 'all' }}
            contentDateLabel="yesterday"
            showSkipToNextValidDay={false}
            digestDescription="Posts a ranked Performance/Efficiency/Utilization summary across all 5 facilities to Front — for senior leadership. Always summarizes yesterday's numbers (regardless of send time) since same-day Takt data usually isn't fully in yet."
          />
          <FacilityGrid facilities={facilities} onOpen={openFacility} />
        </>
      ) : (
        <FacilityDrilldown
          facMeta={facMeta}
          facRollup={facRollup}
          employees={employees}
          error={employeesError}
          onBack={closeFacility}
        />
      )}
    </div>
  )
}

function FacilityGrid({ facilities, onOpen }) {
  if (!facilities) {
    return <div className="stub-page" style={{ opacity: 0.6 }}><p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading Takt data…</p></div>
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
      {FACILITY_LIST.map(fac => {
        const r = facilities.find(f => f.facility === fac.id)
        const hasData = r && r.employeeCount > 0
        return (
          <button
            key={fac.id}
            className="chart-card"
            onClick={() => onOpen(fac.id)}
            style={{ textAlign: 'left', cursor: 'pointer', border: `1px solid var(--border-subtle)`, borderTop: `3px solid ${fac.color}` }}
          >
            <div className="chart-header" style={{ marginBottom: 8 }}>
              <span className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="dot" style={{ background: fac.color }} />{fac.name}
              </span>
            </div>
            {!hasData ? (
              <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: '10px 0' }}>No data yet</div>
            ) : (
              <>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 700, color: pctColor(r.performance.pct) }}>
                  {fmtPct(r.performance.pct)}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Performance</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Efficiency</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: pctColor(r.efficiency.pct) }}>{fmtPct(r.efficiency.pct)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 4 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Utilization</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: pctColor(r.totalUtilization.pct) }}>{fmtPct(r.totalUtilization.pct)}</span>
                </div>
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-dim)' }}>
                  {r.employeeCount} employee{r.employeeCount === 1 ? '' : 's'} · click to view roster
                </div>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}

function FacilityDrilldown({ facMeta, facRollup, employees, error, onBack }) {
  return (
    <div>
      <button
        onClick={onBack}
        style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, marginBottom: 14, padding: 0 }}
      >
        ‹ Back to all facilities
      </button>

      <div className="page-header" style={{ marginBottom: 14 }}>
        <div>
          <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="dot" style={{ background: facMeta?.color }} />{facMeta?.name}
          </div>
          <div className="page-subtitle">Employee roster, Performance highest → lowest</div>
        </div>
        {facRollup && facRollup.employeeCount > 0 && (
          <div className="kpi-row" style={{ marginTop: 0 }}>
            <div className="kpill">
              <span className="kpill-label">Performance</span>
              <span className="kpill-value" style={{ color: pctColor(facRollup.performance.pct) }}>{fmtPct(facRollup.performance.pct)}</span>
            </div>
            <div className="kpill">
              <span className="kpill-label">Efficiency</span>
              <span className="kpill-value" style={{ color: pctColor(facRollup.efficiency.pct) }}>{fmtPct(facRollup.efficiency.pct)}</span>
            </div>
            <div className="kpill">
              <span className="kpill-label">Utilization</span>
              <span className="kpill-value" style={{ color: pctColor(facRollup.totalUtilization.pct) }}>{fmtPct(facRollup.totalUtilization.pct)}</span>
            </div>
          </div>
        )}
      </div>

      {facMeta && (
        <NotifySettingsPanel
          facility={facMeta.id}
          dashboardType="takt"
          functionName="takt-digest-test"
          manualTestBody={{ facility: facMeta.id }}
          contentDateLabel="yesterday"
          showSkipToNextValidDay={false}
          digestDescription={`Posts ${facMeta.name}'s Performance/Efficiency/Utilization (plus top/lowest performer) to a Front thread. Always summarizes yesterday's numbers (regardless of send time) since same-day Takt data usually isn't fully in yet.`}
        />
      )}

      {error && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">Couldn't load employee data: {error}</span>
        </div>
      )}

      {!employees ? (
        <div className="stub-page" style={{ opacity: 0.6 }}><p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading roster…</p></div>
      ) : employees.length === 0 ? (
        <div className="stub-page" style={{ opacity: 0.6 }}><p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No Takt data for this facility on this date yet.</p></div>
      ) : (
        <div className="appt-list-section">
          <div className="appt-list-body">
            <table className="appt-list-table">
              <thead>
                <tr><th>Employee</th><th>Efficiency</th><th>Utilization</th><th>Performance</th></tr>
              </thead>
              <tbody>
                {employees.map(e => (
                  <tr key={e.employeeId}>
                    <td style={{ fontWeight: 600 }}>{e.employeeName}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', color: pctColor(e.efficiency.pct) }}>{fmtPct(e.efficiency.pct)}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', color: pctColor(e.totalUtilization.pct) }}>{fmtPct(e.totalUtilization.pct)}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: pctColor(e.performance.pct) }}>{fmtPct(e.performance.pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
