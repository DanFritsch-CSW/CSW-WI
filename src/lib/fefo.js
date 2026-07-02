// FEFO Rotation module — Phase 6 (mock UI) + Phase 7 (live data wiring).
//
// What ships here:
//   - Project config with date semantic + facility mapping
//   - Pure verdict engine (line + order + severity ordering)
//   - Plain-language verdict copy generator (pack vs expiration aware)
//   - Per-project date parsers — YDDDHHMMSS / MMDDYYYY / PPW+MMDDYYYY → { k, kDay, display }
//   - Hold status detector — multiple Datex statuses count as "on hold"
//   - Aggregations: banner counts, KPI row, by-project rollup
//   - Day stepper helpers (5 ship days)
//   - Mock fixtures (fefoOrderList) — last-resort fallback when live fetch fails
//   - Live fetchers (single + batch) — call /.netlify/functions/fefo-orders
//
// The verdict engine + copy logic is shape-stable across mock and live —
// only the Order source changes.
//
// ── Two-key sorting model (2026-07-01) ─────────────────────────────────────
// Parsers return both `k` and `kDay`:
//   - k    — full-precision sort key (Fair Oaks: includes HH:MM:SS; Richelieu /
//            Crown: identical to kDay since those formats are day-level only).
//            Used to pick the truly-oldest lot as REM within a day.
//   - kDay — day-level integer. Used for violation comparisons. Two Fair Oaks
//            lots produced at 10:00 and 14:00 on the same day should NOT flag
//            as a rotation violation — same-day pack date is same-age
//            inventory operationally. See Hill's Slack feedback 2026-07-01.

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
]

export function getProject(projId) {
  return FEFO_PROJECTS.find(p => p.id === projId) || null
}

export function dateVerb(projId) {
  const p = getProject(projId)
  return p?.dateSemantic === 'expiration' ? 'expiring' : 'packed'
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
  // kDay drops HH:MM:SS so same-day lots compare equal in the verdict
  // engine (see lineVerdict). k retains full precision for sorting the
  // truly-oldest lot when we pick a REM candidate within a day.
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
  // MMDDYYYY is inherently day-level — k and kDay are identical here.
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

// ─── Verdict engine ─────────────────────────────────────────────────────────

export const VERDICT_PRECEDENCE = { violation: 0, stale: 1, hold: 2, clean: 3 }

// lineVerdict — flag a rotation violation only when REM is strictly older
// than the oldest ship lot BY DAY. Historically compared full k which,
// for Fair Oaks (YDDDHHMMSS), included HH:MM:SS — meaning two lots on the
// same day at 10:00 vs 14:00 would flag as a violation despite being
// operationally same-age inventory. Hill's 2026-07-01 feedback: only flag
// stuff that's OLDER, not stuff with a different date code.
//
// Falls back to `k` when kDay is absent to stay compatible with any older
// cached response payloads or mock fixtures that predate the two-key model.
export function lineVerdict(line) {
  if (!line?.ship?.length) return 'clean'
  const oldKDay = Math.min(...line.ship.map(s => s.kDay ?? s.k))
  const rem = line.rem
  const remKDay = rem?.kDay ?? rem?.k
  if (rem && rem.lps > 0 && remKDay != null && remKDay < oldKDay) {
    return rem.hold ? 'hold' : 'violation'
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

export function compareByVerdict(a, b) {
  const av = orderVerdict(a)
  const bv = orderVerdict(b)
  return VERDICT_PRECEDENCE[av] - VERDICT_PRECEDENCE[bv]
}

// ─── Verdict copy ───────────────────────────────────────────────────────────

export function verdictCopy(line, projId) {
  const verb = dateVerb(projId)
  const v = lineVerdict(line)
  if (v === 'violation') {
    const oldShip = line.ship.reduce((a, b) => a.k < b.k ? a : b)
    const stockUnit = line.rem.lps > 0 ? `${line.rem.lps} LP${line.rem.lps === 1 ? '' : 's'}` : 'stock'
    return `Out of rotation — ${stockUnit} ${verb} ${line.rem.date} (${line.rem.cases} cs) sit unallocated and off hold, older than the ${oldShip.date} stock on this order. Swap them in before it ships.`
  }
  if (v === 'hold') {
    const holdType = line.rem.holdType || 'hold'
    return `Older stock exists (${verb} ${line.rem.date}, ${line.rem.lps} LP) but it is on ${holdType}, so it is correctly skipped. Release the hold before it can ship in rotation.`
  }
  if (!line.rem || line.rem.lps === 0) {
    return 'In rotation — the oldest stock on hand is shipping first… fully cleared.'
  }
  return 'In rotation — the oldest stock on hand is shipping first.'
}

// ─── Aggregations ───────────────────────────────────────────────────────────

export function bannerCounts(orders) {
  const out = { violations: [], stale: [], holds: [], allClean: false }
  for (const o of orders) {
    const v = orderVerdict(o)
    if (v === 'violation') out.violations.push(o.id)
    else if (v === 'stale') out.stale.push(o.id)
    else if (v === 'hold') out.holds.push(o.id)
  }
  out.allClean = orders.length > 0 && !out.violations.length && !out.stale.length && !out.holds.length
  return out
}

export function kpiRow(orders) {
  let lps = 0, materials = new Set(), violations = 0, stale = 0, holds = 0
  for (const o of orders) {
    const v = orderVerdict(o)
    if (v === 'violation') violations++
    else if (v === 'stale') stale++
    else if (v === 'hold') holds++
    for (const line of (o.lines || [])) {
      materials.add(line.code)
      for (const s of (line.ship || [])) lps += s.lps || 0
    }
  }
  return { orders: orders.length, lps, materials: materials.size, violations, stale, holds }
}

export function rollupByProject(orders) {
  const map = new Map()
  for (const proj of FEFO_PROJECTS) {
    map.set(proj.id, { proj, orders: 0, lps: 0, violations: 0, stale: 0, holds: 0 })
  }
  for (const o of orders) {
    const r = map.get(o.proj)
    if (!r) continue
    r.orders++
    for (const line of (o.lines || []))
      for (const s of (line.ship || [])) r.lps += s.lps || 0
    const v = orderVerdict(o)
    if (v === 'violation') r.violations++
    else if (v === 'stale') r.stale++
    else if (v === 'hold') r.holds++
  }
  return [...map.values()].sort((a, b) => {
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
  violation: { color: 'var(--red, #c0392b)',    bg: 'rgba(192, 57, 43, 0.08)',  label: '\u26A0 Out of rotation', pill: 'violation' },
  stale:     { color: 'var(--orange, #d4824a)', bg: 'rgba(212, 130, 74, 0.08)', label: '\u25F7 Stale \u00b7 overdue',  pill: 'stale' },
  hold:      { color: 'var(--blue, #2a72b8)',   bg: 'rgba(42, 114, 184, 0.08)', label: '\u23F8 Older lot held',  pill: 'hold' },
  clean:     { color: 'var(--green, #1a8a52)',  bg: 'rgba(26, 138, 82, 0.08)',  label: '\u2713 In rotation',     pill: 'clean' },
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
// Calls /.netlify/functions/fefo-orders with a list of projectIds so all
// projects load on a SINGLE duckdb connection. Replaces the per-project
// fan-out (which triggered a duckdb connection-init bug under parallel Lambda
// invocations — connections failed in ~6ms with "Connection was never
// established"). All projects must share one facility (Phase 7b scope: ken).

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
  const facility = projects[0].facility
  const mixed = projects.some(p => p.facility !== facility)
  if (mixed) {
    return { ordersByProject: {}, errorsByProject: {}, fetchedAt: now(), source: 'mock', error: 'batch requires all projects in same facility' }
  }
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
        fetchedAt: now(),
        source: 'mock',
        elapsedMs: body.elapsedMs,
        error: body.error || `HTTP ${res.status}`,
      }
    }
    return {
      ordersByProject: body.ordersByProject || {},
      errorsByProject: body.errorsByProject || {},
      fetchedAt: body.fetchedAt || now(),
      source: 'live',
      elapsedMs: body.elapsedMs,
    }
  } catch (e) {
    console.warn('fetchLiveFefoOrdersBatch failed:', e.message)
    return {
      ordersByProject: Object.fromEntries(projectIds.map(pid => [pid, []])),
      errorsByProject: Object.fromEntries(projectIds.map(pid => [pid, e.message || 'unknown'])),
      fetchedAt: now(),
      source: 'mock',
      error: e.message,
    }
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Last-resort fallback when every live fetch fails.

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
          rem: { date: '6/15/25', k: 250615, lps: 5, cases: 120, hold: false, lot: 'L2406C' },
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
          rem: { date: '10/30/25', k: 251030, lps: 4, cases: 32, hold: false, lot: 'R2510B' },
        },
      ],
    },
  ]
}
