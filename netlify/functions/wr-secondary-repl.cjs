'use strict'

// WR "Secondary Replenishments" tab backend (added 2026-07-15) — recreated
// from the standalone csw-secondary-replenishment repo/Netlify site
// (csw-secondary-replenishment.netlify.app), folded into CSW-WI as a WR
// sub-tab next to Pick Location Lot Check. Bernatello's - Wisconsin Rapids
// only (same warehouse scope as WrPickCheck/WrCasesToPick).
//
// Live data need: for each F-aisle (odd bay #) / G-aisle (even bay #)
// pallet-rack bay, how many secondary-storage LPs are sitting in the B/C/D
// tiers above the primary P-slot pick face, whether they match what's
// actually being picked from that face, and — if a tier is short — which
// warehouse locations (aisles A-E, F, G) have that material available to
// pull down, furthest-aisle-first.
//
// Per the documented standing rule ("Always proxy through
// ${process.env.URL}/.netlify/functions/omni-query for new server-side
// code"), every live Omni read here goes through the existing omni-query
// proxy rather than calling Omni directly — inherits its Arrow parsing,
// retry logic, and timeout injection. All 6 internal queries fire in
// parallel via Promise.allSettled so one slow/failed query doesn't blank
// the whole tab; per-query errors are surfaced in `errors` and the client
// renders with whatever succeeded.
//
// P-slot -> primary-pick-material assignment (secondary-repl-picks.json)
// is static, sourced from Omni via MCP on 2026-03-20 in the original repo
// — no live query for this piece (see that file's header comment for how
// to refresh it).

const picks = require('./secondary-repl-picks.json')

const MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add' // gold/appointments model, same as WrPickCheck/WrCasesToPick
const WAREHOUSE_FILTER = {
  type: 'string', kind: 'CONTAINS', values: ['Wisconsin Rapids'], case_insensitive: true,
}
const NOT_ARCHIVED = { type: 'boolean', is_negative: true, treat_nulls_as_false: false }
const NOT_LP3 = { type: 'string', kind: 'STARTS_WITH', values: ['3'], is_negative: true }

function aisleOrFilter(aisles) {
  return { type: 'composite', conjunction: 'OR', filters: aisles.map(a => ({ type: 'string', kind: 'STARTS_WITH', values: [a] })) }
}

async function internalOmniQuery(query, timeoutMs = 20000) {
  const base = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/.netlify/functions/omni-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    })
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { throw new Error(`omni-query returned non-JSON (${res.status}): ${text.slice(0, 200)}`) }
    if (!res.ok) throw new Error(data.error || `omni-query failed (${res.status})`)
    return data.rows || []
  } finally {
    clearTimeout(timer)
  }
}

// F+G aisle LP count per location (used both to display LP counts on the
// pull-suggestion chips and as the P-slot capacity fallback).
function fgLpQuery() {
  return {
    modelId: MODEL_ID,
    table: 'silver__datex_slv_licenseplates',
    fields: [
      'silver__datex_slv_locationcontainers.location_container_name',
      'silver__datex_slv_licenseplates.count',
    ],
    filters: {
      'silver__datex_slv_locationcontainers.location_container_name': { type: 'string', kind: 'STARTS_WITH', values: ['F', 'G'] },
      'silver__datex_slv_warehouses.warehouse_name': WAREHOUSE_FILTER,
      'silver__datex_slv_licenseplates.archived': NOT_ARCHIVED,
      'silver__datex_slv_licenseplates.lookup_code': NOT_LP3,
    },
    limit: 10000,
  }
}

// P-slot pick locations -> vendor lot numbers currently in each location.
function pslotLotsQuery() {
  return {
    modelId: MODEL_ID,
    table: 'silver__datex_slv_licenseplates',
    fields: [
      'silver__datex_slv_locationcontainers.location_container_name',
      'silver__datex_slv_lots.lookup_code',
    ],
    filters: {
      'silver__datex_slv_locationcontainers.location_container_name': { type: 'string', kind: 'STARTS_WITH', values: ['P'] },
      'silver__datex_slv_warehouses.warehouse_name': WAREHOUSE_FILTER,
    },
    limit: 2000,
  }
}

// G aisle secondary inventory: location + material + total qty.
function ginvQuery() {
  return {
    modelId: MODEL_ID,
    table: 'silver__datex_slv_licenseplates',
    fields: [
      'silver__datex_slv_locationcontainers.location_container_name',
      'silver__datex_slv_materials.lookup_code',
      'silver__datex_slv_licenseplatecontents.packaged_amount_sum',
    ],
    filters: {
      'silver__datex_slv_locationcontainers.location_container_name': { type: 'string', kind: 'STARTS_WITH', values: ['G'] },
      'silver__datex_slv_warehouses.warehouse_name': WAREHOUSE_FILTER,
      'silver__datex_slv_licenseplates.archived': NOT_ARCHIVED,
      'silver__datex_slv_licenseplates.lookup_code': NOT_LP3,
    },
    limit: 5000,
  }
}

// F aisle secondary inventory: location + direct material + lot material_id + qty.
function finvQuery() {
  return {
    modelId: MODEL_ID,
    table: 'silver__datex_slv_licenseplates',
    fields: [
      'silver__datex_slv_locationcontainers.location_container_name',
      'silver__datex_slv_materials.lookup_code',
      'silver__datex_slv_lots.material_id',
      'silver__datex_slv_licenseplatecontents.packaged_amount_sum',
    ],
    filters: {
      'silver__datex_slv_locationcontainers.location_container_name': { type: 'string', kind: 'STARTS_WITH', values: ['F'] },
      'silver__datex_slv_warehouses.warehouse_name': WAREHOUSE_FILTER,
      'silver__datex_slv_licenseplates.archived': NOT_ARCHIVED,
      'silver__datex_slv_licenseplates.lookup_code': NOT_LP3,
    },
    limit: 5000,
  }
}

function materialLookupQuery(materialIds) {
  return {
    modelId: MODEL_ID,
    table: 'silver__datex_slv_materials',
    fields: [
      'silver__datex_slv_materials.material_id',
      'silver__datex_slv_materials.lookup_code',
    ],
    filters: {
      'silver__datex_slv_materials.material_id': { type: 'number', kind: 'EQUALS', values: materialIds },
    },
    limit: materialIds.length + 10,
  }
}

// Pull-from inventory: location + material, split A-E / F-G to avoid row-limit truncation.
function pullQuery(aisles) {
  return {
    modelId: MODEL_ID,
    table: 'silver__datex_slv_licenseplates',
    fields: [
      'silver__datex_slv_locationcontainers.location_container_name',
      'silver__datex_slv_materials.lookup_code',
    ],
    filters: {
      'silver__datex_slv_locationcontainers.location_container_name': aisleOrFilter(aisles),
      'silver__datex_slv_warehouses.warehouse_name': WAREHOUSE_FILTER,
      'silver__datex_slv_licenseplates.archived': NOT_ARCHIVED,
      'silver__datex_slv_licenseplates.lookup_code': NOT_LP3,
    },
    limit: 5000,
  }
}

async function fetchFinv() {
  const rows = await internalOmniQuery(finvQuery())
  const unresolvedIds = [...new Set(
    rows
      .filter(r => r['silver__datex_slv_materials.lookup_code'] == null && r['silver__datex_slv_lots.material_id'] != null)
      .map(r => r['silver__datex_slv_lots.material_id'])
  )]
  const matIdToCode = {}
  if (unresolvedIds.length > 0) {
    const matRows = await internalOmniQuery(materialLookupQuery(unresolvedIds))
    matRows.forEach(r => {
      if (r['silver__datex_slv_materials.material_id'] != null) {
        matIdToCode[r['silver__datex_slv_materials.material_id']] = r['silver__datex_slv_materials.lookup_code']
      }
    })
  }
  return rows
    .map(r => {
      const loc = r['silver__datex_slv_locationcontainers.location_container_name']
      const mat = r['silver__datex_slv_materials.lookup_code'] ?? matIdToCode[r['silver__datex_slv_lots.material_id']] ?? null
      const qty = Number(r['silver__datex_slv_licenseplatecontents.packaged_amount_sum']) || 0
      return { loc, mat, qty }
    })
    .filter(r => r.loc != null && r.mat != null && r.mat !== '')
}

exports.handler = async () => {
  const startTime = Date.now()
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

  const results = await Promise.allSettled([
    internalOmniQuery(fgLpQuery()),
    internalOmniQuery(pslotLotsQuery()),
    internalOmniQuery(ginvQuery()),
    fetchFinv(),
    internalOmniQuery(pullQuery(['A', 'B', 'C', 'D', 'E'])),
    internalOmniQuery(pullQuery(['F', 'G'])),
  ])

  const [fgLpR, pslotLotsR, gInvR, fInvR, pullABCDER, pullFGR] = results
  const errors = {}
  const labels = ['fgLp', 'pslotLots', 'gInv', 'fInv', 'pullAbcde', 'pullFg']
  results.forEach((r, i) => { if (r.status === 'rejected') errors[labels[i]] = r.reason?.message || String(r.reason) })
  const ok = r => (r.status === 'fulfilled' ? r.value : [])

  const lpMap = {}
  ok(fgLpR).forEach(r => {
    const loc = r['silver__datex_slv_locationcontainers.location_container_name']
    if (loc != null) lpMap[loc] = Number(r['silver__datex_slv_licenseplates.count']) || 0
  })

  const pslotLotsMap = {}
  {
    const byLoc = {}
    ok(pslotLotsR).forEach(r => {
      const loc = r['silver__datex_slv_locationcontainers.location_container_name']
      const lot = r['silver__datex_slv_lots.lookup_code']
      if (!loc || !lot) return
      if (!byLoc[loc]) byLoc[loc] = new Set()
      byLoc[loc].add(String(lot))
    })
    Object.entries(byLoc).forEach(([loc, set]) => { pslotLotsMap[loc] = [...set].sort() })
  }

  const gInv = ok(gInvR)
    .map(r => ({
      loc: r['silver__datex_slv_locationcontainers.location_container_name'],
      mat: r['silver__datex_slv_materials.lookup_code'],
      qty: Number(r['silver__datex_slv_licenseplatecontents.packaged_amount_sum']) || 0,
    }))
    .filter(r => r.loc != null && r.mat != null && r.mat !== '')

  const fInv = fInvR.status === 'fulfilled' ? fInvR.value : []

  const pslots = Object.entries(picks)
    .filter(([, mat]) => mat && mat !== '')
    .map(([loc, mat]) => ({ loc, mat, qty: 0 }))

  // Combine pull-from candidates (A-E + F-G), attach LP counts from the
  // F+G map (aisles A-E have no LP-count query in the original design and
  // default to 1, matching csw-secondary-replenishment's client logic).
  const rawPull = [...ok(pullABCDER), ...ok(pullFGR)]
  const allInv = rawPull.map(r => ({ ...r, lp: lpMap[r.loc] || 1 }))

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      lpMap,
      pslotLotsMap,
      gInv,
      fInv,
      pslots,
      allInv,
      errors: Object.keys(errors).length > 0 ? errors : null,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startTime,
    }),
  }
}
