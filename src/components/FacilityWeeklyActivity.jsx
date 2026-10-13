import { useState, useEffect, useMemo } from 'react'
import ProjectList from './ProjectList.jsx'
import { fetchWeekActivity } from '../lib/customerActivity.js'

// ── Facility Weekly Activity ("All Customers") ──────────────────────────
// Added 2026-10-13 per Dean Dioguardi's ask in the Cal/Ken Labor Planning
// Front thread (cnv_1552i49g): "make it possible to see all ins and outs
// on a full facility basis - so I don't have to look at each customer...
// drops, inbounds, and outbounds for the entire week for each customer
// aggregated onto one page." Hill Hamrick's follow-up ("you gotta add in
// pulling drops") is why this pulls real classified drops, not just
// inbound/outbound.
//
// This is deliberately a THIRD weekly sub-tab, not a change to the
// existing two:
//   - Customer Snapshot (CustomerSnapshot.jsx) — accurate live Drops/
//     Inbound/Outbound classification (see ../lib/customerActivity.js),
//     but only 2 hand-picked customers at a time, 8-week baseline compare.
//     This is what Dean was looking at in the screenshot — its cards are
//     literally titled "<CUSTOMER> — OUTBOUND" because selTypes defaults
//     to ['out'] only.
//   - Labor Overview's "Weekly Projects" grid (ProjectList.jsx, fed by
//     FacilityPanel's weeklyProjectAppts/weeklyProjectDrops) ALREADY shows
//     every project on one page, but its "drops" number is the editable
//     EST-drops labor forecast (Supabase project_hourly_drops_forecast),
//     not a live classification of what's actually scheduled — wrong
//     number for Dean's "what's really coming in" ask.
// This tab reuses ProjectList.jsx's table (so the UI matches what Dan/Kay
// already know) but feeds it live-classified counts for EVERY customer at
// once, via fetchWeekActivity in ../lib/customerActivity.js — the same
// DROP_RULES/classifyType logic Customer Snapshot uses, so the two views
// can never disagree on what counts as a drop.
//
// Week follows FacilityPanel's planDate (weekDays prop, Mon–Sun) — same
// convention as Labor Overview, no separate date picker here.
//
// Cost note: unlike Customer Snapshot's 56-day (8-week) fetch, this only
// fetches the 7 days actually being displayed — 7 Omni queries per
// facility per week, not 56. No baseline/"normal" comparison is computed
// here; if that's wanted later, pull it from customerActivity.js and
// extend this component rather than duplicating CustomerSnapshot's median
// logic.
//
// Known pattern, not a bug (confirmed against gold.truck_appointments
// 2026-10-13): KEN/CAL drop-rule customers routinely show Drops only on
// today's column and little/none on later days in the week, even though
// Outbound is fully booked out all week. Vendor/inbound trucks for these
// accounts just aren't scheduled in Datex more than ~a day ahead — see
// the "Inbound is often not booked ahead" rule in the
// csw-weekly-appointment-pacing skill, which documents the same lag for
// gold.truck_appointments generally. This table is reporting what's
// actually on the books, not a fetch failure; the column fills in as
// vendors book closer to the date.

export default function FacilityWeeklyActivity({ facilityId, weekDays, planDate, color }) {
  const [byProject, setByProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchWeekActivity(facilityId, weekDays)
      .then(result => { if (!cancelled) setByProject(result) })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [facilityId, weekDays.join(',')])

  // Reshape into the { [date]: { [project]: {...} } } ProjectList.jsx expects.
  const { weeklyAppts, weeklyDrops } = useMemo(() => {
    const appts = {}
    const drops = {}
    for (const d of weekDays) { appts[d] = {}; drops[d] = {} }
    if (byProject) {
      for (const [name, perDay] of Object.entries(byProject)) {
        for (const d of weekDays) {
          const cell = perDay[d]
          if (!cell) continue
          appts[d][name] = { inb: cell.in, out: cell.out }
          drops[d][name] = cell.dr
        }
      }
    }
    return { weeklyAppts: appts, weeklyDrops: drops }
  }, [byProject, weekDays])

  const hasAnyData = byProject && Object.keys(byProject).length > 0

  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
        Every customer at this facility, Mon–Sun, in one table — live scheduled Drops / Inbound / Outbound
        (same classification as Customer Snapshot, including the KEN/CAL drop rules). HOLD appointments
        included, Cancelled excluded. Appointments created in the last hour may lag behind due to Datex sync.
        Drops/Inbound are vendor-scheduled and often aren't booked more than a day out — a day showing no
        drops usually means nothing's on the books yet, not that none are coming; Outbound is normally
        booked for the full week.
      </div>
      {loading ? (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          Loading full-facility activity…
        </div>
      ) : error ? (
        <div style={{ fontSize: 11, color: '#e05a5a', fontFamily: 'var(--font-mono)' }}>
          Unavailable: {error}
        </div>
      ) : !hasAnyData ? (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          No scheduled activity this week.
        </div>
      ) : (
        <ProjectList
          weekDays={weekDays}
          selectedDate={planDate}
          weeklyAppts={weeklyAppts}
          weeklyDrops={weeklyDrops}
          color={color}
        />
      )}
    </div>
  )
}
