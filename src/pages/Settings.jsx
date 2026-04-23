import { useState, useEffect } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchFacilitySettings, upsertFacilitySettings, fetchCal2Employees, upsertEmployeeDockSide } from '../lib/supabase.js'

// ── Tab nav ────────────────────────────────────────────────

const TABS = [
  { id: 'labor',   label: 'Labor Planning' },
  { id: 'breaks',  label: 'Break Assumptions' },
  { id: 'dock',    label: 'CAL v2 Dock Assignment' },
]

// ── Labor Settings ────────────────────────────────────────────

const DEFAULTS = { hours_per_appt: 1.5 }

function FacilitySettingsCard({ facility }) {
  const [hpa, setHpa]        = useState(DEFAULTS.hours_per_appt)
  const [saveState, setSave] = useState(null)

  useEffect(() => {
    fetchFacilitySettings(facility.id).then(data => {
      setHpa(data.hours_per_appt ?? DEFAULTS.hours_per_appt)
    })
  }, [facility.id])

  async function handleSave() {
    setSave('saving')
    try {
      await upsertFacilitySettings(facility.id, { hours_per_appt: hpa })
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <span className="settings-facility-dot" style={{ background: facility.color }} />
        <span className="settings-facility-name">{facility.name}</span>
        <span className="settings-facility-code">{facility.code}</span>
      </div>
      <div className="settings-fields">
        <label className="settings-field" title="Labor hours required per appointment — drives the Labor Required calculation">
          <span className="settings-field-label">Hours / Appt</span>
          <input
            type="number"
            className="settings-field-input"
            value={hpa}
            min={0.1} max={10} step={0.1}
            onChange={e => setHpa(parseFloat(e.target.value))}
          />
        </label>
      </div>
      <div className="settings-card-footer">
        <button className="settings-save-btn" onClick={handleSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Break Schedule Editor ───────────────────────────────────────

const BREAK_DEFAULTS = [83, 100, 75, 100, 50, 100, 75, 100]

function BreakScheduleEditor() {
  const [facility, setFacility] = useState(FACILITY_LIST[0].id)
  const [values, setValues]     = useState(BREAK_DEFAULTS)
  const [saveState, setSave]    = useState(null)

  useEffect(() => {
    fetchFacilitySettings(facility).then(data => {
      setValues(BREAK_DEFAULTS.map((def, i) => data[`break_hour_${i + 1}`] ?? def))
    })
  }, [facility])

  function handleChange(i, raw) {
    const num = parseInt(raw, 10)
    setValues(prev => prev.map((v, j) => j === i ? (isNaN(num) ? v : Math.min(100, Math.max(0, num))) : v))
  }

  async function handleSave() {
    setSave('saving')
    const payload = Object.fromEntries(values.map((v, i) => [`break_hour_${i + 1}`, v]))
    try {
      await upsertFacilitySettings(facility, payload)
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  return (
    <div className="break-schedule-editor">
      <div className="break-schedule-controls">
        <div className="break-schedule-warehouse">
          <span className="break-schedule-warehouse-label">Warehouse</span>
          <select className="est-drops-select" value={facility} onChange={e => setFacility(e.target.value)}>
            {FACILITY_LIST.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="break-schedule-actions">
          <button className="settings-save-btn" onClick={handleSave} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save breaks'}
          </button>
          <button className="settings-save-btn" onClick={() => setValues(BREAK_DEFAULTS)}>Clear</button>
        </div>
      </div>
      <div className="break-schedule-grid">
        {values.map((v, i) => (
          <label key={i} className="break-schedule-cell">
            <span className="break-schedule-hour-label">Shift hour {i + 1}</span>
            <input type="number" className="est-drops-input" value={v} min={0} max={100} step={1}
              onChange={e => handleChange(i, e.target.value)} />
            <span className="break-schedule-pct-label">% availability</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// ── Dock Assignment Editor ───────────────────────────────────────

function getSide(lane) {
  if (!lane) return null
  if (lane.startsWith('side35')) return 'side35'
  if (lane.startsWith('side12')) return 'side12'
  return null
}

function DockAssignmentEditor() {
  const [employees, setEmployees] = useState([])
  const [saving, setSaving]       = useState({})
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    fetchCal2Employees().then(data => {
      setEmployees(data)
      setLoading(false)
    })
  }, [])

  async function handleToggle(emp, side) {
    if (getSide(emp.default_lane) === side) return  // already on this side
    setSaving(prev => ({ ...prev, [emp.id]: true }))
    const newLane = await upsertEmployeeDockSide(emp.id, side, emp.default_lane)
    setEmployees(prev => prev.map(e => e.id === emp.id ? { ...e, default_lane: newLane } : e))
    setSaving(prev => ({ ...prev, [emp.id]: false }))
  }

  const side12 = employees.filter(e => getSide(e.default_lane) === 'side12')
  const side35 = employees.filter(e => getSide(e.default_lane) === 'side35')
  const unassigned = employees.filter(e => !getSide(e.default_lane))

  if (loading) return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '24px 0' }}>Loading employees…</div>
  if (!employees.length) return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '24px 0' }}>
      No CAL v2 employees found. Run a B2E sync from the CAL v2 roster tab first.
    </div>
  )

  return (
    <div className="dock-assignment-editor">
      <p className="settings-page-sub" style={{ marginBottom: 16 }}>
        Set each employee’s default side. Changes take effect on the next B2E sync or when the page is refreshed.
      </p>

      <div className="dock-assignment-grid">
        {/* 1-2 Side column */}
        <div className="dock-col">
          <div className="dock-col-header dock-col-12">1-2 Side <span className="dock-col-count">{side12.length}</span></div>
          {side12.map(emp => (
            <DockEmployeeRow key={emp.id} emp={emp} activeSide="side12" saving={!!saving[emp.id]} onToggle={handleToggle} />
          ))}
        </div>

        {/* 3.5 Side column */}
        <div className="dock-col">
          <div className="dock-col-header dock-col-35">3.5 Side <span className="dock-col-count">{side35.length}</span></div>
          {side35.map(emp => (
            <DockEmployeeRow key={emp.id} emp={emp} activeSide="side35" saving={!!saving[emp.id]} onToggle={handleToggle} />
          ))}
        </div>
      </div>

      {unassigned.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Unassigned — assign a side</div>
          {unassigned.map(emp => (
            <DockEmployeeRow key={emp.id} emp={emp} activeSide={null} saving={!!saving[emp.id]} onToggle={handleToggle} />
          ))}
        </div>
      )}
    </div>
  )
}

function DockEmployeeRow({ emp, activeSide, saving, onToggle }) {
  const initials = emp.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
  return (
    <div className="dock-emp-row">
      <div className="dock-emp-avatar">{initials}</div>
      <span className="dock-emp-name">{emp.name}</span>
      <div className="dock-emp-actions">
        <button
          className={`dock-side-btn dock-side-12${activeSide === 'side12' ? ' active' : ''}`}
          onClick={() => onToggle(emp, 'side12')}
          disabled={saving || activeSide === 'side12'}
        >
          1-2
        </button>
        <button
          className={`dock-side-btn dock-side-35${activeSide === 'side35' ? ' active' : ''}`}
          onClick={() => onToggle(emp, 'side35')}
          disabled={saving || activeSide === 'side35'}
        >
          3.5
        </button>
      </div>
      {saving && <span className="dock-saving">…</span>}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────

export default function Settings() {
  const [activeTab, setActiveTab] = useState('labor')

  return (
    <div className="page-content">
      {/* Tab row */}
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

      {/* Labor Planning */}
      {activeTab === 'labor' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">Labor Planning Settings</h2>
            <p className="settings-page-sub">Per-facility hours per appointment used to calculate labor requirements.</p>
          </div>
          <div className="settings-grid">
            {FACILITY_LIST.map(f => <FacilitySettingsCard key={f.id} facility={f} />)}
          </div>
        </>
      )}

      {/* Break Assumptions */}
      {activeTab === 'breaks' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">Employee Break Assumptions</h2>
            <p className="settings-page-sub">Set the % of employees available during each hour of their shift. Used to account for lunches, breaks, and startup time.</p>
          </div>
          <BreakScheduleEditor />
        </>
      )}

      {/* Dock Assignment */}
      {activeTab === 'dock' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">CAL v2 Dock Assignment</h2>
            <p className="settings-page-sub">Assign each Caledonia employee to their default side. Persists across B2E syncs.</p>
          </div>
          <DockAssignmentEditor />
        </>
      )}
    </div>
  )
}
