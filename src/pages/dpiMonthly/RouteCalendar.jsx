import React, { useRef } from 'react'
import { supabase } from '../../lib/supabase.js'
import { colors, cardStyle } from './dpiMonthlyStyles.js'
import { WEEKDAY_LABELS, buildMonthGrid } from './dpiCalendarUtils.js'

// Phase 2 — delivery date calendar. Real September 2026 dock appointment
// data (checked live against MotherDuck 2026-09-06) showed: the WEEK a
// route lands in each month is reliable (matches the template's
// 1st/2nd/3rd/4th pattern), but the specific WEEKDAY is not — roughly half
// of EC's routes ran on a different weekday than their template states.
// That looks like a real scheduling choice made against that month's dock/
// carrier availability, not a fixed rule.
//
// 2026-09-18: this used to mean the calendar started fully blank
// (drag-only, nothing pre-placed). Per Dan, it now starts PRE-POPULATED
// with each route's best-guess date (its usual week x usual weekday) —
// see Phase2BuildFlag's seedFromTemplate, which computes this once via
// computeAutoDeliveryDate when a cycle's routes are first created — and a
// human can freely drag any route to a different day afterward if that
// month's actual truck/dock availability calls for it. The pre-fill only
// ever happens at that one seeding moment, never again, so a later manual
// re-drag (including dragging a route back into a tray to unschedule it)
// is never overwritten by a repeat auto-fill.
//
// Unscheduled routes sit in a sidebar, grouped by dpi_routes.template_week
// (1st/2nd/3rd/4th, parsed once from each template's notes text — see the
// 2026-09-07 migration) — each week's tray sits beside that week's row in
// the month grid, per Dan's request to see routes "already in a row by the
// week they usually go." Routes with no template_week (a couple of EC
// routes genuinely have no ordinal in their notes, or a manually-added
// route) fall into an "Other" tray. Every route needs a date before
// Phase 2 can advance to Phase 4 (agency comms needs a real date to send).
//
// Drag-and-drop uses a ref for the dragged route id, not React state — an
// earlier version used useState, which re-rendered the whole board on
// dragstart and broke the native drag session on the first attempt (fixed
// alongside the same bug in Phase2BuildFlag's agency tiles, 2026-09-07).
//
// 2026-09-18 (week-alignment fix): when a month doesn't start on a Sunday,
// the standard month-grid's first row is a PARTIAL week (e.g. October
// 2026 starts on a Thursday, so row 0 is just Thu-Sat, Oct 1-3) — really
// the tail end of the PREVIOUS month's last week, not this month's
// "Week 1." buildMonthGrid (now shared with dpiCalendarUtils.js, so this
// stays in sync with the auto-fill computation above) only assigns week
// numbers to genuinely full 7-day rows, counted sequentially from the
// first one — a partial row gets no week-number tray at all.

export default function RouteCalendar({ cycle, routes, onRoutesChanged }) {
  const draggingRouteIdRef = useRef(null)

  const weeks = buildMonthGrid(cycle.month_key)
  const [year, month] = cycle.month_key.split('-').map(Number)

  const assignDate = async (routeId, day) => {
    const dateStr = day
      ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : null
    if (!supabase) return
    const { error } = await supabase
      .from('dpi_routes')
      .update({ delivery_date: dateStr, updated_at: new Date().toISOString() })
      .eq('id', routeId)
    if (error) { console.error('assign delivery date:', error); return }
    onRoutesChanged()
  }

  const unscheduled = routes.filter((r) => !r.delivery_date)
  const unscheduledByWeek = (weekNum) => unscheduled.filter((r) => r.template_week === weekNum)
  const unscheduledOther = unscheduled.filter((r) => r.template_week == null)

  const routesByDate = new Map()
  for (const r of routes) {
    if (!r.delivery_date) continue
    const day = Number(r.delivery_date.split('-')[2])
    if (!routesByDate.has(day)) routesByDate.set(day, [])
    routesByDate.get(day).push(r)
  }

  const RouteChip = ({ route }) => (
    <div
      draggable
      onDragStart={(e) => {
        draggingRouteIdRef.current = route.id
        e.currentTarget.style.opacity = '0.4'
      }}
      onDragEnd={(e) => {
        draggingRouteIdRef.current = null
        e.currentTarget.style.opacity = '1'
      }}
      style={{
        padding: '4px 8px', borderRadius: 5, background: colors.panelAlt,
        border: `1px solid ${colors.border}`, fontSize: 12, marginBottom: 4,
        cursor: 'grab', display: 'inline-block',
      }}
    >
      Route {route.route_number}
    </div>
  )

  const WeekTray = ({ label, routesInWeek }) => (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (draggingRouteIdRef.current) assignDate(draggingRouteIdRef.current, null) }}
      style={{
        padding: 8, border: `1px dashed ${colors.borderStrong}`, borderRadius: 6,
        minHeight: 56, display: 'flex', flexDirection: 'column', gap: 2,
      }}
    >
      <div style={{ fontSize: 10, color: colors.textFaint, marginBottom: 2 }}>{label}</div>
      {routesInWeek.length === 0 && <div style={{ fontSize: 11, color: colors.textFaint, fontStyle: 'italic' }}>—</div>}
      {routesInWeek.map((r) => <RouteChip key={r.id} route={r} />)}
    </div>
  )

  return (
    <div style={{ ...cardStyle, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        Delivery dates — {cycle.month_key}
      </div>
      <div style={{ fontSize: 11, color: colors.textFaint, marginBottom: 12 }}>
        Each route starts on its usual week/weekday — drag it to a different day if this month's truck availability calls for it.
      </div>

      {unscheduledOther.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <WeekTray label="Other / no usual week" routesInWeek={unscheduledOther} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '150px repeat(7, 1fr)', gap: 4 }}>
        <div />
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} style={{ fontSize: 11, color: colors.textFaint, textAlign: 'center', padding: '4px 0' }}>{label}</div>
        ))}

        {weeks.map(({ days, weekNumber }, weekIdx) => (
          <React.Fragment key={weekIdx}>
            {weekNumber != null ? (
              <WeekTray label={`Week ${weekNumber} usually`} routesInWeek={unscheduledByWeek(weekNumber)} />
            ) : (
              <div style={{ fontSize: 10, color: colors.textFaint, padding: 8, fontStyle: 'italic' }}>
                Partial week — carries over from an adjacent month
              </div>
            )}
            {days.map((day, i) => (
              <div
                key={i}
                onDragOver={(e) => { if (day) e.preventDefault() }}
                onDrop={(e) => { e.preventDefault(); if (draggingRouteIdRef.current && day) assignDate(draggingRouteIdRef.current, day) }}
                style={{
                  minHeight: 64, borderRadius: 6, padding: 4,
                  background: day ? colors.panelAlt : 'transparent',
                  border: day ? `1px solid ${colors.border}` : 'none',
                }}
              >
                {day && (
                  <>
                    <div style={{ fontSize: 11, color: colors.textFaint, marginBottom: 4 }}>{day}</div>
                    {(routesByDate.get(day) || []).map((r) => <RouteChip key={r.id} route={r} />)}
                  </>
                )}
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}
