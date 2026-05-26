// omniInventory.js
// Fetches location-level inventory from Omni using the silver datex views.
//
// QUERY STRATEGY — three parallel lean queries merged client-side:
//
//   Query 1 (LP → Location → Warehouse):
//     Fields: lp_code, location_container_name
//     Purpose: which LP is in which location (occupied locations only)
//
//   Query 2 (LP → LPContents → Lots → VendorLots → Materials):
//     Fields: lp_code, packaged_amount, material_code, vendor_lot, sys_lot
//     Purpose: qty and material detail per LP
//
//   Query 3 (LocationContainers → Warehouse):
//     Fields: location_container_name
//     Purpose: ALL locations that exist for this facility, including empty ones
//     This is the fix for the "empty location" gap — Queries 1+2 only return
//     locations that have an active LP. Query 3 gives us the full location
//     master so we can surface empty locations (no LP assigned).
//
//   Merge on location_name + lp_code client-side.
//   Locations from Query 3 with no LPs in Query 1 → Empty rows.

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'

const LP     = 'silver__datex_slv_licenseplates'
const LP_CNT = 'silver__datex_slv_licenseplatecontents'
const LOC    = 'silver__datex_slv_locationcontainers'
const WH     = 'silver__datex_slv_warehouses'
const LOT    = 'silver__datex_slv_lots'
const VLOT   = 'silver__datex_slv_vendorlots'
const MAT    = 'silver__datex_slv_materials'

const PAGE_SIZE = 2000

const FACILITY_WH_NAME = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

// ---------------------------------------------------------------------------
// Internal: single omni-query proxy call
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
// Internal: paginate any query until exhausted
// ---------------------------------------------------------------------------
async function fetchAllPages(baseQuery) {
  const allRows = []
  let offset = 0
  const MAX_PAGES = 20

  for (let page = 0; page < MAX_PAGES; page++) {
    const pageRows = await omniQuery({ ...baseQuery, offset })
    allRows.push(...pageRows)
    if (pageRows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return allRows
}

// ---------------------------------------------------------------------------
// Query 1: LP → Location → Warehouse (3 joins, fast)
// Returns: lp_code, location_name
// Only returns locations that have at least one active LP.
// ---------------------------------------------------------------------------
async function fetchLpLocations(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LP,
    fields: [
      `${LP}.lookup_code`,
      `${LOC}.location_container_name`,
    ],
    filters: {
      [`${LP}.archived`]: {
        type: 'boolean',
        is_negative: true,
        treat_nulls_as_false: false,
      },
      [`${WH}.warehouse_name`]: {
        kind: 'EQUALS',
        type: 'string',
        values: [whName],
        is_negative: false,
      },
    },
    sorts: [
      { column_name: `${LOC}.location_container_name`, sort_descending: false },
      { column_name: `${LP}.lookup_code`,              sort_descending: false },
    ],
    limit: PAGE_SIZE,
  })
}

// ---------------------------------------------------------------------------
// Query 2: LP → LPContents → Lots → VendorLots → Materials (4 joins)
// Returns: lp_code, packaged_amount, material_code, vendor_lot, sys_lot
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
      [`${LP}.archived`]: {
        type: 'boolean',
        is_negative: true,
        treat_nulls_as_false: false,
      },
      [`${WH}.warehouse_name`]: {
        kind: 'EQUALS',
        type: 'string',
        values: [whName],
        is_negative: false,
      },
    },
    sorts: [
      { column_name: `${LP}.lookup_code`, sort_descending: false },
    ],
    limit: PAGE_SIZE,
  })
}

// ---------------------------------------------------------------------------
// Query 3: LocationContainers → Warehouse (2 joins, very fast)
// Returns: location_container_name for ALL locations in the facility,
// including empty ones with no LP assigned.
// This is the fix for the missing-empty-location gap.
// ---------------------------------------------------------------------------
async function fetchAllLocationNames(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LOC,
    fields: [
      `${LOC}.location_container_name`,
    ],
    filters: {
      [`${WH}.warehouse_name`]: {
        kind: 'EQUALS',
        type: 'string',
        values: [whName],
        is_negative: false,
      },
    },
    sorts: [
      { column_name: `${LOC}.location_container_name`, sort_descending: false },
    ],
    limit: PAGE_SIZE,
  })
}

// ---------------------------------------------------------------------------
// Derive zone label — reserved for future sprint
// ---------------------------------------------------------------------------
function deriveZone(locationName) {
  if (!locationName) return 'Other'
  return `Aisle ${locationName.slice(0, 2).toUpperCase()}`
}

// ---------------------------------------------------------------------------
// Transform: merge all three query results into structured location objects
//
// Steps:
//   1. Build detail lookup from Query 2: lp → { qty, materialCode, vendorLot, sysLot }
//   2. Build occupied location map from Query 1: location → pallets[]
//   3. Seed location map with ALL location names from Query 3
//      — locations from Query 3 not in Query 1 get palletCount=0 (Empty)
//   4. Sort by location ID
// ---------------------------------------------------------------------------
export function transformInventoryRows(lpLocationRows, lpDetailRows, allLocationRows) {
  // Step 1 — detail map: lp_code → { qty, materialCode, vendorLot, sysLot }
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

  // Step 2 — build location map from LP→Location rows (occupied only)
  const locationMap = new Map()
  for (const row of lpLocationRows) {
    const lp      = row[`${LP}.lookup_code`]              || ''
    const locName = row[`${LOC}.location_container_name`] || ''
    if (!lp || !locName) continue

    if (!locationMap.has(locName)) {
      locationMap.set(locName, {
        id:          locName,
        zone:        deriveZone(locName),
        palletCount: 0,
        onHand:      0,
        pallets:     [],
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

  // Step 3 — seed with ALL locations from Query 3
  // Any location not already in the map (no LP) becomes an Empty row.
  for (const row of allLocationRows) {
    const locName = row[`${LOC}.location_container_name`] || ''
    if (!locName) continue
    if (!locationMap.has(locName)) {
      locationMap.set(locName, {
        id:          locName,
        zone:        deriveZone(locName),
        palletCount: 0,
        onHand:      0,
        pallets:     [],
      })
    }
  }

  // Step 4 — sort by location ID
  return [...locationMap.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// Main entry point — fetch all three queries in parallel, then transform
// ---------------------------------------------------------------------------
export async function fetchInventoryLocations(facilityId) {
  const whName = FACILITY_WH_NAME[facilityId]
  if (!whName) throw new Error(`Unknown facilityId: ${facilityId}`)

  // All three queries are independent — run in parallel
  const [lpLocationRows, lpDetailRows, allLocationRows] = await Promise.all([
    fetchLpLocations(whName),
    fetchLpDetail(whName),
    fetchAllLocationNames(whName),
  ])

  return transformInventoryRows(lpLocationRows, lpDetailRows, allLocationRows)
}
