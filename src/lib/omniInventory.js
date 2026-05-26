// omniInventory.js
// QUERY STRATEGY — two fast queries (primary load) + one background query (empty locations):
//
//   Query 1 (LP → Location → Warehouse, 3 joins):
//     lp_code, location_container_name
//     Returns occupied locations only — fast, renders the page immediately
//
//   Query 2 (LP → LPContents → Lots → VendorLots → Materials, 4 joins):
//     lp_code, packaged_amount, material_code, vendor_lot, sys_lot
//     Material/qty detail per LP
//
//   Query 3 (LocationContainers → Warehouse, 2 joins) — BACKGROUND:
//     location_container_name for ALL facility locations including empty ones
//     Called separately after primary load; merged in without blocking the UI

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'

const LP     = 'silver__datex_slv_licenseplates'
const LP_CNT = 'silver__datex_slv_licenseplatecontents'
const LOC    = 'silver__datex_slv_locationcontainers'
const WH     = 'silver__datex_slv_warehouses'
const LOT    = 'silver__datex_slv_lots'
const VLOT   = 'silver__datex_slv_vendorlots'
const MAT    = 'silver__datex_slv_materials'

const PAGE_SIZE = 2000

export const FACILITY_WH_NAME = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

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

async function fetchAllPages(baseQuery) {
  const allRows = []
  let offset = 0
  for (let page = 0; page < 20; page++) {
    const pageRows = await omniQuery({ ...baseQuery, offset })
    allRows.push(...pageRows)
    if (pageRows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return allRows
}

// Query 1: LP → Location → Warehouse (3 joins)
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
    limit: PAGE_SIZE,
  })
}

// Query 2: LP → LPContents → Lots → VendorLots → Materials (4 joins)
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
    limit: PAGE_SIZE,
  })
}

// Query 3: LocationContainers → Warehouse (2 joins) — background only
// Returns all location names for the facility including empty ones.
export async function fetchAllLocationNames(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LOC,
    fields: [`${LOC}.location_container_name`],
    filters: {
      [`${WH}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [whName] },
    },
    sorts: [{ column_name: `${LOC}.location_container_name`, sort_descending: false }],
    limit: PAGE_SIZE,
  })
}

function deriveZone(locationName) {
  if (!locationName) return 'Other'
  return `Aisle ${locationName.slice(0, 2).toUpperCase()}`
}

// Build detail map from Query 2 rows
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

// Build occupied location map from Query 1 rows + detail map
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
// PRIMARY export — Queries 1 + 2 in parallel, returns occupied locations fast
// ---------------------------------------------------------------------------
export async function fetchInventoryLocations(facilityId) {
  const whName = FACILITY_WH_NAME[facilityId]
  if (!whName) throw new Error(`Unknown facilityId: ${facilityId}`)

  const [lpLocationRows, lpDetailRows] = await Promise.all([
    fetchLpLocations(whName),
    fetchLpDetail(whName),
  ])

  const detailMap   = buildDetailMap(lpLocationRows.length ? lpDetailRows : [])
  const locationMap = buildLocationMap(lpLocationRows, detailMap)

  return [...locationMap.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// BACKGROUND export — Query 3 alone, merges empty locations into existing data
// Call this after fetchInventoryLocations has rendered. Pass the occupied
// data array and it returns a new merged array with empty rows added.
// If Query 3 times out, returns the original occupiedData unchanged.
// ---------------------------------------------------------------------------
export async function mergeEmptyLocations(facilityId, occupiedData) {
  const whName = FACILITY_WH_NAME[facilityId]
  if (!whName) return occupiedData

  let allLocationRows
  try {
    allLocationRows = await fetchAllLocationNames(whName)
  } catch {
    // Background query failed — silently return occupied data as-is.
    // User gets occupied locations without empty ones rather than an error.
    return occupiedData
  }

  // Build set of already-known location IDs
  const occupiedIds = new Set(occupiedData.map(l => l.id))

  // Add only locations not already in the occupied set
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
