import { useSearchParams } from 'react-router-dom'
import SpacePlanningTab from '../components/customers/SpacePlanningTab.jsx'
import OnboardingTab from '../components/customers/OnboardingTab.jsx'
import DvrTab from '../components/customers/DvrTab.jsx'
import FefoRotationTab from '../components/customers/FefoRotationTab.jsx'
import ExpCheckTab from '../components/customers/ExpCheckTab.jsx'
import CustomerShortageReportTab from '../components/customers/CustomerShortageReportTab.jsx'
import ScorecardDraftsTab from '../components/customers/ScorecardDraftsTab.jsx'
import PviShortageTab from '../components/customers/PviShortageTab.jsx'
import PviShelfLife from './PviShelfLife.jsx'
import { PALERMOS_LOGO } from '../lib/palermos-logo.js'

// Customers module — sub-tabs sharing a common header + tab row.
// Sub-tab state lives in URL (?tab=...) so links are shareable and
// refresh-safe, matching the rest of the app's URL-as-state pattern.
//
// Tab order:
//   LoadProof / DVRS → FEFO Rotation → EXP Check (Pretzilla) →
//   Customer Shortage Report → Scorecard Drafts → PVI At Risk Inventory →
//   Space Planning → PVI Shortage Report → Customer Onboarding
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
//
// EXP Check (Pretzilla) tab added 2026-08-02, per Front conversation
// cnv_186hmlg4 (Pretzilla Lots and Expiration Dates) — Julian/manufacture
// date entry errors keep slipping through to closed receipts. This is a
// math-reconciliation view only (EXP vs MFG + shelf life); it does not
// catch an internally-consistent misread manufacture date — see
// netlify/functions/motherduck-exp-check.cjs for exactly what it covers.
//
// Pretzilla Shortage Report tab added 2026-08-31, per Dan's ask (Fathom
// "Pretzilla Daily" call) — automates the team's daily hand-built shortage
// Excel (Pretzilla_Template.xlsx). Kenosha only (project_ids 230, 342) for
// now; validated live against the team's actual 09/01 Excel before this
// tab was built (6/7 materials matched exactly, one real false-shortage in
// the manual sheet caught and explained). Currently VALIDATION MODE — no
// Excel export or Front send yet, visible so Dan can compare it against
// the manual sheet daily before handing off to the CSR team. See
// netlify/functions/motherduck-pretzilla-shortage.cjs for the full design
// writeup (demand join, inventory pull, Short formula). Nav label + in-tab
// header/subtitle genericized to "Customer Shortage Report" / "Shortage
// Report" the same day, per Dan's request — the underlying tool/route id
// ('pretzillashortage') and its Kenosha/Pretzilla scope are unchanged,
// only the visible text, ahead of eventually tying in other customers the
// same way FEFO Rotation already covers multiple customers/projects.
// Demand logic also simplified the same day to appointments-only (dropped
// the requested_delivery_date cross-check/"needs review" concept) per
// Dan's explicit ask — see the backend function's header for detail.
//
// GENERALIZED 2026-09-01 (later same day) into a dropdown-driven,
// multi-customer container per Dan's ask: "mimic Sargento just as
// Pretzilla -- any future additions will probably be for all customers"
// + "My imagination thinks it would have a dropdown project indicator
// (similar to the FEFO tab)... it would render blank at first." This tab
// now renders CustomerShortageReportTab.jsx (a small dropdown wrapper,
// blank by default, mirrors FEFO's ProjectSelect pattern) instead of
// PretzillaShortageTab directly. PretzillaShortageTab.jsx itself is
// unchanged in name (kept for continuity) but now accepts {reportKey,
// reportLabel} props and renders whichever customer the dropdown
// selects — Sargento (Caledonia) joined Pretzilla (Kenosha) the same
// shape, same backend logic, scoped via
// netlify/functions/lib/shortage-report-configs.cjs.
//
// Scorecard Drafts tab added 2026-08-06, per Dan's ask: "build the tab
// within the UI so that I can see and test the prompt." Bernatello's-only
// pilot — view/edit the per-customer prompt style, toggle active, and run
// a real (not dry-run) test draft against a known Front conversation. See
// components/customers/ScorecardDraftsTab.jsx and
// netlify/functions/lib/scorecard-draft-shared.cjs for the full design.
//
// PVI Shortage Report tab added 2026-08-28, per Dan's ask — replaces the
// old Omni-based Palermo's PVI shortage sheet (Front cnv_1c79gvh0, Katie
// Sobieski's original request) entirely. Moved out of Omni because the
// new join/exclusion logic needed for that request hit a hard wall in
// Omni's model layer (a hand-pasted Advanced SQL version failed with
// "could not run this query in this context" — root cause was a modeled
// field reference, ${silver_datex_slv_tasks.effective_material_id}, that
// only resolves inside Omni's own topic context). This is currently
// VIEW ONLY — no Excel export or Front send yet; that's the next step
// once the open items in the tab's own banner are confirmed with
// Hill/Katie. See netlify/functions/motherduck-pvi-shortage.cjs for the
// full design writeup.
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
    id: 'expcheck',
    label: 'EXP Check',
    subtitle: 'Pretzilla · EXP date vs. manufacture date + shelf life reconciliation',
  },
  {
    id: 'pretzillashortage',
    label: 'Customer Shortage Report',
    subtitle: 'Appointment-scheduled orders vs. available inventory · live from MotherDuck',
  },
  {
    id: 'scorecard',
    label: 'Scorecard Drafts',
    subtitle: "Bernatello's pilot · view/edit the AI draft prompt, toggle active, run a test draft",
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
    id: 'pvishortage',
    label: 'PVI Shortage Report',
    subtitle: "Palermo's CALEDONIA finished · rebuilt off Omni, direct from MotherDuck",
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
        {subTab === 'dvr'               && <DvrTab />}
        {subTab === 'fefo'              && <FefoRotationTab />}
        {subTab === 'expcheck'          && <ExpCheckTab />}
        {subTab === 'pretzillashortage' && <CustomerShortageReportTab />}
        {subTab === 'scorecard'         && <ScorecardDraftsTab />}
        {subTab === 'pvi'               && <PviShelfLife />}
        {subTab === 'space'             && <SpacePlanningTab />}
        {subTab === 'pvishortage'       && <PviShortageTab />}
        {subTab === 'onboarding'        && <OnboardingTab />}
      </div>
    </div>
  )
}
