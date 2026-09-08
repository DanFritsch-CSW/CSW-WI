'use strict'

// Single source of truth for Customer Shortage Report customer/project
// configs. Added 2026-09-01 when Sargento (Caledonia) was added alongside
// Pretzilla (Kenosha) — per Dan's explicit direction: "mimic Sargento
// just as Pretzilla -- any future additions will probably be for all
// customers," meaning new customers reuse the SAME report shape and
// SAME backend logic, just a new config entry here. Both
// motherduck-shortage-report.cjs (material table data) and
// lib/shortage-report-email-shared.cjs (email draft) import from this
// one file so they can never drift out of sync with each other.
//
// To add a new customer: add an entry below with its warehouseId,
// Datex project_id(s), and the appointment-name tag Datex/scheduling uses
// to mark that customer's appointments (confirmed live per-customer, not
// guessed — e.g. Pretzilla's is '(PZ)', Sargento's is '(SARG)', Pedone's
// is '(PP)', all seen directly in
// silver.datex_slv_dockappointments.lookup_code). Nothing
// else needs to change — the query logic in both consuming files is
// entirely parameterized off this config.
//
// KNOWN GAP, confirmed live 2026-09-08 (Pedone added): the Not-Linked
// order-number extraction regex (extractOrderNumbers in both
// motherduck-shortage-report.cjs and shortage-report-email-shared.cjs)
// requires 6+ digits. Pretzilla and Sargento's order numbers always met
// that; Pedone's don't always — confirmed live that appointments like
// "(PP) ELK GROVE VILLAGE 978" reference REAL orders (order_ids 767534,
// 767533, 776741 for lookup_codes 978/979/867) that are too short to
// extract, so they currently fall through to "No Order Within Datex" and
// contribute nothing to Needed, even though they're real. Left unfixed
// for now — lowering the digit minimum broadly risks false-positive
// matches on incidental short numbers in other customers' appointment
// text (dock numbers, case counts, etc.) that were never a problem at
// 6+ digits. Revisit if this proves to be a meaningful Needed gap for
// Pedone specifically.

const REPORT_CONFIGS = {
  pretzilla_ken: {
    display: 'Pretzilla — Kenosha',
    warehouseId: 5,
    projectIds: [230, 342], // PRETZ5 + PRTZL5/COOLER
    apptTag: '(PZ)',
  },
  sargento_cal: {
    display: 'Sargento — Caledonia',
    warehouseId: 1,
    projectIds: [234], // Sargento Cheese Inc-Caledonia
    apptTag: '(SARG)',
  },
  pedone_ken: {
    display: 'Pedone Pinsa — Kenosha',
    warehouseId: 5,
    projectIds: [357], // Pedone Pinsa
    apptTag: '(PP)',
  },
}

module.exports = { REPORT_CONFIGS }
