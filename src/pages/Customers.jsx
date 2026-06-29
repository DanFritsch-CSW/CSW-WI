import { useSearchParams } from 'react-router-dom'
import SpacePlanningTab from '../components/customers/SpacePlanningTab.jsx'
import FefoRotationTab from '../components/customers/FefoRotationTab.jsx'

// Customers module — three sub-tabs sharing a common header + tab row.
// Sub-tab state lives in URL (?tab=space|onboarding|fefo) so links are
// shareable and refresh-safe, matching the rest of the app's URL-as-state
// pattern (LaborPlanning uses ?fac=&date=).
const SUB_TABS = [
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
  {
    id: 'fefo',
    label: 'FEFO Rotation',
    subtitle: 'Pre-ship FEFO rotation verification · live from Datex / Omni',
  },
]

export default function Customers() {
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const subTab = SUB_TABS.find(t => t.id === rawTab)?.id || 'space'
  const activeTab = SUB_TABS.find(t => t.id === subTab)

  const handleTabClick = (id) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', id)
    setSearchParams(next)
  }

  return (
    <div className="page-content">
      {/* Page header — title + per-sub-tab subtitle */}
      <div style={{ padding: '20px 24px 0' }}>
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

      {/* Sub-tab row */}
      <div style={{
        display: 'flex', gap: 4, padding: '16px 24px 0',
        borderBottom: '1px solid var(--border)',
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
        {subTab === 'space'      && <SpacePlanningTab />}
        {subTab === 'onboarding' && <OnboardingPlaceholder />}
        {subTab === 'fefo'       && <FefoRotationTab />}
      </div>
    </div>
  )
}

function OnboardingPlaceholder() {
  return (
    <div className="stub-page">
      <h2>Customer Onboarding</h2>
      <p>Single source of truth for onboarding new customers — master checklist + per-customer status tracking.</p>
      <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 8 }}>
        Phase 5 — schema + template + checklist UI (deferred per Dan; FEFO took priority)
      </p>
    </div>
  )
}
