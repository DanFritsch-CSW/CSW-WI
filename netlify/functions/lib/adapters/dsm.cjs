'use strict'

// DSM Firmenich adapter for the shared multi-customer order agent.
// Added 2026-10-26, kicked off by a live call with Mike McNutt, Mercedes
// Dile, Nate Williams and Dean Dioguardi (Fathom: "DF <> Kenosha DSM Team -
// Order Agent") — Monica Espino (the CSR who actually enters these orders
// today) was on PTO for the call itself.
//
// TWO DATEX PROJECTS, ONE SENDER DOMAIN. Unlike every other customer in this
// agent, DSM ships two completely different product lines out of CSW-
// Kenosha under the SAME sender domain (dsm-firmenich.com), with no reliable
// signal at the routing layer to tell them apart:
//   - DSMEN5 (project_id 66, owner_id 768) — enzymes
//   - DSMFO8 (project_id 67, owner_id 770) — cultures
// The email subject sometimes carries "( E )" or "(C)" as a human hint, but
// Dan confirmed by voice (2026-10-26) this is NOT reliable enough to route
// on. This adapter ignores the subject entirely: the webhook extracts the
// PDF first, and resolveOrderLines below resolves the project from the item
// numbers actually printed on it, the same way every other field is read
// off the document rather than guessed from metadata.
//
// WHY ITEM NUMBER ALONE IS A SAFE, UNAMBIGUOUS KEY (confirmed 2026-10-26 by
// querying every active material in both projects — 178 in DSMEN5, 638 in
// DSMFO8, 816 total, ZERO item numbers shared between them). This is the
// opposite of Grassland's problem (one item # meaning two different
// materials in different projects); here the item number by itself always
// identifies exactly one project. resolveOrderLines still requires EVERY
// line on an order to agree on one project (a unanimous vote, not a
// majority — there's no legitimate reason for one order to mix enzymes and
// cultures) before creating anything; a split order, or any item number
// that doesn't resolve to either project, flags to a CSR instead of
// guessing.
//
// VOLUME CONTEXT (confirmed via MotherDuck, 2026-10-26, trailing 60 days):
// DSMEN5 orders are 100% manually created by csw-mespino (25-80/week, zero
// EDI) — this is the bulk of the manual-entry pain this agent exists to
// remove. DSMFO8 is already mostly EDI'd (FOOTPRINT\csw-fpservice creates
// 70-108/week automatically, matching Mercedes' "one of them we get EDI
// for" on the call); mespino's manual DSMFO8 orders (1-20/week) are
// specifically the ones EDI failed on — exactly why item-number matching,
// not the customer's own EDI item codes, is used here too.
//
// DOCUMENT SHAPE: a "Delivery Note" (page 1, continuing onto page 2 for
// cultures orders with several line items) followed by a "Picking list"
// page carrying the Batch/lot code per line — confirmed against two real
// samples (order 859860/DSMEN5 single-line; order 860637/DSMFO8 three-line).
// The lot code is printed as ONE literal token in both cases (e.g.
// "4261555011" for enzymes, "GT00078396" for cultures) — NOT constructed
// from two separate fields, despite how it sounded read aloud digit-by-
// digit on the kickoff call; confirmed directly against real Datex lot
// records for both formats (production_db.silver.datex_slv_lots) before
// writing any of this.
//
// HEADER MAPPING (confirmed against 5 real live Datex orders for these two
// projects, 2026-10-26): lookup_code = the "Delivery" number zero-padded to
// 10 digits (e.g. "81050663" -> "0081050663"); owner_reference AND
// vendor_reference = the "Shipment ID number" zero-padded to 10 digits
// (e.g. "953027" -> "0000953027") — NOT the PO number and NOT the "Our
// order number" (Sales order #), despite those being the more visually
// prominent fields on the page. carrier_id: not printed on either sample —
// left null for now, same open gap Richelieu's adapter already carries.
//
// UOM / PACKAGING: DSM calls the unit "PC" (pieces; Mike/Dan's "we call it
// box" on the call is just CSW's informal name for the same thing, not a
// real unit conversion). Datex's packaging_id for it varies BY MATERIAL
// here (confirmed: item 23156 = packaging_id 2, items 20232/20245/23497 =
// packaging_id 1) — unlike Pedone's single fixed packaging_id, this needs
// the same per-material datex_slv_materialspackagingslookup join
// Richelieu/McCain already use.
//
// LOT / LICENSE PLATE: create_outbound_order_line DOES accept lot_id
// directly (confirmed via Grassland's settled API schema read, see that
// file's header note) — DSM does not hit the no-license-plate-parameter
// wall Grassland/Richelieu/McCain ran into, so this adapter pushes full
// line-item detail (material + lot) from the start; no header-only mode
// needed here.
//
// The structural printed-total check (sum of line net weights vs. the
// document's own header "Net weight" field) lives in the webhook
// (validateDSMTotals in order-agent-webhook/index.ts) since it only needs
// the extracted JSON, not live Datex data — same split as every other
// customer here.
//
// OPEN / UNCONFIRMED (same caution as every other adapter's early days):
//   - Only 2 real sample orders seen so far (one per project) — worth a
//     broader sample before trusting this fully unattended, same spirit as
//     the item-number-overlap check already run across the full catalog.
//   - Whether one DSM email can carry MULTIPLE PDFs/orders in one message
//     is unconfirmed (the "Orders" plural in some subjects, e.g. "10/28
//     Orders (C)", is suggestive but unverified against a real multi-PDF
//     sample) — the webhook's buildJobs processes every PDF found on the
//     triggering message as its own order, the same defensive pattern
//     already proven necessary for Richelieu and Thomas Foods, so nothing
//     silently gets dropped if that turns out to be true here too.
//   - carrier_id is always null for now — revisit once a real order with a
//     visible carrier shows up, or confirm with Dan whether DSM orders use
//     one fixed carrier the way Grassland/Palermo's do.
//   - No reconciliation job yet against create_outbound_order_line's
//     documented silent line-drop-under-load behavior (same open item every
//     other adapter here still carries).

const { runMotherDuckQuery } = require('../order-agent-common.cjs')

const KENOSHA_WAREHOUSE_ID = 5 // CSW-Kenosha (Pleasant Prairie) — confirmed from the PDF's "ShippedFrom" address
const DSM_ORDER_CLASS_ID = 2 // "SO" Sales Order — same class every customer in this agent uses

const DSM_PROJECTS = {
  DSMEN5: { id: 66, ownerId: 768, name: 'DSM FOOD SPECIALTIES USA, INC. (EN)' }, // enzymes
  DSMFO8: { id: 67, ownerId: 770, name: 'DSM FOOD SPECIALTIES, USA' }, // cultures
}
const DSM_PROJECT_IDS = Object.values(DSM_PROJECTS).map((p) => p.id)

function zeroPad10(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '')
  if (!digits) return null
  return digits.padStart(10, '0')
}

// Looks up every item number printed on one PDF against BOTH DSM projects
// at once — this IS the project-resolution step (see file header note).
// TRIM() on both sides, same stray-whitespace guard every other adapter's
// lookup uses (confirmed necessary on 8 of 3,784 lots across other
// customers' projects on 2026-10-14; treating DSM as no exception).
async function fetchMaterials(itemNumbers) {
  if (!itemNumbers.length) return new Map()
  const inList = itemNumbers.map((s) => `'${s.trim().replace(/'/g, "''")}'`).join(',')
  const rows = await runMotherDuckQuery(`
    SELECT m.material_id AS material_id, TRIM(m.lookup_code) AS item_number, m.project_id AS project_id,
           pk.packaging_id AS packaging_id
    FROM production_db.silver.datex_slv_materials m
    JOIN production_db.silver.datex_slv_materialspackagingslookup pk
      ON pk.material_id = m.material_id AND pk.is_base_packaging = true
    WHERE TRIM(m.lookup_code) IN (${inList})
      AND m.project_id IN (${DSM_PROJECT_IDS.join(',')})
  `)
  const map = new Map()
  for (const r of rows) map.set(r.item_number, r)
  return map
}

// Looks up every lot/batch code printed on one PDF, scoped to the
// ALREADY-RESOLVED project only — never both, since a lot code's format is
// not confirmed unique across the two projects and scoping avoids ever
// silently matching the wrong one.
async function fetchLots(lotCodes, projectId) {
  if (!lotCodes.length) return new Map()
  const inList = lotCodes.map((s) => `'${s.trim().replace(/'/g, "''")}'`).join(',')
  const rows = await runMotherDuckQuery(`
    SELECT TRIM(lot.lookup_code) AS lot_code, lot.lot_id AS lot_id, lot.material_id AS material_id,
           lot.vendor_lot_id AS vendor_lot_id
    FROM production_db.silver.datex_slv_lots lot
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
    WHERE TRIM(lot.lookup_code) IN (${inList})
      AND m.project_id = ${projectId}
  `)
  const map = new Map()
  for (const r of rows) map.set(r.lot_code, r)
  return map
}

async function resolveOrderLines(parsed) {
  const lines = parsed.lines || []
  if (lines.length === 0) {
    return { ok: false, flagReason: 'No line items were extracted from this order.' }
  }

  const itemNumbers = [...new Set(lines.map((l) => (l.item_number || '').trim()).filter(Boolean))]
  const materialsByItem = await fetchMaterials(itemNumbers)

  // ── Step 1: resolve the project from the item numbers (unanimous vote) ──
  const projectIdsSeen = new Set()
  const unresolvedItems = []
  for (const line of lines) {
    const material = materialsByItem.get((line.item_number || '').trim())
    if (!material) { unresolvedItems.push(line.item_number); continue }
    projectIdsSeen.add(material.project_id)
  }
  if (unresolvedItems.length) {
    return {
      ok: false,
      flagReason: `Could not resolve item number(s) to a material in either DSM project (DSMEN5/DSMFO8): ${[...new Set(unresolvedItems)].join(', ')}.`,
    }
  }
  if (projectIdsSeen.size > 1) {
    return {
      ok: false,
      flagReason: `This order's lines resolve to more than one DSM project (both DSMEN5 and DSMFO8 matched) — a single order should not mix enzymes and cultures. Flagged for manual entry.`,
    }
  }

  const resolvedProjectId = [...projectIdsSeen][0]
  const projectEntry = Object.entries(DSM_PROJECTS).find(([, p]) => p.id === resolvedProjectId)
  const projectCode = projectEntry ? projectEntry[0] : null
  const ownerId = projectEntry ? projectEntry[1].ownerId : null

  // ── Step 2: resolve each line's lot, scoped to the now-known project ────
  const lotCodes = [...new Set(lines.map((l) => (l.lot_code || '').trim()).filter(Boolean))]
  const lotsByCode = await fetchLots(lotCodes, resolvedProjectId)

  const resolvedLines = []
  const unresolvedLots = []
  for (const line of lines) {
    const material = materialsByItem.get((line.item_number || '').trim())
    const lotCode = (line.lot_code || '').trim()
    const lot = lotCode ? lotsByCode.get(lotCode) : null
    if (!lot) {
      unresolvedLots.push(lotCode ? lotCode : `(no lot printed for item ${line.item_number})`)
      resolvedLines.push({
        ...line,
        line_status: 'missing_lp',
        resolved_material_id: material.material_id,
        resolved_material_code: material.item_number,
        resolved_packaging_id: material.packaging_id,
      })
      continue
    }
    if (lot.material_id !== material.material_id) {
      unresolvedLots.push(`${lotCode} (belongs to a different material in Datex than the one printed with it)`)
      resolvedLines.push({
        ...line,
        line_status: 'missing_lp',
        resolved_material_id: material.material_id,
        resolved_material_code: material.item_number,
        resolved_packaging_id: material.packaging_id,
      })
      continue
    }
    resolvedLines.push({
      ...line,
      line_status: 'resolved',
      storage_lot: lotCode,
      resolved_material_id: material.material_id,
      resolved_material_code: material.item_number,
      resolved_packaging_id: material.packaging_id,
      resolved_lot_id: lot.lot_id,
      resolved_vendor_lot_id: lot.vendor_lot_id,
    })
  }

  if (unresolvedLots.length) {
    return {
      ok: false,
      resolvedLines,
      projectCode,
      flagReason: `Could not resolve lot/batch code(s) against Datex for project ${projectCode}: ${[...new Set(unresolvedLots)].join(', ')}.`,
    }
  }

  return {
    ok: true,
    resolvedLines,
    projectCode,
    ownerId,
    resolvedProjectId,
    successNote: `Resolved to project ${projectCode}.`,
  }
}

function buildOrderHeader(parsed, resolution) {
  return {
    project_id: resolution.resolvedProjectId,
    warehouse_id: KENOSHA_WAREHOUSE_ID,
    order_class_id: DSM_ORDER_CLASS_ID,
    lookup_code: zeroPad10(parsed.delivery_number),
    owner_reference: zeroPad10(parsed.shipment_id_number),
    vendor_reference: zeroPad10(parsed.shipment_id_number),
    order_notes: parsed.your_po_number || null,
    carrier_id: null, // not printed on either real sample seen so far — see file header note
    expected_date: parsed.delivery_date || null,
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
    vendor_lot_id: line.resolved_vendor_lot_id,
  }
}

module.exports = {
  customerCode: 'dsm',
  domains: ['dsm-firmenich.com'],
  resolveOrderLines,
  buildOrderHeader,
  buildLinePayload,
  DSM_PROJECTS,
  KENOSHA_WAREHOUSE_ID,
}
