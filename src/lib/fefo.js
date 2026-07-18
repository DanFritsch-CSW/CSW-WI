// FEFO Rotation module — Phase 6 (mock UI) + Phase 7 (live data wiring).
//
// What ships here:
//   - Project config with date semantic + facility mapping
//   - Pure verdict engine (line + order + severity ordering)
//   - Plain-language verdict copy generator (pack vs expiration vs received)
//   - Per-project date parsers — YDDDHHMMSS / MMDDYYYY / PPW+MMDDYYYY /
//     receiveDate / vendorLotExpiration
//   - Hold status detector — multiple Datex statuses count as "on hold"
//   - Non-allocatable location detector (receiving, staging, docks, doors, etc.)
//   - Undated-lot detector (2026-07-10) — lots whose code can't be parsed into
//     a real date, flagged instead of silently defaulting (see below)
//   - Severity tiering (critical >=4d older, warning 1-3d)
//   - Aggregations: banner counts, KPI row, by-project rollup
//   - Day stepper helpers (5 ship days)
//   - Mock fixtures (fefoOrderList) — last-resort fallback when live fetch fails
//   - Live fetchers (single + batch) — call /.netlify/functions/fefo-orders

// ─── Projects ───────────────────────────────────────────────────────────────

export const FEFO_PROJECTS = [
  {
    id: 'faioa5', code: 'FAIOA5', name: 'Fair Oaks Farms',
    proj: 59,  dateFormat: 'YDDDHHMMSS', dateSemantic: 'pack',
    color: '#e07b4d', facility: 'ken',
    datexProjectName: 'FAIR OAKS FARMS',
  },
  {
    id: 'fofwe5', code: 'FOFWE5', name: 'Fair Oaks Farms West',
    proj: 61,  dateFormat: 'YDDDHHMMSS', dateSemantic: 'pack',
    color: '#d4824a', facility: 'ken',
    datexProjectName: 'FAIR OAKS FARMS WEST',
  },
  {
    id: 'riche5', code: 'RICHE5', name: 'Richelieu Foods',
    proj: 219, dateFormat: 'MMDDYYYY', dateSemantic: 'expiration',
    color: '#7b5cd0', facility: 'ken',
    datexProjectName: 'RICHELIEU KENOSHA',
  },
  {
    id: 'golst5', code: 'GOLST5', name: 'Crown Bakeries',
    proj: 88,  dateFormat: 'PPW+MMDDYYYY', dateSemantic: 'pack',
    color: '#3dba7e', facility: 'ken',
    datexProjectName: 'CROWN BAKERIES',
  },
  {
    // Birchwood lots don't encode dates in lookup_code (PO195487, KA762, etc).
    // Backend uses lot.receive_date TIMESTAMP as the age proxy — verb becomes
    // "received" so ops isn't misled that it's a pack date. Datex project
    // name has an intentional DOUBLE SPACE (confirmed via silver query).
    id: 'birch5', code: 'BIRCH5', name: 'Birchwood Foods',
    proj: 242, dateFormat: 'receiveDate', dateSemantic: 'received',
    color: '#8b5a3c', facility: 'ken',
    datexProjectName: 'BIRCHWOOD FOODS  KENOSHA',
  },
  {
    // Added 2026-07-17 per Dan's request. First FEFO project OUTSIDE Kenosha
    // — this is CSW's own Caledonia finished-goods project (Palermo Villa,
    // Inc.), not a KEN customer, hence facility: 'cal'. Confirmed via
    // MotherDuck (silver.datex_slv_projects: project_id=5, lookup_code=
    // 'PALVI9', 195 orders currently Processing). Left out PALMA9
    // (materials bulk) and PALDSD9 (DSD) per Dan's call — only the
    // finished-goods project for now.
    //
    // CORRECTED 2026-07-17 (later, same day): initially shipped as
    // dateFormat 'receiveDate' — assumed no real expiration data existed
    // since lot codes (WC106515, WJ101444, plain numeric like "19626")
    // don't encode one. Wrong: there IS a real expiration date for these
    // lots, sourced from datex_slv_vendorlots (joined via vendor_lot_id),
    // NOT the lookup_code — same source PVI Shelf Life already uses for
    // this exact project (see netlify/functions/pvi-shelf-life.cjs and
    // fefo-orders.cjs's "vendorLotExpiration" handling).
    id: 'palvi9', code: 'PALVI9', name: "Palermo's Caledonia",
    proj: 5, dateFormat: 'vendorLotExpiration', dateSemantic: 'expiration',
    color: '#1f7a8c', facility: 'cal',
    datexProjectName: 'Palermos CALEDONIA finished',
  },
]

export function getProject(projId) {
  return FEFO_PROJECTS.find(p => p.id === projId) || null
}

export function dateVerb(projId) {
  const p = getProject(projId)
  if (p?.dateSemantic === 'expiration') return 'expiring'
  if (p?.dateSemantic === 'received')   return 'received'
  return 'packed'
}

// ─── Date parsers (Phase 7a) ────────────────────────────────────────────────

function dateFromYearAndDoy(year, doy) {
  const d = new Date(Date.UTC(year, 0, 1))
  d.setUTCDate(doy)
  return d
}

function fmtMDY(year, month, day) {
  const yy = String(year).slice(-2)
  return `${month}/${day}/${yy}`
}

// Parses back a display date string (M/D/YY or MM/DD/YY) to a UTC-midnight
// Date. Used by lineDaysOlder to compute day-diffs uniformly across all
// project date formats — cheaper than plumbing dayEpoch through the backend.
function parseDisplayDate(display) {
  if (!display || typeof display !== 'string') return null
  const m = display.match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/)
  if (!m) return null
  const month = Number(m[1])
  const day   = Number(m[2])
  let year    = Number(m[3])
  if (year < 100) year += 2000  // 25 → 2025
  const d = new Date(Date.UTC(year, month - 1, day))
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseFairOaksDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const m = lookupCode.match(/^(\d)(\d{3})(\d{2})(\d{2})(\d{2})$/)
  if (!m) return null
  const yDigit = Number(m[1])
  const doy    = Number(m[2])
  const hh     = Number(m[3])
  const mm     = Number(m[4])
  const ss     = Number(m[5])
  if (doy < 1 || doy > 366 || hh > 23 || mm > 59 || ss > 59) return null
  const currentYear = new Date().getUTCFullYear()
  const currentDecade = Math.floor(currentYear / 10) * 10
  let year = currentDecade + yDigit
  if (year > currentYear + 1) year -= 10
  const d = dateFromYearAndDoy(year, doy)
  const month = d.getUTCMonth() + 1
  const day   = d.getUTCDate()
  const kDay = year * 1000 + doy
  const k    = kDay * 1e6 + hh * 1e4 + mm * 1e2 + ss
  return { k, kDay, display: fmtMDY(year, month, day) }
}

export function parseRichelieuDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const m = lookupCode.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (!m) return null
  const month = Number(m[1])
  const day   = Number(m[2])
  const year  = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null
  const kDay = year * 10000 + month * 100 + day
  return { k: kDay, kDay, display: fmtMDY(year, month, day) }
}

export function parseCrownDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const stripped = lookupCode.replace(/^PPW/i, '')
  return parseRichelieuDate(stripped)
}

export function parseLotDateKey(lookupCode, projId) {
  const project = getProject(projId)
  if (!project) {
    return { k: 0, kDay: 0, display: lookupCode || '?', error: `unknown project ${projId}` }
  }
  let parsed
  if (project.dateFormat === 'YDDDHHMMSS')        parsed = parseFairOaksDate(lookupCode)
  else if (project.dateFormat === 'MMDDYYYY')     parsed = parseRichelieuDate(lookupCode)
  else if (project.dateFormat === 'PPW+MMDDYYYY') parsed = parseCrownDate(lookupCode)
  // 'receiveDate' and 'vendorLotExpiration' are only parsed server-side
  // (need a DB timestamp field, not something derivable from lookup_code)
  else parsed = null
  if (!parsed) {
    return { k: 0, kDay: 0, display: lookupCode || '?', error: `unparseable ${project.dateFormat}` }
  }
  return parsed
}

// ─── Hold status detector (Phase 7a) ────────────────────────────────────────

export const HOLD_STATUS_NAMES = new Set([
  'HOLD', 'Pending Hold', 'QA Hold', 'Food Safety',
  'NOT RELEASED', 'Damaged / Hold', 'Administrative',
])

export function isHoldStatus(statusName) {
  if (!statusName) return false
  if (HOLD_STATUS_NAMES.has(statusName)) return true
  return /hold|not released/i.test(statusName)
}

// ─── Undated-lot detector (2026-07-10, Dean/Bry FEFO feedback) ──────────────
//
// Context: Bry flagged that manual, no-EDI Fair Oaks receipts sometimes land
// without a real expiration/manufacture date on the pallet. Dean's ask: flag
// ANY lot (any of the 5 FEFO customers, not just Fair Oaks) where we can't
// establish a real date, rather than silently defaulting.
//
// Root cause found in the existing code: parseLotDateKey/parseFairOaksDate/etc
// already fall back to { k: 0, kDay: 0, error: '...' } when a lot's code
// doesn't match the expected pattern. k:0 is the smallest possible sort key,
// which had two silent failure modes depending on which side of an order it
// landed on:
//   - As a REM (on-hand, unallocated) candidate, it looked infinitely OLD and
//     got force-picked as "the oldest lot on the shelf" even though its real
//     age is unknown.
//   - As a SHIPPING lot (already allocated to the order), oldKDay became 0,
//     and the violation check (remKDay < oldKDay) can never fire against 0 —
//     so a genuinely older lot sitting on the shelf would never get flagged.
//     This is the same failure Dean described ("no expiration = ships
//     immediately without scrutiny"), just via a parsing gap rather than a
//     Datex-side default.
//
// Fix (flag-only, per Dan's call — does NOT block or force a hold verdict):
//   - Server (fefo-orders.cjs) tags every ship/onhand entry with
//     `dateUnknown: true` when its code doesn't parse, and excludes those
//     entries from BOTH the "oldest shipping lot" calc and REM auto-pick, so
//     they can no longer silently corrupt either comparison.
//   - Undated on-hand lots that get excluded from REM are still surfaced on
//     the line as `undatedOnHand: [...]` so ops can see there's unverified
//     stock in the bin even though it isn't driving the verdict.
//   - This module's lineVerdict() only compares dated ship entries; the UI
//     surfaces undated lots via a dedicated banner + per-lot badges instead
//     of folding them into the violation/hold/clean verdict.
//
// Scope caveat: this only covers lots tied to today's open order window (the
// data the app already fetches) — it is NOT a full warehouse scan, so "no
// undated lots" in the banner means "none in this view", not "confirmed zero
// anywhere in Datex for this customer."

export function lineHasUndated(line) {
  if ((line?.ship || []).some(s => s.dateUnknown)) return true
  if ((line?.undatedOnHand || []).length > 0) return true
  return false
}

export function orderHasUndated(order) {
  return (order?.lines || []).some(lineHasUndated)
}

// Distinct undated lots across a set of orders (e.g. the currently visible
// day+project scope), for the top-of-view banner. Dedupes by lot code.
export function undatedLotsInView(orders) {
  const lots = new Map()
  for (const o of (orders || [])) {
    for (const line of (o.lines || [])) {
      for (const s of (line.ship || [])) {
        if (s.dateUnknown && s.lot && !lots.has(s.lot)) {
          lots.set(s.lot, { lot: s.lot, source: 'shipping', order: o.id })
        }
      }
      for (const u of (line.undatedOnHand || [])) {
        if (u.lot && !lots.has(u.lot)) {
          lots.set(u.lot, { lot: u.lot, source: 'on-hand', order: null })
        }
      }
    }
  }
  return [...lots.values()]
}

// ─── Verdict engine ─────────────────────────────────────────────────────────
//
// 2026-07-10 (Dan, Slack screenshot feedback): "hold" and "blocked" used to
// be one verdict ('hold') covering two different root causes — a lot on a
// genuine Datex hold (QA, Food Safety, Administrative, etc.) vs. a lot that's
// simply not yet putaway (sitting in receiving/staging/dock/door). Those need
// different actions (clear the hold vs. move/putaway the pallet), so they're
// now two distinct verdicts: 'hold' and 'blocked'. `hold` takes precedence if
// a lot is somehow both (shouldn't normally happen, but a lot in receiving
// could theoretically also carry a hold status).

export const VERDICT_PRECEDENCE = { violation: 0, stale: 1, hold: 2, blocked: 3, clean: 4 }

export function lineVerdict(line) {
  if (!line?.ship?.length) return 'clean'
  // Undated ship entries can't anchor the "how old is what's shipping"
  // comparison — exclude them rather than let their k:0 sentinel silently
  // win as the oldest thing on the order (see undated-lot note above).
  const datedShip = line.ship.filter(s => !s.dateUnknown)
  if (!datedShip.length) return 'clean'
  const oldKDay = Math.min(...datedShip.map(s => s.kDay ?? s.k))
  const rem = line.rem
  const remKDay = rem?.kDay ?? rem?.k
  if (rem && !rem.dateUnknown && rem.lps > 0 && remKDay != null && remKDay < oldKDay) {
    if (rem.hold) return 'hold'
    if (rem.locationBlocked) return 'blocked'
    return 'violation'
  }
  return 'clean'
}

export function orderVerdict(order) {
  const verdicts = (order.lines || []).map(lineVerdict)
  const worst = verdicts.length
    ? verdicts.reduce((a, b) => VERDICT_PRECEDENCE[a] <= VERDICT_PRECEDENCE[b] ? a : b)
    : 'clean'
  if (order.past && worst !== 'violation') return 'stale'
  return worst
}

// ─── Severity ──────────────────────────────────────────────────────────────

export const SEVERITY_THRESHOLDS = {
  critical: 4,   // >=4 days older = critical (multi-day drift)
  warning:  1,   // 1-3 days = warning
}

export function lineDaysOlder(line) {
  const v = lineVerdict(line)
  if (v !== 'violation') return 0
  if (!line?.ship?.length || !line?.rem?.date) return 0
  const datedShip = line.ship.filter(s => !s.dateUnknown)
  if (!datedShip.length) return 0
  const oldShip = datedShip.reduce((a, b) => a.k < b.k ? a : b)
  const shipDate = parseDisplayDate(oldShip.date)
  const remDate  = parseDisplayDate(line.rem.date)
  if (!shipDate || !remDate) return 0
  return Math.max(0, Math.round((shipDate.getTime() - remDate.getTime()) / 86400000))
}

export function lineSeverity(line) {
  const days = lineDaysOlder(line)
  if (days === 0) return null
  if (days >= SEVERITY_THRESHOLDS.critical) return 'critical'
  return 'warning'
}

export function orderSeverity(order) {
  let worst = null
  for (const line of (order.lines || [])) {
    const s = lineSeverity(line)
    if (s === 'critical') return 'critical'
    if (s === 'warning') worst = 'warning'
  }
  return worst
}

export function orderMaxDaysOlder(order) {
  let max = 0
  for (const line of (order.lines || [])) {
    const d = lineDaysOlder(line)
    if (d > max) max = d
  }
  return max
}

export function compareByVerdict(a, b) {
  const av = orderVerdict(a)
  const bv = orderVerdict(b)
  if (VERDICT_PRECEDENCE[av] !== VERDICT_PRECEDENCE[bv]) {
    return VERDICT_PRECEDENCE[av] - VERDICT_PRECEDENCE[bv]
  }
  if (av === 'violation') {
    return orderMaxDaysOlder(b) - orderMaxDaysOlder(a)
  }
  return 0
}

// ─── Verdict copy ───────────────────────────────────────────────────────────

function locSuffix(rem) {
  if (!rem?.location) return ''
  return ` at ${rem.location}`
}

export function verdictCopy(line, projId) {
  const verb = dateVerb(projId)
  const v = lineVerdict(line)
  if (v === 'violation') {
    const datedShip = line.ship.filter(s => !s.dateUnknown)
    const oldShip = datedShip.reduce((a, b) => a.k < b.k ? a : b)
    const stockUnit = line.rem.lps > 0 ? `${line.rem.lps} LP${line.rem.lps === 1 ? '' : 's'}` : 'stock'
    const loc = locSuffix(line.rem)
    const days = lineDaysOlder(line)
    const drift = days > 0 ? ` (${days} day${days === 1 ? '' : 's'} older)` : ''
    return `Out of rotation${drift} — ${stockUnit} ${verb} ${line.rem.date} (${line.rem.cases} cs)${loc} sit unallocated and off hold, older than the ${oldShip.date} stock on this order. Swap them in before it ships.`
  }
  if (v === 'hold') {
    return `Older stock exists (${verb} ${line.rem.date}, ${line.rem.lps} LP${line.rem.lps === 1 ? '' : 's'}) but it is on ${line.rem.holdType || 'hold'}, so it is correctly skipped. Clear the hold before it can ship in rotation.`
  }
  if (v === 'blocked') {
    const where = line.rem.location ? `in ${line.rem.location}` : 'in a non-allocatable location (receiving, staging, dock, etc.)'
    return `Older stock exists (${verb} ${line.rem.date}, ${line.rem.lps} LP${line.rem.lps === 1 ? '' : 's'}) but it hasn't been put away yet — sitting ${where}, so it is correctly skipped. Move it to an allocatable bin before it can ship in rotation.`
  }
  if (!line.rem || line.rem.lps === 0) {
    return 'In rotation — the oldest stock on hand is shipping first… fully cleared.'
  }
  return 'In rotation — the oldest stock on hand is shipping first.'
}

// ─── Aggregations ───────────────────────────────────────────────────────────

export function bannerCounts(orders) {
  const out = { violations: [], criticalCount: 0, warningCount: 0, stale: [], holds: [], blocked: [], allClean: false }
  for (const o of orders) {
    const v = orderVerdict(o)
    if (v === 'violation') {
      out.violations.push(o.id)
      const sev = orderSeverity(o)
      if (sev === 'critical') out.criticalCount++
      else if (sev === 'warning') out.warningCount++
    }
    else if (v === 'stale') out.stale.push(o.id)
    else if (v === 'hold') out.holds.push(o.id)
    else if (v === 'blocked') out.blocked.push(o.id)
  }
  out.allClean = orders.length > 0 && !out.violations.length && !out.stale.length && !out.holds.length && !out.blocked.length
  return out
}

export function kpiRow(orders) {
  let lps = 0, materials = new Set(), violations = 0, critical = 0, warning = 0, stale = 0, holds = 0, blocked = 0
  for (const o of orders) {
    const v = orderVerdict(o)
    if (v === 'violation') {
      violations++
      const sev = orderSeverity(o)
      if (sev === 'critical') critical++
      else if (sev === 'warning') warning++
    }
    else if (v === 'stale') stale++
    else if (v === 'hold') holds++
    else if (v === 'blocked') blocked++
    for (const line of (o.lines || [])) {
      materials.add(line.code)
      for (const s of (line.ship || [])) lps += s.lps || 0
    }
  }
  return { orders: orders.length, lps, materials: materials.size, violations, critical, warning, stale, holds, blocked }
}

export function rollupByProject(orders) {
  const map = new Map()
  for (const proj of FEFO_PROJECTS) {
    map.set(proj.id, { proj, orders: 0, lps: 0, violations: 0, critical: 0, warning: 0, stale: 0, holds: 0, blocked: 0 })
  }
  for (const o of orders) {
    const r = map.get(o.proj)
    if (!r) continue
    r.orders++
    for (const line of (o.lines || []))
      for (const s of (line.ship || [])) r.lps += s.lps || 0
    const v = orderVerdict(o)
    if (v === 'violation') {
      r.violations++
      const sev = orderSeverity(o)
      if (sev === 'critical') r.critical++
      else if (sev === 'warning') r.warning++
    }
    else if (v === 'stale') r.stale++
    else if (v === 'hold') r.holds++
    else if (v === 'blocked') r.blocked++
  }
  return [...map.values()].sort((a, b) => {
    if (a.critical !== b.critical) return b.critical - a.critical
    if (a.violations !== b.violations) return b.violations - a.violations
    if (a.stale !== b.stale) return b.stale - a.stale
    return b.orders - a.orders
  })
}

// ─── Day stepper helpers ────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function dayLabel(dayOffset, today = new Date()) {
  const d = new Date(today)
  d.setDate(d.getDate() + dayOffset)
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
}

export function daySubLabel(dayOffset) {
  if (dayOffset === 0) return 'Today'
  if (dayOffset === 1) return 'Tomorrow'
  return `+${dayOffset} days`
}

// ─── Verdict styling tokens ─────────────────────────────────────────────────

export const VERDICT_TOKENS = {
  violation: { color: 'var(--red, #c0392b)',    bg: 'rgba(192, 57, 43, 0.08)',  label: '⚠ Out of rotation',   pill: 'violation' },
  stale:     { color: 'var(--orange, #d4824a)', bg: 'rgba(212, 130, 74, 0.08)', label: '◷ Stale · overdue',    pill: 'stale' },
  hold:      { color: 'var(--blue, #2a72b8)',   bg: 'rgba(42, 114, 184, 0.08)', label: '⏸ Older lot held',    pill: 'hold' },
  blocked:   { color: 'var(--amber, #a07818)',  bg: 'rgba(160, 120, 24, 0.08)', label: '⚑ Older lot in receiving', pill: 'blocked' },
  clean:     { color: 'var(--green, #1a8a52)',  bg: 'rgba(26, 138, 82, 0.08)',  label: '✓ In rotation',       pill: 'clean' },
}

export const SEVERITY_TOKENS = {
  critical: { color: 'var(--red, #c0392b)',    bg: 'rgba(192, 57, 43, 0.12)',  label: 'CRITICAL' },
  warning:  { color: 'var(--amber, #a07818)', bg: 'rgba(160, 120, 24, 0.12)', label: 'WARNING' },
}

// Styling for the undated-lot banner/badges — deliberately separate from
// VERDICT_TOKENS since "undated" is flag-only and doesn't participate in
// orderVerdict/lineVerdict precedence.
export const UNDATED_TOKEN = {
  alert:   { color: 'var(--red, #c0392b)',   bg: 'rgba(192, 57, 43, 0.08)' },
  clean:   { color: 'var(--green, #1a8a52)', bg: 'rgba(26, 138, 82, 0.06)' },
}

// ─── Live fetcher (single project — kept for backward compat) ───────────────

export async function fetchLiveFefoOrders(projectId, { dayCount = 5 } = {}) {
  const project = getProject(projectId)
  if (!project) {
    return { orders: [], fetchedAt: new Date().toISOString(), source: 'mock', error: `unknown project ${projectId}` }
  }
  const batch = await fetchLiveFefoOrdersBatch([projectId], { dayCount })
  return {
    orders:    batch.ordersByProject[projectId] || [],
    fetchedAt: batch.fetchedAt,
    source:    batch.source,
    elapsedMs: batch.elapsedMs,
    error:     batch.errorsByProject?.[projectId] || batch.error || null,
  }
}

// ─── Live fetcher (batch — multi-project in one Lambda call) ────────────────
//
// Facility grouping (2026-07-17, Palermo's Caledonia/CAL added) — the
// backend function (fefo-orders.cjs) only accepts ONE warehouse per
// request. Until now every FEFO project was KEN, so a single batch request
// covering "All Projects" always happened to be single-facility. Adding a
// CAL project means "All Projects" now spans two facilities, so this groups
// projectIds by their configured facility and fires one request per group
// in parallel, merging the results. Transparent to callers — the exported
// signature and return shape are unchanged; FefoRotationTab.jsx still calls
// this with all project IDs and doesn't need to know facilities exist.

async function fetchOneFacilityBatch(projectIds, facility, dayCount) {
  const now = () => new Date().toISOString()
  try {
    const res = await fetch('/.netlify/functions/fefo-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds, facility, dayCount }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const fallback = Object.fromEntries(projectIds.map(pid => [pid, []]))
      const errs = body.errorsByProject || Object.fromEntries(projectIds.map(pid => [pid, body.error || `HTTP ${res.status}`]))
      return {
        ordersByProject: body.ordersByProject || fallback,
        errorsByProject: errs,
        source: 'mock',
        elapsedMs: body.elapsedMs,
        error: body.error || `HTTP ${res.status}`,
      }
    }
    return {
      ordersByProject: body.ordersByProject || {},
      errorsByProject: body.errorsByProject || {},
      source: 'live',
      elapsedMs: body.elapsedMs,
    }
  } catch (e) {
    console.warn('fetchOneFacilityBatch failed:', e.message)
    return {
      ordersByProject: Object.fromEntries(projectIds.map(pid => [pid, []])),
      errorsByProject: Object.fromEntries(projectIds.map(pid => [pid, e.message || 'unknown'])),
      source: 'mock',
      error: e.message,
    }
  }
}

export async function fetchLiveFefoOrdersBatch(projectIds, { dayCount = 5 } = {}) {
  const now = () => new Date().toISOString()
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    return { ordersByProject: {}, errorsByProject: {}, fetchedAt: now(), source: 'mock', error: 'projectIds required' }
  }
  const projects = projectIds.map(getProject)
  const unknown = projectIds.filter((pid, i) => !projects[i])
  if (unknown.length > 0) {
    return { ordersByProject: {}, errorsByProject: {}, fetchedAt: now(), source: 'mock', error: `unknown projectId(s): ${unknown.join(', ')}` }
  }

  const byFacility = new Map()
  for (const p of projects) {
    if (!byFacility.has(p.facility)) byFacility.set(p.facility, [])
    byFacility.get(p.facility).push(p.id)
  }

  const groupResults = await Promise.all(
    [...byFacility.entries()].map(([facility, ids]) => fetchOneFacilityBatch(ids, facility, dayCount))
  )

  const ordersByProject = {}
  const errorsByProject = {}
  let anyLive = false
  let firstError = null
  let maxElapsed = 0
  for (const r of groupResults) {
    Object.assign(ordersByProject, r.ordersByProject)
    Object.assign(errorsByProject, r.errorsByProject)
    if (r.source === 'live') anyLive = true
    if (r.error && !firstError) firstError = r.error
    if (r.elapsedMs) maxElapsed = Math.max(maxElapsed, r.elapsedMs)
  }

  return {
    ordersByProject,
    errorsByProject,
    fetchedAt: now(),
    source: anyLive ? 'live' : 'mock',
    elapsedMs: maxElapsed || undefined,
    ...(anyLive ? {} : { error: firstError || 'all facility batches failed' }),
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

export function fefoOrderList() {
  return [
    {
      id: 'SO-118472', day: 0, proj: 'faioa5',
      dest: 'Walmart DC McLeansboro',
      appt: '14:30', past: false,
      status: 'Allocated', allocBy: 'kmartinez',
      lines: [
        {
          code: 'FOF-4801', desc: '12oz Mozzarella Sticks', pack: '24 / case',
          ship: [
            { date: '6/24/25', k: 250624, lps: 8,  cases: 192, codes: ['LP-882341', 'LP-882347', 'LP-882356', 'LP-882389'], lot: 'L2406A' },
            { date: '6/26/25', k: 250626, lps: 4,  cases: 96,  codes: ['LP-883102', 'LP-883108'], lot: 'L2406B' },
          ],
          rem: { date: '6/15/25', k: 250615, lps: 5, cases: 120, hold: false, lot: 'L2406C', location: 'BG103D', locationBlocked: false },
        },
      ],
    },
    {
      id: 'SO-118490', day: 0, proj: 'riche5',
      dest: 'FreshMart Distribution',
      appt: '11:00', past: false,
      status: 'Allocated', allocBy: 'dgraham',
      lines: [
        {
          code: 'RIC-2204', desc: 'Pepperoni Pizza 12in', pack: '8 / case',
          ship: [
            { date: '12/15/25', k: 251215, lps: 10, cases: 80, codes: ['LP-771042', 'LP-771050', 'LP-771063'], lot: 'R2511A' },
          ],
          rem: { date: '10/30/25', k: 251030, lps: 4, cases: 32, hold: false, lot: 'R2510B', location: 'C5 Receiving', locationBlocked: true },
        },
      ],
    },
  ]
}
