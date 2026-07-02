import { useState, useEffect } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import {
  fetchFacilitySettings, upsertFacilitySettings,
  fetchCal2Employees, upsertEmployeeDockSide,
  fetchCustomDropProjects, addCustomDropProject, deleteCustomDropProject,
  fetchProjectLaborAssumptions,
  upsertProjectLaborAssumption, deleteProjectLaborAssumption,
} from '../lib/supabase.js'
import { PROJECT_DROP_RULES, KEN_GUARANTEED_PROJECTS, fetchKnownProjectsByFacility } from '../lib/omni.js'
import PviAccountsTab from '../components/settings/PviAccountsTab.jsx'

// ── Tab nav ────────────────────────────────────────────────

const TABS = [
  { id: 'labor',    label: 'Labor Planning' },
  { id: 'breaks',   label: 'Break Assumptions' },
  { id: 'dock',     label: 'CAL Dock Assignment' },
  { id: 'estdrops', label: 'EST Drop Projects' },
  { id: 'pvi',      label: 'PVI Accounts' },
]

// Hardcoded EST drop projects per facility (mirrors PROJECT_DROP_RULES in omni.js).
// These are system-managed and cannot be removed from the UI.
const SYSTEM_DROP_PROJECTS = {
  cal: [
    { project_name: 'Palermos CALEDONIA finished', omni_name: 'Palermos CALEDONIA finished', note: 'Inbound only, excludes PUR+CMM and PUR+Peter Brothers' },
  ],
  ken: [
    { project_name: 'CROWN BAKERIES',                  omni_name: 'CROWN BAKERIES',                  note: 'All inbounds' },
    { project_name: 'Pretzilla Kenosha',               omni_name: 'Pretzilla Kenosha',               note: 'All inbounds' },
    { project_name: 'Birchwood Foods Kenosha',         omni_name: 'BIRCHWOOD FOODS  KENOSHA',         note: 'All inbounds (Omni name has double space)' },
    { project_name: 'Fair Oaks Farms',                 omni_name: 'FAIR OAKS FARMS + FAIR OAKS FARMS WEST', note: 'Merged — both Omni projects combined into one display row' },
    { project_name: 'RICHELIEU KENOSHA',               omni_name: 'RICHELIEU KENOSHA',               note: 'Inbounds with TOP or PSH lookup code' },
    { project_name: 'RICHELIEU RAW MATERIALS KENOSHA', omni_name: 'RICHELIEU RAW MATERIALS KENOSHA', note: 'Inbounds with TOP or PSH lookup code' },
  ],
  mad: [],
  wr:  [],
  ec:  [],
}

// ── Labor Settings ─────────────────────────────────────────

const DEFAULTS = { hours_per_appt: 1.5 }

function ProjectHpaEditor({ facility, facilityHpa, knownProjects, knownProjectsLoading }) {
  const [customNames, setCustomNames] = useState([])
  const [overrides, setOverrides] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [customRows, overrideMap] = await Promise.all([
          fetchCustomDropProjects(facility),
          fetchProjectLaborAssumptions(facility),
        ])
        if (cancelled) return
        setCustomNames(customRows.map(r => r.project_name))
        setOverrides(overrideMap)
      } catch (err) {
        console.error('ProjectHpaEditor load', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [facility])

  async function handleSave(projectName, rawValue) {
    const trimmed = (rawValue ?? '').toString().trim()
    if (trimmed === '') {
      if (overrides.has(projectName)) {
        setSaving(projectName)
        try {
          await deleteProjectLaborAssumption(facility, projectName)
          setOverrides(m => { const n = new Map(m); n.delete(projectName); return n })
        } catch (err) {
          alert(`Failed to clear override for ${projectName}: ${err.message}`)
        } finally {
          setSaving(null)
        }
      }
      return
    }
    const num = Number(trimmed)
    if (!Number.isFinite(num) || num <= 0 || num > 99) {
      alert(`HPA must be a number between 0 and 99 (got "${trimmed}")`)
      return
    }
    // Treat "same as facility default" as clear rather than saving a no-op row.
    if (Math.abs(num - facilityHpa) < 0.001) {
      if (overrides.has(projectName)) {
        setSaving(projectName)
        try {
          await deleteProjectLaborAssumption(facility, projectName)
          setOverrides(m => { const n = new Map(m); n.delete(projectName); return n })
        } catch (err) {
          alert(`Failed to clear override for ${projectName}: ${err.message}`)
        } finally {
          setSaving(null)
        }
      }
      return
    }
    setSaving(projectName)
    try {
      await upsertProjectLaborAssumption(facility, projectName, num)
      setOverrides(m => { const n = new Map(m); n.set(projectName, num); return n })
    } catch (err) {
      alert(`Failed to save override for ${projectName}: ${err.message}`)
    } finally {
      setSaving(null)
    }
  }

  const ruleNames = Object.entries(PROJECT_DROP_RULES || {})
    .filter(([, rule]) => rule?.facility === facility)
    .map(([name]) => name)
  const guaranteed = facility === 'ken' ? (KEN_GUARANTEED_PROJECTS || []) : []
  const projects = Array.from(new Set([...(knownProjects || []), ...ruleNames, ...guaranteed, ...customNames]))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))

  if (loading || knownProjectsLoading) return <div className="project-hpa-loading">Loading projects…</div>

  if (projects.length === 0) {
    return <div className="project-hpa-empty">No projects found for this facility yet.</div>
  }

  return (
    <div className="project-hpa-editor">
      <div className="project-hpa-header">
        <h4>Per-project Hours/Appt</h4>
        <span className="project-hpa-help">
          Overrides facility default ({facilityHpa}). Blank = use facility default.
        </span>
      </div>
      <table className="project-hpa-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Hrs/Appt</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {projects.map(name => {
            const hasOverride = overrides.has(name)
            const value = hasOverride ? overrides.get(name) : ''
            const isSaving = saving === name
            return (
              <tr key={name} className={hasOverride ? 'project-hpa-row--override' : ''}>
                <td className="project-hpa-name">{name}</td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="99"
                    defaultValue={value}
                    placeholder={String(facilityHpa)}
                    disabled={isSaving}
                    onBlur={e => handleSave(name, e.target.value)}
                  />
                </td>
                <td>
                  {hasOverride && (
                    <button
                      className="project-hpa-clear"
                      disabled={isSaving}
                      onClick={() => handleSave(name, '')}
                    >
                      Clear
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FacilitySettingsCard({ facility, knownProjects, knownProjectsLoading }) {
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
        <label className="settings-field" title="Labor hours required per appointment">
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
      <ProjectHpaEditor
        facility={facility.id}
        facilityHpa={hpa}
        knownProjects={knownProjects}
        knownProjectsLoading={knownProjectsLoading}
      />
      <div className="settings-card-footer">
        <button className="settings-save-btn" onClick={handleSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Break Schedule Editor ───────────────────────────────────

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
          <button className="settings-save-btn" onClick={() => setValues(BREAK_DEFAULTS)}>Reset</button>
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

// ── Dock Assignment Editor ────────────────────────────────

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
    if (getSide(emp.default_lane) === side) return
    setSaving(prev => ({ ...prev, [emp.id]: true }))
    const newLane = await upsertEmployeeDockSide(emp.id, side, emp.default_lane)
    setEmployees(prev => prev.map(e => e.id === emp.id ? { ...e, default_lane: newLane } : e))
    setSaving(prev => ({ ...prev, [emp.id]: false }))
  }

  const side12     = employees.filter(e => getSide(e.default_lane) === 'side12')
  const side35     = employees.filter(e => getSide(e.default_lane) === 'side35')
  const unassigned = employees.filter(e => !getSide(e.default_lane))

  if (loading) return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '24px 0' }}>Loading employees…</div>
  if (!employees.length) return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '24px 0' }}>
      No CAL employees found. Run a B2E sync from the CAL roster tab first.
    </div>
  )

  return (
    <div className="dock-assignment-editor">
      <p className="settings-page-sub" style={{ marginBottom: 16 }}>
        Set each employee’s default side. Changes take effect on next B2E sync or page refresh.
      </p>
      <div className="dock-assignment-grid">
        <div className="dock-col">
          <div className="dock-col-header dock-col-12">1-2 Side <span className="dock-col-count">{side12.length}</span></div>
          {side12.map(emp => <DockEmployeeRow key={emp.id} emp={emp} activeSide="side12" saving={!!saving[emp.id]} onToggle={handleToggle} />)}
        </div>
        <div className="dock-col">
          <div className="dock-col-header dock-col-35">3.5 Side <span className="dock-col-count">{side35.length}</span></div>
          {side35.map(emp => <DockEmployeeRow key={emp.id} emp={emp} activeSide="side35" saving={!!saving[emp.id]} onToggle={handleToggle} />)}
        </div>
      </div>
      {unassigned.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Unassigned</div>
          {unassigned.map(emp => <DockEmployeeRow key={emp.id} emp={emp} activeSide={null} saving={!!saving[emp.id]} onToggle={handleToggle} />)}
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
        <button className={`dock-side-btn dock-side-12${activeSide === 'side12' ? ' active' : ''}`}
          onClick={() => onToggle(emp, 'side12')} disabled={saving || activeSide === 'side12'}>1-2</button>
        <button className={`dock-side-btn dock-side-35${activeSide === 'side35' ? ' active' : ''}`}
          onClick={() => onToggle(emp, 'side35')} disabled={saving || activeSide === 'side35'}>3.5</button>
      </div>
      {saving && <span className="dock-saving">…</span>}
    </div>
  )
}

// ── EST Drop Projects Editor ────────────────────────────────

function EstDropProjectsEditor() {
  const [facility, setFacility]   = useState(FACILITY_LIST[0].id)
  const [custom, setCustom]       = useState([])
  const [loading, setLoading]     = useState(false)
  const [newName, setNewName]     = useState('')
  const [newOmni, setNewOmni]     = useState('')
  const [adding, setAdding]       = useState(false)
  const [error, setError]         = useState(null)

  useEffect(() => {
    setLoading(true)
    setCustom([])
    fetchCustomDropProjects(facility)
      .then(data => { setCustom(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [facility])

  async function handleAdd() {
    if (!newName.trim() || !newOmni.trim()) { setError('Both fields are required.'); return }
    setAdding(true)
    setError(null)
    const row = await addCustomDropProject(facility, newName, newOmni)
    if (row) {
      setCustom(prev => [...prev, row].sort((a, b) => a.project_name.localeCompare(b.project_name)))
      setNewName('')
      setNewOmni('')
    } else {
      setError('Failed to add — check that the display name is unique for this facility.')
    }
    setAdding(false)
  }

  async function handleDelete(id) {
    await deleteCustomDropProject(id)
    setCustom(prev => prev.filter(p => p.id !== id))
  }

  const systemProjects = SYSTEM_DROP_PROJECTS[facility] ?? []
  const hasAny = systemProjects.length > 0 || custom.length > 0

  return (
    <div className="est-drops-editor">
      <div className="break-schedule-controls" style={{ marginBottom: 20 }}>
        <div className="break-schedule-warehouse">
          <span className="break-schedule-warehouse-label">Facility</span>
          <select className="est-drops-select" value={facility} onChange={e => { setFacility(e.target.value); setError(null) }}>
            {FACILITY_LIST.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      </div>

      {/* Unified project table */}
      {loading
        ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>Loading…</div>
        : !hasAny
          ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>No EST drop projects configured for this facility yet.</div>
          : (
            <table className="hourly-table" style={{ marginBottom: 20 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Display Name</th>
                  <th style={{ textAlign: 'left' }}>Omni Project Name</th>
                  <th style={{ textAlign: 'left' }}>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {/* System (hardcoded) projects — read-only */}
                {systemProjects.map(p => (
                  <tr key={p.project_name}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{p.project_name}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>{p.omni_name}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>{p.note}</td>
                    <td>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', padding: '2px 6px' }}>system</span>
                    </td>
                  </tr>
                ))}
                {/* Custom (user-managed) projects — removable */}
                {custom.map(p => (
                  <tr key={p.id}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{p.project_name}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>{p.omni_name}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>All inbounds</td>
                    <td>
                      <button
                        className="settings-save-btn"
                        style={{ color: '#e05a5a', borderColor: '#e05a5a' }}
                        onClick={() => handleDelete(p.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      }

      {/* Add new */}
      <div className="settings-page-sub" style={{ marginBottom: 8, fontWeight: 600 }}>Add a project</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Display name (shown in app)</span>
          <input
            className="settings-field-input"
            style={{ width: 200 }}
            placeholder="e.g. Good Foods Group"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Exact Omni project name</span>
          <input
            className="settings-field-input"
            style={{ width: 260 }}
            placeholder="e.g. GOOD FOODS GROUP"
            value={newOmni}
            onChange={e => setNewOmni(e.target.value)}
          />
        </label>
        <button className="settings-save-btn" onClick={handleAdd} disabled={adding}>
          {adding ? 'Adding…' : '+ Add'}
        </button>
      </div>
      {error && <div style={{ fontSize: 11, color: '#e05a5a', fontFamily: 'var(--font-mono)', marginBottom: 8 }}>{error}</div>}
      <p className="settings-page-sub" style={{ marginTop: 4 }}>
        <strong>System projects</strong> are hardcoded and cannot be removed here — contact your developer to modify them.
        <br />
        <strong>Custom projects</strong> count all inbound appointments for the given Omni project name.
        The Omni name must match exactly (case-sensitive, including spaces). After adding, use ↺ Reset EST Drops on the facility tab to pull the 4-week historical average immediately.
      </p>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────

export default function Settings() {
  const [activeTab, setActiveTab] = useState('labor')
  const [knownProjects, setKnownProjects] = useState(null) // null = loading

  useEffect(() => {
    let cancelled = false
    fetchKnownProjectsByFacility(30)
      .then(map => { if (!cancelled) setKnownProjects(map) })
      .catch(err => {
        console.warn('fetchKnownProjectsByFacility failed', err)
        if (!cancelled) setKnownProjects(new Map())
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="page-content">
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

      {activeTab === 'labor' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">Labor Planning Settings</h2>
            <p className="settings-page-sub">Per-facility hours per appointment used to calculate labor requirements.</p>
          </div>
          <div className="settings-grid">
            {FACILITY_LIST.map(f => (
              <FacilitySettingsCard
                key={f.id}
                facility={f}
                knownProjects={knownProjects?.get(f.id) ?? []}
                knownProjectsLoading={knownProjects === null}
              />
            ))}
          </div>
        </>
      )}

      {activeTab === 'breaks' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">Employee Break Assumptions</h2>
            <p className="settings-page-sub">% of employees available during each hour of their shift. Accounts for lunches, breaks, and startup time.</p>
          </div>
          <BreakScheduleEditor />
        </>
      )}

      {activeTab === 'dock' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">CAL Dock Assignment</h2>
            <p className="settings-page-sub">Assign each Caledonia employee to their default side. Persists across B2E syncs.</p>
          </div>
          <DockAssignmentEditor />
        </>
      )}

      {activeTab === 'estdrops' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">EST Drop Projects</h2>
            <p className="settings-page-sub">All customers tracked in the hourly EST drops table, by facility. System projects are managed in code. Custom projects can be added or removed here.</p>
          </div>
          <EstDropProjectsEditor />
        </>
      )}

      {activeTab === 'pvi' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">PVI Accounts (Palermo's Shelf Life)</h2>
            <p className="settings-page-sub">Canonical customer accounts + raw Datex ship-to name mappings + shelf-life days per customer. Drives the PVI Shelf Life dashboard on the Customers tab.</p>
          </div>
          <PviAccountsTab />
        </>
      )}
    </div>
  )
}
