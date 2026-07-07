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
//   verdictForLot({ daysToCodeToday, daysToCodeAtShip, shelfLifeDays })
//   formatLotForEmail(row)
//   bulkCopyForEmail(rows)
//   DISPOSITION_OPTIONS, DISPOSITION_META  (per-lot Tag catalog, 2026-07-07)

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
    const verdict = verdictForLot({ daysToCodeToday, daysToCodeAtShip, shelfLifeDays })

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

export function verdictForLot({ daysToCodeToday, daysToCodeAtShip, shelfLifeDays }) {
  if (daysToCodeToday != null && daysToCodeToday < 0) {
    return { stage: 'expired', ...STAGE_META.expired }
  }
  if (daysToCodeAtShip == null) {
    return { stage: 'watch', ...STAGE_META.watch, missingData: true }
  }
  if (daysToCodeAtShip <= 0) {
    return { stage: 'unshippable', ...STAGE_META.unshippable }
  }
  if (!shelfLifeDays || shelfLifeDays <= 0) {
    if (daysToCodeToday != null && daysToCodeToday < 30) {
      return { stage: 'critical', ...STAGE_META.critical, noShelfLifeCfg: true }
    }
    return { stage: 'watch', ...STAGE_META.watch, noShelfLifeCfg: true }
  }
  const ratio = daysToCodeAtShip / shelfLifeDays
  if (ratio < 0.5) return { stage: 'critical', ...STAGE_META.critical, ratio }
  if (ratio < 1.0) return { stage: 'at_risk',  ...STAGE_META.at_risk,  ratio }
  return { stage: 'watch', ...STAGE_META.watch, ratio }
}

const SPEC_SOURCE_LABEL = {
  material_spec:    'from material spec',
  allocation:       'from allocation',
  material_history: 'from 365-day history',
  default_96:       'default (no history)',
}

export function formatLotForEmail(row) {
  const parts = []
  parts.push(`Item: ${row.material_code} \u2014 ${row.material_desc}`)
  parts.push(`Lot: ${row.lot_code || '(no lot code)'}`)
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
      parts.push(`Vs. spec: ${s > 0 ? `${s} days SHORT` : s < 0 ? `${-s} days of buffer` : 'exactly at spec'}`)
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
