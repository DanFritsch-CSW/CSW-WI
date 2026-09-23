// Shared calendar math for the DPI Monthly Process's route scheduling —
// used by both RouteCalendar.jsx (rendering the drag-and-drop grid) and
// Phase2BuildFlag.jsx (auto-seeding an initial delivery_date guess when
// routes are first created from the template). Kept in one place so the
// week-alignment fix (2026-09-18 — a partial leading/trailing row must
// never claim a real week number) can't drift out of sync between the
// two call sites.

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Builds a standard month grid (array of 7-day rows, nulls for days
// outside the month), then assigns a sequential week number ONLY to
// rows that are a genuine full 7-day week. A month that doesn't start on
// a Sunday has a partial leading row (really the tail of the previous
// month's last week) that must not be mislabeled "Week 1" — see the
// 2026-09-18 fix. Returns [{ days: [day-of-month|null, ...7], weekNumber: number|null }]
function buildMonthGrid(monthKey) {
  const [year, month] = monthKey.split('-').map(Number) // month is 1-indexed
  const firstOfMonth = new Date(year, month - 1, 1)
  const daysInMonth = new Date(year, month, 0).getDate()
  const startWeekday = firstOfMonth.getDay() // 0=Sun

  const cells = []
  for (let i = 0; i < startWeekday; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const rows = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))

  let weekCounter = 0
  return rows.map((days) => {
    const isFullWeek = days.every((d) => d != null)
    const weekNumber = isFullWeek ? ++weekCounter : null
    return { days, weekNumber }
  })
}

// dpi_route_templates.deliver_day is real, messy free text (e.g.
// "Deliver Date - Mon", "Deliver Date  - Mon" with a double space,
// "Deliver Date -Tue" with no space before the day) — confirmed live
// against production_db 2026-09-18. This pulls out whichever known
// weekday abbreviation appears anywhere in the string, tolerant of
// spacing/punctuation, and returns its index into WEEKDAY_LABELS (0=Sun).
// Returns null if nothing recognizable is found.
const WEEKDAY_ABBREVS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, thur: 4, fri: 5, sat: 6 }
function parseWeekdayIndex(text) {
  if (!text) return null
  const match = String(text).toLowerCase().match(/\b(sun|mon|tue|wed|thu|thur|fri|sat)\b/)
  if (!match) return null
  return WEEKDAY_ABBREVS[match[1]]
}

// 2026-09-18: Dan's call — the calendar should come pre-populated with
// each route's usual delivery date (usual week x usual weekday), with a
// human free to drag it elsewhere afterward, rather than starting
// entirely blank. This computes that initial guess at route-creation
// time (see Phase2BuildFlag's seedFromTemplate, which calls this once
// per route, only when a cycle's routes are first seeded — never again
// after that, so a human's later manual re-drag or intentional
// unscheduling is never clobbered by a repeat auto-fill).
//
// 2026-09-18 (Madison fix): confirmed live against production_db that
// EVERY Madison route template has deliver_day = NULL — the real
// delivery weekday text is sitting in load_day instead, e.g.
// "Del Date Thur -" (literally labeled "Del[ivery] Date", just entered
// into the wrong column, apparently from however these templates were
// originally keyed in). EC's templates are correctly split (deliver_day
// populated, load_day genuinely a different, earlier day), so this only
// ever matters for Madison in practice. deliverDayText is tried first;
// loadDayText is only consulted as a fallback when deliverDayText
// doesn't parse to anything, so a properly-populated deliver_day is
// never second-guessed or overridden by a route's real load day.
//
// 2026-09-23: Madison's deliver_day has since been backfilled for real
// (see dpi_route_templates/dpi_routes) so the fallback below is now dead
// code for Madison in practice — left in place as a safety net and
// because it costs nothing to keep working the same way for both
// facilities without a special case.
//
// Returns a "YYYY-MM-DD" date string, or null if it can't be computed
// (no template_week, neither field parses to a weekday, or — for a
// short month — a template_week that doesn't actually have a full
// matching week this month, e.g. a "Week 5" route in a month with only
// 4 full weeks). A null result just means the route starts unscheduled,
// exactly like today, and still needs a manual drag.
function computeAutoDeliveryDate(monthKey, templateWeek, deliverDayText, loadDayText) {
  if (templateWeek == null) return null
  const weekdayIndex = parseWeekdayIndex(deliverDayText) ?? parseWeekdayIndex(loadDayText)
  if (weekdayIndex == null) return null

  const weeks = buildMonthGrid(monthKey)
  const targetWeek = weeks.find((w) => w.weekNumber === templateWeek)
  if (!targetWeek) return null

  const day = targetWeek.days[weekdayIndex]
  if (day == null) return null

  return `${monthKey}-${String(day).padStart(2, '0')}`
}

// dpi_routes.load_time/depart_time come back from Supabase as "HH:MM:SS"
// (Postgres `time`). Formats for display as e.g. "6:00 AM"; returns null
// for an unset time so callers can decide how to render "no time
// recorded" themselves. Shared by RouteCalendar.jsx (chip subtitle) and
// Phase2BuildFlag.jsx (Lane header) so the two never drift out of format.
function formatTimeDisplay(t) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

export { WEEKDAY_LABELS, buildMonthGrid, parseWeekdayIndex, computeAutoDeliveryDate, formatTimeDisplay }
