// omniInventory.js
// QUERY STRATEGY — two fast queries (primary load) + one background query (empty locations):
//
//   Query 1 (LP → Location → Warehouse → LPContents, 4 joins):
//     lp_code, location_container_name, packaged_amount (SUM per LP+location)
//     Returns occupied locations with correct on-hand qty.
//     packaged_amount lives here because Omni groups by LP + location — the SUM
//     is correct (1 LP per location = sum equals the actual qty).
//     Previously in Query 2, the 4-join fan-out multiplied qty incorrectly
//     (405 returned instead of 81 for P029A at WR).
//
//   Query 2 (LP → LPContents → Lots → VendorLots → Materials, 4 joins):
//     lp_code, material_code, vendor_lot, sys_lot — dimensions only, no qty.
//     Material/lot lookup merged client-side onto Query 1 rows by LP code.
//
//   Query 3 (LocationContainers → Warehouse, 2 joins) — BACKGROUND:
//     location_container_name for ALL facility locations including empty ones.
//     Called separately after primary load; merged in without blocking the UI.
//
// PAGINATION STRATEGY:
//   - PAGE_SIZE = 1000 keeps each individual Omni call well under the 26s timeout
//   - PROBE: fire page 0 first, then fetch remaining pages in parallel batches
//   - BATCH_SIZE = 5 parallel pages per batch

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'

const LP     = 'silver__datex_slv_licenseplates'
const LP_CNT = 'silver__datex_slv_licenseplatecontents'
const LOC    = 'silver__datex_slv_locationcontainers'
const WH     = 'silver__datex_slv_warehouses'
const LOT    = 'silver__datex_slv_lots'
const VLOT   = 'silver__datex_slv_vendorlots'
const MAT    = 'silver__datex_slv_materials'

const PAGE_SIZE  = 1000
const MAX_PAGES  = 30
const BATCH_SIZE = 5

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
// ---------------------------------------------------------------------------
async function fetchAllPages(baseQuery) {
  const probeRows = await omniQuery({ ...baseQuery, limit: PAGE_SIZE, offset: 0 })
  const allRows = [...probeRows]
  if (probeRows.length < PAGE_SIZE) return allRows

  let offset = PAGE_SIZE
  for (let batch = 0; batch < MAX_PAGES; batch += BATCH_SIZE) {
    const offsets = []
    for (let i = 0; i < BATCH_SIZE; i++) offsets.push(offset + i * PAGE_SIZE)

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
    if (allRows.length >= MAX_PAGES * PAGE_SIZE) break
  }
  return allRows
}

// ---------------------------------------------------------------------------
// Query 1: LP → Location → Warehouse → LPContents (4 joins)
// Fields: lp_code, location_name, packaged_amount
// packaged_amount is moved here so Omni groups by (LP, location) — the SUM
// is correct because each LP occupies exactly one location.
// Root cause of the qty mismatch: when packaged_amount was in Query 2 alongside
// material/lot joins, Omni's fan-out multiplied the value (405 vs actual 81).
// ---------------------------------------------------------------------------
async function fetchLpLocationsQty(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LP,
    fields: [
      `${LP}.lookup_code`,
      `${LOC}.location_container_name`,
      `${LP_CNT}.packaged_amount`,
    ],
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
// Fields: lp_code, material_code, vendor_lot, sys_lot — dimensions only.
// No packaged_amount here — see above for why.
// ---------------------------------------------------------------------------
async function fetchLpDetail(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LP,
    fields: [
      `${LP}.lookup_code`,
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

// Build detail map from Query 2: lp → { materialCode, vendorLot, sysLot }
// No qty here — qty comes from Query 1.
function buildDetailMap(lpDetailRows) {
  const detailMap = new Map()
  for (const row of lpDetailRows) {
    const lp = row[`${LP}.lookup_code`] || ''
    if (!lp || detailMap.has(lp)) continue   // first row wins per LP
    detailMap.set(lp, {
      materialCode: row[`${MAT}.lookup_code`]  || '',
      vendorLot:    row[`${VLOT}.lookup_code`] || '',
      sysLot:       row[`${LOT}.lookup_code`]  || '',
    })
  }
  return detailMap
}

// Build location map from Query 1 rows (lp + location + qty) + detail map
function buildLocationMap(lpLocationRows, detailMap) {
  const locationMap = new Map()
  for (const row of lpLocationRows) {
    const lp      = row[`${LP}.lookup_code`]              || ''
    const locName = row[`${LOC}.location_container_name`] || ''
    const qty     = Number(row[`${LP_CNT}.packaged_amount`]) || 0
    if (!lp || !locName) continue

    if (!locationMap.has(locName)) {
      locationMap.set(locName, {
        id: locName, zone: deriveZone(locName),
        palletCount: 0, onHand: 0, pallets: [],
      })
    }

    const loc    = locationMap.get(locName)
    const detail = detailMap.get(lp) ?? { materialCode: '', vendorLot: '', sysLot: '' }

    if (!loc.pallets.find(p => p.lp === lp)) {
      loc.pallets.push({ lp, qty, ...detail })
      loc.palletCount += 1
      loc.onHand      += qty
    }
  }
  return locationMap
}

// ---------------------------------------------------------------------------
// PRIMARY export
// ---------------------------------------------------------------------------
export async function fetchInventoryLocations(facilityId) {
  const whName = FACILITY_WH_NAME[facilityId]
  if (!whName) throw new Error(`Unknown facilityId: ${facilityId}`)

  const [lpLocationRows, lpDetailRows] = await Promise.all([
    fetchLpLocationsQty(whName),
    fetchLpDetail(whName),
  ])

  const detailMap   = buildDetailMap(lpDetailRows)
  const locationMap = buildLocationMap(lpLocationRows, detailMap)

  return [...locationMap.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// BACKGROUND export — merges empty locations silently after primary load
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
    emptyRows.push({ id: locName, zone: deriveZone(locName), palletCount: 0, onHand: 0, pallets: [] })
  }

  if (emptyRows.length === 0) return occupiedData
  return [...occupiedData, ...emptyRows].sort((a, b) => a.id.localeCompare(b.id))
}
