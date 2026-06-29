// FEFO Rotation module — Phase 6 (mock UI).
//
// What ships here:
//   - Project config (FAIOA5/FOFWE5/RICHE5/GOLST5) with date semantic
//   - Pure verdict engine (line + order + severity ordering)
//   - Plain-language verdict copy generator (pack vs expiration aware)
//   - Aggregations: banner counts, KPI row, by-project rollup
//   - Day stepper helpers (5 ship days)
//   - Mock fixtures: ~12 orders across 4 projects, calibrated to show every
//     verdict state (violation / stale / hold / clean) so the screen demos
//     all 4 banner types and the auto-expand behavior.
//
// Phase 7 will replace fefoOrderList() with a Datex FootPrint fetch but keep
// the verdict engine + copy logic untouched. Anything that's project-specific
// (date semantic, parsing format codes) lives in FEFO_PROJECTS so a single
// edit there propagates everywhere.

// ─── Projects ────────────────────────────────────────────────────
// Per handoff §3.1. `dateSemantic` drives the verdict-copy verb (packed vs
// expiring); `dateFormat` is documentation for Phase 7 parsing.

export const FEFO_PROJECTS = [
  {
    id: 'faioa5', code: 'FAIOA5', name: 'Fair Oaks Farms',
    proj: 59,  dateFormat: 'YDDDHHMMSS', dateSemantic: 'pack',
    color: '#e07b4d',
  },
  {
    id: 'fofwe5', code: 'FOFWE5', name: 'Fair Oaks Farms West',
    proj: 61,  dateFormat: 'YDDDHHMMSS', dateSemantic: 'pack',
    color: '#d4824a',
  },
  {
    id: 'riche5', code: 'RICHE5', name: 'Richelieu Foods',
    proj: 219, dateFormat: 'MMDDYYYY', dateSemantic: 'expiration',
    color: '#7b5cd0',
  },
  {
    id: 'golst5', code: 'GOLST5', name: 'Crown Bakeries',
    proj: 88,  dateFormat: 'PPW+MMDDYYYY', dateSemantic: 'pack',
    color: '#3dba7e',
  },
]

export function getProject(projId) {
  return FEFO_PROJECTS.find(p => p.id === projId) || null
}

// Returns "packed" or "expiring" for verdict copy — per handoff note:
// "Richelieu violations read as 'packed {expirationDate}' and confuse CSRs".
export function dateVerb(projId) {
  const p = getProject(projId)
  return p?.dateSemantic === 'expiration' ? 'expiring' : 'packed'
}

// ─── Verdict engine ──────────────────────────────────────────────────
// Per handoff §3.7. Pure functions — no side effects, no DOM, no fetches.

export const VERDICT_PRECEDENCE = { violation: 0, stale: 1, hold: 2, clean: 3 }

export function lineVerdict(line) {
  if (!line?.ship?.length) return 'clean'
  const oldK = Math.min(...line.ship.map(s => s.k))
  const rem = line.rem
  if (rem && rem.lps > 0 && rem.k < oldK) {
    return rem.hold ? 'hold' : 'violation'
  }
  return 'clean'
}

export function orderVerdict(order) {
  const verdicts = (order.lines || []).map(lineVerdict)
  // Worst-of-lines: lowest precedence number wins.
  const worst = verdicts.length
    ? verdicts.reduce((a, b) => VERDICT_PRECEDENCE[a] <= VERDICT_PRECEDENCE[b] ? a : b)
    : 'clean'
  // Stale overlay: past appointments upgrade to stale UNLESS already a violation.
  if (order.past && worst !== 'violation') return 'stale'
  return worst
}

export function compareByVerdict(a, b) {
  const av = orderVerdict(a)
  const bv = orderVerdict(b)
  return VERDICT_PRECEDENCE[av] - VERDICT_PRECEDENCE[bv]
}

// ─── Verdict copy ─────────────────────────────────────────────────────
// Plain-language explanation per SKU line. The handoff spec is the source of
// truth for the wording; pack vs expiration is the only per-project variable.

export function verdictCopy(line, projId) {
  const verb = dateVerb(projId)
  const v = lineVerdict(line)
  if (v === 'violation') {
    const oldShip = line.ship.reduce((a, b) => a.k < b.k ? a : b)
    return `Out of rotation — ${line.rem.lps} LPs ${verb} ${line.rem.date} (${line.rem.cases} cs) sit unallocated and off hold, older than the ${oldShip.date} stock on this order. Swap them in before it ships.`
  }
  if (v === 'hold') {
    const holdType = line.rem.holdType || 'hold'
    return `Older stock exists (${verb} ${line.rem.date}, ${line.rem.lps} LP) but it is on ${holdType}, so it is correctly skipped. Release the hold before it can ship in rotation.`
  }
  // Clean
  if (!line.rem || line.rem.lps === 0) {
    return 'In rotation — the oldest stock on hand is shipping first… fully cleared.'
  }
  return 'In rotation — the oldest stock on hand is shipping first.'
}

// ─── Aggregations ──────────────────────────────────────────────────

// Banner counts — drives the four stacked banners at top of screen.
// Only render a banner if its count > 0 (per handoff §3.2).
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

// 6-cell KPI row.
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
  return {
    orders: orders.length,
    lps,
    materials: materials.size,
    violations,
    stale,
    holds,
  }
}

// Per-project rollup — used when filter = "All Projects".
// Returns array sorted with violations first.
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
    // Violations first, then stale, then orders count desc.
    if (a.violations !== b.violations) return b.violations - a.violations
    if (a.stale !== b.stale) return b.stale - a.stale
    return b.orders - a.orders
  })
}

// ─── Day stepper helpers ─────────────────────────────────────────────────

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

// ─── Verdict styling tokens ───────────────────────────────────────────────

export const VERDICT_TOKENS = {
  violation: { color: 'var(--red, #c0392b)',    bg: 'rgba(192, 57, 43, 0.08)',  label: '\u26A0 Out of rotation', pill: 'violation' },
  stale:     { color: 'var(--orange, #d4824a)', bg: 'rgba(212, 130, 74, 0.08)', label: '\u25F7 Stale \u00b7 overdue',  pill: 'stale' },
  hold:      { color: 'var(--blue, #2a72b8)',   bg: 'rgba(42, 114, 184, 0.08)', label: '\u23F8 Older lot held',  pill: 'hold' },
  clean:     { color: 'var(--green, #1a8a52)',  bg: 'rgba(26, 138, 82, 0.08)',  label: '\u2713 In rotation',     pill: 'clean' },
}

// ─── Fixtures ───────────────────────────────────────────────────────
// Phase 7 will replace this with a Datex FootPrint fetch. Until then, these
// orders are calibrated to demonstrate every verdict + auto-expand behavior:
//   - 2 violations (1 Fair Oaks pack date, 1 Richelieu expiration — proves
//     the "packed" vs "expiring" copy switch works)
//   - 1 stale (past appointment, would otherwise be clean)
//   - 2 holds (older lot exists but on hold)
//   - 5 clean (in rotation, mix of single-SKU and multi-SKU)
//   - 2 future-day orders on day=1 to prove the day stepper works
//
// k values are arbitrary sortable integers. Lower k = older. Phase 7 will
// derive these from FootPrint date strings per each project's dateFormat.
// `date` is the display-formatted string; `k` is what the verdict engine reads.

export function fefoOrderList() {
  return [
    // ── Day 0 (today) ── violations + stale + holds + clean ──
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
        {
          code: 'FOF-4902', desc: 'Cheddar Cheese Curds 16oz', pack: '12 / case',
          ship: [
            { date: '6/22/25', k: 250622, lps: 6, cases: 72, codes: ['LP-880118', 'LP-880125'], lot: 'L2406D' },
          ],
          rem: { date: '6/22/25', k: 250622, lps: 0, cases: 0, hold: false },
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
    {
      id: 'SO-118455', day: 0, proj: 'golst5',
      dest: 'BigBox SuperCenter',
      appt: '13:15', past: false,
      status: 'Allocated', allocBy: 'kmartinez',
      lines: [
        {
          code: 'CRN-3301', desc: 'Brioche Buns 6pk', pack: '12 / case',
          ship: [
            { date: '6/20/25', k: 250620, lps: 12, cases: 144, codes: ['LP-664401', 'LP-664410', 'LP-664425'], lot: 'C2406A' },
            { date: '6/23/25', k: 250623, lps: 8,  cases: 96,  codes: ['LP-665002', 'LP-665018'], lot: 'C2406B' },
          ],
          rem: { date: '6/23/25', k: 250623, lps: 0, cases: 0, hold: false },
        },
      ],
    },
    {
      id: 'SO-118412', day: 0, proj: 'fofwe5',
      dest: 'Sysco Indianapolis',
      appt: '08:45', past: true,
      status: 'Allocated', allocBy: 'jolsen',
      lines: [
        {
          code: 'FOW-7012', desc: 'String Cheese 1oz', pack: '48 / case',
          ship: [
            { date: '6/18/25', k: 250618, lps: 14, cases: 672, codes: ['LP-998011', 'LP-998023', 'LP-998037'], lot: 'W2406A' },
          ],
          rem: { date: '6/18/25', k: 250618, lps: 0, cases: 0, hold: false },
        },
      ],
    },
    {
      id: 'SO-118501', day: 0, proj: 'faioa5',
      dest: 'US Foods Cincinnati',
      appt: '16:00', past: false,
      status: 'Allocated', allocBy: 'kmartinez',
      lines: [
        {
          code: 'FOF-4801', desc: '12oz Mozzarella Sticks', pack: '24 / case',
          ship: [
            { date: '6/26/25', k: 250626, lps: 6, cases: 144, codes: ['LP-883204', 'LP-883219'], lot: 'L2406B' },
          ],
          rem: { date: '6/19/25', k: 250619, lps: 3, cases: 72, hold: true, holdType: 'QA hold', lot: 'L2406E' },
        },
      ],
    },
    {
      id: 'SO-118522', day: 0, proj: 'riche5',
      dest: 'Walmart DC Loveland',
      appt: '09:30', past: false,
      status: 'Allocated', allocBy: 'dgraham',
      lines: [
        {
          code: 'RIC-2310', desc: 'Cheese Pizza 12in', pack: '8 / case',
          ship: [
            { date: '11/02/25', k: 251102, lps: 9, cases: 72, codes: ['LP-772840', 'LP-772855'], lot: 'R2510C' },
          ],
          rem: { date: '11/02/25', k: 251102, lps: 0, cases: 0, hold: false },
        },
      ],
    },
    {
      id: 'SO-118538', day: 0, proj: 'golst5',
      dest: 'Kroger Atlanta DC',
      appt: '15:45', past: false,
      status: 'Allocated', allocBy: 'kmartinez',
      lines: [
        {
          code: 'CRN-3408', desc: 'Whole Wheat Hamburger Buns 8pk', pack: '6 / case',
          ship: [
            { date: '6/21/25', k: 250621, lps: 7, cases: 42, codes: ['LP-664780', 'LP-664795'], lot: 'C2406D' },
          ],
          rem: { date: '6/18/25', k: 250618, lps: 2, cases: 12, hold: true, holdType: 'pending QA', lot: 'C2406E' },
        },
      ],
    },
    {
      id: 'SO-118544', day: 0, proj: 'fofwe5',
      dest: 'US Foods Louisville',
      appt: '12:00', past: false,
      status: 'Allocated', allocBy: 'jolsen',
      lines: [
        {
          code: 'FOW-7012', desc: 'String Cheese 1oz', pack: '48 / case',
          ship: [
            { date: '6/23/25', k: 250623, lps: 5, cases: 240, codes: ['LP-998310'], lot: 'W2406B' },
          ],
          rem: { date: '6/23/25', k: 250623, lps: 0, cases: 0, hold: false },
        },
      ],
    },
    {
      id: 'SO-118560', day: 0, proj: 'faioa5',
      dest: 'Costco MW Distribution',
      appt: '17:30', past: false,
      status: 'Allocated', allocBy: 'kmartinez',
      lines: [
        {
          code: 'FOF-5101', desc: 'Cheese Shreds 5lb', pack: '6 / case',
          ship: [
            { date: '6/25/25', k: 250625, lps: 4, cases: 24, codes: ['LP-883501'], lot: 'L2406F' },
          ],
          rem: { date: '6/25/25', k: 250625, lps: 0, cases: 0, hold: false },
        },
      ],
    },
    // ── Day 1 (tomorrow) ── 2 orders, both clean ──
    {
      id: 'SO-118611', day: 1, proj: 'golst5',
      dest: 'Publix Lakeland DC',
      appt: '07:00', past: false,
      status: 'Pre-allocated', allocBy: 'kmartinez',
      lines: [
        {
          code: 'CRN-3301', desc: 'Brioche Buns 6pk', pack: '12 / case',
          ship: [
            { date: '6/24/25', k: 250624, lps: 10, cases: 120, codes: ['LP-665201', 'LP-665215'], lot: 'C2406F' },
          ],
          rem: { date: '6/24/25', k: 250624, lps: 0, cases: 0, hold: false },
        },
      ],
    },
    {
      id: 'SO-118620', day: 1, proj: 'riche5',
      dest: 'Sysco Pittsburgh',
      appt: '10:30', past: false,
      status: 'Pre-allocated', allocBy: 'dgraham',
      lines: [
        {
          code: 'RIC-2204', desc: 'Pepperoni Pizza 12in', pack: '8 / case',
          ship: [
            { date: '11/28/25', k: 251128, lps: 8, cases: 64, codes: ['LP-772990'], lot: 'R2511C' },
          ],
          rem: { date: '11/28/25', k: 251128, lps: 0, cases: 0, hold: false },
        },
      ],
    },
  ]
}
