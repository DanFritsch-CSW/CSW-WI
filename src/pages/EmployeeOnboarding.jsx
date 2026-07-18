import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  fetchOnboardingEmployees, createOnboardingEmployee, updateOnboardingEmployee,
  setEmployeeStatus, deleteOnboardingEmployee,
  fetchCompletions, fetchAllCompletionsGrouped, upsertCompletion, upsertWeeklyEntries,
  fetchEvaluations, upsertEvaluation,
} from '../lib/employeeOnboarding.js'
import {
  MONTHS, WEEKLY_CONFIG, MAX_LOADS_PER_WEEK, MODULES, END_EVAL_SECTIONS, FACILITIES,
} from '../lib/employeeOnboardingCurriculum.js'

// Employee Onboarding — built 2026-07-15 per Tim Morris' Slack request (via
// Dan), from Onboarding_Standardization_Notes.docx. Tracks the 3-month
// warehouse-floor new-hire training program + end-of-onboarding evaluation,
// per employee. Same curriculum applies at all 5 facilities (per Dan
// 2026-07-15). New hires added manually — no B2E pull.
//
// UI mirrors the doc's own black-bullet/white-bullet convention: module
// title + completion controls are always visible; full description/
// objectives reveal on click (ModuleRow's expand toggle).
// moduleKeysForMonth — values key + numbered module keys for one month.
// Used to compute "X/Y tasks assessed" progress (weekly logs excluded —
// those are repeatable observation logs, not pass/fail tasks).
function moduleKeysForMonth(monthKey) {
  const month = MONTHS.find(m => m.key === monthKey)
  return [month.value.key, ...MODULES[monthKey].map(m => m.key)]
}
const ALL_MODULE_KEYS = MONTHS.flatMap(m => moduleKeysForMonth(m.key))

function countDone(completionsByKey, keys) {
  return keys.filter(k => completionsByKey[k]?.completed || completionsByKey[k]?.completed_date).length
}

export default function EmployeeOnboarding() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [showCompleted, setShowCompleted] = useState(false)
  const [showNewForm, setShowNewForm] = useState(false)
  const [urlInitDone, setUrlInitDone] = useState(false)
  const [allCompletions, setAllCompletions] = useState({})
  const [facilityFilter, setFacilityFilter] = useState('all')

  const load = () => {
    setLoading(true)
    Promise.all([fetchOnboardingEmployees(), fetchAllCompletionsGrouped()])
      .then(([rows, grouped]) => { setEmployees(rows); setAllCompletions(grouped); setError(null) })
      .catch(err => setError(err?.message || 'Failed to load employees'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (urlInitDone || employees.length === 0) return
    const urlId = Number(searchParams.get('employee'))
    if (urlId) {
      const match = employees.find(e => e.id === urlId)
      if (match) {
        setSelectedId(urlId)
        if (match.status !== 'active') setShowCompleted(true)
      }
    }
    setUrlInitDone(true)
  }, [employees, urlInitDone, searchParams])

  useEffect(() => {
    if (!urlInitDone) return
    const visible = employees
      .filter(e => (e.status !== 'active') === showCompleted)
      .filter(e => facilityFilter === 'all' || e.facility === facilityFilter)
    if (!visible.find(e => e.id === selectedId)) {
      setSelectedId(visible[0]?.id ?? null)
    }
  }, [employees, showCompleted, facilityFilter, selectedId, urlInitDone])

  const selectEmployee = (id) => {
    setSelectedId(id)
    const next = new URLSearchParams(searchParams)
    if (id) next.set('employee', String(id))
    else next.delete('employee')
    setSearchParams(next)
  }

  const visibleEmployees = employees
    .filter(e => (e.status !== 'active') === showCompleted)
    .filter(e => facilityFilter === 'all' || e.facility === facilityFilter)
  const selected = employees.find(e => e.id === selectedId) || null

  return (
    <div className="page-content">
      <div style={{ padding: '20px 24px 0' }}>
        <h1 style={{
          fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '0.02em',
          textTransform: 'uppercase', color: 'var(--text-primary)',
        }}>
          Employee Onboarding
        </h1>
        <p style={{
          margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
        }}>
          3-month new-hire training tracker · all facilities
        </p>
      </div>

      <div style={{ display: 'flex', gap: 20, minHeight: 500, padding: 24 }}>
        <Sidebar
          employees={visibleEmployees}
          selectedId={selectedId}
          onSelect={selectEmployee}
          showCompleted={showCompleted}
          onToggleCompleted={setShowCompleted}
          onNewHire={() => setShowNewForm(true)}
          facilityFilter={facilityFilter}
          onFacilityFilterChange={setFacilityFilter}
          allCompletions={allCompletions}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</div>}
          {error && !loading && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 13 }}>{error}</div>}
          {!loading && !error && !selected && (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              {visibleEmployees.length === 0
                ? (showCompleted ? 'No completed onboardings yet.' : 'No new hires yet — click "+ New Hire" to start one.')
                : 'Select an employee.'}
            </div>
          )}
          {!loading && !error && selected && (
            <EmployeeDetail
              employee={selected}
              onStatusChange={(status) => {
                setEmployeeStatus(selected.id, status)
                setEmployees(prev => prev.map(e => e.id === selected.id ? { ...e, status } : e))
              }}
              onDelete={() => {
                if (!window.confirm(`Delete ${selected.employee_name}'s onboarding record? This removes all tracked progress too.`)) return
                deleteOnboardingEmployee(selected.id)
                setEmployees(prev => prev.filter(e => e.id !== selected.id))
              }}
              onProgressChange={(moduleKey, patch) => {
                setAllCompletions(prev => ({
                  ...prev,
                  [selected.id]: { ...(prev[selected.id] || {}), [moduleKey]: { ...(prev[selected.id]?.[moduleKey]), ...patch } },
                }))
              }}
            />
          )}
        </div>
      </div>

      {showNewForm && (
        <NewHireModal
          onClose={() => setShowNewForm(false)}
          onCreated={(employee) => {
            setEmployees(prev => [employee, ...prev])
            selectEmployee(employee.id)
            setShowNewForm(false)
          }}
        />
      )}
    </div>
  )
}

function Sidebar({ employees, selectedId, onSelect, showCompleted, onToggleCompleted, onNewHire, facilityFilter, onFacilityFilterChange, allCompletions }) {
  return (
    <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid var(--border)', paddingRight: 16 }}>
      <button type="button" onClick={onNewHire} style={primaryBtnStyle}>+ New Hire</button>

      <div style={{ display: 'flex', gap: 4, marginTop: 10, marginBottom: 10 }}>
        <TabPill label="Active" active={!showCompleted} onClick={() => onToggleCompleted(false)} />
        <TabPill label="Completed" active={showCompleted} onClick={() => onToggleCompleted(true)} />
      </div>

      <select
        value={facilityFilter}
        onChange={(e) => onFacilityFilterChange(e.target.value)}
        style={{ ...inputStyle, marginBottom: 10 }}
      >
        <option value="all">All facilities</option>
        {FACILITIES.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
      </select>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {employees.map(e => {
          const days = e.start_date
            ? Math.max(0, Math.floor((Date.now() - new Date(e.start_date + 'T00:00:00')) / 86400000))
            : null
          const done = countDone(allCompletions[e.id] || {}, ALL_MODULE_KEYS)
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(e.id)}
              style={{
                textAlign: 'left', padding: '8px 10px', borderRadius: 6,
                border: 'none', cursor: 'pointer',
                background: e.id === selectedId ? 'var(--brand-bg, #fef9ec)' : 'transparent',
                color: e.id === selectedId ? 'var(--brand, #a07818)' : 'var(--text-primary)',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{e.employee_name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {e.facility ? `${e.facility.toUpperCase()} · ` : ''}{days !== null ? `Day ${days} · ` : ''}{done}/{ALL_MODULE_KEYS.length} tasks assessed
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TabPill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, padding: '4px 8px', fontSize: 11, fontWeight: 600,
        borderRadius: 4, border: 'none', cursor: 'pointer',
        background: active ? 'var(--brand-bg, #fef9ec)' : 'transparent',
        color: active ? 'var(--brand, #a07818)' : 'var(--text-secondary)',
      }}
    >
      {label}
    </button>
  )
}

function EmployeeDetail({ employee, onStatusChange, onDelete, onProgressChange }) {
  const [completions, setCompletions] = useState({})
  const [evaluations, setEvaluations] = useState({})
  const [loading, setLoading] = useState(true)
  const [openMonth, setOpenMonth] = useState('m1')
  const [evalOpen, setEvalOpen] = useState(false)

  const reload = () => {
    setLoading(true)
    Promise.all([fetchCompletions(employee.id), fetchEvaluations(employee.id)])
      .then(([c, ev]) => { setCompletions(c); setEvaluations(ev) })
      .finally(() => setLoading(false))
  }

  useEffect(() => { reload() }, [employee.id])

  const saveCompletion = async (moduleKey, patch) => {
    setCompletions(prev => ({ ...prev, [moduleKey]: { ...prev[moduleKey], module_key: moduleKey, ...patch } }))
    onProgressChange?.(moduleKey, patch)
    await upsertCompletion(employee.id, moduleKey, patch)
  }

  const saveWeekly = async (moduleKey, entries) => {
    setCompletions(prev => ({ ...prev, [moduleKey]: { ...prev[moduleKey], module_key: moduleKey, entries } }))
    await upsertWeeklyEntries(employee.id, moduleKey, entries)
  }

  const saveEval = async (categoryKey, patch) => {
    setEvaluations(prev => ({ ...prev, [categoryKey]: { ...prev[categoryKey], category_key: categoryKey, ...patch } }))
    await upsertEvaluation(employee.id, categoryKey, patch)
  }

  const [employeeFields, setEmployeeFields] = useState(employee)
  useEffect(() => { setEmployeeFields(employee) }, [employee])
  const saveEmployeeField = async (patch) => {
    setEmployeeFields(prev => ({ ...prev, ...patch }))
    await updateOnboardingEmployee(employee.id, patch)
  }

  // Progress: numbered modules + values completed, across all 3 months.
  const doneCount = countDone(completions, ALL_MODULE_KEYS)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>{employee.employee_name}</h3>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            {employee.facility ? `${employee.facility.toUpperCase()} · ` : ''}
            {employee.trainer_name ? `Trainer: ${employee.trainer_name} · ` : ''}
            {doneCount} / {ALL_MODULE_KEYS.length} tasks assessed
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            value={employee.status}
            onChange={(e) => onStatusChange(e.target.value)}
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)' }}
          >
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="terminated">Terminated</option>
          </select>
          <button type="button" onClick={onDelete} style={{ ...smallBtnStyle, color: 'var(--danger, #dc2626)' }}>
            Delete
          </button>
        </div>
      </div>

      {loading && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading progress…</div>}

      {!loading && MONTHS.map(month => (
        <MonthSection
          key={month.key}
          month={month}
          isOpen={openMonth === month.key}
          onToggle={() => setOpenMonth(openMonth === month.key ? null : month.key)}
          completions={completions}
          onSaveCompletion={saveCompletion}
          onSaveWeekly={saveWeekly}
          employeeFields={employeeFields}
          onSaveEmployeeField={saveEmployeeField}
        />
      ))}

      {!loading && (
        <EndEvalSection
          isOpen={evalOpen}
          onToggle={() => setEvalOpen(!evalOpen)}
          evaluations={evaluations}
          onSaveEval={saveEval}
          employee={employeeFields}
          onSaveEmployee={saveEmployeeField}
        />
      )}
    </div>
  )
}

function SectionHeader({ title, subtitle, isOpen, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', marginTop: 10, background: 'var(--surface-2, #f8f8f8)',
        border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{isOpen ? '▾' : '▸'}</span>
    </button>
  )
}

function MonthSection({ month, isOpen, onToggle, completions, onSaveCompletion, onSaveWeekly, employeeFields, onSaveEmployeeField }) {
  const modules = MODULES[month.key]
  const weeklyCfg = WEEKLY_CONFIG[month.key]
  const valueRow = completions[month.value.key] || {}
  const monthKeys = moduleKeysForMonth(month.key)
  const monthDone = countDone(completions, monthKeys)

  // Milestone review — Month 1 gets the 30-day check-in, Month 2 gets 60-day.
  // (per Tim/Dean feedback, 2026-07-18). Month 3 has no mid-month milestone;
  // the 90-day review lives on the End-of-Onboarding Evaluation instead.
  const milestone = month.key === 'm1'
    ? { dayLabel: '30', moduleKey: 'm1_day30_review', reviewedField: 'day30_review_conducted', reviewedDateField: 'day30_review_date', retainLabel: 'Recommend retaining into Month 2?' }
    : month.key === 'm2'
      ? { dayLabel: '60', moduleKey: 'm2_day60_review', reviewedField: 'day60_review_conducted', reviewedDateField: 'day60_review_date', retainLabel: 'Recommend retaining into Month 3?' }
      : null

  return (
    <div>
      <SectionHeader
        title={month.label}
        subtitle={`${monthDone}/${monthKeys.length} tasks assessed`}
        isOpen={isOpen}
        onToggle={onToggle}
      />
      {isOpen && (
        <div style={{ padding: '10px 4px 4px 14px', borderLeft: '2px solid var(--border)', marginLeft: 6 }}>
          {/* Values discussion */}
          <ExpandableRow
            title={`Value: ${month.value.title}`}
            bullets={month.value.bullets}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 6 }}>
              <input
                type="checkbox"
                checked={!!valueRow.completed}
                onChange={(e) => onSaveCompletion(month.value.key, { completed: e.target.checked })}
              />
              <textarea
                placeholder="How employee demonstrated (or struggled with) these values..."
                defaultValue={valueRow.comments || ''}
                onBlur={(e) => onSaveCompletion(month.value.key, { comments: e.target.value })}
                style={{ ...inputStyle, flex: 1, minHeight: 50, resize: 'vertical' }}
              />
            </div>
          </ExpandableRow>

          {/* Weekly observation logs */}
          {Array.from({ length: weeklyCfg.weeks }, (_, i) => i + 1).map(weekNum => (
            <WeeklyLogRow
              key={weekNum}
              moduleKey={`${month.key}_week${weekNum}`}
              weekNum={weekNum}
              label={weeklyCfg.label}
              gradeLabel={weeklyCfg.gradeLabel}
              hasGrade={weeklyCfg.hasGrade}
              entries={completions[`${month.key}_week${weekNum}`]?.entries || []}
              onSave={(entries) => onSaveWeekly(`${month.key}_week${weekNum}`, entries)}
            />
          ))}

          {/* Numbered training modules */}
          {modules.map(mod => (
            <ModuleRow
              key={mod.key}
              module={mod}
              row={completions[mod.key] || {}}
              onSave={(patch) => onSaveCompletion(mod.key, patch)}
            />
          ))}

          {/* 30/60-day milestone review (Month 1 / Month 2 only) */}
          {milestone && (
            <MilestoneReviewRow
              milestone={milestone}
              completionRow={completions[milestone.moduleKey] || {}}
              onSaveCompletion={(patch) => onSaveCompletion(milestone.moduleKey, patch)}
              reviewed={employeeFields?.[milestone.reviewedField]}
              reviewedDate={employeeFields?.[milestone.reviewedDateField]}
              onSaveEmployeeField={onSaveEmployeeField}
            />
          )}
        </div>
      )}
    </div>
  )
}

// MilestoneReviewRow — end-of-month trainer write-up + retain-into-next-
// month Y/N, plus "warehouse leadership review conducted?" Y/N + date.
// Added 2026-07-18 per Tim/Dean feedback (30-day / 60-day check-ins).
function MilestoneReviewRow({ milestone, completionRow, onSaveCompletion, reviewed, reviewedDate, onSaveEmployeeField }) {
  return (
    <div style={{ padding: '10px', marginBottom: 6, background: 'var(--surface-2, #f8f8f8)', borderRadius: 6, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{milestone.dayLabel}-Day Check-In</div>

      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Trainer {milestone.dayLabel}-day comments</div>
      <textarea
        placeholder="Trainer comments..."
        defaultValue={completionRow.comments || ''}
        onBlur={(e) => onSaveCompletion({ comments: e.target.value })}
        style={{ ...inputStyle, width: '100%', minHeight: 50, resize: 'vertical', boxSizing: 'border-box', marginBottom: 8 }}
      />

      <YesNoRow
        label={milestone.retainLabel}
        value={completionRow.retain_flag}
        onChange={(v) => onSaveCompletion({ retain_flag: v })}
      />

      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <YesNoRow
          label={`${milestone.dayLabel}-day review with warehouse leadership conducted?`}
          value={reviewed}
          onChange={(v) => onSaveEmployeeField({ [milestone.reviewedField]: v })}
        />
        {reviewed && (
          <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginTop: 6 }}>
            Date conducted
            <input
              type="date"
              value={reviewedDate || ''}
              onChange={(e) => onSaveEmployeeField({ [milestone.reviewedDateField]: e.target.value || null })}
              style={{ ...inputStyle, marginLeft: 6, width: 140 }}
            />
          </label>
        )}
      </div>
    </div>
  )
}

// YesNoRow — shared Y/N toggle used by milestone reviews + End-of-Onboarding
// retain recommendations. `value` is boolean|null (null = not yet answered).
function YesNoRow({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          type="button"
          onClick={() => onChange(true)}
          style={{ ...smallBtnStyle, background: value === true ? 'var(--brand, #a07818)' : 'transparent', color: value === true ? '#fff' : 'inherit' }}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => onChange(false)}
          style={{ ...smallBtnStyle, background: value === false ? 'var(--danger, #dc2626)' : 'transparent', color: value === false ? '#fff' : 'inherit' }}
        >
          No
        </button>
      </div>
    </div>
  )
}

function ExpandableRow({ title, bullets, children }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ padding: '8px 10px', marginBottom: 6, background: 'var(--surface-2, #f8f8f8)', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        {bullets && bullets.length > 0 && (
          <button type="button" onClick={() => setExpanded(!expanded)} style={linkBtnStyle}>
            {expanded ? 'Hide detail' : 'Show detail'}
          </button>
        )}
      </div>
      {expanded && bullets && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)' }}>
          {bullets.map((b, i) => <li key={i} style={{ marginBottom: 4 }}>{b}</li>)}
        </ul>
      )}
      {children}
    </div>
  )
}

function ModuleRow({ module, row, onSave }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = (module.bullets && module.bullets.length > 0) || module.objectives

  return (
    <div style={{ padding: '8px 10px', marginBottom: 6, background: 'var(--surface-2, #f8f8f8)', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={!!row.completed_date}
          onChange={(e) => onSave({ completed_date: e.target.checked ? (row.completed_date || todayStr()) : null })}
        />
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
          {module.code ? `${module.code} — ${module.title}` : module.title}
        </div>
        {hasDetail && (
          <button type="button" onClick={() => setExpanded(!expanded)} style={linkBtnStyle}>
            {expanded ? 'Hide detail' : 'Show detail'}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {module.bullets && module.bullets.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)' }}>
              {module.bullets.map((b, i) => <li key={i} style={{ marginBottom: 4 }}>{b}</li>)}
            </ul>
          )}
          {module.objectives && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, fontStyle: 'italic' }}>
              Training objective: {module.objectives}
            </div>
          )}
          {module.resourceLabel && (
            module.resourceLink
              ? <a href={module.resourceLink} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: 'inline-block', marginTop: 6 }}>📄 {module.resourceLabel}</a>
              : <div style={{ fontSize: 11, color: 'var(--text-dim, #999)', marginTop: 6, fontStyle: 'italic' }}>📄 {module.resourceLabel} — link pending</div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          Date completed
          <input
            type="date"
            value={row.completed_date || ''}
            onChange={(e) => onSave({ completed_date: e.target.value || null })}
            style={{ ...inputStyle, marginLeft: 6, width: 140 }}
          />
        </label>
        <label style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, minWidth: 160 }}>
          Observer
          <input
            type="text"
            defaultValue={row.observer_name || ''}
            onBlur={(e) => onSave({ observer_name: e.target.value || null })}
            style={{ ...inputStyle, marginLeft: 6, width: 'calc(100% - 70px)' }}
          />
        </label>
      </div>
      <textarea
        placeholder="Comments..."
        defaultValue={row.comments || ''}
        onBlur={(e) => onSave({ comments: e.target.value })}
        style={{ ...inputStyle, width: '100%', marginTop: 6, minHeight: 40, resize: 'vertical', boxSizing: 'border-box' }}
      />
    </div>
  )
}

function WeeklyLogRow({ moduleKey, weekNum, label, gradeLabel, hasGrade, entries, onSave }) {
  const [expanded, setExpanded] = useState(false)

  const addLoad = () => {
    if (entries.length >= MAX_LOADS_PER_WEEK) return
    onSave([...entries, { date: '', grade: '', comments: '', observer: '' }])
  }
  const updateLoad = (idx, patch) => {
    onSave(entries.map((e, i) => i === idx ? { ...e, ...patch } : e))
  }
  const removeLoad = (idx) => {
    onSave(entries.filter((_, i) => i !== idx))
  }

  return (
    <div style={{ padding: '8px 10px', marginBottom: 6, background: 'var(--surface-2, #f8f8f8)', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Week {weekNum} — {label}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{entries.length} logged</span>
          <button type="button" onClick={() => setExpanded(!expanded)} style={linkBtnStyle}>
            {expanded ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {entries.map((entry, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
              <input
                type="date"
                value={entry.date || ''}
                onChange={(e) => updateLoad(idx, { date: e.target.value })}
                style={{ ...inputStyle, width: 130 }}
              />
              {hasGrade && (
                <input
                  type="text"
                  placeholder={gradeLabel}
                  value={entry.grade || ''}
                  onChange={(e) => updateLoad(idx, { grade: e.target.value })}
                  style={{ ...inputStyle, width: 120 }}
                />
              )}
              <input
                type="text"
                placeholder="Comments"
                value={entry.comments || ''}
                onChange={(e) => updateLoad(idx, { comments: e.target.value })}
                style={{ ...inputStyle, flex: 1, minWidth: 140 }}
              />
              <input
                type="text"
                placeholder="Observer"
                value={entry.observer || ''}
                onChange={(e) => updateLoad(idx, { observer: e.target.value })}
                style={{ ...inputStyle, width: 120 }}
              />
              <button type="button" onClick={() => removeLoad(idx)} style={{ ...linkBtnStyle, color: 'var(--danger, #dc2626)' }}>×</button>
            </div>
          ))}
          <button
            type="button"
            onClick={addLoad}
            disabled={entries.length >= MAX_LOADS_PER_WEEK}
            style={smallBtnStyle}
          >
            + Add load {entries.length >= MAX_LOADS_PER_WEEK ? '(max 10)' : ''}
          </button>
        </div>
      )}
    </div>
  )
}

function EndEvalSection({ isOpen, onToggle, evaluations, onSaveEval, employee, onSaveEmployee }) {
  return (
    <div>
      <SectionHeader
        title="End-of-Onboarding Evaluation"
        subtitle="Trainer + Supervisor sign-off"
        isOpen={isOpen}
        onToggle={onToggle}
      />
      {isOpen && (
        <div style={{ padding: '10px 4px 4px 14px', borderLeft: '2px solid var(--border)', marginLeft: 6 }}>
          {END_EVAL_SECTIONS.map(section => (
            <div key={section.key} style={{ marginBottom: 14 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                color: 'var(--text-secondary)', marginBottom: 6,
              }}>
                {section.title}
              </div>
              {section.items.map(item => {
                const row = evaluations[item.key] || {}
                return (
                  <div key={item.key} style={{ padding: '6px 10px', marginBottom: 4, background: 'var(--surface-2, #f8f8f8)', borderRadius: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{item.label}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        placeholder="Trainer evaluation"
                        defaultValue={row.trainer_eval || ''}
                        onBlur={(e) => onSaveEval(item.key, { trainer_eval: e.target.value })}
                        style={{ ...inputStyle, flex: 1, minWidth: 160 }}
                      />
                      <input
                        type="text"
                        placeholder="Supervisor evaluation"
                        defaultValue={row.supervisor_eval || ''}
                        onBlur={(e) => onSaveEval(item.key, { supervisor_eval: e.target.value })}
                        style={{ ...inputStyle, flex: 1, minWidth: 160 }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          ))}

          <div style={{ marginBottom: 8 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
              color: 'var(--text-secondary)', marginBottom: 6,
            }}>
              90-Day Leadership Review
            </div>
            <div style={{ padding: '6px 10px', background: 'var(--surface-2, #f8f8f8)', borderRadius: 6, marginBottom: 12 }}>
              <YesNoRow
                label="90-day review with warehouse leadership conducted?"
                value={employee.day90_review_conducted}
                onChange={(v) => onSaveEmployee({ day90_review_conducted: v })}
              />
              {employee.day90_review_conducted && (
                <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginTop: 6 }}>
                  Date conducted
                  <input
                    type="date"
                    value={employee.day90_review_date || ''}
                    onChange={(e) => onSaveEmployee({ day90_review_date: e.target.value || null })}
                    style={{ ...inputStyle, marginLeft: 6, width: 140 }}
                  />
                </label>
              )}
            </div>

            <div style={{
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
              color: 'var(--text-secondary)', marginBottom: 6,
            }}>
              Recommendation to Retain Past Initial Probationary Period?
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <YesNoRow
                  label="Trainer recommends retain?"
                  value={employee.trainer_retain_flag}
                  onChange={(v) => onSaveEmployee({ trainer_retain_flag: v })}
                />
                <textarea
                  placeholder="Trainer comment"
                  defaultValue={employee.trainer_recommendation || ''}
                  onBlur={(e) => onSaveEmployee({ trainer_recommendation: e.target.value })}
                  style={{ ...inputStyle, width: '100%', minHeight: 50, resize: 'vertical', marginTop: 6, boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <YesNoRow
                  label="Supervisor recommends retain?"
                  value={employee.supervisor_retain_flag}
                  onChange={(v) => onSaveEmployee({ supervisor_retain_flag: v })}
                />
                <textarea
                  placeholder="Supervisor comment"
                  defaultValue={employee.supervisor_recommendation || ''}
                  onBlur={(e) => onSaveEmployee({ supervisor_recommendation: e.target.value })}
                  style={{ ...inputStyle, width: '100%', minHeight: 50, resize: 'vertical', marginTop: 6, boxSizing: 'border-box' }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function NewHireModal({ onClose, onCreated }) {
  const [employeeName, setEmployeeName] = useState('')
  const [facility, setFacility] = useState(FACILITIES[0])
  const [startDate, setStartDate] = useState(todayStr())
  const [trainerName, setTrainerName] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!employeeName.trim()) return
    setSaving(true)
    try {
      const employee = await createOnboardingEmployee({
        employeeName: employeeName.trim(), facility, startDate, trainerName,
      })
      onCreated(employee)
    } catch (err) {
      window.alert(`Failed to create employee: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }}>
      <div style={{ background: 'var(--surface, #fff)', borderRadius: 10, padding: 20, width: 340 }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>New Hire</h3>
        <label style={labelStyle}>Employee name</label>
        <input value={employeeName} onChange={(e) => setEmployeeName(e.target.value)} style={inputStyle} autoFocus />
        <label style={labelStyle}>Facility</label>
        <select value={facility} onChange={(e) => setFacility(e.target.value)} style={inputStyle}>
          {FACILITIES.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
        </select>
        <label style={labelStyle}>Start date</label>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
        <label style={labelStyle}>Trainer</label>
        <input value={trainerName} onChange={(e) => setTrainerName(e.target.value)} style={inputStyle} />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={smallBtnStyle}>Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !employeeName.trim()}
            style={{ ...smallBtnStyle, background: 'var(--brand, #a07818)', color: '#fff' }}
          >
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

const primaryBtnStyle = {
  width: '100%', padding: '8px 12px',
  background: 'var(--brand, #a07818)', color: '#fff', border: 'none',
  borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
}
const smallBtnStyle = {
  padding: '4px 10px', fontSize: 12, borderRadius: 4,
  border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer',
}
const linkBtnStyle = {
  padding: '2px 6px', fontSize: 11, borderRadius: 4,
  border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--brand, #a07818)',
}
const labelStyle = { display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginTop: 10, marginBottom: 4 }
const inputStyle = { width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 4, border: '1px solid var(--border)', boxSizing: 'border-box' }
