import { useState } from 'react'
import AttendancePointsTab from '../components/hr/AttendancePointsTab.jsx'

// HR — new top-level tab added 2026-08-02, sitting between Manager and
// Settings. Structured as a tab row (like Settings.jsx) so future HR
// tools land here as additional sub-tabs without another top-level nav
// entry. Only one sub-tab exists today.

const TABS = [
  { id: 'attendance', label: 'Attendance Points' },
]

export default function Hr() {
  const [activeTab, setActiveTab] = useState('attendance')

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">HR</div>
          <div className="page-subtitle">Attendance points and other HR automation tools.</div>
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
    </div>
  )
}
