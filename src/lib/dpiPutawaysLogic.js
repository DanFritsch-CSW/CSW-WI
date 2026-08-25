// Pure helper functions for the DPI Putaways tab. Duplicated from
// jdfPutawaysLogic.js 2026-08-25. No parseLotCodeDate here -- DPI's lot
// codes are plain sequential numbers with no date encoded in them
// (confirmed live), so the "second layer" classification uses the DB's
// own lot.receive_date instead of a client-side parse. See
// motherduck-dpi-putaways.cjs's header for the full rationale.

export function pct(n, d) {
  if (!d) return 0
  return Math.round((n / d) * 1000) / 10
}

export function classifyLocation(loc) {
  const [, , dpiLp, distinctMaterials, distinctRecvDates] = loc
  if (dpiLp <= 1) return 'single'
  if (distinctMaterials > 1) return 'mixed_item'
  if (distinctRecvDates > 1) return 'mixed_date'
  return 'clean'
}

// Rolling window for "recent activity": normally the past 24 hours, but on
// a Monday that would miss all of Friday/Saturday/Sunday, so the window
// extends back to the same time on Friday instead.
export function getWindowStart(now) {
  const dayOfWeek = now.getDay() // 0 = Sunday, 1 = Monday, ...
  const hoursBack = dayOfWeek === 1 ? 24 * 3 : 24
  return new Date(now.getTime() - hoursBack * 60 * 60 * 1000)
}

export function windowLabel(now) {
  return now.getDay() === 1 ? 'Since Friday' : 'Past 24 hours'
}
