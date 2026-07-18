import { useState } from 'react'
import { END_EVAL_SECTIONS, FACILITIES } from '../../lib/employeeOnboardingCurriculum.js'

// Dashboard — built 2026-07-18 per Dean/Tim feedback: a high-level view for
// the GM call (all facilities) and the trainer L10 (filtered to one
// facility, click a name to jump to their detail). Styled after the
// CSW-Caledonia Personnel Tracker skill-matrix app Dan shared as a baseline
// — stat cards + a colored-dot table — but the columns map to onboarding
// data (Month 1/2/3, End Eval, 30/60/90 reviews) since this data doesn't
// have "skills" the way that tool does.
//
// Dot semantics (matches the Caledonia tracker's color language):
//   grey = not started · orange = in progress · green = complete
//   red is reserved for the "flagged" state (a Not-Retain recommendation
//   anywhere in the record) — surfaced as a stat card and a per-row badge,
//   not a fifth dot, since it cuts across months rather than belonging to one.
function monthStatus(monthKey, completions, curriculumModules) {
  const keys = [`${monthKey}_values`, ...(curriculumModules[monthKey] || []).map(m => m.key)]
  const done = keys.filter(k => completions[k]?.completed || completions[k]?.completed_date).length
  return { done, total: keys.length, state: done === 0 ? 'none' : done === keys.length ? 'done' : 'partial' }
}

function endEvalStatus(evaluations) {
  const items = END_EVAL_SECTIONS.flatMap(s => s.items)
  const done = items.filter(i => evaluations[i.key]?.trainer_eval || evaluations[i.key]?.supervisor_eval).length
  return { done, total: items.length, state: done === 0 ? 'none' : done === items.length ? 'done' : 'partial' }
}

function daysAt(employee) {
  if (!employee.start_date) return null
  return Math.max(0, Math.floor((Date.now() - new Date(employee.start_date + 'T00:00:00')) / 86400000))
}

function isFlagged(employee, completions) {
  if (employee.trainer_retain_flag === false || employee.supervisor_retain_flag === false) return true
  if (completions['m1_day30_review']?.retain_flag === false) return true
  if (completions['m2_day60_review']?.retain_flag === false) return true
  return false
}

function reviewsOverdue(employee) {
  const days = daysAt(employee)
  if (days === null) return false
  if (days >= 30 && !employee.day30_review_conducted) return true
  if (days >= 60 && !employee.day60_review_conducted) return true
  if (days >= 90 && !employee.day90_review_conducted) return true
  return false
}

export default function Dashboard({ employees, allCompletions, allEvaluations, curriculumModules, onSelectEmployee }) {
  const [facilityFilter, setFacilityFilter] = useState('all')
  const [search, setSearch] = useState('')

  const activeEmployees = employees.filter(e => e.status === 'active')
  const filtered = activeEmployees
    .filter(e => facilityFilter === 'all' || e.facility === facilityFilter)
    .filter(e => !search.trim() || e.employee_name.toLowerCase().includes(search.trim().toLowerCase()))

  const flaggedCount = activeEmployees.filter(e => isFlagged(e, allCompletions[e.id] || {})).length
  const overdueCount = activeEmployees.filter(e => reviewsOverdue(e)).length
  const completedCount = employees.filter(e => e.status === 'completed').length

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <StatCard label="Active Onboarding" value={activeEmployees.length} />
        <StatCard label="Flagged (Not Retain)" value={flaggedCount} color={flaggedCount > 0 ? '#dc2626' : undefined} />
        <StatCard label="Reviews Overdue" value={overdueCount} color={overdueCount > 0 ? '#d97706' : undefined} />
        <StatCard label="Completed" value={completedCount} color="#059669" />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inputStyle, width: 200 }}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          <FilterPill label="All" active={facilityFilter === 'all'} onClick={() => setFacilityFilter('all')} />
          {FACILITIES.map(f => (
            <FilterPill key={f} label={f.toUpperCase()} active={facilityFilter === f} onClick={() => setFacilityFilter(f)} />
          ))}
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Facility</th>
            <th style={thStyle}>Hire Date</th>
            <th style={thStyle}>Day</th>
            <th style={thStyle}>Month 1</th>
            <th style={thStyle}>Month 2</th>
            <th style={thStyle}>Month 3</th>
            <th style={thStyle}>End Eval</th>
            <th style={thStyle}>30/60/90</th>
            <th style={thStyle}>Overall</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(e => {
            const completions = allCompletions[e.id] || {}
            const evaluations = allEvaluations[e.id] || {}
            const m1 = monthStatus('m1', completions, curriculumModules)
            const m2 = monthStatus('m2', completions, curriculumModules)
            const m3 = monthStatus('m3', completions, curriculumModules)
            const eval_ = endEvalStatus(evaluations)
            const reviewsDone = [e.day30_review_conducted, e.day60_review_conducted, e.day90_review_conducted].filter(Boolean).length
            const overallDone = m1.done + m2.done + m3.done
            const overallTotal = m1.total + m2.total + m3.total
            const flagged = isFlagged(e, completions)
            const overdue = reviewsOverdue(e)

            return (
              <tr
                key={e.id}
                onClick={() => onSelectEmployee(e.id)}
                style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
              >
                <td style={tdStyle}>
                  {e.employee_name}
                  {flagged && <span title="Not-Retain recommendation on file" style={{ marginLeft: 6, color: '#dc2626' }}>⚑</span>}
                </td>
                <td style={tdStyle}>{e.facility ? e.facility.toUpperCase() : '—'}</td>
                <td style={tdStyle}>{e.start_date || '—'}</td>
                <td style={tdStyle}>{daysAt(e) ?? '—'}</td>
                <td style={tdStyle}><StatusDot state={m1.state} label={`${m1.done}/${m1.total}`} /></td>
                <td style={tdStyle}><StatusDot state={m2.state} label={`${m2.done}/${m2.total}`} /></td>
                <td style={tdStyle}><StatusDot state={m3.state} label={`${m3.done}/${m3.total}`} /></td>
                <td style={tdStyle}><StatusDot state={eval_.state} label={`${eval_.done}/${eval_.total}`} /></td>
                <td style={tdStyle}>
                  <span style={{ color: overdue ? '#d97706' : 'inherit', fontWeight: overdue ? 700 : 400 }}>
                    {reviewsDone}/3{overdue ? ' ⚠' : ''}
                  </span>
                </td>
                <td style={tdStyle}>{overallDone}/{overallTotal}</td>
              </tr>
            )
          })}
          {filtered.length === 0 && (
            <tr><td colSpan={10} style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>No active employees match.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2, #f8f8f8)' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || 'inherit' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

function FilterPill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 10px', fontSize: 12, fontWeight: 600,
        borderRadius: 4, border: 'none', cursor: 'pointer',
        background: active ? 'var(--brand-bg, #fef9ec)' : 'transparent',
        color: active ? 'var(--brand, #a07818)' : 'var(--text-secondary)',
      }}
    >
      {label}
    </button>
  )
}

function StatusDot({ state, label }) {
  const color = state === 'done' ? '#10b981' : state === 'partial' ? '#f59e0b' : '#9ca3af'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</span>
    </span>
  )
}

const thStyle = { padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-secondary)' }
const tdStyle = { padding: '8px 10px' }
const inputStyle = { fontSize: 13, padding: '6px 8px', borderRadius: 4, border: '1px solid var(--border)', boxSizing: 'border-box' }
