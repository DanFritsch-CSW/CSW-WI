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
// number; resolution matches on (lot_code, material_code) TOGETHER, never
// lot_code alone — matching lot_code alone can and did pick an entirely
// wrong lot/material pairing.
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
// REWRITTEN AGAIN 2026-10-23 (real team feedback, cnv_1cpor7v8): the
// 2026-10-16 "push the full requested quantity anyway and flag the
// shortfall" behavior was a genuine miss — Sadie (CSR handling these
// orders) reported she still had to manually remove the short lines
// herself every time, so the flag added no value over the prior manual
// process. The real, Richelieu-confirmed policy (relayed by Sadie, who
// used to email Richelieu about every shortfall until they told her not
// to): when a requested lot can't cover the full amount, automatically
// pull the remainder from the NEXT lot in FEFO rotation for that same
// material — FULL PALLETS ONLY, never a partial pallet — and no customer
// email is needed as long as that holds. Confirmed directly against real
// data before building this: Richelieu's own lot codes encode a pack date
// right in the code (e.g. "16SEP6EF", "26AUG6EF"), and `receive_date` on
// `datex_slv_lots` tracks that embedded date in lockstep — so
// `receive_date` ascending is a clean, reliable FEFO ordering key, no
// fragile parsing of the lot code's own text required.
//
// Allocation logic (resolveLotLineWithFefo below): try the originally
// requested lot first; if it can't cover the full pallet count, walk
// forward through that material's remaining lots in receive_date order,
// taking whole pallets from each (skipping any with none available) until
// the request is met. This can turn one requested lot line into several
// pushed lines (e.g. 34 pallets requested on 26AUG6EF → 32 from 26AUG6EF
// + 2 from the next lot with stock) — still one Datex order, just sourced
// from real inventory instead of a lot that can't fully cover it.
//
// If the ENTIRE rotation for that material still can't cover the request
// (not just the one named lot, but every later lot too), that's a real
// shortage, not a rotation question — Dan's explicit call (2026-10-23):
// still don't hard-fail the order over it. Push whatever full pallets
// exist across the whole rotation and surface the remaining shortfall as
// a `warnings` entry (order-agent-common.cjs appends these to the success
// comment) for manual follow-up, the same mechanism as before — just now
// reserved for this genuinely-out-of-stock case instead of every
// shortfall.
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
// Safety cap on how many later-lot candidates to pull per material when
// substituting — comfortably more than any real shortfall should need;
// just a guard against a runaway query on a material with huge lot churn.
const MAX_ROTATION_CANDIDATES = 50

// Looks up every lot code printed on one PDF, across every item, in a
// single query, scoped to the Richelieu project. Returns ALL candidate
// rows per lot code (not deduped to one) — resolveOrderLines below is
// responsible for narrowing each lot to the one candidate whose material
// matches that lot's own item block, since lot codes are confirmed NOT
// unique across materials within this project (see file header note).
// TRIM() on both sides guards against the same stray-whitespace issue
// confirmed on other customers' lot codes (2026-10-14). receive_date is
// the FEFO ordering key for the substitution logic below.
async function fetchLotDetails(lotCodes) {
  if (!lotCodes.length) return new Map()
  const inList = lotCodes.map((s) => `'${s.trim().replace(/'/g, "''")}'`).join(',')
  const rows = await runMotherDuckQuery(`
    SELECT TRIM(lot.lookup_code) AS lot_code, lot.lot_id AS lot_id, lot.material_id AS material_id,
           lot.vendor_lot_id AS vendor_lot_id, lot.receive_date AS receive_date, m.lookup_code AS material_code,
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

// Every later lot for one material, in FEFO (receive_date ascending)
// order, starting from the originally-requested lot's own receive_date —
// excludes that lot itself (it's tried separately, first, in
// resolveLotLineWithFefo). Capped at MAX_ROTATION_CANDIDATES; in the
// extremely unlikely case a real shortfall needs more than that many
// lots to cover, it will show up as a flagged shortfall rather than
// silently stopping, since the allocation loop below simply runs out of
// candidates and reports whatever's left unmet.
async function fetchRotationCandidates(materialId, fromReceiveDate, excludeLotId) {
  const rows = await runMotherDuckQuery(`
    SELECT lot.lot_id AS lot_id, TRIM(lot.lookup_code) AS lot_code, lot.vendor_lot_id AS vendor_lot_id,
           lot.receive_date AS receive_date
    FROM production_db.silver.datex_slv_lots lot
    WHERE lot.material_id = ${materialId}
      AND lot.receive_date >= TIMESTAMP '${fromReceiveDate}'
      AND lot.lot_id != ${excludeLotId}
    ORDER BY lot.receive_date ASC
    LIMIT ${MAX_ROTATION_CANDIDATES}
  `)
  return rows
}

// Real on-hand quantity for a set of resolved lot_ids, summed from actual
// license plate contents — the same source Grassland's amount-mismatch
// check reads from.
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

// Allocates one requested (lot, pallet count) against real inventory,
// trying the named lot first and then walking forward through FEFO
// rotation for the same material if it falls short — full pallets only,
// per Dan's 2026-10-23 confirmation. Returns one entry per lot actually
// used (only entries with pallets > 0), plus any pallets still unmet
// after exhausting the whole rotation.
async function resolveLotLineWithFefo(primary, requestedPallets) {
  const eachesPerTote = Number(primary.pallet_tie) * Number(primary.pallet_high)
  const rotation = await fetchRotationCandidates(primary.material_id, primary.receive_date, primary.lot_id)
  const candidateLotIds = [primary.lot_id, ...rotation.map((r) => r.lot_id)]
  const availableByLotId = await fetchAvailableQuantities(candidateLotIds)

  const orderedCandidates = [
    { lot_id: primary.lot_id, lot_code: primary.lot_code, vendor_lot_id: primary.vendor_lot_id },
    ...rotation,
  ]

  const allocations = []
  let remainingPallets = requestedPallets
  for (const candidate of orderedCandidates) {
    if (remainingPallets <= 0) break
    const availableEaches = availableByLotId.get(candidate.lot_id) ?? 0
    const availablePallets = Math.floor(availableEaches / eachesPerTote)
    const take = Math.min(availablePallets, remainingPallets)
    if (take > 0) {
      allocations.push({
        lot_id: candidate.lot_id,
        lot_code: candidate.lot_code,
        vendor_lot_id: candidate.vendor_lot_id,
        pallets: take,
        each_quantity: take * eachesPerTote,
        substituted: candidate.lot_id !== primary.lot_id,
      })
      remainingPallets -= take
    }
  }

  return { allocations, eachesPerTote, shortfallPallets: remainingPallets }
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
  const warnings = []

  for (const item of items) {
    const lots = item.lots || []
    const itemResolvedCounts = []
    let itemHadUnresolved = false

    for (const lotLine of lots) {
      const lotCode = (lotLine.lot_code || '').trim()
      const candidates = (detailsByLotCode.get(lotCode) || []).filter(
        (c) => String(c.material_code).trim() === String(item.item_number || '').trim()
      )
      if (candidates.length !== 1) {
        unresolved.push(`${lotCode} (${item.item_number})`)
        resolvedLines.push({ ...lotLine, item_number: item.item_number, line_status: candidates.length === 0 ? 'missing_lp' : 'ambiguous' })
        itemHadUnresolved = true
        continue
      }
      const primary = candidates[0]
      const requestedPallets = Number(lotLine.count)
      const { allocations, eachesPerTote, shortfallPallets } = await resolveLotLineWithFefo(primary, requestedPallets)

      let totalEaches = 0
      for (const alloc of allocations) {
        totalEaches += alloc.each_quantity
        resolvedLines.push({
          ...lotLine,
          lot_code: alloc.lot_code,
          item_number: item.item_number,
          line_status: 'resolved',
          item_count: alloc.each_quantity,
          resolved_lot_id: alloc.lot_id,
          resolved_material_id: primary.material_id,
          resolved_material_code: primary.material_code,
          resolved_vendor_lot_id: alloc.vendor_lot_id ?? null,
          resolved_packaging_id: primary.packaging_id,
          eaches_per_tote: eachesPerTote,
          substituted_from_lot: alloc.substituted ? lotCode : null,
        })
      }
      itemResolvedCounts.push(totalEaches)

      if (shortfallPallets > 0) {
        warnings.push(
          `${item.item_number}: requested ${requestedPallets} pallet(s) starting from lot ${lotCode}, but only ${requestedPallets - shortfallPallets} pallet(s) were available across the full FEFO rotation for this material — short by ${shortfallPallets} pallet(s). Pushed what's available; flagging for manual follow-up since there's no further rotation to pull from.`
        )
      }
    }

    // Per-item structural check against this item's own printed total —
    // a mismatch here means a real extraction/math problem, not a stock
    // question, and still blocks the push. Skipped for an item that had
    // any unresolved lot (true total can't be known yet) or a genuine
    // shortfall (its own warning already explains why the sum is lower
    // than the printed total — that's not an extraction error).
    const itemHadShortfall = warnings.some((w) => w.startsWith(`${item.item_number}:`))
    if (!itemHadUnresolved && !itemHadShortfall && item.total_quantity != null) {
      const sum = itemResolvedCounts.reduce((s, n) => s + n, 0)
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
