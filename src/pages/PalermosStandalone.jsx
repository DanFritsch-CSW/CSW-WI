import PviShelfLife from './PviShelfLife.jsx'
import { PALERMOS_LOGO } from '../lib/palermos-logo.js'
import { CSW_BEAR_LOGO } from '../lib/csw-logo.js'

// Palermo's standalone entry point.
//
// Rendered when Netlify builds with VITE_APP_MODE=palermos (see App.jsx).
// This build is deployed at cswpvi.netlify.app (later: a custom Palermo's
// domain). No access to the rest of the CSW app — the other routes don't
// exist in this build at all.
//
// Header layout (2026-07-07, Hill request): Palermo's brand mark on the
// far left as the primary brand, "At Risk Inventory Manager" title +
// tagline in the middle, CSW polar bear brand mark on the far right so
// the co-branding is visible up front (Hill: "want the Palermo's logo
// and CSW logo side by side"). Both logos at 56px for equal visual
// weight. The "CAL lots × canonical account cutoffs" descriptor was
// removed earlier — Hill considered it visual noise on the standalone
// site. Content area renders PviShelfLife, which also owns the browser
// document.title (set to "Palermo's At Risk Inventory Manager" on mount).

export default function PalermosStandalone() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg0, #fafafa)', display: 'flex', flexDirection: 'column' }}>
      {/* Co-branded header — Palermo's | title stack | CSW */}
      <div style={{
        borderBottom: '1px solid var(--border, #e5e5e5)',
        background: 'white',
        padding: '20px 32px',
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        flexWrap: 'wrap',
      }}>
        <img
          src={PALERMOS_LOGO}
          alt="Palermo's"
          style={{ height: 56, width: 'auto', display: 'block', flexShrink: 0 }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{
              fontSize: 22,
              fontWeight: 700,
              margin: 0,
              letterSpacing: '0.02em',
              color: '#8b1a1a',
              textTransform: 'uppercase',
            }}>
              At Risk Inventory Manager
            </h1>
            <span style={{
              fontSize: 11,
              color: 'var(--text-dim, #888)',
              fontFamily: 'var(--font-mono, monospace)',
            }}>
              live inventory · risk snapshot
            </span>
          </div>
        </div>
        <img
          src={CSW_BEAR_LOGO}
          alt="Central Storage & Warehouse"
          style={{ height: 56, width: 'auto', display: 'block', flexShrink: 0 }}
        />
      </div>

      {/* Content */}
      <div style={{ padding: '24px 32px', flex: 1 }}>
        <PviShelfLife />
      </div>

      {/* Footer — quiet, small print. Kept even with the CSW logo now in the
          header for a redundant belt-and-suspenders identifier in case
          someone screenshots just the content area. */}
      <div style={{
        padding: '12px 32px 20px',
        color: 'var(--text-dim, #888)',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 10,
        textAlign: 'right',
      }}>
        powered by Central Storage &amp; Warehouse
      </div>
    </div>
  )
}
