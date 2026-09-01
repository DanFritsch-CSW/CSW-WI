import { useState, useEffect } from 'react'
import { FACILITY_LIST, FACILITIES } from '../lib/constants.js'
import {
  fetchFacilitySettings, upsertFacilitySettings,
  fetchCal2Employees, upsertEmployeeDockSide,
  fetchCustomDropProjects, addCustomDropProject, deleteCustomDropProject,
  fetchProjectLaborAssumptions,
  upsertProjectLaborAssumption, deleteProjectLaborAssumption,
  fetchDailyDiscussionConfigs, upsertDailyDiscussionConfigActive,
  fetchFrontTeammates, fetchDiscussionRecipients, saveDiscussionRecipients,
  triggerDailyDiscussionTest, triggerDigestTest,
} from '../lib/supabase.js'
import {
  fetchCmmOutboundSettings, upsertCmmOutboundSettings,
  fetchCmmOutboundEmailRecipients, saveCmmOutboundEmailRecipients,
  fetchCmmOutboundDiscussionRecipients, saveCmmOutboundDiscussionRecipients,
  fetchFrontChannels, triggerFrontChannelsSync,
} from '../lib/cmmOutbound.js'
import { PROJECT_DROP_RULES, KEN_GUARANTEED_PROJECTS, fetchKnownProjectsByFacility } from '../lib/omni.js'
import { fetchCronHealth } from '../lib/cronHealth.js'
import PviAccountsTab from '../components/settings/PviAccountsTab.jsx'
import DailyDiscussionEmailEditor from '../components/settings/DailyDiscussionEmailEditor.jsx'

// ── Tab nav ────────────────────────────────────────────────

const TABS = [
  { id: 'labor',       label: 'Labor Planning' },
  { id: 'breaks',      label: 'Break Assumptions' },
  { id: 'dock',        label: 'CAL Dock Assignment' },
  { id: 'estdrops',    label: 'EST Drop Projects' },
  { id: 'pvi',         label: 'PVI Accounts' },
  { id: 'discussions', label: 'Daily Discussions' },
  { id: 'cmmOutbound', label: 'CMM Outbound Appts' },
  { id: 'b2eSync',     label: 'B2E Sync Health' },
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

// ── Daily Discussions Editor ────────────────────────────────
//
// Manages front_daily_discussion_configs (per-facility active toggle) and
// notification_recipients (list_name = daily_discussion_<facility>). See
// front-daily-discussion-run.cjs for the scheduled side.
//
// Also renders DailyDiscussionEmailEditor below (added 2026-09-01, see
// that component's own header for the full story) — a completely
// separate, additional email-draft capability sharing this component's
// `facility` and `teammates` state so facility selection stays a single
// dropdown rather than two.

function DailyDiscussionsEditor() {
  const [configs, setConfigs]     = useState([])
  const [teammates, setTeammates] = useState([])
  const [facility, setFacility]   = useState(FACILITY_LIST[0].id)
  const [selected, setSelected]   = useState(new Set())
  const [loading, setLoading]     = useState(true)
  const [recipientsLoading, setRecipientsLoading] = useState(true)
  const [saveState, setSave]      = useState(null)
  const [testState, setTestState] = useState(null)
  const [testDetail, setTestDetail] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [cfgs, tms] = await Promise.all([fetchDailyDiscussionConfigs(), fetchFrontTeammates()])
      if (cancelled) return
      setConfigs(cfgs)
      setTeammates(tms)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setRecipientsLoading(true)
    fetchDiscussionRecipients(facility).then(rows => {
      if (cancelled) return
      setSelected(new Set(rows.filter(r => r.front_teammate_id).map(r => r.front_teammate_id)))
      setRecipientsLoading(false)
    })
    return () => { cancelled = true }
  }, [facility])

  const config = configs.find(c => c.facility === facility)

  async function handleToggleActive() {
    const next = !config?.active
    setConfigs(prev => prev.map(c => c.facility === facility ? { ...c, active: next } : c))
    await upsertDailyDiscussionConfigActive(facility, next)
  }

  function toggleTeammate(teammateId) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(teammateId)) next.delete(teammateId)
      else next.add(teammateId)
      return next
    })
  }

  async function handleSave() {
    setSave('saving')
    const chosen = teammates.filter(t => selected.has(t.teammate_id))
    try {
      await saveDiscussionRecipients(facility, chosen)
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  async function handleTest() {
    setTestState('running')
    setTestDetail(null)
    try {
      // Save current checkbox state first — otherwise a freshly-checked
      // teammate who hasn't been saved yet produces a confusing "no active
      // recipients" failure even though the picker clearly shows them checked.
      const chosen = teammates.filter(t => selected.has(t.teammate_id))
      await saveDiscussionRecipients(facility, chosen)
      const res = await triggerDailyDiscussionTest(facility)
      const result = res?.results?.[0]
      if (result?.ok) {
        setTestState('ok')
        setTestDetail(`Created "${result.subject}" with ${result.recipientCount} recipient(s).`)
      } else {
        setTestState('error')
        setTestDetail(result?.reason || 'No result returned.')
      }
    } catch (err) {
      setTestState('error')
      setTestDetail(err.message)
    }
    setTimeout(() => { setTestState(null); setTestDetail(null) }, 6000)
  }

  if (loading) {
    return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '24px 0' }}>Loading…</div>
  }

  const facilityName = FACILITIES[facility]?.name ?? facility
  const selectedCount = selected.size

  return (
    <div className="daily-discussions-editor">
      <div className="break-schedule-controls" style={{ marginBottom: 16 }}>
        <div className="break-schedule-warehouse">
          <span className="break-schedule-warehouse-label">Facility</span>
          <select className="est-drops-select" value={facility} onChange={e => setFacility(e.target.value)}>
            {FACILITY_LIST.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={!!config?.active} onChange={handleToggleActive} />
          Auto-create daily discussion (6pm CT, for the next day)
        </label>
      </div>

      <p className="settings-page-sub" style={{ marginBottom: 12 }}>
        Recipients get added to a new Front discussion titled "{facilityName} Weekday M/D", created the evening before.
        Only people with a resolved Front teammate ID (synced nightly) can be selected — {teammates.length} available.
        {selectedCount > 0 && <> Currently selected: <strong>{selectedCount}</strong>.</>}
      </p>

      {recipientsLoading ? (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>Loading recipients…</div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6,
          maxHeight: 340, overflowY: 'auto', padding: 8, border: '1px solid var(--border)', borderRadius: 4,
        }}>
          {teammates.map(t => {
            const label = [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email
            const checked = selected.has(t.teammate_id)
            return (
              <label
                key={t.teammate_id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 3,
                  fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
                  background: checked ? 'var(--brand-bg, rgba(61,186,126,0.12))' : 'transparent',
                }}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleTeammate(t.teammate_id)} />
                <span>{label}</span>
              </label>
            )
          })}
        </div>
      )}

      <div className="settings-card-footer" style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="settings-save-btn" onClick={handleSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save recipients'}
        </button>
        <button className="settings-save-btn" onClick={handleTest} disabled={testState === 'running' || !config?.active}>
          {testState === 'running' ? 'Creating…' : testState === 'ok' ? 'Created ✓' : testState === 'error' ? 'Failed' : 'Create Now (test)'}
        </button>
        {testDetail && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: testState === 'error' ? '#e05a5a' : 'var(--text-dim)' }}>
            {testDetail}
          </span>
        )}
      </div>
      {!config?.active && (
        <p className="settings-page-sub" style={{ marginTop: 8, fontStyle: 'italic' }}>
          Turn on the checkbox above to enable both the nightly auto-create and the test button for this facility.
        </p>
      )}

      <DailyDiscussionEmailEditor facility={facility} teammates={teammates} />
    </div>
  )
}

// ── CMM Outbound Appts (Caledonia) ──────────────────────────
//
// Single-facility tab (cal only — the only warehouse this appt filter
// currently targets). Four independent pieces, matching
// cmm-outbound-draft-create.cjs exactly:
//   1. Send time / days / active toggle (prepick_notify_settings)
//   2. TO/CC email recipients (cmm_outbound_email_recipients) — external
//      addresses that land on the draft itself
//   3. From channel picker (front_channels) + Draft Author — two SEPARATE
//      concepts. Front ties the From address to the channel a draft is
//      created on, NOT to the author (author just controls who Front shows
//      as the draft's owner). Added 2026-07-19 after Dan noticed drafts
//      always showed "From: cswmain@csw-wi.com" regardless of Draft Author.
//   4. Discussion comment + internal teammate picker (front_teammate_id
//      followers) — people who see the internal note, not the email

const CMM_FACILITY = 'cal'

function EmailListEditor({ label, emails, onChange }) {
  const [draft, setDraft] = useState('')

  function addEmail() {
    const trimmed = draft.trim().toLowerCase()
    if (!trimmed) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      alert(`"${trimmed}" doesn't look like a valid email address.`)
      return
    }
    if (emails.includes(trimmed)) { setDraft(''); return }
    onChange([...emails, trimmed])
    setDraft('')
  }

  function removeEmail(email) {
    onChange(emails.filter(e => e !== email))
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {emails.map(email => (
          <span key={email} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 3,
            fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--brand-bg, rgba(61,186,126,0.12))',
          }}>
            {email}
            <button
              onClick={() => removeEmail(email)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12, lineHeight: 1, padding: 0 }}
              aria-label={`Remove ${email}`}
            >×</button>
          </span>
        ))}
        {emails.length === 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>None added yet.</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="email"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEmail() } }}
          placeholder="name@example.com"
          className="est-drops-select"
          style={{ flex: 1 }}
        />
        <button className="settings-save-btn" onClick={addEmail}>Add</button>
      </div>
    </div>
  )
}

function CmmOutboundApptsEditor() {
  const [settings, setSettings]   = useState(null)
  const [teammates, setTeammates] = useState([])
  const [channels, setChannels]   = useState([])
  const [syncingChannels, setSyncingChannels] = useState(false)
  const [toEmails, setToEmails]   = useState([])
  const [ccEmails, setCcEmails]   = useState([])
  const [selectedDiscussion, setSelectedDiscussion] = useState(new Set())
  const [comment, setComment]     = useState('')
  const [authorId, setAuthorId]   = useState('')
  const [channelId, setChannelId] = useState('')
  const [notifyHour, setNotifyHour] = useState(18)
  const [notifyMinute, setNotifyMinute] = useState(0)
  const [notifyDays, setNotifyDays] = useState([1, 2, 3, 4, 5, 6, 7])
  const [active, setActive]       = useState(false)
  const [loading, setLoading]     = useState(true)
  const [saveState, setSave]      = useState(null)
  const [testState, setTestState] = useState(null)
  const [testDetail, setTestDetail] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [s, tms, chans, emails, discussion] = await Promise.all([
        fetchCmmOutboundSettings(CMM_FACILITY),
        fetchFrontTeammates(),
        fetchFrontChannels(),
        fetchCmmOutboundEmailRecipients(CMM_FACILITY),
        fetchCmmOutboundDiscussionRecipients(CMM_FACILITY),
      ])
      if (cancelled) return
      setSettings(s)
      setTeammates(tms)
      setChannels(chans)
      setToEmails((emails.to || []).map(r => r.email))
      setCcEmails((emails.cc || []).map(r => r.email))
      setSelectedDiscussion(new Set(discussion.filter(r => r.front_teammate_id).map(r => r.front_teammate_id)))
      if (s) {
        setNotifyHour(s.notify_hour ?? 18)
        setNotifyMinute(s.notify_minute ?? 0)
        setNotifyDays(s.notify_days ?? [1, 2, 3, 4, 5, 6, 7])
        setActive(!!s.active)
        setComment(s.discussion_comment ?? '')
        setAuthorId(s.author_teammate_id ?? '')
        setChannelId(s.from_channel_id ?? '')
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  function toggleDay(day) {
    setNotifyDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort())
  }

  function toggleTeammate(teammateId) {
    setSelectedDiscussion(prev => {
      const next = new Set(prev)
      if (next.has(teammateId)) next.delete(teammateId)
      else next.add(teammateId)
      return next
    })
  }

  async function handleSyncChannels() {
    setSyncingChannels(true)
    try {
      await triggerFrontChannelsSync()
      setChannels(await fetchFrontChannels())
    } catch (err) {
      alert(`Failed to sync channels: ${err.message}`)
    } finally {
      setSyncingChannels(false)
    }
  }

  async function handleSave() {
    setSave('saving')
    try {
      await Promise.all([
        upsertCmmOutboundSettings(CMM_FACILITY, {
          notifyHour, notifyMinute, notifyDays, active,
          discussionComment: comment, authorTeammateId: authorId || null, fromChannelId: channelId || null,
        }),
        saveCmmOutboundEmailRecipients(CMM_FACILITY, toEmails, ccEmails),
        saveCmmOutboundDiscussionRecipients(
          CMM_FACILITY,
          teammates.filter(t => selectedDiscussion.has(t.teammate_id))
        ),
      ])
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch (err) {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  async function handleTest() {
    setTestState('running')
    setTestDetail(null)
    try {
      // Save current state first — same reasoning as Daily Discussions'
      // handleTest: a freshly-edited field that hasn't been saved yet would
      // otherwise produce a confusing result that doesn't match what's on screen.
      await Promise.all([
        upsertCmmOutboundSettings(CMM_FACILITY, {
          notifyHour, notifyMinute, notifyDays, active,
          discussionComment: comment, authorTeammateId: authorId || null, fromChannelId: channelId || null,
        }),
        saveCmmOutboundEmailRecipients(CMM_FACILITY, toEmails, ccEmails),
        saveCmmOutboundDiscussionRecipients(
          CMM_FACILITY,
          teammates.filter(t => selectedDiscussion.has(t.teammate_id))
        ),
      ])
      const res = await triggerDigestTest('cmm-outbound-draft-create-test', { facility: CMM_FACILITY })
      if (res?.success) {
        setTestState('ok')
        setTestDetail(`Draft created: "${res.subject}" — ${res.apptCount} appt(s), ${res.toCount} TO / ${res.ccCount} CC, ${res.followerCount} follower(s).`)
      } else {
        setTestState('error')
        setTestDetail(res?.reason || 'No result returned.')
      }
    } catch (err) {
      setTestState('error')
      setTestDetail(err.message)
    }
    setTimeout(() => { setTestState(null); setTestDetail(null) }, 8000)
  }

  if (loading) {
    return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '24px 0' }}>Loading…</div>
  }

  const DAY_LABELS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 7]]

  return (
    <div className="cmm-outbound-editor">
      <p className="settings-page-sub" style={{ marginBottom: 16 }}>
        Creates a Front <strong>email draft</strong> (never sent automatically) listing tomorrow's open outbound
        appointments for carrier CMM / Palermo's at Caledonia. A human still reviews and sends it. Currently
        configured for Caledonia only.
      </p>

      <div className="break-schedule-controls" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          Auto-create nightly (for the next day)
        </label>
        <div className="break-schedule-warehouse">
          <span className="break-schedule-warehouse-label">Send time (CT)</span>
          <select className="est-drops-select" value={notifyHour} onChange={e => setNotifyHour(Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}
          </select>
          <select className="est-drops-select" value={notifyMinute} onChange={e => setNotifyMinute(Number(e.target.value))}>
            {[0, 15, 30, 45].map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {DAY_LABELS.map(([label, day]) => (
          <button
            key={day}
            onClick={() => toggleDay(day)}
            className="settings-save-btn"
            style={{
              padding: '4px 10px', fontSize: 11,
              background: notifyDays.includes(day) ? 'var(--brand-bg, rgba(61,186,126,0.12))' : 'transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <EmailListEditor label="TO (external — receives the draft)" emails={toEmails} onChange={setToEmails} />
      <EmailListEditor label="CC (external — receives the draft)" emails={ccEmails} onChange={setCcEmails} />

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
          From (Front channel — the address the draft actually sends from)
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="est-drops-select" value={channelId} onChange={e => setChannelId(e.target.value)} style={{ minWidth: 280 }}>
            <option value="">— CSW Main (default) —</option>
            {channels.map(c => (
              <option key={c.channel_id} value={c.channel_id}>
                {c.name}{c.address ? ` <${c.address}>` : ''}
              </option>
            ))}
          </select>
          <button className="settings-save-btn" onClick={handleSyncChannels} disabled={syncingChannels}>
            {syncingChannels ? 'Syncing…' : 'Sync channels now'}
          </button>
        </div>
        <p className="settings-page-sub" style={{ marginTop: 4, fontSize: 10 }}>
          Front ties the From address to the channel a draft is created on, not to the Draft Author below —
          pick the actual inbox/address you want this to send from. {channels.length} channel(s) available
          (synced nightly, or click "Sync channels now" for an immediate refresh).
        </p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>Draft Author (Front teammate)</div>
        <select className="est-drops-select" value={authorId} onChange={e => setAuthorId(e.target.value)} style={{ minWidth: 240 }}>
          <option value="">— select —</option>
          {teammates.map(t => (
            <option key={t.teammate_id} value={t.teammate_id}>
              {[t.first_name, t.last_name].filter(Boolean).join(' ') || t.email}
            </option>
          ))}
        </select>
        <p className="settings-page-sub" style={{ marginTop: 4, fontSize: 10 }}>
          Required — Front needs an author to create the draft under. Controls who Front shows as the draft's
          owner, not the From address (that's the picker above).
        </p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Internal discussion comment (posted on the draft, visible only to teammates below)
        </div>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          rows={3}
          placeholder="e.g. Flag anything that looks off before sending."
          className="est-drops-select"
          style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
        />
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Internal discussion people (added as conversation followers — {teammates.length} available)
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6,
          maxHeight: 260, overflowY: 'auto', padding: 8, border: '1px solid var(--border)', borderRadius: 4,
        }}>
          {teammates.map(t => {
            const label = [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email
            const checked = selectedDiscussion.has(t.teammate_id)
            return (
              <label
                key={t.teammate_id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 3,
                  fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
                  background: checked ? 'var(--brand-bg, rgba(61,186,126,0.12))' : 'transparent',
                }}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleTeammate(t.teammate_id)} />
                <span>{label}</span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="settings-card-footer" style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="settings-save-btn" onClick={handleSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
        <button className="settings-save-btn" onClick={handleTest} disabled={testState === 'running' || !authorId}>
          {testState === 'running' ? 'Creating…' : testState === 'ok' ? 'Created ✓' : testState === 'error' ? 'Failed' : 'Create Draft Now (test)'}
        </button>
        {testDetail && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: testState === 'error' ? '#e05a5a' : 'var(--text-dim)' }}>
            {testDetail}
          </span>
        )}
      </div>
      {!authorId && (
        <p className="settings-page-sub" style={{ marginTop: 8, fontStyle: 'italic' }}>
          Select a Draft Author above to enable the test button.
        </p>
      )}
    </div>
  )
}

// ── B2E Sync Health ──────────────────────────────────────────
//
// Added 2026-08-11 alongside the nightly-b2e-sync shared/run/test split.
// Dan/Dean suspected the 5am cron wasn't seeding future days as expected
// (see lib/nightly-b2e-sync-shared.cjs's header for the full story). This
// panel gives two things without needing Netlify's dashboard log viewer:
//   1. A "Run B2E Sync Now" button — fires nightly-b2e-sync-test.cjs
//      directly, NOT a dry run, same real purge/seed/refresh as the real
//      5am cron, so "is this actually working" can be checked TODAY.
//   2. A log of the last several runs (scheduled AND manual) from the new
//      cron_health table, including the diagnostic fields
//      (b2eDatesAfterDedup / maxSeededDate / expectedMaxDate) that answer
//      "did this run actually reach the full 21-day forward window."

function formatCronHealthTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
}

function B2eSyncHealthPanel() {
  const [summaryRows, setSummaryRows] = useState([])
  const [facilityRows, setFacilityRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState(null)
  const [runError, setRunError] = useState(null)

  async function loadHealth() {
    setLoading(true)
    const [summaries, facilities] = await Promise.all([
      fetchCronHealth('nightly-b2e-sync-summary', 10),
      fetchCronHealth('nightly-b2e-sync', 25),
    ])
    setSummaryRows(summaries)
    setFacilityRows(facilities)
    setLoading(false)
  }

  useEffect(() => { loadHealth() }, [])

  async function handleRunNow() {
    setRunning(true)
    setRunResult(null)
    setRunError(null)
    try {
      const res = await triggerDigestTest('nightly-b2e-sync-test', {})
      setRunResult(res)
    } catch (err) {
      setRunError(err.message)
    } finally {
      setRunning(false)
      await loadHealth()
    }
  }

  const lastScheduled = summaryRows.find(r => r.trigger === 'scheduled')

  return (
    <div className="b2e-sync-health">
      <p className="settings-page-sub" style={{ marginBottom: 16 }}>
        The nightly B2E sync (5am Central) seeds <code>roster_assignments</code> 21 days forward for all 5
        facilities. Click below to run it right now instead of waiting for tomorrow's scheduled tick — this is
        NOT a dry run, it writes real data, same as the real cron.
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <button className="settings-save-btn" onClick={handleRunNow} disabled={running}>
          {running ? 'Running…' : 'Run B2E Sync Now (test)'}
        </button>
        {lastScheduled && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
            Last scheduled run: {formatCronHealthTime(lastScheduled.ran_at)} — {lastScheduled.ok ? 'ok' : 'FAILED'}
          </span>
        )}
      </div>

      {runError && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#e05a5a', marginBottom: 16 }}>
          Run failed: {runError}
        </div>
      )}

      {runResult && (
        <div style={{ marginBottom: 20, padding: 12, border: '1px solid var(--border)', borderRadius: 4 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
            Just ran ({formatCronHealthTime(runResult.ranAt)}) — overall: {runResult.ok ? 'OK' : 'FAILED'}
          </div>
          <table className="hourly-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Facility</th>
                <th>OK</th>
                <th>Active Emps</th>
                <th>B2E days seen</th>
                <th>Max date written</th>
                <th>Expected max date</th>
                <th style={{ textAlign: 'left' }}>Purge / Seed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(runResult.results || {}).map(([fac, r]) => (
                <tr key={fac}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{fac.toUpperCase()}</td>
                  <td style={{ textAlign: 'center', color: r.ok ? 'var(--text-secondary)' : '#e05a5a' }}>{r.ok ? '✓' : '✗'}</td>
                  <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.activeEmps ?? '—'}</td>
                  <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.b2eDatesAfterDedup ?? '—'}</td>
                  <td style={{
                    textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11,
                    color: r.maxSeededDate && r.expectedMaxDate && r.maxSeededDate < r.expectedMaxDate ? '#e0a05a' : 'inherit',
                  }}>
                    {r.maxSeededDate ?? '—'}
                  </td>
                  <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.expectedMaxDate ?? '—'}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                    {r.ok
                      ? `+${r.seed?.inserted ?? 0} / -${r.seed?.deleted ?? 0} / ~${r.seed?.refreshed ?? 0}`
                      : (r.error || 'error')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="settings-page-sub" style={{ marginTop: 8, fontSize: 10 }}>
            "Max date written" in amber means this run did NOT reach the expected 21-day window for that
            facility — the gap is real, not a display artifact.
          </p>
        </div>
      )}

      <div className="settings-page-sub" style={{ fontWeight: 600, marginBottom: 8 }}>Recent runs</div>
      {loading ? (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>Loading…</div>
      ) : summaryRows.length === 0 ? (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>
          No runs logged yet — click "Run B2E Sync Now" above, or wait for the next scheduled tick.
        </div>
      ) : (
        <table className="hourly-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Ran At</th>
              <th style={{ textAlign: 'left' }}>Trigger</th>
              <th>OK</th>
              <th>Total ms</th>
            </tr>
          </thead>
          <tbody>
            {summaryRows.map(r => (
              <tr key={r.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{formatCronHealthTime(r.ran_at)}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.trigger}</td>
                <td style={{ textAlign: 'center', color: r.ok ? 'var(--text-secondary)' : '#e05a5a' }}>{r.ok ? '✓' : '✗'}</td>
                <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.duration_ms ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="settings-page-sub" style={{ fontWeight: 600, marginBottom: 8 }}>Per-facility history (last 25)</div>
      {facilityRows.length === 0 ? (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>No facility-level runs logged yet.</div>
      ) : (
        <table className="hourly-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Ran At</th>
              <th style={{ textAlign: 'left' }}>Facility</th>
              <th style={{ textAlign: 'left' }}>Trigger</th>
              <th>OK</th>
              <th>B2E days seen</th>
              <th>Max date written</th>
            </tr>
          </thead>
          <tbody>
            {facilityRows.map(r => (
              <tr key={r.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{formatCronHealthTime(r.ran_at)}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{(r.facility || '—').toUpperCase()}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.trigger}</td>
                <td style={{ textAlign: 'center', color: r.ok ? 'var(--text-secondary)' : '#e05a5a' }}>{r.ok ? '✓' : '✗'}</td>
                <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.detail?.b2eDatesAfterDedup ?? '—'}</td>
                <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.detail?.maxSeededDate ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

      {activeTab === 'discussions' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">Daily Discussions</h2>
            <p className="settings-page-sub">Automated per-facility Front discussion threads for daily check-ins — leadership, supervisors, GM/CEM, etc. Created automatically each evening for the next day.</p>
          </div>
          <DailyDiscussionsEditor />
        </>
      )}

      {activeTab === 'cmmOutbound' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">CMM Outbound Appts</h2>
            <p className="settings-page-sub">Creates a Front email draft (not sent) of tomorrow's open CMM/Palermo's outbound appointments at Caledonia, for review before sending.</p>
          </div>
          <CmmOutboundApptsEditor />
        </>
      )}

      {activeTab === 'b2eSync' && (
        <>
          <div className="settings-page-header">
            <h2 className="settings-page-title">B2E Sync Health</h2>
            <p className="settings-page-sub">Run the nightly roster sync on demand and see recent run history — no waiting for tomorrow, no Netlify log diving.</p>
          </div>
          <B2eSyncHealthPanel />
        </>
      )}
    </div>
  )
}
