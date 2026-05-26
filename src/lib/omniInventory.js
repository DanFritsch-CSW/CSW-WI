// omniInventory.js
// QUERY STRATEGY:
//
//   Single query per facility — all 6 fields grouped together:
//     lp_code, location_name, packaged_amount, material_code, vendor_lot, sys_lot
//
//   This mirrors the original dashboard SQL GROUP BY exactly:
//     GROUP BY packaged_amount, lp_code, location_name, sys_lot, material_code, vendor_lot, warehouse_name
//
//   One query avoids the fan-out multiplication bug that occurred when
//   packaged_amount was in a separate query from the material/lot joins.
//   Omni groups all 6 fields together, so each row = one unique LP content entry.
//
//   PAGINATION: probe page 0, then parallel batches of BATCH_SIZE=2.
//   Small batch size prevents overwhelming Omni with concurrent requests.

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'

const LP     = 'silver__datex_slv_licenseplates'
const LP_CNT = 'silver__datex_slv_licenseplatecontents'
const LOC    = 'silver__datex_slv_locationcontainers'
const WH     = 'silver__datex_slv_warehouses'
const LOT    = 'silver__datex_slv_lots'
const VLOT   = 'silver__datex_slv_vendorlots'
const MAT    = 'silver__datex_slv_materials'

const PAGE_SIZE  = 1000
const MAX_PAGES  = 50     // 50,000 rows max — covers Caledonia (37k LPs)
const BATCH_SIZE = 2      // Conservative — don't hammer Omni with concurrent calls

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
// Paginated fetch — probe first, then parallel batches of BATCH_SIZE
// ---------------------------------------------------------------------------
async function fetchAllPages(baseQuery) {
  // Probe: page 0
  const probeRows = await omniQuery({ ...baseQuery, limit: PAGE_SIZE, offset: 0 })
  const allRows = [...probeRows]
  if (probeRows.length < PAGE_SIZE) return allRows

  let offset = PAGE_SIZE
  let pageCount = 1

  while (pageCount < MAX_PAGES) {
    // Build a small batch of offsets
    const offsets = []
    for (let i = 0; i < BATCH_SIZE && pageCount + i < MAX_PAGES; i++) {
      offsets.push(offset + i * PAGE_SIZE)
    }

    const batchResults = await Promise.all(
      offsets.map(off => omniQuery({ ...baseQuery, limit: PAGE_SIZE, offset: off }))
    )

    let done = false
    for (const rows of batchResults) {
      allRows.push(...rows)
      pageCount++
      if (rows.length < PAGE_SIZE) { done = true; break }
    }

    if (done) break
    offset += BATCH_SIZE * PAGE_SIZE
  }

  return allRows
}

// ---------------------------------------------------------------------------
// SINGLE inventory query — all fields together, mirrors dashboard SQL GROUP BY
// lp_code + location + packaged_amount + material + vendor_lot + sys_lot
// Omni groups all 6 as dimensions → correct one-row-per-LP-content result.
// ---------------------------------------------------------------------------
async function fetchInventoryRows(whName) {
  return fetchAllPages({
    modelId: GOLD_MODEL_ID,
    table: LP,
    fields: [
      `${LP}.lookup_code`,
      `${LOC}.location_container_name`,
      `${LP_CNT}.packaged_amount`,
      `${MAT}.lookup_code`,
      `${VLOT}.lookup_code`,
      `${LOT}.lookup_code`,
    ],
    filters: {
      [`${LP}.archived`]: { type: 'boolean', is_negative: true, treat_nulls_as_false: false },
      [`${WH}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [whName] },
    },
    sorts: [
      { column_name: `${LOC}.location_container_name`, sort_descending: false },
      { column_name: `${LP}.lookup_code`,              sort_descending: false },
    ],
  })
}

// ---------------------------------------------------------------------------
// Query 3: All location names including empty — background only
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
// Transform
// ---------------------------------------------------------------------------
function deriveZone(locationName) {
  if (!locationName) return 'Other'
  return `Aisle ${locationName.slice(0, 2).toUpperCase()}`
}

function buildLocationMap(rows) {
  const locationMap = new Map()

  for (const row of rows) {
    const lp      = row[`${LP}.lookup_code`]              || ''
    const locName = row[`${LOC}.location_container_name`] || ''
    const qty     = Number(row[`${LP_CNT}.packaged_amount`]) || 0
    const mat     = row[`${MAT}.lookup_code`]  || ''
    const vl      = row[`${VLOT}.lookup_code`] || ''
    const sl      = row[`${LOT}.lookup_code`]  || ''

    if (!lp || !locName) continue

    if (!locationMap.has(locName)) {
      locationMap.set(locName, {
        id: locName, zone: deriveZone(locName),
        palletCount: 0, onHand: 0, pallets: [],
      })
    }

    const loc = locationMap.get(locName)

    // Deduplicate by LP — Omni may return multiple rows per LP if multi-lot
    const existing = loc.pallets.find(p => p.lp === lp)
    if (existing) {
      // Same LP, additional lot row — accumulate qty, keep first material/lot
      existing.qty += qty
      loc.onHand   += qty
    } else {
      loc.pallets.push({ lp, qty, materialCode: mat, vendorLot: vl, sysLot: sl })
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

  const rows        = await fetchInventoryRows(whName)
  const locationMap = buildLocationMap(rows)

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
    return occupiedData  // fail silently — occupied data still usable
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
