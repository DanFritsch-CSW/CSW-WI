import { useState, useEffect } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchFacilitySettings, upsertFacilitySettings, fetchEstDrops, upsertEstDrops, fetchProjectDrops, upsertProjectDrops } from '../lib/supabase.js'
import { fetchProjectData } from '../lib/omni.js'

// ── Labor Settings ────────────────────────────────────────────────

const FIELD_DEFS = [
  { key: 'hours_per_appt', label: 'Hours / Appt',          min: 0.1, max: 10, step: 0.1, hint: 'Labor hours per appointment (used to calculate required labor)' },
  { key: 'shift1_start',   label: '1st Shift Start (hr)',   min: 0,   max: 23, step: 1,   hint: 'Default start hour for 1st shift employees (0–23) when no B2E schedule is on file' },
  { key: 'shift1_hours',   label: '1st Shift Hours',        min: 1,   max: 16, step: 0.5, hint: 'Duration of a 1st shift in hours' },
  { key: 'mid_start',      label: 'Mid Shift Start (hr)',   min: 0,   max: 23, step: 1,   hint: 'Default start hour for mid shift employees (0–23) when no B2E schedule is on file' },
  { key: 'mid_hours',      label: 'Mid Shift Hours',        min: 1,   max: 16, step: 0.5, hint: 'Duration of a mid shift in hours' },
  { key: 'shift2_start',   label: '2nd Shift Start (hr)',   min: 0,   max: 23, step: 1,   hint: 'Default start hour for 2nd shift employees (0–23) when no B2E schedule is on file' },
  { key: 'shift2_hours',   label: '2nd Shift Hours',        min: 1,   max: 16, step: 0.5, hint: 'Duration of a 2nd shift in hours' },
  { key: 'shift3_start',   label: '3rd Shift Start (hr)',   min: 0,   max: 23, step: 1,   hint: 'Default start hour for 3rd shift employees (0–23) when no B2E schedule is on file' },
  { key: 'shift3_hours',   label: '3rd Shift Hours',        min: 1,   max: 16, step: 0.5, hint: 'Duration of a 3rd shift in hours' },
]

const DEFAULTS = {
  hours_per_appt: 1.5,
  shift1_start: 5,  shift1_hours: 8,
  mid_start:    9,  mid_hours:    8,
  shift2_start: 13, shift2_hours: 8,
  shift3_start: 22, shift3_hours: 8,
}

function FacilitySettingsCard({ facility }) {
  const [values, setValues]   = useState(DEFAULTS)
  const [saveState, setSave]  = useState(null)

  useEffect(() => {
    fetchFacilitySettings(facility.id).then(data => {
      setValues({
        hours_per_appt: data.hours_per_appt ?? DEFAULTS.hours_per_appt,
        shift1_start:   data.shift1_start   ?? DEFAULTS.shift1_start,
        shift1_hours:   data.shift1_hours   ?? DEFAULTS.shift1_hours,
        mid_start:      data.mid_start      ?? DEFAULTS.mid_start,
        mid_hours:      data.mid_hours      ?? DEFAULTS.mid_hours,
        shift2_start:   data.shift2_start   ?? DEFAULTS.shift2_start,
        shift2_hours:   data.shift2_hours   ?? DEFAULTS.shift2_hours,
        shift3_start:   data.shift3_start   ?? DEFAULTS.shift3_start,
        shift3_hours:   data.shift3_hours   ?? DEFAULTS.shift3_hours,
      })
    })
  }, [facility.id])

  function handleChange(key, raw) {
    const num = parseFloat(raw)
    setValues(prev => ({ ...prev, [key]: isNaN(num) ? raw : num }))
  }

  async function handleSave() {
    setSave('saving')
    try {
      await upsertFacilitySettings(facility.id, values)
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
        {FIELD_DEFS.map(({ key, label, min, max, step, hint }) => (
          <label key={key} className="settings-field" title={hint}>
            <span className="settings-field-label">{label}</span>
            <input
              type="number"
              className="settings-field-input"
              value={values[key]}
              min={min}
              max={max}
              step={step}
              onChange={e => handleChange(key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="settings-card-footer">
        <button
          className="settings-save-btn"
          onClick={handleSave}
          disabled={saveState === 'saving'}
        >
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Break Schedule Editor ─────────────────────────────────────────

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

  function handleClear() {
    setValues(BREAK_DEFAULTS)
  }

  return (
    <div className="break-schedule-editor">
      <div className="break-schedule-controls">
        <div className="break-schedule-warehouse">
          <span className="break-schedule-warehouse-label">Warehouse</span>
          <select
            className="est-drops-select"
            value={facility}
            onChange={e => setFacility(e.target.value)}
          >
            {FACILITY_LIST.map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
        <div className="break-schedule-actions">
          <button
            className="settings-save-btn"
            onClick={handleSave}
            disabled={saveState === 'saving'}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save breaks'}
          </button>
          <button className="settings-save-btn" onClick={handleClear}>
            Clear
          </button>
        </div>
      </div>
      <div className="break-schedule-grid">
        {values.map((v, i) => (
          <label key={i} className="break-schedule-cell">
            <span className="break-schedule-hour-label">Shift hour {i + 1}</span>
            <input
              type="number"
              className="est-drops-input"
              value={v}
              min={0}
              max={100}
              step={1}
              onChange={e => handleChange(i, e.target.value)}
            />
            <span className="break-schedule-pct-label">% availability</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// ── Est Drops Editor ──────────────────────────────────────────────

const SHIFT_HOURS = [5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4]

function fmtHour(h) {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function EstDropsEditor() {
  const [facility, setFacility] = useState(FACILITY_LIST[0].id)
  const [date, setDate]         = useState(todayISO)
  const [values, setValues]     = useState(() => Object.fromEntries(SHIFT_HOURS.map(h => [h, 0])))
  const [saveState, setSave]    = useState(null)

  useEffect(() => {
    fetchEstDrops(facility, date).then(data => {
      setValues(Object.fromEntries(SHIFT_HOURS.map(h => [h, data[h] ?? 0])))
    })
  }, [facility, date])

  function handleChange(h, raw) {
    const num = parseInt(raw, 10)
    setValues(prev => ({ ...prev, [h]: isNaN(num) ? 0 : Math.max(0, num) }))
  }

  async function handleSave() {
    setSave('saving')
    try {
      await upsertEstDrops(facility, date, SHIFT_HOURS.map(h => ({ h, est: values[h] })))
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  const fac = FACILITY_LIST.find(f => f.id === facility)

  return (
    <div className="est-drops-editor">
      <div className="est-drops-controls">
        <select
          className="est-drops-select"
          value={facility}
          onChange={e => setFacility(e.target.value)}
        >
          {FACILITY_LIST.map(f => (
            <option key={f.id} value={f.id}>{f.name} ({f.code})</option>
          ))}
        </select>
        <input
          type="date"
          className="est-drops-date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{ colorScheme: 'dark' }}
        />
        <button
          className="settings-save-btn"
          onClick={handleSave}
          disabled={saveState === 'saving'}
        >
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
      </div>
      <div className="est-drops-grid">
        {SHIFT_HOURS.map(h => (
          <label key={h} className="est-drops-cell">
            <span className="est-drops-hour" style={{ color: fac?.color }}>{fmtHour(h)}</span>
            <input
              type="number"
              className="est-drops-input"
              value={values[h]}
              min={0}
              step={1}
              onChange={e => handleChange(h, e.target.value)}
            />
          </label>
        ))}
      </div>
    </div>
  )
}

// ── Project Drops Editor ──────────────────────────────────────────

function ProjectDropsEditor() {
  const [facility, setFacility] = useState(FACILITY_LIST[0].id)
  const [date, setDate]         = useState(todayISO)
  const [projects, setProjects] = useState([])      // [{ name }] from Omni
  const [values, setValues]     = useState({})      // { [project_name]: est_drops }
  const [loading, setLoading]   = useState(false)
  const [saveState, setSave]    = useState(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetchProjectData(facility, date),
      fetchProjectDrops(facility, date),
    ]).then(([omniProjects, saved]) => {
      setProjects(omniProjects.map(p => ({ name: p.name })))
      const init = {}
      omniProjects.forEach(p => { init[p.name] = saved[p.name] ?? 0 })
      setValues(init)
    }).finally(() => setLoading(false))
  }, [facility, date])

  function handleChange(name, raw) {
    const num = parseInt(raw, 10)
    setValues(prev => ({ ...prev, [name]: isNaN(num) ? 0 : Math.max(0, num) }))
  }

  async function handleSave() {
    setSave('saving')
    try {
      const rows = projects.map(p => ({ project_name: p.name, est_drops: values[p.name] ?? 0 }))
      await upsertProjectDrops(facility, date, rows)
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  const fac = FACILITY_LIST.find(f => f.id === facility)

  return (
    <div className="est-drops-editor">
      <div className="est-drops-controls">
        <select
          className="est-drops-select"
          value={facility}
          onChange={e => setFacility(e.target.value)}
        >
          {FACILITY_LIST.map(f => (
            <option key={f.id} value={f.id}>{f.name} ({f.code})</option>
          ))}
        </select>
        <input
          type="date"
          className="est-drops-date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{ colorScheme: 'dark' }}
        />
        <button
          className="settings-save-btn"
          onClick={handleSave}
          disabled={saveState === 'saving' || loading}
        >
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
      </div>
      {loading ? (
        <div style={{ padding: '12px', fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          Loading projects…
        </div>
      ) : projects.length === 0 ? (
        <div style={{ padding: '12px', fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          No projects found for this facility / date. Try selecting a recent business day.
        </div>
      ) : (
        <div className="project-drops-list">
          {projects.map(p => (
            <label key={p.name} className="project-drops-row">
              <span className="project-drops-name" style={{ color: fac?.color }}>{p.name}</span>
              <input
                type="number"
                className="est-drops-input"
                value={values[p.name] ?? 0}
                min={0}
                step={1}
                onChange={e => handleChange(p.name, e.target.value)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <div className="page-content">
      <div className="settings-page-header">
        <h2 className="settings-page-title">Labor Planning Settings</h2>
        <p className="settings-page-sub">Per-facility parameters used to calculate labor requirements and availability.</p>
      </div>
      <div className="settings-grid">
        {FACILITY_LIST.map(f => (
          <FacilitySettingsCard key={f.id} facility={f} />
        ))}
      </div>

      <div className="gold-line" style={{ margin: '28px 0 20px' }} />

      <div className="settings-page-header">
        <h2 className="settings-page-title">Employee Break Assumptions</h2>
        <p className="settings-page-sub">Set the % of employees available during each hour of their shift. Used to account for lunches, breaks, and startup time.</p>
      </div>
      <BreakScheduleEditor />

      <div className="gold-line" style={{ margin: '28px 0 20px' }} />

      <div className="settings-page-header">
        <h2 className="settings-page-title">Estimated Drops — By Project</h2>
        <p className="settings-page-sub">Set forecasted drop counts per project for a facility and date. Displayed in the Projects Table alongside actuals.</p>
      </div>
      <ProjectDropsEditor />

      <div className="gold-line" style={{ margin: '28px 0 20px' }} />

      <div className="settings-page-header">
        <h2 className="settings-page-title">Estimated Drops — Hourly</h2>
        <p className="settings-page-sub">Manual hourly drop forecast used in the Hourly Breakdown chart. Auto-populated from historical averages when a date has no prior entries.</p>
      </div>
      <EstDropsEditor />
    </div>
  )
}
