// Shared style constants across all DPI Monthly Process phase components.
// Maps to CSW-WI's actual design tokens (src/index.css :root) — this was
// previously an invented dark palette with no relation to the rest of the
// app; fixed 2026-09-07 per Dan's feedback that it looked out of place.
// The app itself is light-mode (var(--bg0) etc.), gold/brand accent.

export const colors = {
  bg: 'var(--bg0)',
  panel: 'var(--bg2)',
  panelAlt: 'var(--bg3)',
  border: 'var(--border)',
  borderStrong: 'var(--bg5)',
  text: 'var(--text-primary)',
  textMuted: 'var(--text-secondary)',
  textFaint: 'var(--text-dim)',
  accent: 'var(--brand)',
  accentBg: 'var(--brand-bg)',
  success: 'var(--green)',
  successBg: 'color-mix(in srgb, var(--green) 12%, white)',
  warning: 'var(--yellow)',
  warningBg: 'color-mix(in srgb, var(--yellow) 12%, white)',
  danger: 'var(--red)',
  dangerBg: 'color-mix(in srgb, var(--red) 12%, white)',
}

export const cardStyle = {
  background: colors.panel,
  border: `1px solid ${colors.border}`,
  borderRadius: 'var(--r-lg)',
  padding: '14px 16px',
}

export const buttonPrimary = {
  fontSize: 14, padding: '9px 18px', borderRadius: 'var(--r-md)', border: 'none',
  background: colors.accent, color: '#fff', fontWeight: 600, cursor: 'pointer',
}

export const buttonSuccess = {
  fontSize: 14, padding: '9px 18px', borderRadius: 'var(--r-md)', border: 'none',
  background: colors.success, color: '#fff', fontWeight: 600, cursor: 'pointer',
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
