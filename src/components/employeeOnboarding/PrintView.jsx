import { useEffect, useState } from 'react'
import { fetchOnboardingEmployees, fetchCompletions, fetchEvaluations } from '../../lib/employeeOnboarding.js'
import { fetchCurriculumValues, fetchCurriculumModules } from '../../lib/employeeOnboardingTemplate.js'
import { MONTHS, WEEKLY_CONFIG, END_EVAL_SECTIONS } from '../../lib/employeeOnboardingCurriculum.js'

// PrintView — full onboarding record for one employee, formatted for HR's
// personnel file. Built 2026-07-18 per Tim's original request (2026-07-15):
// "press a button that will message HR and they will have the ability to
// print a PDF of this entire onboarding document." No PDF generation
// library — HR opens this and uses the browser's native print-to-PDF, same
// print-CSS pattern as the Inventory count sheet / WR digests elsewhere in
// the app. @media print rules hide the app chrome (TopNav) so only the
// record itself prints.
export default function PrintView({ employeeId }) {
  const [employee, setEmployee] = useState(null)
  const [completions, setCompletions] = useState({})
  const [evaluations, setEvaluations] = useState({})
  const [curriculumValues, setCurriculumValues] = useState({})
  const [curriculumModules, setCurriculumModules] = useState({ m1: [], m2: [], m3: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetchOnboardingEmployees(),
      fetchCompletions(employeeId),
      fetchEvaluations(employeeId),
      fetchCurriculumValues(),
      fetchCurriculumModules(),
    ]).then(([employees, c, ev, values, modules]) => {
      setEmployee(employees.find(e => e.id === Number(employeeId)) || null)
      setCompletions(c)
      setEvaluations(ev)
      setCurriculumValues(values)
      setCurriculumModules(modules)
    }).finally(() => setLoading(false))
  }, [employeeId])

  if (loading) return <div style={{ padding: 24, fontSize: 13, color: '#666' }}>Loading record…</div>
  if (!employee) return <div style={{ padding: 24, fontSize: 13, color: '#666' }}>Employee not found.</div>

  return (
    <div className="eo-print-view">
      <style>{`
        @media print {
          .top-nav, .util-bar, .eo-print-no-print { display: none !important; }
          body { background: #fff !important; }
        }
        .eo-print-view { max-width: 800px; margin: 0 auto; padding: 24px; font-family: system-ui, sans-serif; color: #111; }
        .eo-print-view h1 { font-size: 20px; margin: 0 0 4px; }
        .eo-print-view h2 { font-size: 15px; margin: 20px 0 8px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
        .eo-print-view h3 { font-size: 13px; margin: 10px 0 4px; }
        .eo-print-view table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
        .eo-print-view td, .eo-print-view th { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
        .eo-print-view .meta { font-size: 12px; color: #555; margin-bottom: 16px; }
        .eo-print-view .module-row { margin-bottom: 6px; font-size: 12px; }
      `}</style>

      <div className="eo-print-no-print" style={{ marginBottom: 16 }}>
        <button type="button" onClick={() => window.print()} style={{ padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}>
          🖨 Print / Save as PDF
        </button>
      </div>

      <h1>Employee Onboarding Record — {employee.employee_name}</h1>
      <div className="meta">
        {employee.facility && <span>Facility: {employee.facility.toUpperCase()} · </span>}
        {employee.start_date && <span>Start date: {employee.start_date} · </span>}
        {employee.trainer_name && <span>Trainer: {employee.trainer_name} · </span>}
        Status: {employee.status}
      </div>

      {MONTHS.map(month => {
        const valueRow = curriculumValues[month.key]
        const completionValueRow = completions[month.value.key] || {}
        const modules = curriculumModules[month.key] || []
        const weeklyCfg = WEEKLY_CONFIG[month.key]

        return (
          <div key={month.key}>
            <h2>{month.label}</h2>

            {valueRow && (
              <div style={{ marginBottom: 10 }}>
                <h3>Value: {valueRow.title} — {completionValueRow.completed ? '✓ Discussed' : 'Not discussed'}</h3>
                {completionValueRow.comments && <div style={{ fontSize: 12 }}>{completionValueRow.comments}</div>}
              </div>
            )}

            <h3>Training Modules</h3>
            <table>
              <thead>
                <tr><th>Module</th><th>Date Completed</th><th>Observer</th><th>Comments</th></tr>
              </thead>
              <tbody>
                {modules.map(mod => {
                  const row = completions[mod.key] || {}
                  return (
                    <tr key={mod.key}>
                      <td>{mod.code ? `${mod.code} — ${mod.title}` : mod.title}</td>
                      <td>{row.completed_date || '—'}</td>
                      <td>{row.observer_name || '—'}</td>
                      <td>{row.comments || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <h3>Weekly Observation Logs</h3>
            <table>
              <thead>
                <tr><th>Week</th><th>Date</th>{weeklyCfg.hasGrade && <th>Grade</th>}<th>Observer</th><th>Comments</th></tr>
              </thead>
              <tbody>
                {Array.from({ length: weeklyCfg.weeks }, (_, i) => i + 1).flatMap(weekNum => {
                  const entries = completions[`${month.key}_week${weekNum}`]?.entries || []
                  if (entries.length === 0) return [
                    <tr key={`${weekNum}-empty`}><td>Week {weekNum}</td><td colSpan={weeklyCfg.hasGrade ? 4 : 3}>No entries logged</td></tr>
                  ]
                  return entries.map((entry, idx) => (
                    <tr key={`${weekNum}-${idx}`}>
                      <td>{idx === 0 ? `Week ${weekNum}` : ''}</td>
                      <td>{entry.date || '—'}</td>
                      {weeklyCfg.hasGrade && <td>{entry.grade || '—'}</td>}
                      <td>{entry.observer || '—'}</td>
                      <td>{entry.comments || '—'}</td>
                    </tr>
                  ))
                })}
              </tbody>
            </table>

            {(month.key === 'm1' || month.key === 'm2') && (() => {
              const milestoneKey = month.key === 'm1' ? 'm1_day30_review' : 'm2_day60_review'
              const dayLabel = month.key === 'm1' ? '30' : '60'
              const row = completions[milestoneKey] || {}
              const reviewedField = month.key === 'm1' ? 'day30_review_conducted' : 'day60_review_conducted'
              const reviewedDateField = month.key === 'm1' ? 'day30_review_date' : 'day60_review_date'
              return (
                <div style={{ marginBottom: 10 }}>
                  <h3>{dayLabel}-Day Check-In</h3>
                  <div className="module-row">Trainer comments: {row.comments || '—'}</div>
                  <div className="module-row">Recommend retaining into next month: {row.retain_flag === true ? 'Yes' : row.retain_flag === false ? 'No' : '—'}</div>
                  <div className="module-row">Leadership review conducted: {employee[reviewedField] ? `Yes (${employee[reviewedDateField] || 'date not set'})` : 'No'}</div>
                </div>
              )
            })()}
          </div>
        )
      })}

      <h2>End-of-Onboarding Evaluation</h2>
      {END_EVAL_SECTIONS.map(section => (
        <div key={section.key} style={{ marginBottom: 10 }}>
          <h3>{section.title}</h3>
          <table>
            <thead><tr><th>Item</th><th>Trainer</th><th>Supervisor</th></tr></thead>
            <tbody>
              {section.items.map(item => {
                const row = evaluations[item.key] || {}
                return (
                  <tr key={item.key}>
                    <td>{item.label}</td>
                    <td>{row.trainer_eval || '—'}</td>
                    <td>{row.supervisor_eval || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      <h3>90-Day Leadership Review</h3>
      <div className="module-row">
        Conducted: {employee.day90_review_conducted ? `Yes (${employee.day90_review_date || 'date not set'})` : 'No'}
      </div>

      <h3>Recommendation to Retain Past Initial Probationary Period</h3>
      <table>
        <thead><tr><th></th><th>Retain?</th><th>Comments</th></tr></thead>
        <tbody>
          <tr>
            <td>Trainer</td>
            <td>{employee.trainer_retain_flag === true ? 'Yes' : employee.trainer_retain_flag === false ? 'No' : '—'}</td>
            <td>{employee.trainer_recommendation || '—'}</td>
          </tr>
          <tr>
            <td>Supervisor</td>
            <td>{employee.supervisor_retain_flag === true ? 'Yes' : employee.supervisor_retain_flag === false ? 'No' : '—'}</td>
            <td>{employee.supervisor_recommendation || '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
