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
// guessed — e.g. Pretzilla's is '(PZ)', Sargento's is '(SARG)', both seen
// directly in silver.datex_slv_dockappointments.lookup_code). Nothing
// else needs to change — the query logic in both consuming files is
// entirely parameterized off this config.

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
}

module.exports = { REPORT_CONFIGS }
