import { useSearchParams } from 'react-router-dom'
import SpacePlanningTab from '../components/customers/SpacePlanningTab.jsx'
import OnboardingTab from '../components/customers/OnboardingTab.jsx'
import DvrTab from '../components/customers/DvrTab.jsx'
import FefoRotationTab from '../components/customers/FefoRotationTab.jsx'
import PviShelfLife from './PviShelfLife.jsx'
import { PALERMOS_LOGO } from '../lib/palermos-logo.js'

// Customers module — sub-tabs sharing a common header + tab row.
// Sub-tab state lives in URL (?tab=...) so links are shareable and
// refresh-safe, matching the rest of the app's URL-as-state pattern.
//
// Tab order:
//   LoadProof / DVRS → FEFO Rotation → PVI At Risk Inventory →
//   Space Planning → Customer Onboarding
//
// LoadProof / DVRS tab (2026-07-10): multi-facility DVR incident tracker
// for Caledonia and Kenosha. Seeded with last-30-day open incidents from
// the INV CTRL DVRS Excel exports. Will switch to a live Supabase query
// once the LoadProof → Zapier → Supabase pipeline is activated.
//
// PVI tab rename (2026-07-07, Hill Slack 9:12 AM): "change the app title
// to Palermo's At Risk Inventory Manager."
//
// Revisions sub-tab removed 2026-07-24 per Dan's request (front-end +
// nav entry point removed; the backing files/schema/netlify.toml entry
// still need manual cleanup — see the corresponding changelog entry).
const SUB_TABS = [
  {
    id: 'dvr',
    label: 'LoadProof / DVRS',
    subtitle: 'Open DVR incidents · Caledonia & Kenosha · last 30 days',
  },
  {
    id: 'fefo',
    label: 'FEFO Rotation',
    subtitle: 'Pre-ship FEFO rotation verification · live from Datex / Omni',
  },
  {
    id: 'pvi',
    label: 'PVI At Risk Inventory',
    subtitle: "Palermo's At Risk Inventory Manager · per-lot disposition & owner tracking",
  },
  {
    id: 'space',
    label: 'Space Planning',
    subtitle: 'Space planning, allocations & utilization across the network',
  },
  {
    id: 'onboarding',
    label: 'Customer Onboarding',
    subtitle: 'New-customer onboarding checklist · single source of truth',
  },
]

export default function Customers() {
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const subTab = SUB_TABS.find(t => t.id === rawTab)?.id || 'dvr'
  const activeTab = SUB_TABS.find(t => t.id === subTab)

  const handleTabClick = (id) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', id)
    setSearchParams(next)
  }

  return (
    <div className="page-content">
      {/* Page header */}
      <div style={{ padding: '20px 24px 0', display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{
            fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '0.02em',
            textTransform: 'uppercase', color: 'var(--text-primary)',
          }}>
            Customers
          </h1>
          <p style={{
            margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          }}>
            {activeTab.subtitle}
          </p>
        </div>
        {subTab === 'pvi' && (
          <img
            src={PALERMOS_LOGO}
            alt="Palermo's"
            style={{ height: 40, width: 'auto', display: 'block', flexShrink: 0 }}
          />
        )}
      </div>

      {/* Sub-tab row */}
      <div style={{
        display: 'flex', gap: 4, padding: '16px 24px 0',
        borderBottom: '1px solid var(--border)',
        overflowX: 'auto',
      }}>
        {SUB_TABS.map(t => {
          const isActive = t.id === subTab
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => handleTabClick(t.id)}
              style={{
                padding: '8px 16px',
                background: isActive ? 'var(--brand-bg, #fef9ec)' : 'transparent',
                border: 'none',
                borderBottom: isActive
                  ? '2px solid var(--brand, #a07818)'
                  : '2px solid transparent',
                color: isActive ? 'var(--brand, #a07818)' : 'var(--text-secondary)',
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                cursor: 'pointer',
                marginBottom: -1,
                whiteSpace: 'nowrap',
                transition: 'color 0.15s ease, background 0.15s ease',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Sub-tab content */}
      <div style={{ padding: '24px' }}>
        {subTab === 'dvr'        && <DvrTab />}
        {subTab === 'fefo'       && <FefoRotationTab />}
        {subTab === 'pvi'        && <PviShelfLife />}
        {subTab === 'space'      && <SpacePlanningTab />}
        {subTab === 'onboarding' && <OnboardingTab />}
      </div>
    </div>
  )
}
