'use strict'

// Pedone Pinsa adapter for the shared multi-customer order agent.
// Added 2026-10-14 as the third customer (after Grassland, Richelieu).
//
// WHAT THESE ORDERS ARE: a "Picking Operations" document Pedone's own
// order-management system generates per shipment, sent by email (one PDF
// per email, confirmed via real thread cnv_1chmcd5g — a teammate flagged
// it to Dan as "this is how they send them now"). CSW fulfills these as
// outbound Sales Orders (order_class_id 2, "SO" — same class every
// customer in this agent uses) out of CSW-Kenosha to the customer's own
// delivery address (Greco and Sons of Wisconsin, in the one example seen
// so far — the actual delivery address varies by order and is read off
// the PDF each time, not hardcoded).
//
// BY FAR THE SIMPLEST CUSTOMER HANDLED SO FAR — confirmed 2026-10-14
// against a real matching order already in Datex (order_id 808297,
// vendor_reference CSW/CSD/00644, matching the sample PDF exactly):
//   - NO lot-level detail at all. Every real historical line for this
//     project has lot_id null — Pedone doesn't track by lot/pallet the
//     way Grassland or Richelieu do.
//   - NO pallet/tote-to-eaches conversion. The PDF's printed "Case"
//     quantity IS the quantity to push, verbatim — confirmed matching
//     exactly across all 5 lines of the sample order.
//   - packaged_id (the packaging_id field on create_outbound_order_line)
//     is a FIXED 3 ("CS") with zero exceptions across 1,980 real lines
//     checked for this project.
//   - carrier_id is confirmed NULL across every real outbound SO for this
//     project (the PDF's "Carrier: LTL (dock)" field is Pedone's own
//     shipping-method label, not a Datex carrier record — don't push it).
//
// HEADER FIELD MAPPING (confirmed against the same real order): this is a
// THIRD distinct convention, different from both other customers —
// lookup_code = owner_reference = the customer's own "Cust PO" number
// (e.g. "317231"); vendor_reference = the "CSW/CSD/#####" code printed
// prominently at the top of the document (CSW's own internal reference
// for this shipment, not the customer's).
//
// KNOWN GAP: unlike Grassland (printed storage-lot/grand totals) and
// Richelieu (printed TOTAL TOTES line), this document has NO printed
// total to structurally cross-check extraction against — there's nothing
// on the page analogous to those other customers' self-consistency
// checks. validate() below is a no-op for that reason, not an oversight;
// extraction errors on this customer type can only be caught by
// resolution failing (e.g. an item number not resolving) or, eventually,
// a reconciliation job, not by the document validating itself.
//
// KNOWN DISCREPANCY (informational, not a blocker): the real matching
// order (808297) has a 6th line (WBF-0816-C, qty 1) that does not appear
// on the sample PDF at all — most likely a manual addition after the
// original picking document was generated, not something extraction
// needs to account for.
//
// The "All products could not be reserved — click Check Availability"
// warning seen on these documents is Pedone's own OMS reservation status
// and is explicitly NOT used by this adapter (confirmed with Dan
// 2026-10-14) — ignored entirely during extraction.

const { runMotherDuckQuery } = require('../order-agent-common.cjs')

const PEDONE_PROJECT_ID = 357 // PEDPI5 — Pedone Pinsa
const KENOSHA_WAREHOUSE_ID = 5 // CSW-Kenosha
const PEDONE_ORDER_CLASS_ID = 2 // "SO" Sales Order — same class as Grassland/Richelieu
const PEDONE_PACKAGING_ID = 3 // "CS" — confirmed fixed across 1,980 real lines, zero exceptions

// Looks up every item number printed on one PDF, scoped to the Pedone
// project only (no multi-project vote needed — this customer has one
// project, same as Richelieu).
async function fetchMaterials(itemNumbers) {
  if (!itemNumbers.length) return new Map()
  const inList = itemNumbers.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')
  const rows = await runMotherDuckQuery(`
    SELECT material_id AS material_id, lookup_code AS item_number
    FROM production_db.silver.datex_slv_materials
    WHERE project_id = ${PEDONE_PROJECT_ID}
      AND lookup_code IN (${inList})
  `)
  const map = new Map()
  for (const r of rows) map.set(r.item_number, r)
  return map
}

async function resolveOrderLines(parsed) {
  const lines = parsed.lines || []
  if (lines.length === 0) {
    return { ok: false, flagReason: 'No line items were extracted from this picking document.' }
  }

  const itemNumbers = [...new Set(lines.map((l) => l.item_number))]
  const materialsByItem = await fetchMaterials(itemNumbers)

  const resolvedLines = []
  const unresolvedItems = []

  for (const line of lines) {
    const material = materialsByItem.get(line.item_number)
    if (!material) {
      unresolvedItems.push(line.item_number)
      resolvedLines.push({ ...line, line_status: 'missing_lp' })
      continue
    }
    resolvedLines.push({
      ...line,
      line_status: 'resolved',
      item_count: line.case_quantity,
      resolved_material_id: material.material_id,
      resolved_material_code: material.item_number,
      resolved_packaging_id: PEDONE_PACKAGING_ID,
    })
  }

  const anyUnresolved = resolvedLines.some((l) => l.line_status !== 'resolved')
  if (anyUnresolved) {
    return {
      ok: false,
      resolvedLines,
      flagReason: `Could not resolve item number(s) to a material in project PEDPI5: ${[...new Set(unresolvedItems)].join(', ')}.`,
    }
  }

  // No printed total exists on this document type to cross-check against
  // (see file header note) — resolving every line to a real material is
  // the whole of what can be validated here.
  return { ok: true, resolvedLines }
}

function buildOrderHeader(parsed) {
  return {
    project_id: PEDONE_PROJECT_ID,
    warehouse_id: KENOSHA_WAREHOUSE_ID,
    order_class_id: PEDONE_ORDER_CLASS_ID,
    lookup_code: parsed.cust_po || null,
    owner_reference: parsed.cust_po || null,
    vendor_reference: parsed.csw_csd_code || null,
    order_notes: null,
    carrier_id: null, // CONFIRMED null across every real outbound SO for this project — see file header note
    expected_date: parsed.scheduled_date || null,
    shipping_address: {
      name: parsed.delivery_address?.name || null,
      line1: parsed.delivery_address?.line1 || null,
      city: parsed.delivery_address?.city || null,
      state: parsed.delivery_address?.state || null,
      postal_code: parsed.delivery_address?.zip || null,
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
  }
}

module.exports = {
  customerCode: 'pedone',
  domains: ['pedonepinsa.com'],
  resolveOrderLines,
  buildOrderHeader,
  buildLinePayload,
  PEDONE_PROJECT_ID,
  KENOSHA_WAREHOUSE_ID,
}
