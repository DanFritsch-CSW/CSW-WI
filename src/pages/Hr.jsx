import { useState } from 'react'
import AttendancePointsTab from '../components/hr/AttendancePointsTab.jsx'
import RecruitingTab from '../components/hr/RecruitingTab.jsx'

// HR — top-level tab (added 2026-08-02). Structured as a tab row (like
// Settings.jsx) so future HR tools land here as additional sub-tabs
// without another top-level nav entry. Recruiting moved in from its own
// standalone /recruiting tab (2026-08-02, same session Takt took over
// Recruiting's old top-level nav slot) — inherits this page's
// HrPasswordGate instead of its own RecruitingPasswordGate.

const TABS = [
  { id: 'attendance', label: 'Attendance Points' },
  { id: 'recruiting', label: 'Recruiting' },
]

export default function Hr() {
  const [activeTab, setActiveTab] = useState('attendance')

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">HR</div>
          <div className="page-subtitle">Attendance points, recruiting, and other HR automation tools.</div>
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
    </div>
  )
}
