'use strict'

// Thomas Foods International adapter for the shared multi-customer order
// agent. Added 2026-10-14 as the fourth customer (after Grassland,
// Richelieu, Pedone Pinsa).
//
// WHAT THESE ORDERS ARE: a "Fulfillment Authorization" PDF (Thomas Foods'
// own system-generated doc, e.g. #IF10169386) attached to a one-PDF-per-
// email request, sender tfiusainventoryauthorization@thomasfoodsusa.com.
// CSW ships OUT of Kenosha (project THOMA5, project_id 345) to the
// customer's own destination — Birchwood Foods, in every example seen so
// far, read off the PDF's own "Ship To" block each time, not hardcoded.
// Confirmed via real Datex order history: genuinely outbound Sales Orders
// (order_class_id 2, "SO"), same class every customer in this agent uses.
//
// LINE STRUCTURE — closest to Richelieu's shape, but simpler math: one row
// per physical storage lot, in the form "PO######-N" (e.g. "PO156366-1"),
// which IS the real Datex storage lot lookup_code directly — confirmed
// against two real historical orders, including one (815906) with the
// exact same material code and the same "-1"/"-2" split as a sample order
// checked 2026-10-14. Unlike Richelieu, there is NO pallet/tote-to-eaches
// conversion here: the PDF's own "Cases Ordered" column IS the quantity to
// push, verbatim — `packaged_amount` on real historical lines matches it
// directly. `packaged_id` is a fixed 3 ("CS"), confirmed across all 348
// real historical lines for this project, zero exceptions.
//
// A REAL CROSS-CHECK UNIQUE TO THIS CUSTOMER: the PDF's "Item" field prints
// BOTH a description and the material code together ("BEEF TRIM 85 CL FZN
// : 221000462"), and separately gives the storage lot. That lets each
// line's resolution verify the extracted material code against the
// material the resolved LOT actually belongs to in Datex — two
// independently-stated facts on the same line that should always agree.
// This document has no printed grand total anywhere (unlike Grassland's/
// Richelieu's totals lines), so this cross-check is the only structural
// safety net available before hitting Datex, similar in spirit to (but
// more informative than) Pedone's complete lack of one.
//
// HEADER FIELD MAPPING — confirmed in part, genuinely unconfirmed in part:
//   - lookup_code / owner_reference: the Transfer Order number (e.g.
//     "TO10006606", from the PDF's own "Sales Order #" field printed as
//     "Transfer Order #TO10006606") — confirmed reliable across every real
//     historical order checked.
//   - vendor_reference: UNCONFIRMED THEORY, not yet proven against a real
//     push. Real historical orders show vendor_reference sometimes equal
//     to the TO number, sometimes a completely different value (e.g.
//     "K186787", "PO13595") — the working theory is that it mirrors the
//     PDF's own "Customer PO#" field when populated, falling back to the
//     TO number when that field is blank (true of every sample PDF seen
//     so far). Needs confirming against a real order where Customer PO#
//     is actually filled in before trusting this fully.
//   - carrier_id: deliberately left null, NOT a guess gap the way it is
//     for Richelieu/Pedone. Real historical Thomas Foods orders DO have a
//     real, varying carrier set — but the email itself says "you must
//     reply to this message with the related shipping details," meaning
//     carrier is very likely supplied by CSW in a REPLY after the order
//     already exists, not present on the original request PDF at all.
//     Leaving it null at creation time is probably the correct behavior,
//     not a missing feature — revisit only if a real pushed order shows
//     otherwise.

const { runMotherDuckQuery } = require('../order-agent-common.cjs')

const THOMAS_PROJECT_ID = 345 // THOMA5 — Thomas Foods - Kenosha
const KENOSHA_WAREHOUSE_ID = 5 // CSW-Kenosha
const THOMAS_ORDER_CLASS_ID = 2 // "SO" Sales Order — same class as every other customer here
const THOMAS_PACKAGING_ID = 3 // "CS" — confirmed fixed across 348 real historical lines, zero exceptions

// Looks up every storage lot printed on one PDF in a single query, scoped
// to the Thomas Foods project only (single project, no multi-project vote
// needed — same simplicity as Richelieu/Pedone).
// FIXED 2026-10-14 (real failure, order TO10006606): a matching exact-
// string lookup against lot.lookup_code silently missed a real lot —
// Datex's own stored value for storage lot "PO156366-1" actually carries
// a trailing space ("PO156366-1 ", 11 characters), confirmed directly.
// Checked broadly: 8 of 3,784 lots across the three projects this agent
// currently touches (THOMA5/RICHR5/PEDPI5) have the same stray leading/
// trailing whitespace — small, but a real recurring landmine, not a one-
// off. TRIM() on both sides of the match makes this robust regardless of
// which side (ours or Datex's) has the stray space.
async function fetchLotDetails(storageLots) {
  if (!storageLots.length) return new Map()
  const inList = storageLots.map((s) => `'${s.trim().replace(/'/g, "''")}'`).join(',')
  const rows = await runMotherDuckQuery(`
    SELECT TRIM(lot.lookup_code) AS storage_lot, lot.lot_id AS lot_id, lot.material_id AS material_id,
           lot.vendor_lot_id AS vendor_lot_id, m.lookup_code AS material_code
    FROM production_db.silver.datex_slv_lots lot
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
    WHERE TRIM(lot.lookup_code) IN (${inList})
      AND m.project_id = ${THOMAS_PROJECT_ID}
  `)
  const map = new Map()
  for (const r of rows) map.set(r.storage_lot, r)
  return map
}

async function resolveOrderLines(parsed) {
  const lines = parsed.lines || []
  if (lines.length === 0) {
    return { ok: false, flagReason: 'No lot lines were extracted from this Fulfillment Authorization PDF.' }
  }

  const storageLots = [...new Set(lines.map((l) => (l.storage_lot || '').trim()))]
  const detailsByLot = await fetchLotDetails(storageLots)

  const resolvedLines = []
  const unresolvedLots = []
  const materialMismatches = []

  for (const line of lines) {
    const details = detailsByLot.get((line.storage_lot || '').trim())
    if (!details) {
      unresolvedLots.push(line.storage_lot)
      resolvedLines.push({ ...line, line_status: 'missing_lp' })
      continue
    }
    // Cross-check: the PDF states the material code independently of the
    // lot — both should point to the same real material. The resolved
    // lot's own material is ground truth (same principle as Grassland
    // trusting a matched license plate's real contents over the form); a
    // disagreement here means something is genuinely wrong, not just a
    // formatting quirk, and is worth flagging rather than silently
    // pushing whichever one "looks more official."
    if (line.material_code && String(line.material_code).trim() !== String(details.material_code).trim()) {
      materialMismatches.push(`${line.storage_lot}: PDF says material ${line.material_code}, but that lot actually belongs to material ${details.material_code} in Datex`)
    }
    resolvedLines.push({
      ...line,
      line_status: 'resolved',
      item_count: line.case_count,
      resolved_lot_id: details.lot_id,
      resolved_material_id: details.material_id,
      resolved_material_code: details.material_code,
      resolved_vendor_lot_id: details.vendor_lot_id ?? null,
      resolved_packaging_id: THOMAS_PACKAGING_ID,
    })
  }

  const anyUnresolved = resolvedLines.some((l) => l.line_status !== 'resolved')
  if (anyUnresolved) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `Could not resolve every storage lot to a real Datex lot in project THOMA5 (lot codes: ${[...new Set(unresolvedLots)].join(', ')}).`,
    }
  }
  if (materialMismatches.length > 0) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `Material code mismatch between the PDF's item field and the actual lot in Datex: ${materialMismatches.join('; ')}.`,
    }
  }

  return { ok: true, resolvedLines }
}

function buildOrderHeader(parsed) {
  return {
    project_id: THOMAS_PROJECT_ID,
    warehouse_id: KENOSHA_WAREHOUSE_ID,
    order_class_id: THOMAS_ORDER_CLASS_ID,
    lookup_code: parsed.transfer_order_number || null,
    owner_reference: parsed.transfer_order_number || null,
    // UNCONFIRMED — see file header note. Falls back to the TO number
    // when Customer PO# is blank, which is true of every sample seen so
    // far; a real order with a populated Customer PO# hasn't been tested
    // yet to confirm this fallback is actually what Datex should receive.
    vendor_reference: parsed.customer_po || parsed.transfer_order_number || null,
    order_notes: parsed.fulfillment_authorization_number ? `Fulfillment Authorization ${parsed.fulfillment_authorization_number}` : null,
    carrier_id: null, // deliberate — see file header note, not a guess gap
    expected_date: parsed.ship_date || null,
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
  customerCode: 'thomasfoods',
  domains: ['thomasfoodsusa.com'],
  resolveOrderLines,
  buildOrderHeader,
  buildLinePayload,
  THOMAS_PROJECT_ID,
  KENOSHA_WAREHOUSE_ID,
}
