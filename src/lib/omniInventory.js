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

// 2026-08-27 (Dan, following the "AQ" aisle-search fix): the team refers to
// locations by the legacy "A<letter><bay><level>" style (e.g. "AQ001A"), but
// Room F1 at Caledonia was partially renamed in Datex to a 4-segment
// "F1-<letter>-<bay>-<level>" style (e.g. "F1-Q-001-A") — the underlying
// data (loc.id, used for search matching, Supabase discrepancy keys, and
// merge/dedup against occupiedIds) has to stay the REAL Datex name, since
// that's what the backend and Supabase actually key off of. This helper is
// purely a DISPLAY transform: format any "F1-<letter>-<bay>-<level>" name
// back into the "A<letter><bay><level>" style the team already knows, by
// stripping the "F1-" prefix and the dashes. Confirmed live in MotherDuck
// that every F1-prefixed location follows this exact 4-segment shape (no
// variant bay/level widths), so this is a safe, lossless string transform,
// not a guess. Names that don't match (already-legacy "AQ116B", or any
// other facility/room's naming) pass through unchanged.
const F1_LEGACY_STYLE_RE = /^F1-([A-Za-z])-(\d+)-([A-Za-z0-9]+)$/
export function toDisplayLocationId(id) {
  if (!id) return id
  const m = F1_LEGACY_STYLE_RE.exec(id)
  return m ? `A${m[1].toUpperCase()}${m[2]}${m[3].toUpperCase()}` : id
}

// Derives from the DISPLAY id (not the raw Datex id) so this reproduces the
// original "Aisle A<letter>" convention regardless of which of the two
// underlying naming styles a given location actually uses.
function deriveZone(displayId) {
  if (!displayId) return 'Other'
  return `Aisle ${displayId.slice(0, 2).toUpperCase()}`
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
      const displayId = toDisplayLocationId(locationName)
      locationMap.set(locationName, {
        id: locationName,
        displayId,
        zone: deriveZone(displayId),
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
  // Sort by displayId, not the raw Datex id: the one remaining legacy-named
  // location in a partially-renamed aisle (e.g. "AQ116B") would otherwise
  // sort as if its bay number were before all "F1-Q-..." rows (since 'A' <
  // 'F' lexically) — sorting by the same style everything now DISPLAYS in
  // keeps bay order numerically sane regardless of which underlying name a
  // given location happens to still have.
  return [...locationMap.values()].sort((a, b) => a.displayId.localeCompare(b.displayId))
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
    .map(name => {
      const displayId = toDisplayLocationId(name)
      return {
        id: name,
        displayId,
        zone: deriveZone(displayId),
        palletCount: 0,
        onHand: 0,
        pallets: [],
      }
    })

  if (emptyRows.length === 0) return occupiedData
  // Same displayId-based sort as fetchInventoryLocations, for the same reason.
  return [...occupiedData, ...emptyRows].sort((a, b) => a.displayId.localeCompare(b.displayId))
}
