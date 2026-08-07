import { useState } from 'react'
import AttendancePointsTab from '../components/hr/AttendancePointsTab.jsx'
import RecruitingTab from '../components/hr/RecruitingTab.jsx'
import ThirtySixtyNinetyTab from '../components/hr/ThirtySixtyNinetyTab.jsx'
import ActiveLeaveTab from '../components/hr/ActiveLeaveTab.jsx'

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

const TABS = [
  { id: 'attendance', label: 'Attendance Points' },
  { id: 'recruiting', label: 'Recruiting' },
  { id: 'checkins', label: '30/60/90 Check-Ins' },
  { id: 'leave', label: 'Active Leave' },
]

export default function Hr() {
  const [activeTab, setActiveTab] = useState('attendance')

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">HR</div>
          <div className="page-subtitle">Attendance points, recruiting, 30/60/90 check-ins, leave tracking, and other HR automation tools.</div>
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

      {activeTab === 'attendance' && <AttendancePointsTab />}
      {activeTab === 'recruiting' && <RecruitingTab />}
      {activeTab === 'checkins' && <ThirtySixtyNinetyTab />}
      {activeTab === 'leave' && <ActiveLeaveTab />}
    </div>
  )
}
