import { useState, useEffect } from 'react'
import ProjectList from './ProjectList.jsx'
import { fetchWeeklyRosterHours, fetchWeeklyRequiredHours } from '../lib/weeklyLabor.js'

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
// Required hours: fetchWeeklyRequiredHours (src/lib/weeklyLabor.js)
// replicates FacilityPanel's perHourReq formula HOUR BY HOUR, not a
// day-level per-project sum. Dan caught two rounds of this: (1) a flat
// facility-default rate ran ~10h/day low on KEN (which has 6 of 8
// projects overridden above the 1.5 default); (2) even after switching
// to a per-project-rate DAY-TOTAL sum (mathematically clean, but wrong),
// KEN Mon 8/3 still showed 171.8h vs Daily's validated 161.6h — Daily's
// real formula blends per-project rates hour-by-hour against the
// facility-wide hourly total and clamps the non-override remainder to
// zero when the override projects' own hourly counts exceed it, which
// only happens at the hour level and can't be reproduced by summing
// daily totals. See weeklyLabor.js's header comment for the full story.

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
  const [reqHoursByDay, setReqHoursByDay] = useState({})
  const [hoursLoading, setHoursLoading] = useState(true)

  useEffect(() => {
    if (!weekDays.length || !settings) return
    let cancelled = false
    setHoursLoading(true)
    Promise.all([
      fetchWeeklyRosterHours(facilityId, weekDays, settings),
      fetchWeeklyRequiredHours(facilityId, weekDays, settings, projectHpa, weeklyProjectAppts),
    ])
      .then(([avail, req]) => {
        if (cancelled) return
        setRosterHours(avail)
        setReqHoursByDay(req)
      })
      .catch(() => { if (!cancelled) { setRosterHours({}); setReqHoursByDay({}) } })
      .finally(() => { if (!cancelled) setHoursLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityId, weekDays.join(','), settings, projectHpa])

  const dayRows = weekDays.map((date, idx) => {
    const reqHours = reqHoursByDay[date]
    const availHours = rosterHours[date]
    const delta = (availHours == null || reqHours == null) ? null : Math.round((availHours - reqHours) * 10) / 10
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
            ) : d.reqHours == null ? (
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 8 }}>Req unavailable</div>
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
