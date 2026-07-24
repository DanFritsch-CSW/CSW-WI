// src/lib/pviShelfLife.js
//
// Pure client-side helpers for the PVI Shelf Life dashboard. No React, no
// Supabase, no fetch — all inputs are plain data so this module is easy to
// unit-test and iterate on without redeploying the Netlify function.
//
// Public surface:
//   buildRawNameToCanonical(canonicals, nameMap)
//   resolveCanonical(rawName, index)
//   getShelfLifeDays(canonical)
//   velocityConfidence(shipments30d)
//   projectFefo({ lots, pendingOrders, velocity, materialShipHistory, materialSpecs, canonicalIndex })
//   verdictForLot({ daysToCodeToday, daysToCodeAtShip, shelfLifeDays, shortfallDays, projectNumber })
//   formatLotForEmail(row)
//   bulkCopyForEmail(rows)
//   DISPOSITION_OPTIONS, DISPOSITION_META  (per-lot Tag catalog, 2026-07-07)
//   PROJECT_CODE_MAP, formatProjectLabel   (Palermo's internal project
//                                           numbers, 2026-07-07)

export const STAGE_ORDER = ['expired', 'unshippable', 'critical', 'at_risk', 'watch']

export const STAGE_META = {
  watch:        { label: 'Watch',        color: '#5b9bd5', bg: '#eaf2fa' },
  at_risk:      { label: 'At Risk',      color: '#c88a2a', bg: '#fbf1de' },
  critical:     { label: 'Critical',     color: '#d1583a', bg: '#fbe4dd' },
  unshippable:  { label: 'Unshippable',  color: '#8b3a89', bg: '#f2e2f2' },
  expired:      { label: 'Expired',      color: '#5f2c2c', bg: '#e8d4d4' },
}

// Stages that make up the default filter. Narrowed 2026-07-07 per Hill:
// only At Risk + Critical are on by default; Expired and Unshippable are
// off by default so the dashboard opens focused on actionable inventory.
// Operator toggles Expired/Unshippable on when doing a full audit.
export const DEFAULT_STAGES = new Set(['at_risk', 'critical'])

// Runtime fallback shelf-life spec when a material has no curated spec,
// no allocation customer spec, and no shipment history. Per Hill: "default
// to 96 days if the material hasn't shipped yet." Applied to end-customer
// and unmapped allocations, NOT to internal_transfer.
export const DEFAULT_UNSHIPPED_SHELF_LIFE_DAYS = 96

// ── Palermo's internal project numbers (2026-07-07, Hill + Dean) ────────
//
// Palermo's tracks these projects by an internal numeric ID that does NOT
// exist anywhere in Datex/Omni — it's purely their own bookkeeping
// convention. Hill asked that both the Omni project_lookup code AND
// Palermo's number show together everywhere a project appears.
//
// Dean's clarification (2026-07-07, in response to "243 is what again?"):
//   PALVI9  = 247
//   PALVI5  = 240
//   PALDSD5 = 243
//   PALDSD9 = 243
// So project number 243 ("DSD") covers TWO project_lookup codes
// (PALDSD5 and PALDSD9) — this is why the unshippable-threshold and
// required-days-override logic below key off the NUMBER, not the raw
// lookup, wherever Hill's rule is stated in terms of "243"/"247"/"248".
//
// PALVI5/PALDSD5 were previously missing from both this map AND the
// Netlify function's PVI_PROJECT_LOOKUPS allowlist (see
// netlify/functions/pvi-shelf-life.cjs) — their lots never reached the
// client at all before this fix.
//
// This mapping is display-only. It never reaches Datex/Omni/MotherDuck —
// project_lookup (the Omni-side code) remains the actual filter/query key
// throughout the app; PROJECT_CODE_MAP only decorates the label shown to
// the user (except where explicitly noted below, e.g. the 243 required-
// days override, which intentionally keys off the derived NUMBER).
export const PROJECT_CODE_MAP = {
  PALVI9:  '247',
  PALVI5:  '240',
  PALDSD9: '243',
  PALDSD5: '243',
  PALMA9:  '248',
}

// formatProjectLabel — "PALVI9 · 247" when a mapping exists, otherwise just
// the raw lookup code (covers any future/unmapped project_lookup values
// without hiding them). Returns null for falsy input so callers can do
// `{row.project_lookup && <div>{formatProjectLabel(row.project_lookup)}</div>}`
// without an extra guard.
export function formatProjectLabel(projectLookup) {
  if (!projectLookup) return null
  const code = PROJECT_CODE_MAP[projectLookup]
  return code ? `${projectLookup} \u00b7 ${code}` : projectLookup
}

// ── Verdict tuning (2026-07-07, Hill: "our categories are too wonky") ───
//
// Hill's Slack rewrite of the five verdict stages, replacing the old
// ratio-based (daysToCodeAtShip / shelfLifeDays) approach entirely:
//
//   Expired      — Days to Code is negative                      (today)
//   Unshippable  — Days to Code < 30 for 243, < 90 for 247/240,
//                  < 5 for 248                                    (today)
//   Critical     — projected ship is under req by MORE than 15 days
//   At Risk      — projected ship is under req by 0–15 days
//   Watch        — leave as is (everything else: has buffer, or we
//                  don't have enough data to say)
//
// Worth flagging: "Days to Code" for Unshippable is explicitly TODAY's
// count, not at-projected-ship — same as Expired. This is a real behavior
// change from the old rule (which used daysToCodeAtShip <= 0). It reframes
// Unshippable from "will be past code by the time it ships" to "this
// project's customer won't even consider it beyond this floor, regardless
// of when it's projected to actually move."
//
// 240 (PALVI5) threshold confirmed by Hill 2026-07-24: "240 can match
// 247" — same 90-day floor as PALVI9. Any project_lookup not covered here
// (i.e. not 243/247/248/240) falls back to the pre-existing "at or past
// projected ship" definition via the `else` branch in verdictForLot, so
// coverage isn't silently lost if a new project code shows up before a
// threshold is defined for it.
const UNSHIPPABLE_DAYS_TO_CODE_THRESHOLD_BY_PROJECT_NUMBER = {
  '243': 30,
  '247': 90,
  '248': 5,
  '240': 90, // matches 247, per Hill 2026-07-24
}

// Critical/At Risk split point on shortfall_days (shelfLifeDays required −
// daysToCodeAtShip; positive = lands under spec at projected ship).
const CRITICAL_SHORTFALL_THRESHOLD_DAYS = 15

// "for all items in 243, the required days should be 30" — Hill, same
// message. Unconditional override: whatever the normal spec-resolution
// chain (ops-edited material spec > allocation > 365-day history > 96-day
// default) would have produced, project number 243 always gets 30. Keyed
// by NUMBER (not project_lookup) since both PALDSD5 and PALDSD9 map to it.
const REQUIRED_DAYS_OVERRIDE_BY_PROJECT_NUMBER = {
  '243': 30,
}

// ── PVI Lot Dispositions (2026-07-07, Hill request) ─────────────────────
//
// Nine allowed disposition values per Hill's Slack (2026-07-07 9:12 AM).
// Order chosen so operators scan a natural workflow: pending approvals at
// the top (need action), approved states next, then already-handled states,
// then terminal states (Quarantine, Donation). Persisted per-lot in
// pvi_lot_dispositions along with a free-text Owner field.

export const DISPOSITION_OPTIONS = [
  'Disposal - Pending Approval',
  'Disposal - Approved',
  'Customer Acceptance - Pending',
  'Customer Acceptance - Approved',
  'Sell-Through - DSD',
  'Ship - Scheduled',
  'Claim / Reimbursement',
  'Quarantine / Loss',
  'Donation',
]

// One badge style per disposition. `label` is the display string used in
// the drawer dropdown; `short` is the compact tag used in the inline table
// cell (limited horizontal space). Colors picked to differentiate at-a-
// glance in the table without visually competing with STAGE_META badges —
// stage wins on urgency, disposition is secondary status.
export const DISPOSITION_META = {
  'Disposal - Pending Approval':    { label: 'Disposal (Pending)',  short: 'Disp Pend',   color: '#c88a2a', bg: '#fbf1de' },
  'Disposal - Approved':            { label: 'Disposal (Approved)', short: 'Disp OK',     color: '#8b1a1a', bg: '#f9e0e0' },
  'Customer Acceptance - Pending':  { label: 'Cust Accept (Pend)',  short: 'Cust Pend',   color: '#5b9bd5', bg: '#eaf2fa' },
  'Customer Acceptance - Approved': { label: 'Cust Accept (OK)',    short: 'Cust OK',     color: '#3a7a3a', bg: '#e4f0e4' },
  'Sell-Through - DSD':             { label: 'Sell-Through DSD',    short: 'DSD',         color: '#2b8a91', bg: '#dff0f2' },
  'Ship - Scheduled':               { label: 'Ship Scheduled',      short: 'Ship Sched',  color: '#3a7a3a', bg: '#e4f0e4' },
  'Claim / Reimbursement':          { label: 'Claim/Reimburse',     short: 'Claim',       color: '#7d3aa1', bg: '#efe4f7' },
  'Quarantine / Loss':              { label: 'Quarantine/Loss',     short: 'Quar/Loss',   color: '#5f2c2c', bg: '#e8d4d4' },
  'Donation':                       { label: 'Donation',            short: 'Donate',      color: '#a86a2a', bg: '#f5e6d3' },
}

// ── Canonical resolution ───────────────────────────────────────────

export function buildRawNameToCanonical(canonicals, nameMap) {
  const byCanonId = new Map(canonicals.map(c => [c.id, c]))
  const byRaw = new Map()
  for (const m of nameMap) {
    const canon = byCanonId.get(m.canonical_id)
    if (canon) byRaw.set(normalizeName(m.raw_account_name), canon)
  }
  return { byRaw, byCanonId }
}

export function resolveCanonical(rawName, index) {
  if (!rawName || !index) return null
  return index.byRaw.get(normalizeName(rawName)) || null
}

function normalizeName(s) {
  return String(s || '').toUpperCase().trim()
}

export function getShelfLifeDays(canonical) {
  if (!canonical) return null
  if (canonical.account_type === 'internal_transfer') return null
  return canonical.override_days ?? null
}

// ── Velocity confidence tiers ────────────────────────────────────

export function velocityConfidence(shipments30d) {
  const s = Number(shipments30d) || 0
  if (s >= 12) return { tier: 'high', label: 'High', color: '#3a7a3a' }
  if (s >= 4)  return { tier: 'med',  label: 'Med',  color: '#c88a2a' }
  return       { tier: 'low',  label: 'Low',  color: '#d1583a' }
}

export function dailyCaseRate(vel) {
  if (!vel) return 0
  const r30 = (Number(vel.cases_30d) || 0) / 30
  const r60 = (Number(vel.cases_60d) || 0) / 60
  const r90 = (Number(vel.cases_90d) || 0) / 90
  const rates = [r30, r60, r90].filter(r => r > 0)
  if (rates.length === 0) return 0
  return Math.min(...rates)
}

function buildMaterialBaselines(materialShipHistory, canonicalIndex) {
  const casesByMaterialCanonical = new Map()
  for (const h of materialShipHistory || []) {
    const canon = resolveCanonical(h.ship_to_raw_name, canonicalIndex)
    if (!canon || canon.account_type === 'internal_transfer') continue
    if (!casesByMaterialCanonical.has(h.material_id)) {
      casesByMaterialCanonical.set(h.material_id, new Map())
    }
    const inner = casesByMaterialCanonical.get(h.material_id)
    inner.set(canon.id, (inner.get(canon.id) || 0) + (Number(h.cases_90d) || 0))
  }

  const dominantByMaterial = new Map()
  const strictestByMaterial = new Map()
  for (const [materialId, inner] of casesByMaterialCanonical) {
    let bestCanon = null, bestCases = -1
    let strictestCanon = null, strictestDays = -1
    for (const [canonId, cases] of inner) {
      const canon = canonicalIndex.byCanonId.get(canonId)
      if (!canon) continue
      if (cases > bestCases) { bestCases = cases; bestCanon = canon }
      const spec = getShelfLifeDays(canon)
      if (spec != null && spec > strictestDays) {
        strictestDays = spec
        strictestCanon = canon
      }
    }
    if (bestCanon)     dominantByMaterial.set(materialId,  bestCanon)
    if (strictestCanon) strictestByMaterial.set(materialId, { canonical: strictestCanon, spec_days: strictestDays })
  }

  return { dominantByMaterial, strictestByMaterial }
}

export function projectFefo({ lots, pendingOrders, velocity, materialShipHistory, materialSpecs, canonicalIndex, today }) {
  const now = today ? new Date(today) : new Date()
  const todayMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

  const { dominantByMaterial, strictestByMaterial } = buildMaterialBaselines(
    materialShipHistory || [],
    canonicalIndex,
  )

  const materialSpecMap = new Map()
  for (const s of (materialSpecs || [])) {
    const days = Number(s?.shelf_life_days_required)
    if (Number.isFinite(days) && days > 0 && s?.material_id != null) {
      materialSpecMap.set(s.material_id, days)
    }
  }

  const lotsByMaterial = new Map()
  for (const lot of lots) {
    if (!lotsByMaterial.has(lot.material_id)) lotsByMaterial.set(lot.material_id, [])
    lotsByMaterial.get(lot.material_id).push({ ...lot, _remaining: lot.cases_available })
  }
  for (const arr of lotsByMaterial.values()) {
    arr.sort((a, b) => {
      const ax = a.expiration_date_iso ? Date.parse(a.expiration_date_iso) : Infinity
      const bx = b.expiration_date_iso ? Date.parse(b.expiration_date_iso) : Infinity
      if (ax !== bx) return ax - bx
      return a.lot_id - b.lot_id
    })
  }

  const velByKey = new Map()
  const velByMaterial = new Map()
  for (const v of velocity) {
    velByKey.set(`${v.material_id}|${v.project_lookup}`, v)
    if (!velByMaterial.has(v.material_id)) velByMaterial.set(v.material_id, v)
  }
  const getVelocity = (materialId, projectLookup) => {
    return velByKey.get(`${materialId}|${projectLookup}`)
        || velByMaterial.get(materialId)
        || null
  }

  const allocations = new Map()

  const sortedOrders = [...pendingOrders].sort((a, b) => {
    const ax = a.scheduled_arrival_iso ? Date.parse(a.scheduled_arrival_iso) : Infinity
    const bx = b.scheduled_arrival_iso ? Date.parse(b.scheduled_arrival_iso) : Infinity
    return ax - bx
  })

  for (const ord of sortedOrders) {
    const canon = resolveCanonical(ord.ship_to_raw_name, canonicalIndex)
    for (const line of ord.lines || []) {
      let need = line.cases
      const queue = lotsByMaterial.get(line.material_id)
      if (!queue) continue
      for (const lot of queue) {
        if (need <= 0) break
        if (lot._remaining <= 0) continue
        const take = Math.min(lot._remaining, need)
        lot._remaining -= take
        need -= take
        if (!allocations.has(lot.lot_id)) allocations.set(lot.lot_id, [])
        allocations.get(lot.lot_id).push({
          cases:               take,
          canonical:           canon,
          projected_ship_iso:  ord.scheduled_arrival_iso,
          source:              'scheduled',
          order_lookup:        ord.order_lookup,
          ship_to_raw_name:    ord.ship_to_raw_name,
        })
      }
    }
  }

  for (const [materialId, queue] of lotsByMaterial) {
    const remaining = queue.reduce((s, l) => s + l._remaining, 0)
    if (remaining <= 0) continue
    const projectLookup = queue.find(l => l.project_lookup)?.project_lookup || null
    const vel = getVelocity(materialId, projectLookup)
    const perDay = dailyCaseRate(vel)
    const projectedAccount = dominantByMaterial.get(materialId) || null
    let cumCases = 0
    for (const lot of queue) {
      if (lot._remaining <= 0) continue
      const midCases = cumCases + lot._remaining / 2
      const daysOut = perDay > 0 ? midCases / perDay : null
      const projectedShipMs = daysOut != null ? todayMid + daysOut * 86400000 : null
      const projectedShipIso = projectedShipMs != null ? new Date(projectedShipMs).toISOString() : null
      if (!allocations.has(lot.lot_id)) allocations.set(lot.lot_id, [])
      allocations.get(lot.lot_id).push({
        cases:               lot._remaining,
        canonical:           projectedAccount,
        projected_ship_iso:  projectedShipIso,
        source:              perDay > 0 ? 'projected' : 'no_velocity',
        velocity_per_day:    perDay,
      })
      cumCases += lot._remaining
    }
  }

  const rows = []
  for (const lot of lots) {
    const allocs = allocations.get(lot.lot_id) || []
    allocs.sort((a, b) => {
      const ax = a.projected_ship_iso ? Date.parse(a.projected_ship_iso) : Infinity
      const bx = b.projected_ship_iso ? Date.parse(b.projected_ship_iso) : Infinity
      return ax - bx
    })
    const primary = allocs[0] || null
    const vel = velByKey.get(`${lot.material_id}|${lot.project_lookup}`)
              || velByMaterial.get(lot.material_id)
              || null

    let shelfLifeDays = null
    let specSource   = null
    let displayCanonical = primary?.canonical || null

    const matSpec = materialSpecMap.get(lot.material_id)
    if (matSpec != null) {
      shelfLifeDays = matSpec
      specSource   = 'material_spec'
    } else {
      const allocDays = getShelfLifeDays(primary?.canonical)
      if (allocDays != null) {
        shelfLifeDays = allocDays
        specSource   = 'allocation'
      } else {
        const strictest = strictestByMaterial.get(lot.material_id)
        if (strictest) {
          shelfLifeDays = strictest.spec_days
          specSource   = 'material_history'
        }
        if (!displayCanonical) {
          displayCanonical = dominantByMaterial.get(lot.material_id) || null
        }
        if (shelfLifeDays == null && primary?.canonical?.account_type !== 'internal_transfer') {
          shelfLifeDays = DEFAULT_UNSHIPPED_SHELF_LIFE_DAYS
          specSource   = 'default_96'
        }
      }
    }

    // Project number derived from project_lookup — used both for display
    // (formatProjectLabel elsewhere) and for the two Hill rules below that
    // key off the NUMBER rather than the raw lookup code (since 243 covers
    // both PALDSD5 and PALDSD9).
    const projectNumber = lot.project_lookup ? (PROJECT_CODE_MAP[lot.project_lookup] || null) : null

    // Required-days override (2026-07-07, Hill): "for all items in 243,
    // the required days should be 30." Unconditional — replaces whatever
    // the spec-resolution chain above produced. Applied here, before
    // shortfall/verdict calculation, so everything downstream (shortfall
    // days, verdict stage, Vs. spec column, email copy) reflects the
    // overridden requirement automatically.
    const requiredOverride = projectNumber ? REQUIRED_DAYS_OVERRIDE_BY_PROJECT_NUMBER[projectNumber] : null
    if (requiredOverride != null) {
      shelfLifeDays = requiredOverride
      specSource   = 'project_override'
    }

    const expIso = lot.expiration_date_iso
    const expMs = expIso ? Date.parse(expIso) : null
    const daysToCodeToday = expMs != null
      ? Math.round((expMs - todayMid) / 86400000)
      : null
    let daysToCodeAtShip = daysToCodeToday
    if (expMs != null && primary?.projected_ship_iso) {
      const shipMs = Date.parse(primary.projected_ship_iso)
      const shipDay = Date.UTC(
        new Date(shipMs).getUTCFullYear(),
        new Date(shipMs).getUTCMonth(),
        new Date(shipMs).getUTCDate(),
      )
      daysToCodeAtShip = Math.round((expMs - shipDay) / 86400000)
    }
    const shortfallDays = (shelfLifeDays && daysToCodeAtShip != null)
      ? shelfLifeDays - daysToCodeAtShip
      : null
    const verdict = verdictForLot({ daysToCodeToday, daysToCodeAtShip, shelfLifeDays, shortfallDays, projectNumber })

    const displayPrimary = primary
      ? { ...primary, canonical: displayCanonical || primary.canonical }
      : (displayCanonical
          ? { cases: lot.cases_available, canonical: displayCanonical, projected_ship_iso: null, source: 'baseline' }
          : null)

    rows.push({
      ...lot,
      allocations:         allocs,
      primary:             displayPrimary,
      spec_source:         specSource,
      shelf_life_days:     shelfLifeDays,
      days_to_code_today:  daysToCodeToday,
      days_to_code_at_ship: daysToCodeAtShip,
      shortfall_days:      shortfallDays,
      velocity:            vel,
      velocity_confidence: vel ? velocityConfidence(vel.shipments_30d) : { tier: 'low', label: 'None', color: '#999' },
      verdict,
    })
  }

  return rows
}

// verdictForLot — rewritten 2026-07-07 per Hill ("our categories are too
// wonky right now"). Priority order, first match wins:
//
//   1. Expired      — daysToCodeToday < 0
//   2. Unshippable  — daysToCodeToday < per-project threshold (243/247/
//                      248/240 per UNSHIPPABLE_DAYS_TO_CODE_THRESHOLD_BY_
//                      PROJECT_NUMBER). Any project_lookup with no defined
//                      threshold falls back to the pre-existing "at or
//                      past projected ship" definition so nothing silently
//                      loses Unshippable coverage.
//   3. (no data)    — Watch, missingData flag, if we can't compute a
//                      shortfall (no projected ship or no spec).
//   4. Critical     — shortfallDays > 15
//   5. At Risk      — 0 <= shortfallDays <= 15
//   6. Watch        — shortfallDays < 0 (has buffer) — "leave as is"
export function verdictForLot({ daysToCodeToday, daysToCodeAtShip, shelfLifeDays, shortfallDays, projectNumber }) {
  if (daysToCodeToday != null && daysToCodeToday < 0) {
    return { stage: 'expired', ...STAGE_META.expired }
  }

  const unshippableThreshold = projectNumber
    ? UNSHIPPABLE_DAYS_TO_CODE_THRESHOLD_BY_PROJECT_NUMBER[projectNumber]
    : undefined
  if (unshippableThreshold != null) {
    if (daysToCodeToday != null && daysToCodeToday < unshippableThreshold) {
      return { stage: 'unshippable', ...STAGE_META.unshippable }
    }
  } else if (daysToCodeAtShip != null && daysToCodeAtShip <= 0) {
    // Fallback for projects Hill didn't give an explicit threshold for.
    return { stage: 'unshippable', ...STAGE_META.unshippable }
  }

  if (daysToCodeAtShip == null || shortfallDays == null) {
    return { stage: 'watch', ...STAGE_META.watch, missingData: true }
  }

  if (shortfallDays > CRITICAL_SHORTFALL_THRESHOLD_DAYS) {
    return { stage: 'critical', ...STAGE_META.critical }
  }
  if (shortfallDays >= 0) {
    return { stage: 'at_risk', ...STAGE_META.at_risk }
  }
  // shortfallDays < 0 → has buffer beyond spec. Leave as Watch per Hill.
  return { stage: 'watch', ...STAGE_META.watch }
}

const SPEC_SOURCE_LABEL = {
  material_spec:    'from material spec',
  allocation:       'from allocation',
  material_history: 'from 365-day history',
  default_96:       'default (no history)',
  project_override: 'project override (243 fixed at 30d)',
}

export function formatLotForEmail(row) {
  const parts = []
  parts.push(`Item: ${row.material_code} \u2014 ${row.material_desc}`)
  parts.push(`Lot: ${row.lot_code || '(no lot code)'}`)
  if (row.project_lookup) {
    parts.push(`Project: ${formatProjectLabel(row.project_lookup)}`)
  }
  parts.push(`Code date: ${row.expiration_date_iso || '(unknown)'}`)
  parts.push(`On hand: ${row.cases_onhand} cases`)
  parts.push(`Committed: ${row.cases_committed} cases`)
  parts.push(`Available: ${row.cases_available} cases`)
  parts.push(`Days to code (today): ${row.days_to_code_today ?? '?'}`)
  if (row.days_to_code_at_ship != null && row.days_to_code_at_ship !== row.days_to_code_today) {
    parts.push(`Days to code (at projected ship): ${row.days_to_code_at_ship}`)
  }
  if (row.shelf_life_days) {
    const srcLabel = SPEC_SOURCE_LABEL[row.spec_source]
      ? ` (${SPEC_SOURCE_LABEL[row.spec_source]})`
      : ''
    parts.push(`Customer minimum-at-receipt: ${row.shelf_life_days} days${srcLabel}`)
    if (row.shortfall_days != null) {
      const s = row.shortfall_days
      parts.push(`Vs. spec: ${s > 0 ? `${s} days projected ship (under spec)` : s < 0 ? `${-s} days of buffer` : 'exactly at spec'}`)
    }
  }
  if (row.disposition) parts.push(`Disposition: ${row.disposition}`)
  if (row.owner)       parts.push(`Owner: ${row.owner}`)
  const prim = row.primary
  if (prim) {
    const acct = prim.canonical?.canonical_name || prim.ship_to_raw_name || '(unmapped)'
    const shipIso = prim.projected_ship_iso ? prim.projected_ship_iso.slice(0, 10) : '(unscheduled)'
    const src = prim.source === 'scheduled'
      ? `scheduled \u2014 ${prim.order_lookup}`
      : prim.source === 'projected'
        ? `projected @ ${(prim.velocity_per_day || 0).toFixed(1)} cs/day`
        : prim.source === 'baseline'
          ? 'material history baseline'
          : 'no velocity \u2014 unassigned'
    parts.push(`Projected ship: ${acct} on ${shipIso} (${src})`)
  } else {
    parts.push(`Projected ship: (unallocated)`)
  }
  parts.push(`Stage: ${row.verdict?.label || '?'}`)
  return parts.join('\n')
}

export function bulkCopyForEmail(rows) {
  return rows.map(formatLotForEmail).join('\n---\n')
}
