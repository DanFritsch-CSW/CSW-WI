import { useState, useEffect } from 'react'
import ProjectList from './ProjectList.jsx'
import { fetchWeeklyRosterHours } from '../lib/weeklyLabor.js'

// Labor Overview sub-tab (Weekly tab), added 2026-08-03 alongside the
// Customer Snapshot / Labor Overview sub-tab split in FacilityPanel.jsx.
// Two sections:
//   1. Labor Hours Delta — Mon-Sun strip of avail-vs-required hours per
//      day, mirroring the Cal/Ken Front thread's Monday manual post
//      (Kay: "8/3: Ken +23.5 / Cal +1.5" etc.) but computed live.
//   2. Weekly Projects — the per-project Mon-Sun grid (ProjectList.jsx),
//      reconnected here. FacilityPanel already fetched weeklyProjectAppts/
//      weeklyProjectDrops for this component but had nothing rendering
//      them (orphaned since Customer Snapshot took over the Weekly tab).
//
// See src/lib/weeklyLabor.js for the roster-hours half of the delta calc.
// Required hours use the SAME weekly appts/drops data as the Projects
// grid below (dr + inb + out) x hours_per_appt, NOT Omni's own
// labor_required column — keeps the two sections internally consistent.

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
function formatMDD(iso) {
  const d = new Date(iso + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function WeeklyLaborOverview({
  facilityId, planDate, weekDays, weeklyProjectAppts, weeklyProjectDrops,
  weeklyLoading, settings, color, projectFilter,
}) {
  const [rosterHours, setRosterHours] = useState({})
  const [hoursLoading, setHoursLoading] = useState(true)

  useEffect(() => {
    if (!weekDays.length || !settings) return
    let cancelled = false
    setHoursLoading(true)
    fetchWeeklyRosterHours(facilityId, weekDays, settings)
      .then(res => { if (!cancelled) setRosterHours(res) })
      .catch(() => { if (!cancelled) setRosterHours({}) })
      .finally(() => { if (!cancelled) setHoursLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityId, weekDays.join(','), settings])

  const hpa = settings?.hours_per_appt ?? 1.5

  const dayRows = weekDays.map((date, idx) => {
    const projAppts = weeklyProjectAppts[date] || {}
    const projDrops = weeklyProjectDrops[date] || {}
    const names = new Set([...Object.keys(projAppts), ...Object.keys(projDrops)])
    let totalAppts = 0
    for (const name of names) {
      const a = projAppts[name] || {}
      totalAppts += (a.inb ?? 0) + (a.out ?? 0) + (projDrops[name] ?? 0)
    }
    const reqHours = Math.round(totalAppts * hpa * 10) / 10
    const availHours = rosterHours[date]
    const delta = availHours == null ? null : Math.round((availHours - reqHours) * 10) / 10
    return { date, label: DAY_LABELS[idx], mdd: formatMDD(date), reqHours, availHours, delta, isToday: date === planDate }
  })

  return (
    <div>
      <div className="section-label" style={{ marginTop: 0 }}>Labor Hours Delta — Mon–Sun</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, marginBottom: 8 }}>
        {dayRows.map(d => (
          <div
            key={d.date}
            style={{
              border: '1px solid var(--border)', borderRadius: 6, padding: '8px 6px',
              textAlign: 'center', fontFamily: 'var(--font-mono)',
              ...(d.isToday ? { borderColor: color, boxShadow: `inset 0 0 0 1px ${color}` } : {}),
            }}
          >
            <div style={{ fontSize: 10, opacity: 0.7 }}>{d.label} {d.mdd}</div>
            {hoursLoading ? (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>…</div>
            ) : d.availHours == null ? (
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 8 }}>No roster data</div>
            ) : (
              <>
                <div
                  style={{
                    fontSize: 16, fontWeight: 700, marginTop: 4,
                    color: d.delta >= 0 ? '#4caf7d' : '#e05a5a',
                  }}
                >
                  {d.delta > 0 ? '+' : ''}{d.delta}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {d.availHours}h avail / {d.reqHours}h req
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
        Delta = roster hours available (break-adjusted) minus required hours (drops + inbound + outbound appointments × hours/appt). Days with no roster data yet show blank — open that date in the Daily tab / Roster Board to sync it.
      </div>

      <div className="section-label">Weekly Projects</div>
      <ProjectList
        weekDays={weekDays}
        selectedDate={planDate}
        weeklyAppts={weeklyProjectAppts}
        weeklyDrops={weeklyProjectDrops}
        color={color}
        projectFilter={projectFilter}
      />
      {weeklyLoading && (
        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 6 }}>· loading week…</div>
      )}
    </div>
  )
}
