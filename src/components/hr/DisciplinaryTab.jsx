import { useState, useEffect, useMemo } from 'react'

// Disciplinary Action Tracker — HR sub-tab (added 2026-08-07). Same
// conventions as the other HR sub-tabs: no page-content/page-header
// wrapper, inherits HrPasswordGate.
//
// 3 sheets: Attendance Write Up, Misconduct, PIPs — each with a different
// "step" progression (Attendance: Verbal→Written→Final→Termination;
// Misconduct: Coaching→Verbal→Written→Final→Termination; PIPs: 4-week plan
// with a pass/fail outcome). Preview fallback uses generic placeholder
// names, not real employees — same reasoning as ActiveLeaveTab.jsx.

const FN_BASE = '/.netlify/functions/sharepoint-disciplinary'

const STEP_COLOR = {
  'Coaching': 'var(--text-secondary)',
  'Verbal Warning': 'var(--blue)',
  'Verbal Warning/Coaching': 'var(--blue)',
  'Written Warning': 'var(--yellow)',
  'Final Written': 'var(--red)',
  'Termination': 'var(--red)',
}

const PREVIEW = {
  attendance: [
    { id: 'ATT-P1', name: 'Employee A', location: 'CAL', shift: '2nd', step: 'Written Warning', hrSentDate: '—', b2eStatus: '—', rowIndex: 2, _colMap: {} },
    { id: 'ATT-P2', name: 'Employee B', location: 'KEN', shift: '1st', step: 'Verbal Warning/Coaching', hrSentDate: '—', b2eStatus: '—', rowIndex: 3, _colMap: {} },
  ],
  misconduct: [
    { id: 'MIS-P1', name: 'Employee C', location: 'WR', shift: '1st', step: 'Final Written', gmSentBack: '—', b2eStatus: '—', rowIndex: 2, _colMap: {} },
  ],
  pips: [
    { id: 'PIP-P1', name: 'Employee D', site: 'MAD', shifts: '2nd', startDate: '—', weeks: ['X', 'X', '', ''], result: '', endDate: '', uploadedB2E: false, notes: 'In progress' },
  ],
}

const TABS = [
  { key: 'attendance', label: 'Attendance Write-Ups' },
  { key: 'misconduct', label: 'Misconduct' },
  { key: 'pips', label: 'PIPs' },
]

async function fetchTab(tab) {
  const res = await fetch(`${FN_BASE}?tab=${tab}`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export default function DisciplinaryTab() {
  const [activeType, setActiveType] = useState('attendance')
  const [records, setRecords] = useState(null)
  const [live, setLive] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setRecords(null)
    fetchTab(activeType)
      .then((d) => {
        if (cancelled) return
        setRecords(d.records)
        setLive(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setRecords(PREVIEW[activeType] || [])
        setLive(false)
      })
    return () => { cancelled = true }
  }, [activeType])

  const terminationCount = useMemo(
    () => (activeType !== 'pips' && records ? records.filter((r) => r.step === 'Termination').length : 0),
    [records, activeType]
  )

  return (
    <div style={{ marginTop: 16 }}>
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <div className="page-subtitle">Attendance write-ups, misconduct escalations, and performance improvement plans</div>
        </div>
      </div>

      {!live && records !== null && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">
            Preview data (placeholder — not real employee info) — SharePoint connection not yet configured{error ? ` (${error})` : ''}. Add
            {' '}<code>SHAREPOINT_DISCIPLINARY_URL</code> in Netlify env vars to go live.
          </span>
        </div>
      )}

      <div className="settings-tab-row" style={{ marginTop: 0 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`settings-tab${activeType === t.key ? ' active' : ''}`}
            onClick={() => setActiveType(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeType !== 'pips' && records && (
        <div className="kpi-row">
          <div className="kpill">
            <span className="kpill-label">Records</span>
            <span className="kpill-value">{records.length}</span>
          </div>
          <div className="kpill">
            <span className="kpill-label">Terminations</span>
            <span className="kpill-value" style={{ color: 'var(--red)' }}>{terminationCount}</span>
          </div>
        </div>
      )}

      {records === null ? (
        <div className="stub-page" style={{ opacity: 0.6 }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</p>
        </div>
      ) : activeType === 'pips' ? (
        <PipsTable records={records} />
      ) : (
        <StepTable records={records} type={activeType} />
      )}
    </div>
  )
}

function StepTable({ records, type }) {
  if (records.length === 0) return <div className="appt-list-empty">No records on this tab.</div>
  return (
    <div className="appt-list-section">
      <div className="appt-list-body">
        <table className="appt-list-table">
          <thead>
            <tr>
              <th>Name</th><th>Location</th><th>Shift</th><th>Step</th>
              <th>{type === 'misconduct' ? 'GM Sent Back to HR' : 'HR Sent to GMs'}</th><th>B2E Status</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                <td>{r.location}</td>
                <td>{r.shift}</td>
                <td>
                  {r.step ? (
                    <span className="appt-list-type-badge" style={{ background: 'transparent', border: `1px solid ${STEP_COLOR[r.step] || 'var(--text-dim)'}`, color: STEP_COLOR[r.step] || 'var(--text-dim)' }}>
                      {r.step}
                    </span>
                  ) : '—'}
                </td>
                <td className="appt-list-mono">{type === 'misconduct' ? r.gmSentBack : r.hrSentDate}</td>
                <td className="appt-list-col-notes">{r.b2eStatus || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PipsTable({ records }) {
  if (records.length === 0) return <div className="appt-list-empty">No active PIPs.</div>
  return (
    <div className="appt-list-section">
      <div className="appt-list-body">
        <table className="appt-list-table">
          <thead>
            <tr>
              <th>Name</th><th>Site</th><th>Shift</th><th>Start</th>
              <th>Wk1</th><th>Wk2</th><th>Wk3</th><th>Wk4</th>
              <th>Result</th><th>End Date</th><th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                <td>{r.site}</td>
                <td>{r.shifts}</td>
                <td className="appt-list-mono">{r.startDate}</td>
                {r.weeks.map((w, i) => (
                  <td key={i} className="appt-list-mono" style={{ color: w.toUpperCase() === 'F' ? 'var(--red)' : 'inherit' }}>{w || '—'}</td>
                ))}
                <td>
                  {r.result && (
                    <span className="appt-list-type-badge" style={{ background: 'transparent', border: `1px solid ${r.result.toUpperCase() === 'F' ? 'var(--red)' : 'var(--green)'}`, color: r.result.toUpperCase() === 'F' ? 'var(--red)' : 'var(--green)' }}>
                      {r.result.toUpperCase() === 'F' ? 'Fail' : r.result.toUpperCase() === 'P' ? 'Pass' : r.result}
                    </span>
                  )}
                </td>
                <td className="appt-list-mono">{r.endDate || '—'}</td>
                <td className="appt-list-col-notes">{r.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
