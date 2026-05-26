// omniInventory.js
// QUERY STRATEGY — two fast queries (primary load) + one background query (empty locations):
//
//   Query 1 (LP → Location → Warehouse, 3 joins):
//     lp_code, location_container_name
//     Returns occupied locations only — fast, renders the page immediately
//
//   Query 2 (LP → LPContents → Lots → VendorLots → Materials, 4 joins):
//     lp_code, packaged_amount, material_code, vendor_lot, sys_lot
//     Material/qty detail per LP — paginated in parallel batches
//
//   Query 3 (LocationContainers → Warehouse, 2 joins) — BACKGROUND:
//     location_container_name for ALL facility locations including empty ones
//     Called separately after primary load; merged in without blocking the UI
//
// PAGINATION STRATEGY:
//   - PAGE_SIZE = 1000 keeps each individual Omni call well under the 26s timeout
//   - PROBE: fire page 0 first, check total, then fetch remaining pages in parallel
//   - This means a 16,800-row facility (Madison) does 1 probe + 16 parallel pages
//     instead of 17 sequential pages

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'

const LP     = 'silver__datex_slv_licenseplates'
const LP_CNT = 'silver__datex_slv_licenseplatecontents'
const LOC    = 'silver__datex_slv_locationcontainers'
const WH     = 'silver__datex_slv_warehouses'
const LOT    = 'silver__datex_slv_lots'
const VLOT   = 'silver__datex_slv_vendorlots'
const MAT    = 'silver__datex_slv_materials'

const PAGE_SIZE    = 1000   // Safe per-call size — well under Netlify timeout
const MAX_PAGES    = 30     // Hard ceiling: 30,000 rows max per query
const BATCH_SIZE   = 5      // Parallel pages per batch — tuned to avoid overwhelming Omni

export const FACILITY_WH_NAME = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------
async function omniQuery(query) {
  let res
  try {
    res = await fetch('/.netlify/functions/omni-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { version: 5, ...query } }),
    })
  } catch (e) {
    throw new Error(`Network error reaching omni-query: ${e.message}`)
  }
  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new Error(body.error || `omni-query ${res.status}`)
  }
  const { rows } = await res.json()
  return rows
}

// ---------------------------------------------------------------------------
// Parallel-paginated fetch
//   1. Fire page 0 (probe)
//   2. If probe returned a full page, fire remaining pages in parallel batches
//   3. Merge all results in offset order
// ---------------------------------------------------------------------------
async function fetchAllPages(baseQuery) {
  // Probe — page 0
  const probeRows = await omniQuery({ ...baseQuery, limit: PAGE_SIZE, offset: 0 })
  const allRows = [...probeRows]

  if (probeRows.length < PAGE_SIZE) return allRows  // All data fit in one page

  // Fire remaining pages in parallel batches
  let offset = PAGE_SIZE
  for (let batch = 0; batch < MAX_PAGES; batch += BATCH_SIZE) {
    const offsets = []
    for (let i = 0; i < BATCH_SIZE; i++) {
      offsets.push(offset + i * PAGE_SIZE)
    }

    const batchResults = await Promise.all(
      offsets.map(off => omniQuery({ ...baseQuery, limit: PAGE_SIZE, offset: off }))
    )

    let done = false
    for (const rows of batchResults) {
      allRows.push(...rows)
      if (rows.length < PAGE_SIZE) { done = true; break }
    }

    if (done) break
    offset += BATCH_SIZE * PAGE_SIZE

    // Safety: stop if we've exceeded max rows
    if (allRows.length >= MAX_PAGES * PAGE_SIZE) break
  }

  return allRows
}

// ---------------------------------------------------------------------------
// Query 1: LP → Location → Warehouse (3 joins, lean)
// ---------------------------------------------------------------------------
async function fetchLpLocations(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LP,
    fields: [`${LP}.lookup_code`, `${LOC}.location_container_name`],
    filters: {
      [`${LP}.archived`]: { type: 'boolean', is_negative: true, treat_nulls_as_false: false },
      [`${WH}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [whName] },
    },
    sorts: [
      { column_name: `${LOC}.location_container_name`, sort_descending: false },
      { column_name: `${LP}.lookup_code`, sort_descending: false },
    ],
  })
}

// ---------------------------------------------------------------------------
// Query 2: LP → LPContents → Lots → VendorLots → Materials (4 joins)
// ---------------------------------------------------------------------------
async function fetchLpDetail(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LP,
    fields: [
      `${LP}.lookup_code`,
      `${LP_CNT}.packaged_amount`,
      `${MAT}.lookup_code`,
      `${VLOT}.lookup_code`,
      `${LOT}.lookup_code`,
    ],
    filters: {
      [`${LP}.archived`]: { type: 'boolean', is_negative: true, treat_nulls_as_false: false },
      [`${WH}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [whName] },
    },
    sorts: [{ column_name: `${LP}.lookup_code`, sort_descending: false }],
  })
}

// ---------------------------------------------------------------------------
// Query 3: LocationContainers → Warehouse (2 joins) — background only
// ---------------------------------------------------------------------------
export async function fetchAllLocationNames(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LOC,
    fields: [`${LOC}.location_container_name`],
    filters: {
      [`${WH}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [whName] },
    },
    sorts: [{ column_name: `${LOC}.location_container_name`, sort_descending: false }],
  })
}

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------
function deriveZone(locationName) {
  if (!locationName) return 'Other'
  return `Aisle ${locationName.slice(0, 2).toUpperCase()}`
}

function buildDetailMap(lpDetailRows) {
  const detailMap = new Map()
  for (const row of lpDetailRows) {
    const lp  = row[`${LP}.lookup_code`] || ''
    const qty = Number(row[`${LP_CNT}.packaged_amount`]) || 0
    if (!lp) continue
    if (detailMap.has(lp)) {
      detailMap.get(lp).qty += qty
    } else {
      detailMap.set(lp, {
        qty,
        materialCode: row[`${MAT}.lookup_code`]  || '',
        vendorLot:    row[`${VLOT}.lookup_code`] || '',
        sysLot:       row[`${LOT}.lookup_code`]  || '',
      })
    }
  }
  return detailMap
}

function buildLocationMap(lpLocationRows, detailMap) {
  const locationMap = new Map()
  for (const row of lpLocationRows) {
    const lp      = row[`${LP}.lookup_code`]              || ''
    const locName = row[`${LOC}.location_container_name`] || ''
    if (!lp || !locName) continue

    if (!locationMap.has(locName)) {
      locationMap.set(locName, {
        id: locName, zone: deriveZone(locName),
        palletCount: 0, onHand: 0, pallets: [],
      })
    }

    const loc    = locationMap.get(locName)
    const detail = detailMap.get(lp) ?? { qty: 0, materialCode: '', vendorLot: '', sysLot: '' }

    if (!loc.pallets.find(p => p.lp === lp)) {
      loc.pallets.push({ lp, ...detail })
      loc.palletCount += 1
      loc.onHand      += detail.qty
    }
  }
  return locationMap
}

// ---------------------------------------------------------------------------
// PRIMARY export — Queries 1 + 2 in parallel (both use parallel pagination)
// ---------------------------------------------------------------------------
export async function fetchInventoryLocations(facilityId) {
  const whName = FACILITY_WH_NAME[facilityId]
  if (!whName) throw new Error(`Unknown facilityId: ${facilityId}`)

  const [lpLocationRows, lpDetailRows] = await Promise.all([
    fetchLpLocations(whName),
    fetchLpDetail(whName),
  ])

  const detailMap   = buildDetailMap(lpDetailRows)
  const locationMap = buildLocationMap(lpLocationRows, detailMap)

  return [...locationMap.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// BACKGROUND export — Query 3, merges empty locations silently after primary load
// Fails silently — returns occupiedData unchanged if Query 3 times out
// ---------------------------------------------------------------------------
export async function mergeEmptyLocations(facilityId, occupiedData) {
  const whName = FACILITY_WH_NAME[facilityId]
  if (!whName) return occupiedData

  let allLocationRows
  try {
    allLocationRows = await fetchAllLocationNames(whName)
  } catch {
    return occupiedData
  }

  const occupiedIds = new Set(occupiedData.map(l => l.id))
  const emptyRows = []

  for (const row of allLocationRows) {
    const locName = row[`${LOC}.location_container_name`] || ''
    if (!locName || occupiedIds.has(locName)) continue
    emptyRows.push({
      id: locName, zone: deriveZone(locName),
      palletCount: 0, onHand: 0, pallets: [],
    })
  }

  if (emptyRows.length === 0) return occupiedData

  return [...occupiedData, ...emptyRows].sort((a, b) => a.id.localeCompare(b.id))
}
