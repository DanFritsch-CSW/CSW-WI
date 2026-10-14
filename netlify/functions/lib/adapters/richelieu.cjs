'use strict'

// Richelieu Raw Materials adapter for the shared multi-customer order
// agent. Added 2026-10-13 as the second customer (after Grassland).
//
// WHAT THESE ORDERS ARE: a daily "CSW TO WL" email from Richelieu's
// Wheeling plant lists several Transfer Orders (TOP######), each as its
// own attached PDF, for raw-material SKUs CSW ships OUT of Pleasant
// Prairie (Datex warehouse "CSW-Kenosha") to Richelieu's Wheeling plant.
// Confirmed 2026-10-13 via real Datex order history: these are genuinely
// OUTBOUND Sales Orders in Datex (order_class_id 2, "SO" — same class
// Grassland and DPI use), not inbound receipts, even though Wheeling's own
// paperwork is titled "Transfer Order" and frames CSW as the "transfer
// from" site.
//
// ONE PDF = ONE ORDER, and — unlike Grassland — there is no per-pallet
// license-plate matching at all here. Each PDF lists one material and a
// set of (lot, tote-count) pairs; the Datex-side math is: each physical
// pallet ("tote", per Dan's framing — one license plate) of a given
// material holds a FIXED number of eaches, defined on the material's own
// Datex packaging record (pallet_tie × pallet_high), not something to
// infer per-shipment. Confirmed 2026-10-13 against 6 real Richelieu SKUs
// and a dozen real historical orders: every order quantity is an exact
// integer multiple of its material's pallet_tie × pallet_high, with zero
// exceptions. So resolution here is: look up each lot code directly
// (project RICHR5 only — single project, no vote needed like Grassland),
// multiply its tote count by that material's pallet size, and the sum
// across all lots on the PDF must equal the PDF's own printed total
// quantity — the Richelieu equivalent of Grassland's printed-totals check.
//
// LOT-LEVEL DETAIL IS A DELIBERATE UPGRADE OVER CURRENT PRACTICE: checked
// a dozen real past Richelieu TOP orders in Datex — almost all were
// entered as a single line with just the total quantity, lot_id and
// vendor_lot_id left null. Dan confirmed (2026-10-13) he wants this agent
// to push the real per-lot detail every time, not match that historical
// shortcut.
//
// NOT YET RESOLVED / left for the first real test push, same spirit as
// Grassland's iterative confirm-via-real-order approach:
//   - carrier_id: varies per shipment/truck and isn't printed on the PDF
//     itself; left null here rather than guessed. If it matters, a source
//     for it needs to be identified (the email body lists truck numbers,
//     but Dan asked to ignore that for now).
//   - shipping_address: taken from the PDF's own letterhead block
//     ("Wheeling Plant Shipping" + its address) as the ship-to, since
//     Datex confirms the direction is CSW → Wheeling; unconfirmed against
//     a real pushed order yet.

const { runMotherDuckQuery } = require('../order-agent-common.cjs')

const RICHELIEU_PROJECT_ID = 224 // RICHR5 — Richelieu Raw Materials Kenosha
const KENOSHA_WAREHOUSE_ID = 5 // CSW-Kenosha (Pleasant Prairie)
const RICHELIEU_ORDER_CLASS_ID = 2 // "SO" Sales Order — same class as Grassland/DPI

// FIXED 2026-10-14 (real failure, Thomas Foods order TO10006606 — same
// bug class applies here): an exact-string match against lot.lookup_code
// can silently miss a real lot if Datex's own stored value carries stray
// leading/trailing whitespace — confirmed directly for one real Thomas
// Foods lot ("PO156366-1" stored as "PO156366-1 "), and confirmed broadly:
// 8 of 3,784 lots across the three projects this agent touches
// (THOMA5/RICHR5/PEDPI5) have the same issue. TRIM() on both sides of the
// match (and on the input list) makes this robust regardless of which
// side has the stray space.
async function fetchLotDetails(lotCodes) {
  if (!lotCodes.length) return new Map()
  const inList = lotCodes.map((s) => `'${s.trim().replace(/'/g, "''")}'`).join(',')
  const rows = await runMotherDuckQuery(`
    SELECT TRIM(lot.lookup_code) AS lot_code, lot.lot_id AS lot_id, lot.material_id AS material_id,
           lot.vendor_lot_id AS vendor_lot_id, m.lookup_code AS material_code,
           pk.packaging_id AS packaging_id, pk.pallet_tie AS pallet_tie, pk.pallet_high AS pallet_high
    FROM production_db.silver.datex_slv_lots lot
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
    JOIN production_db.silver.datex_slv_materialspackagingslookup pk
      ON pk.material_id = lot.material_id AND pk.is_base_packaging = true
    WHERE TRIM(lot.lookup_code) IN (${inList})
      AND m.project_id = ${RICHELIEU_PROJECT_ID}
  `)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.lot_code)) map.set(r.lot_code, [])
    map.get(r.lot_code).push(r)
  }
  return map
}

async function resolveOrderLines(parsed) {
  const lots = parsed.lots || []
  if (lots.length === 0) {
    return { ok: false, flagReason: 'No lot/tote lines were extracted from this Transfer Order PDF.' }
  }

  const lotCodes = lots.map((l) => (l.lot_code || '').trim())
  const detailsByLotCode = await fetchLotDetails(lotCodes)

  const resolvedLines = []
  const unresolvedLotCodes = []

  for (const lotLine of lots) {
    const candidates = detailsByLotCode.get((lotLine.lot_code || '').trim()) || []
    if (candidates.length !== 1) {
      unresolvedLotCodes.push(lotLine.lot_code)
      resolvedLines.push({ ...lotLine, line_status: candidates.length === 0 ? 'missing_lp' : 'ambiguous' })
      continue
    }
    const { lot_id, material_id, material_code, vendor_lot_id, packaging_id, pallet_tie, pallet_high } = candidates[0]
    const eachesPerTote = Number(pallet_tie) * Number(pallet_high)
    const quantity = Number(lotLine.totes) * eachesPerTote

    resolvedLines.push({
      ...lotLine,
      line_status: 'resolved',
      item_count: quantity,
      resolved_lot_id: lot_id,
      resolved_material_id: material_id,
      resolved_material_code: material_code,
      resolved_vendor_lot_id: vendor_lot_id ?? null,
      resolved_packaging_id: packaging_id,
      eaches_per_tote: eachesPerTote,
    })
  }

  const anyUnresolved = resolvedLines.some((l) => l.line_status !== 'resolved')
  if (anyUnresolved) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `Could not resolve every lot to a specific Datex lot record in project RICHR5 (lot codes: ${[...new Set(unresolvedLotCodes)].join(', ')}).`,
    }
  }

  // Every material line on a Richelieu Transfer Order PDF is the same SKU
  // (confirmed: one item row per PDF), so a mismatched material_id across
  // lots would itself indicate a real data problem worth flagging rather
  // than silently pushing a mixed-material order.
  const distinctMaterials = new Set(resolvedLines.map((l) => l.resolved_material_id))
  if (distinctMaterials.size > 1) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `This PDF's lots resolved to more than one material (${[...distinctMaterials].join(', ')}) — expected exactly one material per Transfer Order.`,
    }
  }

  const sumQuantity = resolvedLines.reduce((s, l) => s + (Number(l.item_count) || 0), 0)
  if (parsed.total_quantity != null && sumQuantity !== Number(parsed.total_quantity)) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `Sum of resolved lot quantities ${sumQuantity} != the PDF's printed total quantity ${parsed.total_quantity}.`,
    }
  }

  return { ok: true, resolvedLines, materialCode: resolvedLines[0].resolved_material_code }
}

function buildOrderHeader(parsed) {
  return {
    project_id: RICHELIEU_PROJECT_ID,
    warehouse_id: KENOSHA_WAREHOUSE_ID,
    order_class_id: RICHELIEU_ORDER_CLASS_ID,
    lookup_code: parsed.transfer_order_number || null,
    owner_reference: parsed.transfer_order_number || null,
    vendor_reference: parsed.transfer_order_number || null,
    order_notes: null,
    carrier_id: null, // UNCONFIRMED — see file header note
    expected_date: parsed.posting_date || null,
    shipping_address: {
      name: parsed.ship_to?.name || null,
      line1: parsed.ship_to?.line1 || null,
      city: parsed.ship_to?.city || null,
      state: parsed.ship_to?.state || null,
      postal_code: parsed.ship_to?.zip || null,
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
    packaging_id: line.resolved_packaging_id,
    lot_id: line.resolved_lot_id,
    vendor_lot_id: line.resolved_vendor_lot_id ?? null,
  }
}

module.exports = {
  customerCode: 'richelieu',
  domains: ['richelieufoods.com'],
  resolveOrderLines,
  buildOrderHeader,
  buildLinePayload,
  RICHELIEU_PROJECT_ID,
  KENOSHA_WAREHOUSE_ID,
}
