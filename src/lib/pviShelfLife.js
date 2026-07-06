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
//
// ── Verdict semantics (revised 2026-07-02 per Hill feedback) ──────────────
//
// The customer's shelf-life-days requirement is a MINIMUM at receipt — i.e.
// "Costco needs 156 days remaining when the load lands." A lot arriving with
// less than that is below spec and subject to rejection or discount. The
// verdict engine now compares days-to-code-at-ship against that minimum:
//
//   ratio = daysToCodeAtShip / shelfLifeDays
//
//   Watch        ratio ≥ 1.0    (meets or exceeds customer minimum)
//   At Risk      0.5 ≤ ratio < 1.0    (below customer spec, likely negotiable)
//   Critical     ratio < 0.5    (well below spec, needs escalation)
//   Unshippable  daysToCodeAtShip ≤ 0 but not yet expired today
//   Expired      Past code date TODAY
//
// ── Spec source priority (revised 2026-07-06 per Hill feedback) ──────────
//
// Hill's reframe: a material's shelf-life requirement is a fixed property
// of the material, not something to infer per-load from allocation or
// history. The `pvi_material_specs` table is the ops-curated source of
// truth — one row per material, editable in Settings. History/allocation
// remain as fallbacks for materials that haven't been curated yet.
//
// Priority (highest wins):
//   'material_spec'    — pvi_material_specs row for this material.
//                        Ops-curated. Overrides everything else.
//   'allocation'       — the lot is bound to a specific order (Phase A) or
//                        velocity-projected to a specific customer (Phase B),
//                        and that customer has a configured shelf-life spec.
//   'material_history' — no allocation spec. Fall back to the strictest
//                        customer spec across the last 365 days of this
//                        material's shipments (mapped end-customers only).
//   'default_96'       — final fallback for materials with no material_spec,
//                        no allocation spec, AND no history — assume 96 days.
//                        Matches Hill's "default to 96 days if the material
//                        hasn't shipped yet." NOT applied when the primary
//                        allocation is an internal_transfer (internal moves
//                        between Palermo's facilities have no customer spec).
//   null               — only possible for internal_transfer allocations
//                        with no material_spec row. Vs. Spec column renders "—".
//
// The dominant-recipient-for-display / strictest-recipient-for-math split
// still applies to the material_history baseline. Every row's math should
// protect against the worst plausible spec violation while the display
// reflects the most likely destination.

export const STAGE_ORDER = ['expired', 'unshippable', 'critical', 'at_risk', 'watch']

export const STAGE_META = {
  watch:        { label: 'Watch',        color: '#5b9bd5', bg: '#eaf2fa' },
  at_risk:      { label: 'At Risk',      color: '#c88a2a', bg: '#fbf1de' },
  critical:     { label: 'Critical',     color: '#d1583a', bg: '#fbe4dd' },
  unshippable:  { label: 'Unshippable',  color: '#8b3a89', bg: '#f2e2f2' },
  expired:      { label: 'Expired',      color: '#5f2c2c', bg: '#e8d4d4' },
}

// Stages that make up the default "At Risk and worse" filter.
export const DEFAULT_STAGES = new Set(['at_risk', 'critical', 'unshippable', 'expired'])

// Runtime fallback shelf-life spec when a material has no curated spec,
// no allocation customer spec, and no shipment history. Per Hill: "default
// to 96 days if the material hasn't shipped yet." Applied to end-customer
// and unmapped allocations, NOT to internal_transfer.
export const DEFAULT_UNSHIPPED_SHELF_LIFE_DAYS = 96

// ── Canonical resolution ──────────────────────────────────────────────────

// Build a lookup index the client can use O(1) per raw ship-to name.
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

// ── Velocity confidence tiers ─────────────────────────────────────────────

export function velocityConfidence(shipments30d) {
  const s = Number(shipments30d) || 0
  if (s >= 12) return { tier: 'high', label: 'High', color: '#3a7a3a' }
  if (s >= 4)  return { tier: 'med',  label: 'Med',  color: '#c88a2a' }
  return       { tier: 'low',  label: 'Low',  color: '#d1583a' }
}

// Daily case rate = MIN across the three windows. Conservative — a customer
// who's slowed down over the last 30d shouldn't inflate our projection.
export function dailyCaseRate(vel) {
  if (!vel) return 0
  const r30 = (Number(vel.cases_30d) || 0) / 30
  const r60 = (Number(vel.cases_60d) || 0) / 60
  const r90 = (Number(vel.cases_90d) || 0) / 90
  const rates = [r30, r60, r90].filter(r => r > 0)
  if (rates.length === 0) return 0
  return Math.min(...rates)
}

// ── Material-level baselines from shipment history ───────────────────────
//
// Returns two maps keyed by material_id:
//   dominantByMaterial: canonical → whoever received the most cases in the
//                       history window (end-customers only; internal
//                       transfers skipped)
//   strictestByMaterial: { canonical, spec_days } → recipient whose shelf-
//                       life-days spec was tightest across the window's
//                       roster
//
// Internal transfers are excluded from both — they have no shelf-life spec
// and don't drive customer-facing risk.
//
// Note: field is named `cases_90d` for backward compat but the Netlify
// function currently queries a 365-day window.

function buildMaterialBaselines(materialShipHistory, canonicalIndex) {
  const casesByMaterialCanonical = new Map() // material_id → Map(canonical_id → cases)
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

// ── FEFO projection ───────────────────────────────────────────────────────
//
// Input:
//   lots                — from pvi-shelf-life.cjs
//   pendingOrders       — from pvi-shelf-life.cjs (scheduled next 21 days)
//   velocity            — from pvi-shelf-life.cjs
//   materialShipHistory — from pvi-shelf-life.cjs (per-material recipients)
//   materialSpecs       — from Supabase pvi_material_specs table
//                         (ops-curated per-material shelf-life spec)
//   canonicalIndex      — from buildRawNameToCanonical
//
// Output: one row per lot with a projected recipient, days_to_code_at_ship,
// shelf_life_days (from material_specs / allocation / history baseline /
// 96d default), and a spec_source flag so the UI can distinguish sources.
//
// Algorithm:
//   1. Build per-material dominant+strictest maps from history.
//   2. Build materialSpecMap for O(1) lookup.
//   3. Sort lots per material by expiration_date ASC (FEFO). Nulls last.
//   4. Sort pending orders by scheduled_arrival ASC.
//   5. Phase A: consume against scheduled demand. Each allocation slice
//      carries the destination canonical + real ship date.
//   6. Phase B: remaining lot balance projected forward via velocity to the
//      material's dominant end-customer (from history). Ship date estimated
//      at the midpoint of each lot's burn.
//   7. Roll up per lot. Spec resolution priority:
//      a. materialSpecMap → 'material_spec'
//      b. Allocation canonical's override_days → 'allocation'
//      c. Strictest-baseline spec_days → 'material_history'
//      d. DEFAULT_UNSHIPPED_SHELF_LIFE_DAYS → 'default_96'
//         (skipped when allocation is internal_transfer)
//   8. Compute days_to_code_today, days_to_code_at_ship, shortfall_days,
//      verdict via verdictForLot.

export function projectFefo({ lots, pendingOrders, velocity, materialShipHistory, materialSpecs, canonicalIndex, today }) {
  const now = today ? new Date(today) : new Date()
  const todayMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

  const { dominantByMaterial, strictestByMaterial } = buildMaterialBaselines(
    materialShipHistory || [],
    canonicalIndex,
  )

  // Fast lookup for the ops-curated per-material spec. Positive-integer only —
  // schema enforces > 0 but guard defensively in case of a bad row.
  const materialSpecMap = new Map()
  for (const s of (materialSpecs || [])) {
    const days = Number(s?.shelf_life_days_required)
    if (Number.isFinite(days) && days > 0 && s?.material_id != null) {
      materialSpecMap.set(s.material_id, days)
    }
  }

  // Group lots by material, sort by expiration_date ASC (nulls last).
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

  // Build velocity lookup: (material_id, project_lookup) → row.
  const velByKey = new Map()
  const velByMaterial = new Map() // any project — fallback
  for (const v of velocity) {
    velByKey.set(`${v.material_id}|${v.project_lookup}`, v)
    if (!velByMaterial.has(v.material_id)) velByMaterial.set(v.material_id, v)
  }
  const getVelocity = (materialId, projectLookup) => {
    return velByKey.get(`${materialId}|${projectLookup}`)
        || velByMaterial.get(materialId)
        || null
  }

  // Allocation records: one per (lot, recipient) sub-slice.
  const allocations = new Map() // lot_id → array of { cases, canonical, projected_ship_iso, source }

  // Sort pending orders by scheduled_arrival ASC.
  const sortedOrders = [...pendingOrders].sort((a, b) => {
    const ax = a.scheduled_arrival_iso ? Date.parse(a.scheduled_arrival_iso) : Infinity
    const bx = b.scheduled_arrival_iso ? Date.parse(b.scheduled_arrival_iso) : Infinity
    return ax - bx
  })

  // Phase A: consume against scheduled demand.
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
      // Any leftover `need` = short on inventory for this order. Not our
      // concern here; FEFO tab already surfaces stockouts.
    }
  }

  // Phase B: project remaining lot balance forward using velocity + the
  // material's dominant historical recipient.
  for (const [materialId, queue] of lotsByMaterial) {
    const remaining = queue.reduce((s, l) => s + l._remaining, 0)
    if (remaining <= 0) continue
    const projectLookup = queue.find(l => l.project_lookup)?.project_lookup || null
    const vel = getVelocity(materialId, projectLookup)
    const perDay = dailyCaseRate(vel)
    const projectedAccount = dominantByMaterial.get(materialId) || null
    // Cumulative days-to-consume as we walk the queue.
    let cumCases = 0
    for (const lot of queue) {
      if (lot._remaining <= 0) continue
      const midCases = cumCases + lot._remaining / 2  // "midpoint" of this lot's burn
      const daysOut = perDay > 0 ? midCases / perDay : null
      const projectedShipMs = daysOut != null
        ? todayMid + daysOut * 86400000
        : null
      const projectedShipIso = projectedShipMs != null
        ? new Date(projectedShipMs).toISOString()
        : null
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

  // Roll up per-lot rows. Each lot may have multiple allocations (e.g. sub-
  // slices to different accounts). We compute one PRIMARY verdict for the
  // table row (using the earliest ship + tightest shelf-life) and expose the
  // full allocation list for the detail drawer.
  const rows = []
  for (const lot of lots) {
    const allocs = allocations.get(lot.lot_id) || []
    // Sort allocations by projected ship ASC so [0] is the primary.
    allocs.sort((a, b) => {
      const ax = a.projected_ship_iso ? Date.parse(a.projected_ship_iso) : Infinity
      const bx = b.projected_ship_iso ? Date.parse(b.projected_ship_iso) : Infinity
      return ax - bx
    })
    const primary = allocs[0] || null
    const vel = velByKey.get(`${lot.material_id}|${lot.project_lookup}`)
              || velByMaterial.get(lot.material_id)
              || null

    // ── Spec resolution (see priority order documented at top of file) ──
    let shelfLifeDays = null
    let specSource   = null
    let displayCanonical = primary?.canonical || null

    // 1. Ops-curated material_specs row wins over everything.
    const matSpec = materialSpecMap.get(lot.material_id)
    if (matSpec != null) {
      shelfLifeDays = matSpec
      specSource   = 'material_spec'
    } else {
      // 2. Allocation canonical's shelf-life days.
      const allocDays = getShelfLifeDays(primary?.canonical)
      if (allocDays != null) {
        shelfLifeDays = allocDays
        specSource   = 'allocation'
      } else {
        // 3. Strictest-across-365d-history baseline.
        const strictest = strictestByMaterial.get(lot.material_id)
        if (strictest) {
          shelfLifeDays = strictest.spec_days
          specSource   = 'material_history'
        }
        // Prefer the dominant recipient for display when no allocation
        // canonical is present.
        if (!displayCanonical) {
          displayCanonical = dominantByMaterial.get(lot.material_id) || null
        }
        // 4. Final fallback: 96d default. Skipped for internal_transfer
        //    allocations (no shelf-life expectation for internal moves).
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
    // Days-to-code AT projected ship time = expiration - ship_date.
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
    // Shortfall = how many days below the customer's minimum-at-receipt spec.
    // Positive = below spec by that many days. Negative = compliant with N
    // days of buffer above spec. Null = no spec configured.
    const shortfallDays = (shelfLifeDays && daysToCodeAtShip != null)
      ? shelfLifeDays - daysToCodeAtShip
      : null
    const verdict = verdictForLot({
      daysToCodeToday,
      daysToCodeAtShip,
      shelfLifeDays,
    })

    // Compose a primary suitable for display. If the raw primary is missing
    // (no allocation at all), synthesize one from baseline so the UI has
    // something to render.
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

// ── Verdict engine ────────────────────────────────────────────────────────
//
// Ratio semantics: days-to-code-at-ship / customer's minimum-at-receipt spec.
//   ≥ 1.0  → meets spec (Watch)
//   0.5–1.0 → below spec, negotiable (At Risk)
//   < 0.5  → deep below spec, needs escalation (Critical)
// Absolute-date fallbacks (Expired, Unshippable) override the ratio math.
// No-spec fallback (unmapped account or internal transfer) uses days-to-code-
// today with a 30-day soft-critical trigger.

export function verdictForLot({ daysToCodeToday, daysToCodeAtShip, shelfLifeDays }) {
  // Expired trumps everything — past code today = write-off candidate.
  if (daysToCodeToday != null && daysToCodeToday < 0) {
    return { stage: 'expired', ...STAGE_META.expired }
  }
  // No expiration data — nothing to judge. Bucket as watch with a null flag.
  if (daysToCodeAtShip == null) {
    return { stage: 'watch', ...STAGE_META.watch, missingData: true }
  }
  // Unshippable = code date passes before we can ship it out.
  if (daysToCodeAtShip <= 0) {
    return { stage: 'unshippable', ...STAGE_META.unshippable }
  }
  // No shelf-life days configured — projected recipient is internal transfer
  // or unmapped account. Skip ratio math; fall back to a soft rule.
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

// ── Copy-for-email formatter ──────────────────────────────────────────────

// Human-readable label for each spec source. Used in the email format so
// ops can see at a glance whether a spec came from a curated row, an
// allocation, a history baseline, or the runtime default.
const SPEC_SOURCE_LABEL = {
  material_spec:    'from material spec',
  allocation:       'from allocation',
  material_history: 'from 365-day history',
  default_96:       'default (no history)',
}

export function formatLotForEmail(row) {
  const parts = []
  parts.push(`Item: ${row.material_code} — ${row.material_desc}`)
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
  const prim = row.primary
  if (prim) {
    const acct = prim.canonical?.canonical_name || prim.ship_to_raw_name || '(unmapped)'
    const shipIso = prim.projected_ship_iso ? prim.projected_ship_iso.slice(0, 10) : '(unscheduled)'
    const src = prim.source === 'scheduled'
      ? `scheduled — ${prim.order_lookup}`
      : prim.source === 'projected'
        ? `projected @ ${(prim.velocity_per_day || 0).toFixed(1)} cs/day`
        : prim.source === 'baseline'
          ? 'material history baseline'
          : 'no velocity — unassigned'
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
