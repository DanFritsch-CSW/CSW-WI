// DPI Monthly — Phase 1 Datex Excel Import export.
//
// Builds Datex's own "ExcelOrderImport" grid-component format directly
// from staged agencies, so a human can review the file and run Datex's
// native Excel import themselves — instead of this app calling Datex's
// SmartUp API directly.
//
// 2026-10-28: Phase 1's live API push (dpi-import-push-background.cjs /
// dpi-monthly-shared.cjs) is PAUSED per Dan — repeated test-cycle resets
// were creating duplicate REAL Datex orders under the same deterministic
// lookup code. Root cause: the existing dedup check
// (getExistingLookupCodes in dpi-monthly-shared.cjs) queries Datex's own
// live API before every push, but Datex's API has read-after-write lag —
// a reset-and-rerun seconds/minutes later doesn't see the previous run's
// just-created order yet, so the check passes and a duplicate gets
// created. Those duplicate orders have since been cancelled/deleted in
// Datex by Dan. Until the API path is revisited (fix would be checking
// against this app's own Supabase tracking, not just Datex's API — no
// lag there), Phase 1 generates this file instead. Nothing in this
// module calls Datex. The old push function/shared lib are left
// untouched in case this gets re-enabled later.
//
// Column order/names below are copied EXACTLY from Datex's own
// "ExcelOrderImport_excel_order_import_gridComponent_export" template
// (120 columns, confirmed 2026-10-28 against a real export Dan provided)
// — do not reorder/rename without re-checking against a fresh export from
// Datex, since the import grid most likely matches by column position
// and/or header name.
//
// Facility constants (Warehouse/ProjectLookupCode/CarrierName/
// OwnerLookupCode) are the TEXT lookup values Datex's Excel import
// expects — confirmed directly against Datex's own tables via MotherDuck
// 2026-10-28 (production_db.bronze.datex_projects / datex_carriers /
// datex_owners), not guessed:
//   Eau Claire: project lookup code DPI2, carrier "ECHO BROOK"
//   Madison:    project lookup code DPI1, carrier "J&J"
//   Owner (both facilities): DPI0 (Department of Public Instruction)
// Mirrors netlify/functions/lib/dpi-monthly-shared.cjs's FACILITIES map,
// which uses numeric Datex IDs for the (now-paused) API path — same
// facilities, different value shape, because the Excel import grid takes
// human-readable lookup codes/names, not internal IDs.
//
// Known gaps, left blank — confirmed with Dan 2026-10-28, not blocking:
//   - Billing address: this template has no distinct billing-address
//     columns at all (only one address block). The API path explicitly
//     mirrors billing_address = shipping_address (Dan's direction,
//     2026-09-29). Unconfirmed whether Datex's Excel import does this
//     automatically on import — needs a live test.
//   - Expected/requested delivery date: no column for this in the
//     template either. The API path sets this to the last day of the
//     delivery month (lastDayOfMonth() in DpiMonthlyProcess.jsx).
//   - Cost/Price, lot/serial fields, weight/dimension fields, LastName,
//     Line2, phone/email/attention, PO identifier, tracking, UDFs: not
//     set by the current API path either, so leaving these blank isn't a
//     regression — just genuinely no source data for them yet.

import * as XLSX from 'xlsx'

export const FACILITY_EXPORT_CONFIG = {
  'Eau Claire': { warehouse: 'CSW-Eau Claire', projectLookupCode: 'DPI2', carrierName: 'ECHO BROOK', ownerLookupCode: 'DPI0' },
  'Madison':    { warehouse: 'CSW-Madison',    projectLookupCode: 'DPI1', carrierName: 'J&J',         ownerLookupCode: 'DPI0' },
}

const PACKAGING = 'CS' // matches packaging_id 3 ("CS") used by the (paused) API path — same constant, both facilities
const ORDER_TYPE = 'Outbound'

// Fixed columns (45) in Datex's exact order, then 25 UDF triples (75 more
// columns = 120 total). Generating the UDF block rather than hand-typing
// 75 column names, to avoid a transcription typo breaking Datex's import
// matching.
const FIXED_COLUMNS = [
  'Type', 'OrderLookupCode', 'VendorReference', 'OwnerReference', 'Warehouse', 'ProjectLookupCode',
  'MaterialLookupCode', 'Packaging', 'Quantity', 'Cost', 'Price', 'LotLookupCode', 'VendorLotLookupCode',
  'VendorLotManufactureDate', 'VendorLotExpirationDate', 'LicensePlateLookupCode', 'SerialNumberLookupCode',
  'NetWeight', 'GrossWeight', 'WeightUom', 'Length', 'Width', 'Height', 'DimensionUom',
  'FirstName', 'LastName', 'Line1', 'Line2', 'City', 'State', 'Zip', 'Country',
  'PhoneNumber', 'PaymentAccount', 'LineNotes', 'PurchaseOrderIdentifier',
  'CarrierName', 'CarrierServiceTypeName', 'TrackingNumber', 'TransportMode', 'ShipmentPaymentTermName',
  'Notes', 'Email', 'Attention', 'OwnerLookupCode',
]

const UDF_COLUMNS = Array.from({ length: 25 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0')
  return [`UDF${n}Name`, `UDF${n}Value`, `UDF${n}Entity`]
}).flat()

export const DATEX_IMPORT_HEADER = [...FIXED_COLUMNS, ...UDF_COLUMNS]

function buildRow(agency, line, facility) {
  const cfg = FACILITY_EXPORT_CONFIG[facility]
  const values = {
    Type: ORDER_TYPE,
    OrderLookupCode: agency.lookupCode,
    VendorReference: agency.lookupCode,
    OwnerReference: agency.lookupCode,
    Warehouse: cfg.warehouse,
    ProjectLookupCode: cfg.projectLookupCode,
    MaterialLookupCode: line.materialLookupCode,
    Packaging: PACKAGING,
    Quantity: line.quantity,
    FirstName: agency.firstName,
    Line1: agency.line1 || '',
    City: agency.city || '',
    State: agency.state || '',
    Zip: agency.postalCode || '',
    Country: 'US',
    CarrierName: cfg.carrierName,
    OwnerLookupCode: cfg.ownerLookupCode,
  }
  return DATEX_IMPORT_HEADER.map((col) => (col in values ? values[col] : ''))
}

/**
 * agencies: same shape as DpiMonthlyProcess.jsx's `agencies` state
 * (rowToAgency output / dpiMonthlyParser's parseFdp201w output) — each
 * with { lookupCode, firstName, line1, city, state, postalCode,
 * lines: [{ materialLookupCode, quantity }] }.
 */
export function buildDatexImportRows(agencies, facility) {
  const rows = []
  for (const agency of agencies) {
    for (const line of agency.lines) {
      rows.push(buildRow(agency, line, facility))
    }
  }
  return rows
}

export function buildDatexImportWorkbook(agencies, facility) {
  const aoa = [DATEX_IMPORT_HEADER, ...buildDatexImportRows(agencies, facility)]
  const sheet = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'OrderImport')
  return wb
}

/** Triggers a browser download. Returns the filename used. */
export function downloadDatexImportFile(agencies, facility, monthKey) {
  const wb = buildDatexImportWorkbook(agencies, facility)
  const facilitySlug = facility.replace(/\s+/g, '')
  const filename = `DPI_${monthKey}_${facilitySlug}_DatexImport.xlsx`
  XLSX.writeFile(wb, filename)
  return filename
}
