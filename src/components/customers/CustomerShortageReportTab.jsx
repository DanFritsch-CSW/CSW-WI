import { useState } from 'react'
import PretzillaShortageTab from './PretzillaShortageTab.jsx'

// Customer Shortage Report — dropdown container. Added 2026-09-01 per
// Dan's ask: "My imagination thinks it would have a dropdown project
// indicator (similar to the FEFO tab) -- it would render blank at first
// then select the project that we determine available for the Customer
// Shortage Report." Mirrors FEFO Rotation's ProjectSelect <select>
// pattern (src/components/customers/FefoRotationTab.jsx), but starts
// blank rather than defaulting to an "All" option — there's no
// cross-customer aggregate view here since each customer's report is its
// own independent query/shape, unlike FEFO where "All Projects" is a
// real, meaningful selection.
//
// REPORTS list below is the frontend mirror of
// netlify/functions/lib/shortage-report-configs.cjs's REPORT_CONFIGS —
// kept as a separate small list here (not fetched) since it's just
// {key, label} pairs for the dropdown, not the full warehouse/project/
// appt-tag scope config the backend needs. Add a new customer here AND
// in shortage-report-configs.cjs when one gets built — the key must
// match exactly.

const REPORTS = [
  { key: 'pretzilla_ken', label: 'Pretzilla — Kenosha' },
  { key: 'sargento_cal', label: 'Sargento — Caledonia' },
]

const selectStyle = {
  padding: '6px 10px',
  background: 'var(--bg2, #1a1d24)',
  border: '1px solid var(--border, #2a2e38)',
  borderRadius: 6,
  color: 'var(--text-primary, #fff)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
}

export default function CustomerShortageReportTab() {
  const [selected, setSelected] = useState('')

  const report = REPORTS.find((r) => r.key === selected)

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{ margin: 0, color: 'var(--text-primary, #fff)' }}>Customer Shortage Report</h3>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          style={selectStyle}
        >
          <option value="">— Select a customer report —</option>
          {REPORTS.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
      </div>

      {!report && (
        <div style={{ color: 'var(--text-secondary, #9aa1ac)', padding: '24px 0' }}>
          Select a customer report above to view it.
        </div>
      )}

      {report && (
        // key={report.key} forces a fresh mount per selection — clears
        // stale state (targetDate reverting, in-progress edits, etc.)
        // instead of trying to reconcile one instance across customers.
        <PretzillaShortageTab key={report.key} reportKey={report.key} reportLabel={report.label} />
      )}
    </div>
  )
}
