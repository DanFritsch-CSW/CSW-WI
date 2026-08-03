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
// See src/lib/weeklyLabor.js for the roster-hours (avail) half of the
// delta calc — as of 2026-08-03 (later) it uses buildRosterAvailability,
// the SAME function Daily's own Total Hrs Avail KPI uses, not a separate
// reimplementation, so avail matches Daily exactly for any date.
//
// Required hours use the SAME weekly appts/drops data as the Projects
// grid below (dr + inb + out per project), NOT Omni's own labor_required
// column. As of 2026-08-03 (later), required hours also apply each
// project's hours_per_appt OVERRIDE from project_labor_assumptions
// (projectHpa, same map Daily's perHourReq uses) instead of a flat
// facility default — Dan caught KEN's Weekly total running ~10h/day
// low vs. the validated Daily total because KEN has 6 of its projects
// overridden above the 1.5 default (Crown/Pretzilla/Richelieu/
// Birchwood/BossBites at 1.75, Pedone Pinsa at 2.00). Since req is
// linear in appts, summing (project_total_appts × its own rate) across
// the day is mathematically identical to Daily's per-hour blended
// calc integrated over 24 hours — no need to replicate hour-by-hour.

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
function formatMDD(iso) {
  const d = new Date(iso + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function WeeklyLaborOverview({
  facilityId, planDate, weekDays, weeklyProjectAppts, weeklyProjectDrops,
  weeklyLoading, settings, color, projectFilter, projectHpa,
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

  const defaultHpa = settings?.hours_per_appt ?? 1.5

  // Per-project rate: use the project's hours_per_appt override if one
  // exists in project_labor_assumptions (same projectHpa map Daily's
  // perHourReq uses), else the facility default. Summing (appts × rate)
  // per project across the whole day is equivalent to Daily's per-hour
  // blended formula summed over 24 hours, since req is linear in appts.
  const dayRows = weekDays.map((date, idx) => {
    const projAppts = weeklyProjectAppts[date] || {}
    const projDrops = weeklyProjectDrops[date] || {}
    const names = new Set([...Object.keys(projAppts), ...Object.keys(projDrops)])
    let reqHours = 0
    for (const name of names) {
      const a = projAppts[name] || {}
      const projectTotal = (a.inb ?? 0) + (a.out ?? 0) + (projDrops[name] ?? 0)
      const rate = projectHpa?.get?.(name) ?? defaultHpa
      reqHours += projectTotal * rate
    }
    reqHours = Math.round(reqHours * 10) / 10
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
        Delta = roster hours available (break-adjusted) minus required hours (drops + inbound + outbound appointments × hours/appt, using each project's rate override where configured in Settings). Days with no roster data yet show blank — open that date in the Daily tab / Roster Board to sync it.
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
