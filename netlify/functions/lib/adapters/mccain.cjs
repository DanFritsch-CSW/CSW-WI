'use strict'

// McCain Foods (Wisconsin Rapids) adapter for the shared multi-customer
// order agent. Added 2026-10-24 as the sixth customer (after Grassland,
// Richelieu, Pedone, Thomas Foods, Echo Lake).
//
// WHAT THESE ORDERS ARE: a "Shipping Information Email" sent by BizLink
// (bizlink@mccain.com) to wisconsinrapids@csw-wi.com. Confirmed against 10
// real emails (2026-10-24): the PDF is NOT a direct attachment on the Front
// message — every one of these emails attaches a single `.eml` (a
// forwarded/relayed message), and the real PDF is an attachment INSIDE that
// .eml. The webhook (supabase/functions/grassland-order-webhook/index.ts)
// handles the unwrap: it detects McCain by the .eml attachment (there is no
// direct PDF to find), downloads it, MIME-parses it, and extracts the PDF
// before calling this adapter's extract/validate the same as any other
// customer. See that file's emlAttachments/findPdfInMime for the parsing.
//
// CATCH-WEIGHT, NOT CASE COUNT: McCain's PDF gives a target WEIGHT per lot
// line, not a case or tote count (confirmed: "Quantity"/"Weight" columns
// both print the same LB figure). Datex's create_outbound_order_line API
// does not take a weight — like every other customer here, the real field
// is a packaged-unit COUNT (totes, in McCain's case, each a catch-weight
// unit of ~850-860 lb, confirmed via real license-plate data). It also
// cannot take a license plate ID (same constraint Grassland hit — see
// grassland.cjs), so this adapter never tries to pin the order to specific
// totes; it only decides HOW MANY totes to request from a specific lot,
// and the floor picks whichever physical totes actually fulfill that count
// at pick time — exactly like every other customer's quantity-only line.
//
// Dan's confirmed intent (2026-10-24): "fill the order as close as
// possible to the stated weight — most of the time it's a full truckload
// in and out," i.e. most lines will turn out to want the ENTIRE lot's
// current on-hand totes, not a partial pull. Both cases are handled by one
// allocation routine below (resolveWeightLine): if the full lot's on-hand
// weight is within tolerance of the target, push the whole lot (common
// case); otherwise, estimate the tote count that gets closest to the
// target without exceeding on-hand count, and add a `warnings` entry (same
// non-blocking mechanism other adapters use) if the result still misses by
// more than the tolerance — never a hard fail, per Dan's "as close as
// possible" framing.
//
// LOT CODE IS CONSTRUCTED, NOT PRINTED DIRECTLY: confirmed against 9 real
// orders in Datex with zero exceptions — the PDF's footer free-text line
// prints a 10-digit number (e.g. "4500821227") right before the batch
// breakdown; the Datex lot lookup_code is `<last 6 digits of that number>
// - <last 6 digits of the batch#>` (e.g. "821227 - 260911" for footer
// "4500821227" + "BATCH# 20260911"). The webhook's extraction prompt pulls
// that footer number as `footer_po_number` specifically for this purpose —
// it is NOT the same as "Reference number" (-> owner_reference) or
// "Shipment No." (-> vendor_reference), which are separate printed fields
// confirmed to map 1:1 to those two Datex order columns.
//
// NOT YET CONFIRMED AGAINST A REAL PUSH (same spirit as every other
// adapter's "first real test" caveats):
//   - Tolerance band for "close enough" (resolveWeightLine's WEIGHT_
//     TOLERANCE_LB below) — Dan said "use your judgement" rather than give
//     a number; set to whichever is larger of 100 lb or 1% of the target.
//     Tighten or loosen after watching the first several real pushes.
//   - No FEFO-style rotation to a different lot on shortfall, unlike
//     Richelieu — McCain's PDF always names one specific lot per line, and
//     Dan did not ask for substitution; a lot that can't cover its own
//     target just pushes what's on hand and warns.
//   - carrier_id: not printed on this document at all (one PDF showed
//     "CUSTOMER PICK UP" as a value in a Carrier field alongside a literal
//     "CARRIER" line — unclear if that's ever anything else); left null.

const { runMotherDuckQuery } = require('../order-agent-common.cjs')

const MCCAIN_PROJECT_ID = 315 // MCCMA3 — McCain Foods, Wisconsin Rapids
const WI_RAPIDS_WAREHOUSE_ID = 6 // CSW-Wisconsin Rapids
const MCCAIN_ORDER_CLASS_ID = 2 // "SO" Sales Order — same class as every other customer here

// last6() mirrors the construction rule confirmed in the file header note:
// both the footer PO-style number and the batch number are longer printed
// strings whose last 6 digits are what actually appears in the Datex lot
// lookup_code. Returns the input unchanged (trimmed) if it's already 6
// characters or shorter, so a shorter real-world variant doesn't silently
// truncate into something wrong.
function last6(value) {
  const s = String(value || '').trim()
  return s.length > 6 ? s.slice(-6) : s
}

function buildLotCode(footerPoNumber, batchNumber) {
  return `${last6(footerPoNumber)} - ${last6(batchNumber)}`
}

// Looks up every constructed lot code across every item on one PDF, in a
// single query, scoped to the McCain project. Mirrors Richelieu's
// fetchLotDetails shape (candidates keyed by lot_code, narrowed by material
// in resolveOrderLines below) since lot codes are only unique in
// combination with their material here too — unconfirmed whether McCain
// ever repeats a lot code across materials the way Richelieu does, but
// matching on (lot_code, material_code) together costs nothing and avoids
// repeating Richelieu's original mistake if it turns out to matter.
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
      AND m.project_id = ${MCCAIN_PROJECT_ID}
  `)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.lot_code)) map.set(r.lot_code, [])
    map.get(r.lot_code).push(r)
  }
  return map
}

// Real on-hand totes for one lot, with each tote's own net_weight — the
// per-tote weight is what makes a weight-target estimate meaningful here
// (unlike a fixed-size-pallet customer, McCain's totes genuinely vary,
// confirmed ~850-860 lb across real license plates on the same lot).
// Active/non-archived filters keep this to genuinely on-hand inventory,
// not stale or already-shipped license plate rows.
async function fetchLotTotes(lotId) {
  const rows = await runMotherDuckQuery(`
    SELECT lp.license_plate_id AS license_plate_id, lp.net_weight AS net_weight
    FROM production_db.silver.datex_slv_licenseplatecontents lpc
    JOIN production_db.silver.datex_slv_licenseplates lp ON lp.license_plate_id = lpc.license_plate_id
    WHERE lpc.lot_id = ${lotId}
      AND lp.Archived = false
      AND lp.status_name = 'Active'
  `)
  return rows.map((r) => Number(r.net_weight) || 0)
}

// Allocates one requested (lot, target weight) line against real on-hand
// totes. Common case (per Dan, 2026-10-24: "usually FTL in/out") is that
// the full lot's on-hand weight is already close to the target — push
// every tote currently in the lot. Otherwise, estimate how many totes
// (using this lot's own average tote weight, since totes aren't uniform)
// get closest to the target without exceeding on-hand count, and report
// how far off that lands so the caller can decide whether a warning is
// needed. Never fails outright — "as close as possible" per Dan's
// instruction — even a lot with zero on-hand totes still returns (with
// count 0), by design: let the normal unresolved/shortfall messaging
// explain why, rather than throwing.
function resolveWeightLine(toteWeights, targetWeight) {
  const onHandCount = toteWeights.length
  const onHandWeight = toteWeights.reduce((s, w) => s + w, 0)

  const WEIGHT_TOLERANCE_LB = Math.max(100, targetWeight * 0.01)

  if (onHandCount === 0 || Math.abs(onHandWeight - targetWeight) <= WEIGHT_TOLERANCE_LB) {
    // Full-lot case (the common one) — also what's left if there's
    // nothing on hand at all; a 0-tote line surfaces as a shortfall below.
    return { toteCount: onHandCount, estimatedWeight: onHandWeight, shortBy: targetWeight - onHandWeight }
  }

  const avgToteWeight = onHandWeight / onHandCount
  let toteCount = Math.round(targetWeight / avgToteWeight)
  if (toteCount > onHandCount) toteCount = onHandCount
  if (toteCount < 0) toteCount = 0
  const estimatedWeight = toteCount * avgToteWeight

  return { toteCount, estimatedWeight, shortBy: targetWeight - estimatedWeight }
}

async function resolveOrderLines(parsed) {
  const items = parsed.items || []
  if (items.length === 0) {
    return { ok: false, flagReason: 'No items were extracted from this Shipping Information PDF.' }
  }
  if (!parsed.footer_po_number) {
    return { ok: false, flagReason: 'No footer PO number was found on this PDF — the lot code cannot be constructed without it (see mccain.cjs header note).' }
  }

  // Build every candidate lot code up front (one per batch line across
  // every item) and resolve them all in a single MotherDuck round trip.
  const lotCodesByLine = []
  for (const item of items) {
    for (const line of item.lines || []) {
      lotCodesByLine.push({ item, line, lotCode: buildLotCode(parsed.footer_po_number, line.batch_number) })
    }
  }
  const detailsByLotCode = await fetchLotDetails(lotCodesByLine.map((l) => l.lotCode))

  const resolvedLines = []
  const unresolved = []
  const warnings = []

  for (const { item, line, lotCode } of lotCodesByLine) {
    const candidates = (detailsByLotCode.get(lotCode) || []).filter(
      (c) => String(c.material_code).trim() === String(item.material_code || '').trim()
    )
    if (candidates.length !== 1) {
      unresolved.push(`${lotCode} (${item.material_code}, batch ${line.batch_number})`)
      resolvedLines.push({ lot_code: lotCode, item_number: item.material_code, line_status: candidates.length === 0 ? 'missing_lp' : 'ambiguous' })
      continue
    }
    const primary = candidates[0]
    const toteWeights = await fetchLotTotes(primary.lot_id)
    const { toteCount, estimatedWeight, shortBy } = resolveWeightLine(toteWeights, Number(line.weight))

    if (toteCount === 0) {
      unresolved.push(`${lotCode} (${item.material_code}) — no on-hand totes found for this lot`)
      resolvedLines.push({ lot_code: lotCode, item_number: item.material_code, line_status: 'missing_lp' })
      continue
    }

    resolvedLines.push({
      lot_code: lotCode,
      item_number: item.material_code,
      line_status: 'resolved',
      item_count: toteCount,
      weight: line.weight,
      resolved_lot_id: primary.lot_id,
      resolved_material_id: primary.material_id,
      resolved_material_code: primary.material_code,
      resolved_vendor_lot_id: primary.vendor_lot_id ?? null,
      resolved_packaging_id: primary.packaging_id,
      amount_mismatch: Math.abs(shortBy) > Math.max(100, Number(line.weight) * 0.01),
    })

    if (Math.abs(shortBy) > Math.max(100, Number(line.weight) * 0.01)) {
      warnings.push(
        `${item.material_code} / lot ${lotCode}: requested ${Number(line.weight).toFixed(2)} LB, pushed ${toteCount} tote(s) estimated at ${estimatedWeight.toFixed(2)} LB (${shortBy > 0 ? 'short by' : 'over by'} ${Math.abs(shortBy).toFixed(2)} LB) — this lot's on-hand inventory couldn't get closer. No further lot was substituted (unlike Richelieu); flagging for manual review.`
      )
    }
  }

  if (unresolved.length > 0) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `Could not resolve every lot to a specific Datex lot record with on-hand inventory in project MCCMA3 (lot code / item pairs: ${[...new Set(unresolved)].join(', ')}).`,
    }
  }

  return { ok: true, resolvedLines, warnings: warnings.length ? warnings : undefined }
}

function buildOrderHeader(parsed) {
  return {
    project_id: MCCAIN_PROJECT_ID,
    warehouse_id: WI_RAPIDS_WAREHOUSE_ID,
    order_class_id: MCCAIN_ORDER_CLASS_ID,
    lookup_code: parsed.delivery_note_number || null,
    owner_reference: parsed.reference_number || null,
    vendor_reference: parsed.shipment_number || null,
    order_notes: null,
    carrier_id: null, // UNCONFIRMED — see file header note
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
  customerCode: 'mccain',
  domains: ['mccain.com'],
  resolveOrderLines,
  buildOrderHeader,
  buildLinePayload,
  MCCAIN_PROJECT_ID,
  WI_RAPIDS_WAREHOUSE_ID,
  // exported for the webhook's Edge-side lot-code construction mirror, if
  // ever needed there; also usable from tests.
  buildLotCode,
}
