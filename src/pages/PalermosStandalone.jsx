import PviShelfLife from './PviShelfLife.jsx'

// Palermo's standalone entry point.
//
// Rendered when Netlify builds with VITE_APP_MODE=palermos (see App.jsx).
// This build is deployed at cswpvi.netlify.app (later: a custom Palermo's
// domain). No access to the rest of the CSW app — the other routes don't
// exist in this build at all.
//
// Palermo's-branded header + subtitle so the user experience feels like
// their own product. Content area renders PviShelfLife exactly as it
// appears inside the CSW Customers tab — same component, same behavior,
// same data. Fix a bug in one place, ships to both sites automatically.
//
// Brand palette: placeholder Palermo's red (#8b1a1a). Swap for their
// official brand color once we have it. Keep the "powered by CSW" footer
// small so it doesn't compete with the Palermo's identity but stays
// discoverable if a user needs to know where the data lives.

export default function PalermosStandalone() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg0, #fafafa)', display: 'flex', flexDirection: 'column' }}>
      {/* Palermo's-branded header */}
      <div style={{
        borderBottom: '1px solid var(--border, #e5e5e5)',
        background: 'white',
        padding: '20px 32px',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{
            fontSize: 26,
            fontWeight: 700,
            margin: 0,
            letterSpacing: '0.01em',
            color: '#8b1a1a',
            textTransform: 'uppercase',
          }}>
            Palermo's Shelf Life
          </h1>
          <span style={{
            fontSize: 11,
            color: 'var(--text-dim, #888)',
            fontFamily: 'var(--font-mono, monospace)',
          }}>
            live inventory · risk snapshot
          </span>
        </div>
        <p style={{
          margin: '4px 0 0',
          fontSize: 12,
          color: 'var(--text-secondary, #666)',
          fontFamily: 'var(--font-mono, monospace)',
        }}>
          CAL lots × canonical account cutoffs — refreshed on every load
        </p>
      </div>

      {/* Content */}
      <div style={{ padding: '24px 32px', flex: 1 }}>
        <PviShelfLife />
      </div>

      {/* Footer — quiet, small print. Discoverable but not competitive with
          the Palermo's identity above. */}
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
