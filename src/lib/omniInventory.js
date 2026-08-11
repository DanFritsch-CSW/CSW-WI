// omniInventory.js
// Data source: MotherDuck (production_db silver schema) via motherduck-inventory Netlify function.
// Switched from Omni API due to packaged_amount measure aggregation bug —
// Omni treated packaged_amount as a SUM measure and fan-out multiplied quantities
// (e.g. 405 returned instead of actual 81 for P029A at WR).
// MotherDuck queries the silver views directly and returns accurate raw values.

export const FACILITY_WH_NAME = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

function deriveZone(locationName) {
  if (!locationName) return 'Other'
  return `Aisle ${locationName.slice(0, 2).toUpperCase()}`
}

// ---------------------------------------------------------------------------
// Core fetch via motherduck-inventory Netlify function
// ---------------------------------------------------------------------------
async function mdInventoryFetch(facilityId, includeEmpty = false) {
  let res
  try {
    res = await fetch('/.netlify/functions/motherduck-inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facilityId, includeEmpty }),
    })
  } catch (e) {
    throw new Error(`Network error reaching motherduck-inventory: ${e.message}`)
  }
  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new Error(body.error || `motherduck-inventory ${res.status}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Transform raw DB rows into structured location objects
// ---------------------------------------------------------------------------
function buildLocationMap(inventoryRows) {
  const locationMap = new Map()

  for (const row of inventoryRows) {
    const { lp, locationName, qty, materialCode, materialDescription, vendorLot, sysLot } = row
    if (!lp || !locationName) continue

    if (!locationMap.has(locationName)) {
      locationMap.set(locationName, {
        id: locationName,
        zone: deriveZone(locationName),
        palletCount: 0,
        onHand: 0,
        pallets: [],
      })
    }

    const loc = locationMap.get(locationName)

    // Deduplicate by LP — multiple lot rows can exist per LP
    const existing = loc.pallets.find(p => p.lp === lp)
    if (existing) {
      existing.qty += qty
      loc.onHand   += qty
    } else {
      loc.pallets.push({ lp, qty, materialCode, materialDescription, vendorLot, sysLot })
      loc.palletCount += 1
      loc.onHand      += qty
    }
  }

  return locationMap
}

// ---------------------------------------------------------------------------
// PRIMARY export — occupied locations, fast
// ---------------------------------------------------------------------------
export async function fetchInventoryLocations(facilityId) {
  const { inventoryRows } = await mdInventoryFetch(facilityId, false)
  const locationMap = buildLocationMap(inventoryRows)
  return [...locationMap.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// BACKGROUND export — merge empty locations after primary load
// Requests includeEmpty=true; returns original data on failure
// ---------------------------------------------------------------------------
export async function mergeEmptyLocations(facilityId, occupiedData) {
  let result
  try {
    result = await mdInventoryFetch(facilityId, true)
  } catch {
    return occupiedData  // fail silently
  }

  const occupiedIds = new Set(occupiedData.map(l => l.id))
  const emptyRows = (result.emptyLocations || [])
    .filter(name => name && !occupiedIds.has(name))
    .map(name => ({
      id: name,
      zone: deriveZone(name),
      palletCount: 0,
      onHand: 0,
      pallets: [],
    }))

  if (emptyRows.length === 0) return occupiedData
  return [...occupiedData, ...emptyRows].sort((a, b) => a.id.localeCompare(b.id))
}
