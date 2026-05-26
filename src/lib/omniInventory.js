// omniInventory.js
// Fetches location-level inventory from Omni using the silver datex views.
// Mirrors the SQL from the Omni dashboard query:
//   silver__datex_slv_licenseplates
//   silver__datex_slv_licenseplatecontents
//   silver__datex_slv_locationcontainers
//   silver__datex_slv_warehouses
//   silver__datex_slv_lots
//   silver__datex_slv_vendorlots
//   silver__datex_slv_materials
//
// Returns a structured array of location objects, each with their pallets[].
// The component shape is:
//   { id, zone, palletCount, onHand (total qty), pallets[] }
//   pallet: { lp, qty, materialCode, vendorLot, sysLot }

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'

// Silver view names — match exact Omni topic names
const LP      = 'silver__datex_slv_licenseplates'
const LP_CNT  = 'silver__datex_slv_licenseplatecontents'
const LOC     = 'silver__datex_slv_locationcontainers'
const WH      = 'silver__datex_slv_warehouses'
const LOT     = 'silver__datex_slv_lots'
const VLOT    = 'silver__datex_slv_vendorlots'
const MAT     = 'silver__datex_slv_materials'

// Warehouse name as it appears in Omni per facility
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

/**
 * Fetch all LP-level inventory rows for a given facility from Omni.
 * Matches the dashboard SQL exactly:
 *   - Filter: NOT archived, warehouse_name = '<facility>'
 *   - Fields: warehouse_name, location_container_name, lp lookup_code,
 *             material lookup_code, vendor_lot lookup_code, sys_lot lookup_code,
 *             packaged_amount
 *   - ORDER BY warehouse, location, lp
 *   - LIMIT 1000
 *
 * Returns raw rows as-is from Omni.
 */
export async function fetchInventoryRawRows(facilityId) {
  const whName = FACILITY_WH_NAME[facilityId]
  if (!whName) throw new Error(`Unknown facilityId: ${facilityId}`)

  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: LP,
    fields: [
      `${WH}.warehouse_name`,
      `${LOC}.location_container_name`,
      `${LP}.lookup_code`,
      `${MAT}.lookup_code`,
      `${VLOT}.lookup_code`,
      `${LOT}.lookup_code`,
      `${LP_CNT}.packaged_amount`,
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
      { column_name: `${WH}.warehouse_name`,        sort_descending: false },
      { column_name: `${LOC}.location_container_name`, sort_descending: false },
      { column_name: `${LP}.lookup_code`,           sort_descending: false },
    ],
    limit: 1000,
  })

  return rows
}

/**
 * Derives the aisle/zone label from a location container name.
 * Convention: first 2 chars = aisle prefix (AA, AB, AR, BB, etc.)
 * Returns "Aisle AA", "Aisle AR", etc. or "Other" as fallback.
 */
function deriveZone(locationName) {
  if (!locationName) return 'Other'
  const prefix = locationName.slice(0, 2).toUpperCase()
  return `Aisle ${prefix}`
}

/**
 * Transforms raw Omni rows into structured location objects.
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
 *
 * Locations with no LP rows in Omni are occupied-only — empty locations
 * are not returned by the silver view (it only shows LPs with a location).
 * This matches the current Omni limitation discussed in the call transcript.
 */
export function transformInventoryRows(rows) {
  const locationMap = new Map()

  for (const row of rows) {
    const locationName = row[`${LOC}.location_container_name`] || ''
    const lpCode       = row[`${LP}.lookup_code`]    || null
    const matCode      = row[`${MAT}.lookup_code`]   || ''
    const vendorLot    = row[`${VLOT}.lookup_code`]  || ''
    const sysLot       = row[`${LOT}.lookup_code`]   || ''
    const qty          = Number(row[`${LP_CNT}.packaged_amount`]) || 0

    if (!locationName) continue

    if (!locationMap.has(locationName)) {
      locationMap.set(locationName, {
        id:          locationName,
        zone:        deriveZone(locationName),
        palletCount: 0,
        onHand:      0,
        pallets:     [],
      })
    }

    const loc = locationMap.get(locationName)

    if (lpCode) {
      // Deduplicate by LP code — Omni can return multiple rows per LP
      // if there are multiple lot entries; sum qty across those rows.
      const existing = loc.pallets.find(p => p.lp === lpCode)
      if (existing) {
        existing.qty += qty
      } else {
        loc.pallets.push({ lp: lpCode, qty, materialCode: matCode, vendorLot, sysLot })
        loc.palletCount += 1
      }
      loc.onHand += qty
    }
  }

  // Sort: by zone then location ID (natural string sort handles AA001A < AA001B < AA002A)
  return [...locationMap.values()].sort((a, b) => {
    if (a.zone !== b.zone) return a.zone.localeCompare(b.zone)
    return a.id.localeCompare(b.id)
  })
}

/**
 * Main entry point — fetch + transform.
 * Returns structured location array ready for InventoryReport.
 */
export async function fetchInventoryLocations(facilityId) {
  const rows = await fetchInventoryRawRows(facilityId)
  return transformInventoryRows(rows)
}
