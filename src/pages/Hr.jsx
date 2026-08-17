import { useState } from 'react'
import RecruitingTab from '../components/hr/RecruitingTab.jsx'
import ThirtySixtyNinetyTab from '../components/hr/ThirtySixtyNinetyTab.jsx'
import ActiveLeaveTab from '../components/hr/ActiveLeaveTab.jsx'
import DisciplinaryTab from '../components/hr/DisciplinaryTab.jsx'
import ReferralBonusTab from '../components/hr/ReferralBonusTab.jsx'
import CoachingTab from '../components/hr/CoachingTab.jsx'

// HR — top-level tab (added 2026-08-02). Structured as a tab row (like
// Settings.jsx) so future HR tools land here as additional sub-tabs
// without another top-level nav entry. Recruiting moved in from its own
// standalone /recruiting tab (2026-08-02, same session Takt took over
// Recruiting's old top-level nav slot) — inherits this page's
// HrPasswordGate instead of its own RecruitingPasswordGate.
//
// 2026-08-07 — 30/60/90 Check-Ins added as a third sub-tab, per Dan/Tim's
// HR Functions to AI call. Separate from the Employee Onboarding module's
// trainer curriculum (day30/60/90_review_conducted) — this tracks HR's
// new-hire follow-up calls (Maria/Amy) + benefits enrollment.
//
// 2026-08-07 (later) — Active Leave Tracker added as a fourth sub-tab.
// Covers FMLA, STD, Workman's Comp, LOA, and other leave types — 7 sheets
// with genuinely different schemas in the source workbook, confirmed live
// before writing parsers. Most sensitive HR data in the app so far
// (medical/legal details) — this is the tracker Tim specifically flagged
// as needing a stronger password than the app's other gates.
//
// 2026-08-07 (later still) — Disciplinary Action Tracker added as a fifth
// sub-tab. 3 sheets: Attendance Write-Ups, Misconduct, PIPs, each with its
// own step progression derived from which "mark" column is set (X).
//
// 2026-08-07 (later still) — Referral Bonus Tracker added as a sixth
// sub-tab. Single sheet, simplest of the batch — $200 at 90 days, $300 at
// 1 year, per-milestone "Mark Paid" action. This completes the tracker
// list from Dan/Tim's original HR call, aside from EEOC/Legal and
// Workman's Comp (no file link provided) and the survey response files.
//
// 2026-08-14 — "HR dashboard connect" call: Attendance Points, formerly its
// own top-level sub-tab here, was merged INTO the Disciplinary Action tab
// as a 4th internal view (Tim/Maria/Amy felt points and write-ups belong
// together conceptually). Page went from 6 sub-tabs to 5 — see
// DisciplinaryTab.jsx for the merged Attendance Points view.
//
// 2026-08-17 — Coaching added as a sixth sub-tab. This is Tim Morris's own
// prototype (built with Claude, sent via Front cnv_1c58erkk) — a manager
// coaching log (Lines of Effort, session recaps, homework) fed by a
// separate SharePoint workbook, wrapped the same way as every other
// tracker (CoachingTab.jsx -> sharepoint-coaching.cjs). Read-only by
// design — edits happen in Excel or by asking Claude to process a Fathom
// transcript, not through this dashboard. BLOCKED on Tim confirming
// whether the workbook is on SharePoint yet.

const TABS = [
  { id: 'recruiting', label: 'Recruiting' },
  { id: 'checkins', label: '30/60/90 Check-Ins' },
  { id: 'leave', label: 'Active Leave' },
  { id: 'disciplinary', label: 'Disciplinary Action' },
  { id: 'referral', label: 'Referral Bonus' },
  { id: 'coaching', label: 'Coaching' },
]

export default function Hr() {
  const [activeTab, setActiveTab] = useState('recruiting')

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">HR</div>
          <div className="page-subtitle">Recruiting, 30/60/90 check-ins, leave tracking, disciplinary action (including attendance points), referral bonuses, manager coaching, and other HR automation tools.</div>
        </div>
      </div>

      <div className="settings-tab-row">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`settings-tab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'recruiting' && <RecruitingTab />}
      {activeTab === 'checkins' && <ThirtySixtyNinetyTab />}
      {activeTab === 'leave' && <ActiveLeaveTab />}
      {activeTab === 'disciplinary' && <DisciplinaryTab />}
      {activeTab === 'referral' && <ReferralBonusTab />}
      {activeTab === 'coaching' && <CoachingTab />}
    </div>
  )
}
