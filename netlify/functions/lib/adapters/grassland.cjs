'use strict'

// Grassland adapter for the shared multi-customer order agent.
// Extracted 2026-10-13 out of what was a single-customer
// grassland-order-shared.cjs, when the agent expanded to also handle
// Richelieu. This file now owns everything Grassland-specific; the
// mechanics every customer shares (Supabase CRUD, the actual
// create_outbound_order/_line push loop) live in ../order-agent-common.cjs.
//
// WHY THE RESOLUTION LOGIC BELOW IS NOT A SIMPLE LOOKUP — proven against
// real release forms and real storage lots:
//   1. Grassland's "Item #" is not a stable material key — the same item #
//      exists as two different materials in two different Madison
//      projects (GRAFG1 "Cooler" vs GRALA1 "Frozen"). Project is resolved
//      per order via a majority-vote across the order's own storage lots
//      (voteOrderProject), never guessed from the item #.
//   2. The release form's "Pallet/Tote #" has no relationship to Datex's
//      real license-plate codes. The crosswalk (decodePalletNumber): take
//      the LP's LookupCode, drop its last digit, the remaining 3 digits
//      equal the release form's Pallet/Tote #.
//   3. A SPLIT PALLET's second lot fraction can live under a DIFFERENT
//      Datex storage lot than the one printed on the form (confirmed
//      2026-10-13, PO 0116894180: the form prints both 564951's 53-case
//      fraction and 564965's 7-case fraction under one "STORAGE LOT:
//      163441A" header, but Datex actually filed the 564965 fraction
//      under a separate lot 163441C — same license plate, same material,
//      same project, different lot_id). fetchAllContentsForLicensePlate +
//      the fallback search in resolveOrderLines below handles this.
//   4. create_outbound_order_line is a CONFIRMED UNRELIABLE Datex endpoint
//      (see dpi-monthly-shared.cjs) — silently drops lines under load.
//      Every push here writes to grassland_order_batches/_lines and MUST
//      be paired with a reconciliation job (not yet built) before being
//      trusted unattended.
//
// SETTLED 2026-10-13 against the real create_outbound_order_line OpenAPI
// schema (https://csw-smartup-api.wavelength.host/documentation/, found by
// Dan): the endpoint's actual parameters are order_id, shipment_id,
// material_id, expected_quantity, actual_quantity, packaging_id, lot_id,
// vendor_lot_id, marks, notes — THERE IS NO license_plate_id PARAMETER AT
// ALL. `lot_id` is confirmed correct (every line's Lot column matched on
// real order 818983/1160587). Specific-pallet selection is NOT
// controllable through this endpoint — lines land at the lot level only.
//
// `vendor_lot_id` IS a real parameter — a Datex-internal integer FK,
// confirmed to already exist as a column on datex_slv_lots itself (not a
// field to invent a value for). fetchLotCandidates/
// fetchAllContentsForLicensePlate select it directly off the matched lot
// record and pass that through, giving each line's Grassland lot number
// real traceability in Datex without guessing an ID.
//
// CONFIRMED 2026-10-13 (same order): lookup_code and owner_reference need
// to be Grassland's own "Sales Order" number (printed only on the "Lot
// Information" PDF, e.g. "1160587"), NOT left blank. vendor_reference
// needs to be the PO number EXACTLY as printed, leading zero included
// (e.g. "0116894180") — stripping it is wrong. vendor_reference's field
// name is confirmed correct from the schema but still didn't persist on
// the real order — likely a Datex-side business rule for Sales Orders,
// not a code bug; order_notes carries the PO number as a reliable backup.
//
// FIXED 2026-10-14 (real failure found via Thomas Foods, same bug class
// applies here): an exact-string match against lot.lookup_code can
// silently miss a real lot if Datex's own stored value carries stray
// leading/trailing whitespace — confirmed directly for a real lot on
// another customer's project, and confirmed broadly: 8 of 3,784 lots
// across the three other projects this agent touches have the same
// issue. TRIM() on both sides of the match (and on the input list) in
// fetchLotCandidates makes this robust regardless of which side has the
// stray space.

const { runMotherDuckQuery } = require('../order-agent-common.cjs')

const MADISON_WAREHOUSE_ID = 4
const GRASSLAND_ORDER_CLASS_ID = 2 // "SO" Sales Order — same as DPI
const GRASSLAND_CARRIER_ID = 1618 // "GRASSLAND" — fixed on every sampled real order
const GRASSLAND_PACKAGING_ID = 3 // "CS" — confirmed for 1162/1163/1164/7105 across all 3 projects

const GRASSLAND_PROJECTS = {
  GRAFG1: { id: 181, name: 'Grassland WM - Cooler - CSW-Madison' },
  GRASM1: { id: 301, name: "Grassland Sam's - Cooler - CSW-Madison" },
  GRALA1: { id: 65, name: 'Grassland WM - Frozen - CSW-Madison' },
}
const GRASSLAND_PROJECT_IDS = Object.values(GRASSLAND_PROJECTS).map((p) => p.id)

// ── LINE-ITEM MODE SWITCH (added 2026-10-21) ────────────────────────────────
// false = HEADER-ONLY (current): the agent creates the Datex outbound order
//   as a shell — project, Sales Order #, PO, ship-to, carrier, expected date —
//   with ZERO lines. A CSR then adds the lines and assigns license plates in
//   Datex before the warehouse picks. Reason: create_outbound_order_line has
//   no license_plate_id parameter, so lines pushed through the API can only
//   land at the lot level and the CSR has to redo them down to the LP anyway.
// true  = FULL LINE-ITEM mode (the original behavior, all logic below is
//   intact): resolve every PDF line to a lot / license plate and push a
//   line per pallet. Flip this to true and push once Datex's API accepts a
//   license plate on order lines.
// A code constant, not an env var, on purpose: this Netlify site is at
// Lambda's hard 4KB total-env-var ceiling, and adding a new variable fails
// the deploy for the whole site (see GRASSLAND_AGENT_ACTIVE history).
const GRASSLAND_LINE_ITEM_MODE = false

function decodePalletNumber(lpLookupCode) {
  if (!lpLookupCode || lpLookupCode.length < 4) return null
  const threeDigits = lpLookupCode.slice(-4, -1)
  const n = parseInt(threeDigits, 10)
  return Number.isNaN(n) ? null : n
}

async function fetchLotCandidates(storageLots) {
  if (!storageLots.length) return new Map()
  const inList = storageLots.map((s) => `'${s.trim().replace(/'/g, "''")}'`).join(',')
  const rows = await runMotherDuckQuery(`
    SELECT TRIM(lot.lookup_code) AS storage_lot, lot.lot_id AS lot_id, lot.material_id AS material_id,
           lot.vendor_lot_id AS vendor_lot_id,
           m.lookup_code AS material_code, m.project_id AS project_id
    FROM production_db.silver.datex_slv_lots lot
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
    WHERE TRIM(lot.lookup_code) IN (${inList})
      AND m.project_id IN (${GRASSLAND_PROJECT_IDS.join(',')})
  `)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.storage_lot)) map.set(r.storage_lot, [])
    map.get(r.storage_lot).push(r)
  }
  return map
}

function voteOrderProject(storageLots, candidatesByLot) {
  const votes = new Map()
  let votedLots = 0
  for (const sl of storageLots) {
    const candidates = candidatesByLot.get(sl) || []
    if (candidates.length === 1) {
      votedLots += 1
      const pid = candidates[0].project_id
      votes.set(pid, (votes.get(pid) || 0) + 1)
    }
  }
  if (votedLots === 0) return { projectId: null, conflict: false, noVotes: true }
  if (votes.size > 1) return { projectId: null, conflict: true, noVotes: false, votes: Object.fromEntries(votes) }
  const [projectId] = [...votes.keys()]
  const projectCode = Object.keys(GRASSLAND_PROJECTS).find((k) => GRASSLAND_PROJECTS[k].id === projectId)
  return { projectId, projectCode, conflict: false, noVotes: false }
}

async function fetchLicensePlatesForLot(lotId) {
  const rows = await runMotherDuckQuery(`
    SELECT lp.license_plate_id AS license_plate_id, lp.lookup_code AS lp_code, lpc.packaged_amount AS amount
    FROM production_db.silver.datex_slv_licenseplatecontents lpc
    JOIN production_db.silver.datex_slv_licenseplates lp ON lp.license_plate_id = lpc.license_plate_id
    WHERE lpc.lot_id = ${Number(lotId)}
  `)
  const byPallet = new Map()
  for (const r of rows) {
    const n = decodePalletNumber(r.lp_code)
    if (n != null) byPallet.set(n, r)
  }
  return byPallet
}

async function fetchAllContentsForLicensePlate(licensePlateId) {
  return runMotherDuckQuery(`
    SELECT lpc.lot_id AS lot_id, lot.lookup_code AS storage_lot, lot.material_id AS material_id,
           lot.vendor_lot_id AS vendor_lot_id,
           m.lookup_code AS material_code, m.project_id AS project_id, lpc.packaged_amount AS amount
    FROM production_db.silver.datex_slv_licenseplatecontents lpc
    JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
    WHERE lpc.license_plate_id = ${Number(licensePlateId)}
  `)
}

async function resolveOrderLines(parsed) {
  const lines = parsed.lines || []
  const distinctStorageLots = [...new Set(lines.map((l) => (l.storage_lot || '').trim()))]

  const candidatesByLot = await fetchLotCandidates(distinctStorageLots)
  const vote = voteOrderProject(distinctStorageLots, candidatesByLot)

  if (vote.noVotes) {
    return { ok: false, flagReason: 'No storage lot on this order resolved unambiguously to a Grassland project — needs manual lookup.' }
  }
  if (vote.conflict) {
    return { ok: false, flagReason: `Order's storage lots voted for more than one project (${JSON.stringify(vote.votes)}) — this should not occur; needs manual review.` }
  }

  // HEADER-ONLY MODE: the project vote above is all the header needs
  // (project_id can't be guessed from the item #, see note 1 at the top).
  // Skip every line / license-plate lookup below — they stay intact for
  // when GRASSLAND_LINE_ITEM_MODE is flipped back on.
  if (!GRASSLAND_LINE_ITEM_MODE) {
    return {
      ok: true,
      headerOnly: true,
      projectCode: vote.projectCode,
      projectId: vote.projectId,
      resolvedLines: [],
      successNote: 'Header only — no lines were created. A CSR needs to add the lines and assign license plates in Datex before this can be picked.',
    }
  }

  const lpCacheByLotId = new Map()
  const lpContentsCacheByLpId = new Map()
  const resolvedLines = []
  const unresolvedStorageLots = []

  for (const line of lines) {
    const candidates = (candidatesByLot.get((line.storage_lot || '').trim()) || []).filter((c) => c.project_id === vote.projectId)
    if (candidates.length !== 1) {
      unresolvedStorageLots.push(line.storage_lot)
      resolvedLines.push({ ...line, line_status: 'ambiguous' })
      continue
    }
    const { lot_id, material_id, material_code, vendor_lot_id } = candidates[0]
    if (!lpCacheByLotId.has(lot_id)) {
      lpCacheByLotId.set(lot_id, await fetchLicensePlatesForLot(lot_id))
    }
    const lp = lpCacheByLotId.get(lot_id).get(Number(line.pallet_tote_number))
    if (!lp) {
      resolvedLines.push({ ...line, line_status: 'missing_lp', resolved_lot_id: lot_id, resolved_material_id: material_id, resolved_material_code: material_code, resolved_vendor_lot_id: vendor_lot_id ?? null })
      continue
    }

    let finalLotId = lot_id
    let finalMaterialId = material_id
    let finalMaterialCode = material_code
    let finalVendorLotId = vendor_lot_id ?? null
    let amountMismatch = Number(lp.amount) !== Number(line.item_count)

    if (amountMismatch) {
      if (!lpContentsCacheByLpId.has(lp.license_plate_id)) {
        lpContentsCacheByLpId.set(lp.license_plate_id, await fetchAllContentsForLicensePlate(lp.license_plate_id))
      }
      const allContents = lpContentsCacheByLpId.get(lp.license_plate_id)
      const wantedItemNumber = String(line.item_number || '').trim()
      const alternates = allContents.filter((c) =>
        c.lot_id !== lot_id &&
        c.project_id === vote.projectId &&
        String(c.material_code).trim() === wantedItemNumber &&
        Number(c.amount) === Number(line.item_count)
      )
      if (alternates.length === 1) {
        finalLotId = alternates[0].lot_id
        finalMaterialId = alternates[0].material_id
        finalMaterialCode = alternates[0].material_code
        finalVendorLotId = alternates[0].vendor_lot_id ?? null
        amountMismatch = false
        console.log(`[order-agent:grassland] split-pallet cross-lot match: LP ${lp.lp_code} line (storage_lot ${line.storage_lot}, grassland_lot ${line.grassland_lot}) actually belongs to Datex lot ${finalLotId} (storage lot ${alternates[0].storage_lot}), not the printed ${line.storage_lot}/${lot_id}.`)
      }
    }

    resolvedLines.push({
      ...line,
      line_status: 'resolved',
      resolved_lot_id: finalLotId,
      resolved_material_id: finalMaterialId,
      resolved_material_code: finalMaterialCode,
      resolved_vendor_lot_id: finalVendorLotId,
      resolved_license_plate_id: lp.license_plate_id,
      resolved_license_plate_code: lp.lp_code,
      amount_mismatch: amountMismatch,
    })
  }

  const anyUnresolved = resolvedLines.some((l) => l.line_status !== 'resolved')
  const anyAmountMismatch = resolvedLines.some((l) => l.amount_mismatch)

  if (anyUnresolved) {
    return {
      ok: false,
      projectCode: vote.projectCode,
      resolvedLines,
      flagReason: `Could not resolve every line to a specific license plate (storage lots: ${[...new Set(unresolvedStorageLots)].join(', ') || 'see line_status'}).`,
    }
  }
  if (anyAmountMismatch) {
    return {
      ok: false,
      projectCode: vote.projectCode,
      resolvedLines,
      flagReason: 'One or more lines: the PDF\u2019s item count does not match the quantity actually on the matched license plate in Datex.',
    }
  }

  return { ok: true, projectCode: vote.projectCode, projectId: vote.projectId, resolvedLines }
}

function buildOrderHeader(parsed, resolution) {
  return {
    project_id: resolution.projectId,
    warehouse_id: MADISON_WAREHOUSE_ID,
    order_class_id: GRASSLAND_ORDER_CLASS_ID,
    lookup_code: parsed.sales_order_number || null,
    owner_reference: parsed.sales_order_number || null,
    vendor_reference: parsed.po_number || null,
    order_notes: parsed.po_number ? `PO ${parsed.po_number}` : null,
    carrier_id: GRASSLAND_CARRIER_ID,
    expected_date: parsed.ship_date || null,
    shipping_address: {
      name: parsed.released_to?.name || null,
      first_name: parsed.released_to?.name || null,
      line1: parsed.released_to?.line1 || null,
      city: parsed.released_to?.city || null,
      state: parsed.released_to?.state || null,
      postal_code: parsed.released_to?.zip || null,
      country: 'US',
    },
  }
}

function buildLinePayload(line, ctx) {
  return {
    order_id: ctx.order_id,
    shipment_id: ctx.shipment_id,
    line_number: ctx.line_number,
    material_id: line.resolved_material_id,
    expected_quantity: line.item_count,
    actual_quantity: line.item_count,
    packaging_id: GRASSLAND_PACKAGING_ID,
    lot_id: line.resolved_lot_id,
    vendor_lot_id: line.resolved_vendor_lot_id ?? null,
  }
}

module.exports = {
  customerCode: 'grassland',
  GRASSLAND_LINE_ITEM_MODE,
  domains: ['grassland.com'],
  resolveOrderLines,
  buildOrderHeader,
  buildLinePayload,
  decodePalletNumber,
  GRASSLAND_PROJECTS,
}
