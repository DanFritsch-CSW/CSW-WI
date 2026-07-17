// Pure helper functions for the JDF Putaways tab. No React, no data --
// just date/window math and location classification, kept separate so the
// component file stays focused on rendering.

export function pct(n, d) {
  if (!d) return 0
  return Math.round((n / d) * 1000) / 10
}

// -----------------------------------------------------------------------
// Date derivation for JDF product
//
// Datex has no working expiration logic for JDF: material.shelf_life_span
// and minimum_dating_span are NULL for all 34 JDF materials, and
// vendor_lot.manufacture_date / expiration_date are only populated on ~13%
// of LPs -- and even those are the LP's receiving/creation timestamp
// mis-stored in that field, not a real production date (expiration_date
// on those rows is always the same calendar day as manufacture_date,
// which isn't a real shelf life).
//
// The only trustworthy date signal is embedded in the lot code / vendor
// lot code itself: "F" + YYMMDD + a sequence number, e.g. F2607061159 ->
// 2026-07-06. Validated two ways before relying on it:
//   1. Zero invalid month/day combinations across 1,887+ active JDF lot
//      codes (a 3-digit Julian day-of-year encoding would not coincidentally
//      produce 100% valid calendar dates).
//   2. The parsed date consistently lands 0-3 days before the LP's actual
//      receiving timestamp, matching a pack date arriving ahead of receipt.
//
// If Datex is ever configured with real shelf-life data for JDF, prefer
// that over this derivation -- this exists because the system fields are
// unusable today, not because it's better than a proper expiration date.
// -----------------------------------------------------------------------
export function parseLotCodeDate(lotCode) {
  if (!lotCode || lotCode[0] !== 'F' || lotCode.length < 7) return null
  const yy = lotCode.slice(1, 3)
  const mm = lotCode.slice(3, 5)
  const dd = lotCode.slice(5, 7)
  const month = parseInt(mm, 10)
  const day = parseInt(dd, 10)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `20${yy}-${mm}-${dd}`
}

export function classifyLocation(loc) {
  const [, , jdfLp, distinctMaterials, distinctMfgDates] = loc
  if (jdfLp <= 1) return 'single'
  if (distinctMaterials > 1) return 'mixed_item'
  if (distinctMfgDates > 1) return 'mixed_date'
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
