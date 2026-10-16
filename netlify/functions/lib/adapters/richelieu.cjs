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
// REWRITTEN 2026-10-16 (real failure, TOP1060598/cnv_1cnvq9as): the
// original design assumed exactly one item per PDF, with a flat top-level
// item_number and a single lots[] array. A real order proved that wrong —
// TOP1060598 has TWO items (R1116537 and R1117692) on one page, each with
// its own lot block — and the old schema silently kept only the first,
// dropping the second item's entire $-value from the order with no error
// at all. The schema is now `items: [{ item_number, description,
// total_quantity, lots: [...], printed_total_count }]`, one entry per item
// block actually printed on the page.
//
// That same real order also surfaced a second, more fundamental issue:
// a lot CODE is not unique within the Richelieu project — "16SEP6EF"
// exists as THREE separate Datex lot records, one each for R1116537,
// R1117692, and R1117575 (confirmed directly). The PDF disambiguates this
// correctly by printing each lot block directly under its own item
// number; resolution now matches on (lot_code, material_code) TOGETHER,
// never lot_code alone — matching lot_code alone can and did pick an
// entirely wrong lot/material pairing.
//
// ONE PDF = ONE ORDER. There is no per-pallet license-plate matching here
// (unlike Grassland); the Datex-side math is: each physical pallet
// ("tote"/"pallet" — Dan's PDFs use both labels interchangeably for the
// same physical unit, a license plate) of a given material holds a FIXED
// number of eaches, defined on the material's own Datex packaging record
// (pallet_tie × pallet_high), not something to infer per-shipment.
// Confirmed against 6 real Richelieu SKUs and many real historical
// orders: every order quantity is an exact integer multiple of its
// material's pallet_tie × pallet_high, with zero exceptions.
//
// LOT-LEVEL DETAIL IS A DELIBERATE UPGRADE OVER CURRENT PRACTICE: checked
// a dozen real past Richelieu TOP orders in Datex — almost all were
// entered as a single line with just the total quantity, lot_id and
// vendor_lot_id left null. Dan confirmed (2026-10-13) he wants this agent
// to push the real per-lot detail every time, not match that historical
// shortcut.
//
// AVAILABILITY SHORTFALLS ARE A FLAG, NOT A FAILURE (Dan's explicit
// request, 2026-10-16, same real order): TOP1060598's 26AUG6EF lot needed
// 34 pallets of R1117692 (26,520 eaches) but Datex currently shows only
// 32 pallets (24,960 eaches) actually on real license plates for that lot
// — confirmed directly. Unlike an unresolvable lot (a genuine data
// problem that still blocks the order), a quantity shortfall is a normal
// warehouse timing situation — more inventory may be in transit, or the
// order may simply short-ship — so resolution still succeeds and pushes
// the order at the FULL requested quantity; the shortfall is surfaced as
// a `warnings` entry that order-agent-common.cjs appends to the success
// comment, not as a flagReason that blocks the push. If CSW ever wants
// the pushed quantity capped at what's actually available instead of the
// requested amount, that's a real policy choice to revisit, not assumed
// here.
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

// Looks up every lot code printed on one PDF, across every item, in a
// single query, scoped to the Richelieu project. Returns ALL candidate
// rows per lot code (not deduped to one) — resolveOrderLines below is
// responsible for narrowing each lot to the one candidate whose material
// matches that lot's own item block, since lot codes are confirmed NOT
// unique across materials within this project (see file header note).
// TRIM() on both sides guards against the same stray-whitespace issue
// confirmed on other customers' lot codes (2026-10-14).
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

// Real on-hand quantity for a set of resolved lot_ids, summed from actual
// license plate contents — the same source Grassland's amount-mismatch
// check reads from. Used only to produce the shortfall warning below;
// never blocks resolution on its own.
async function fetchAvailableQuantities(lotIds) {
  if (!lotIds.length) return new Map()
  const rows = await runMotherDuckQuery(`
    SELECT lot_id, SUM(packaged_amount) AS available_qty
    FROM production_db.silver.datex_slv_licenseplatecontents
    WHERE lot_id IN (${lotIds.join(',')})
    GROUP BY lot_id
  `)
  const map = new Map()
  for (const r of rows) map.set(r.lot_id, Number(r.available_qty) || 0)
  return map
}

async function resolveOrderLines(parsed) {
  const items = parsed.items || []
  if (items.length === 0) {
    return { ok: false, flagReason: 'No items were extracted from this Transfer Order PDF.' }
  }

  const allLotCodes = [...new Set(items.flatMap((it) => (it.lots || []).map((l) => (l.lot_code || '').trim())))]
  const detailsByLotCode = await fetchLotDetails(allLotCodes)

  const resolvedLines = []
  const unresolved = []
  const totalMismatches = []

  for (const item of items) {
    const lots = item.lots || []
    const itemResolved = []
    for (const lotLine of lots) {
      const lotCode = (lotLine.lot_code || '').trim()
      const candidates = (detailsByLotCode.get(lotCode) || []).filter(
        (c) => String(c.material_code).trim() === String(item.item_number || '').trim()
      )
      if (candidates.length !== 1) {
        unresolved.push(`${lotCode} (${item.item_number})`)
        resolvedLines.push({ ...lotLine, item_number: item.item_number, line_status: candidates.length === 0 ? 'missing_lp' : 'ambiguous' })
        continue
      }
      const { lot_id, material_id, material_code, vendor_lot_id, packaging_id, pallet_tie, pallet_high } = candidates[0]
      const eachesPerTote = Number(pallet_tie) * Number(pallet_high)
      const quantity = Number(lotLine.count) * eachesPerTote

      const resolvedLine = {
        ...lotLine,
        item_number: item.item_number,
        line_status: 'resolved',
        item_count: quantity,
        resolved_lot_id: lot_id,
        resolved_material_id: material_id,
        resolved_material_code: material_code,
        resolved_vendor_lot_id: vendor_lot_id ?? null,
        resolved_packaging_id: packaging_id,
        eaches_per_tote: eachesPerTote,
      }
      resolvedLines.push(resolvedLine)
      itemResolved.push(resolvedLine)
    }

    // Per-item structural check against this item's own printed total —
    // a mismatch here means a real extraction/math problem, not a stock
    // question, and still blocks the push.
    if (itemResolved.length === lots.length && item.total_quantity != null) {
      const sum = itemResolved.reduce((s, l) => s + (Number(l.item_count) || 0), 0)
      if (sum !== Number(item.total_quantity)) {
        totalMismatches.push(`${item.item_number}: sum of resolved lot quantities ${sum} != printed total ${item.total_quantity}`)
      }
    }
  }

  if (unresolved.length > 0) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `Could not resolve every lot to a specific Datex lot record in project RICHR5 (lot code / item pairs: ${[...new Set(unresolved)].join(', ')}).`,
    }
  }
  if (totalMismatches.length > 0) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `Printed-total validation failed: ${totalMismatches.join('; ')}.`,
    }
  }

  // Availability check — a shortfall is surfaced as a warning, never a
  // block. See file header note for why (2026-10-16, Dan's explicit call).
  const lotIds = [...new Set(resolvedLines.map((l) => l.resolved_lot_id))]
  const availableByLotId = await fetchAvailableQuantities(lotIds)
  const warnings = []
  for (const line of resolvedLines) {
    const available = availableByLotId.get(line.resolved_lot_id) ?? 0
    if (available < Number(line.item_count)) {
      const eachesShort = Number(line.item_count) - available
      const palletsNeeded = Math.round(Number(line.item_count) / line.eaches_per_tote)
      const palletsAvailable = Math.round(available / line.eaches_per_tote)
      line.availability_short = true
      line.available_qty = available
      warnings.push(
        `Lot ${line.lot_code} (${line.resolved_material_code}): order needs ${palletsNeeded} pallet(s) (${line.item_count} each) but Datex currently shows only ${palletsAvailable} pallet(s) (${available} each) on real license plates — short by ${eachesShort} each. Pushed at the full requested quantity regardless; flagging for manual follow-up.`
      )
    }
  }

  return { ok: true, resolvedLines, warnings: warnings.length ? warnings : undefined }
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
