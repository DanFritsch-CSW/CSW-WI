// src/lib/omniInventory.js
//
// Fetches location-level inventory from Omni using the silver datex views.
//
// FIX: The original single 7-table JOIN timed out (~26s Netlify ceiling) on
// large facilities. This version splits it into two parallel lean queries that
// each stay well under the limit, then merges client-side on LP code.
//
//   Query 1 — LP → Location → Warehouse (3 joins)
//     Fields: lp.lookup_code, location_container_name
//     Purpose: which LP is in which location
//
//   Query 2 — LP → LPContents → Lots → VendorLots → Materials (4 joins)
//     Fields: lp.lookup_code, packaged_amount, material.lookup_code,
//             vendorlot.lookup_code, lot.lookup_code
//     Purpose: qty and material detail per LP
//
// Both queries paginate at PAGE_SIZE = 2000 with offset until exhausted.
// Promise.all() runs them in parallel; merge happens in transformInventoryRows().
//
// Component shape returned by fetchInventoryLocations(facilityId):
//   { id, zone, palletCount, onHand, pallets[] }
//   pallet: { lp, qty, materialCode, vendorLot, sysLot }

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

// Safety cap: 20 pages × 2000 rows = 40,000 rows max. No CSW facility is
// anywhere near that, but this prevents an infinite loop if Omni misbehaves.
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

// Query 1: LP → Location → Warehouse (3 joins, fast)
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

/**
 * Derives the aisle/zone label from a location container name.
 * Convention: first 2 chars = aisle prefix (AA, AB, AR, BB, etc.)
 * Returns "Aisle AA", "Aisle AR", etc. or "Other" as fallback.
 * Zone grouping is reserved for a future sprint.
 */
function deriveZone(locationName) {
  if (!locationName) return 'Other'
  const prefix = locationName.slice(0, 2).toUpperCase()
  return `Aisle ${prefix}`
}

/**
 * Merges two row sets (LP→Location and LP→Detail) into structured location objects.
 *
 * Output shape per location:
 *   {
 *     id:          string   — location_container_name  (e.g. 'AA001A')
 *     zone:        string   — derived aisle group      (e.g. 'Aisle AA')
 *     palletCount: number   — distinct LP count
 *     onHand:      number   — sum of packaged_amount across all pallets
 *     pallets: [
 *       { lp, qty, materialCode, vendorLot, sysLot }
 *     ]
 *   }
 */
export function transformInventoryRows(lpLocationRows, lpDetailRows) {
  // Build detail lookup: lp_code → { qty, materialCode, vendorLot, sysLot }
  const detailMap = new Map()
  for (const row of lpDetailRows) {
    const lp  = row[`${LP}.lookup_code`]           || ''
    const qty = Number(row[`${LP_CNT}.packaged_amount`]) || 0
    if (!lp) continue
    if (detailMap.has(lp)) {
      // Sum qty across multiple lot rows for the same LP
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

  // Build location map from LP→Location rows, enriching each LP with detail
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

    // Deduplicate — LP rows are unique from Query 1, but guard just in case
    if (!loc.pallets.find(p => p.lp === lp)) {
      loc.pallets.push({ lp, ...detail })
      loc.palletCount += 1
      loc.onHand      += detail.qty
    }
  }

  // Sort by location ID — zone grouping deferred to future sprint
  return [...locationMap.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Main entry point — runs both queries in parallel, then merges.
 * Returns structured location array ready for InventoryReport.
 */
export async function fetchInventoryLocations(facilityId) {
  const whName = FACILITY_WH_NAME[facilityId]
  if (!whName) throw new Error(`Unknown facilityId: ${facilityId}`)

  const [lpLocationRows, lpDetailRows] = await Promise.all([
    fetchLpLocations(whName),
    fetchLpDetail(whName),
  ])

  return transformInventoryRows(lpLocationRows, lpDetailRows)
}
