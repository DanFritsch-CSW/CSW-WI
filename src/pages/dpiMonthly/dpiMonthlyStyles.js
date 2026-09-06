// Shared style constants across all DPI Monthly Process phase components.
// Matches the dark inline-style convention already used throughout this app.

export const colors = {
  bg: '#0f1115',
  panel: '#171a21',
  panelAlt: '#1d2129',
  border: '#2a2f3a',
  borderStrong: '#3a4150',
  text: '#e8eaed',
  textMuted: '#9aa1ad',
  textFaint: '#6b7280',
  accent: '#4d8dff',
  success: '#3ecf8e',
  successBg: 'rgba(62,207,142,0.12)',
  warning: '#e0a83e',
  warningBg: 'rgba(224,168,62,0.12)',
  danger: '#e05a4e',
  dangerBg: 'rgba(224,90,78,0.12)',
}

export const cardStyle = {
  background: colors.panel,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: '14px 16px',
}

export const buttonPrimary = {
  fontSize: 14, padding: '9px 18px', borderRadius: 7, border: 'none',
  background: colors.accent, color: '#fff', fontWeight: 500, cursor: 'pointer',
}

export const buttonSuccess = {
  fontSize: 14, padding: '9px 18px', borderRadius: 7, border: 'none',
  background: colors.success, color: '#08110c', fontWeight: 500, cursor: 'pointer',
}

// Placeholder per-case weight (lbs) used for Phase 2 capacity flags. This is
// a KNOWN SIMPLIFICATION — real weight should come from Datex materials +
// packaging lookup (silver.datex_slv_materialspackagingslookup.Weight), not
// a flat constant. Fine for a simulate-only test run; must be replaced
// before Phase 2 handles real capacity decisions.
export const PLACEHOLDER_LBS_PER_CASE = 25

export const CAPACITY_LBS_LIMIT = 40000
export const CAPACITY_CASES_LIMIT = 1700

export function agencyTotalCases(agency) {
  return (agency.lines || []).reduce((sum, l) => sum + (Number(l.quantity) || 0), 0)
}
