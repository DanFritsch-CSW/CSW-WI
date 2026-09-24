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

// Fallback per-case weight (lbs), used ONLY for line items whose material
// isn't in the live weight map yet — either dpi-material-weights.cjs
// hasn't returned yet, or (rare) the material genuinely isn't in this
// facility's Datex catalog. Real weight for everything else comes from
// agencyTotalWeight below. FIXED 2026-09-24 (A7): this constant used to be
// the ONLY weight source for every line, always — that's what produced
// Jen's original report (her route showed 41,000 lbs in Datex vs 37,575
// lbs here), and it was also worse than her report implied: this wasn't
// "reading the wrong CSV column," the CSV's own weight column was never
// used for order creation at all (see dpiMonthlyParser.js's header). Real
// weight now comes from production_db.silver.datex_slv_materialspackagingslookup
// via netlify/functions/dpi-material-weights.cjs, confirmed live to be
// off from real gross weight by roughly the same margin as Jen's report.
export const FALLBACK_LBS_PER_CASE = 25

export const CAPACITY_LBS_LIMIT = 40000
export const CAPACITY_CASES_LIMIT = 1700

export function agencyTotalCases(agency) {
  return (agency.lines || []).reduce((sum, l) => sum + (Number(l.quantity) || 0), 0)
}

// Real gross weight (Datex shipping_weight = Weight + tare_weight — the
// physical trailer-scale number, not net product weight) for one agency,
// summed line-by-line from weightMap (keyed by trimmed materialLookupCode,
// see dpi-material-weights.cjs). Falls back to FALLBACK_LBS_PER_CASE per
// line for any material not yet in weightMap, and reports how many lines
// that happened for — callers should surface that count rather than
// silently blending real and placeholder numbers with no signal that a
// route's total isn't fully real yet.
export function agencyTotalWeight(agency, weightMap) {
  let weight = 0
  let unresolvedLines = 0
  for (const line of (agency.lines || [])) {
    const qty = Number(line.quantity) || 0
    const code = String(line.materialLookupCode || '').trim()
    const entry = weightMap ? weightMap[code] : null
    if (entry) {
      weight += qty * entry.grossWeight
    } else {
      weight += qty * FALLBACK_LBS_PER_CASE
      unresolvedLines += 1
    }
  }
  return { weight, unresolvedLines }
}
