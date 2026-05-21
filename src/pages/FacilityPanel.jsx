import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import HourlyTable from '../components/HourlyTable.jsx'
import ProjectList from '../components/ProjectList.jsx'
import RosterBoard from '../components/RosterBoard.jsx'
import PicklinePanel from '../components/PicklinePanel.jsx'
import {
  fetchHourlyData, fetchHourlyAppointments, fetchProjectData,
  fetchHistoricalProjectHourlyDropsCached, fetchProjectHourlyAppointments,
  isRuleProject, fetchActiveInventory, KEN_GUARANTEED_PROJECTS, loadCustomDropRules,
} from '../lib/omni.js'
import {
  fetchProjectHourlyDrops,
  upsertProjectHourlyDrops,
  upsertProjectHourlyDropsSeed,
  deleteProjectHourlyDropsForProject,
  clearExpiredManualEdits,
  fetchHourlyAdjustments,
  upsertHourlyAdjustment,
} from '../lib/supabase.js'
import { useSettings } from '../hooks/useSettings.js'
import { applySettings, computeDailyKpis, buildRosterAvailability, buildRosterStaffedHeadcount } from '../lib/laborCalc.js'

const CAL2_SIDE35_PROJECTS = new Set([
  'Palermos CALEDONIA finished', "Palermo's CALEDONIA finished", 'PALERMOS CALEDONIA FINISHED',
])
const SIDE12_LANES = new Set(['side12_shift1','side12_mid','side12_shift2','side12_shift3'])
const SIDE35_LANES = new Set(['side35_shift1','side35_mid','side35_shift2','side35_shift3'])
const CAL2_TABS = [
  { id: 'all', label: 'All' }, { id: 'side12', label: '1-2 Side' }, { id: 'side35', label: '3.5 Side' },
]
const WR_TABS = [
  { id: 'warehouse', label: 'Warehouse' }, { id: 'pickline', label: 'Pickline' },
]
const KEN_STALE_KEYS = new Set(['FAIR OAKS FARMS', 'FAIR OAKS FARMS WEST'])

const AUTO_REFRESH_MIN_GAP_MS = 2 * 60 * 1000

function r1(n) { return Math.round(n * 10) / 10 }

function dateRange(from, to) {
  const dates = []
  const cur = new Date(from + 'T00:00:00Z')
  const end = new Date(to   + 'T00:00:00Z')
  while (cur <= end) { dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1) }
  return dates
}
function weekOf(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z')
  const day = d.getUTCDay() || 7
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - (day - 1))
  const fri = new Date(mon); fri.setUTCDate(mon.getUTCDate() + 4)
  return { from: mon.toISOString().slice(0, 10), to: fri.toISOString().slice(0, 10) }
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}

export default function FacilityPanel({ facility, planDate, networkKpi, onDeltaComputed, onKpiComputed }) {
  const [rawHourly, setRawHourly]           = useState([])
  const [hourlyAppts, setHourlyAppts]       = useState({})
  const [hourlyErr, setHourlyErr]           = useState(null)
  const [omniWarning, setOmniWarning]       = useState(null)
  const [projects, setProjects]             = useState([])
  const [laborCount, setLaborCount]         = useState(0)
  const [rosterState, setRosterState]       = useState({ employees: [], laneMap: {}, assignmentMap: {} })
  const [projectHourlyDrops, setProjectHourlyDrops] = useState({})
  const [seedingDrops, setSeedingDrops]             = useState(false)
  const [refreshingProject, setRefreshingProject]   = useState(null) // project name being refreshed
  const [hourlyAdjustments, setHourlyAdjustments]   = useState({})
  const [activeInventory, setActiveInventory]       = useState(null)
  const [sideHourlyAppts, setSideHourlyAppts]       = useState({})
  const [customDropProjects, setCustomDropProjects] = useState([])
  const [copyOpen, setCopyOpen]         = useState(false)
  const [copyFrom, setCopyFrom]         = useState('')
  const [copyTo, setCopyTo]             = useState('')
  const [copyProjects, setCopyProjects] = useState(new Set())
  const [copying, setCopying]           = useState(false)
  const [copyMsg, setCopyMsg]           = useState(null)
  const [fetchedAt, setFetchedAt]       = useState(null)
  const [retryNonce, setRetryNonce]     = useState(0)

  const isCal2 = facility.id === 'cal'
  const isMad  = facility.id === 'mad'
  const isKen  = facility.id === 'ken'
  const isWr   = facility.id === 'wr'

  const [sideTab, setSideTab] = useState('all')
  const [wrTab, setWrTab]     = useState('warehouse')

  const [picklineSnapshot,  setPicklineSnapshot]  = useState(null)
  const [picklineOverrides, setPicklineOverrides] = useState({})

  const { settings, loading: settingsLoading } = useSettings(facility.id)

  const lastRefreshRef = useRef(0)

  const refreshAppointments = useCallback(async () => {
    try {
      const [apptsResult, projectResult] = await Promise.allSettled([
        fetchHourlyAppointments(facility.id, planDate),
        fetchProjectData(facility.id, planDate),
      ])
      if (apptsResult.status === 'fulfilled') setHourlyAppts(apptsResult.value)
      if (projectResult.status === 'fulfilled') setProjects(projectResult.value)
      setFetchedAt(new Date())
    } catch { /* non-fatal */ }
  }, [facility.id, planDate])

  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRefreshRef.current < AUTO_REFRESH_MIN_GAP_MS) return
      lastRefreshRef.current = now
      refreshAppointments()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [refreshAppointments])

  useEffect(() => {
    let cancelled = false
    setRawHourly([]); setHourlyAppts({}); setHourlyErr(null); setOmniWarning(null); setProjects([])
    setProjectHourlyDrops({}); setHourlyAdjustments({}); setSideHourlyAppts({}); setActiveInventory(null)
    setFetchedAt(null)

    async function loadData() {
      let omniFailures = []

      // Clear manually edited rows from before the current week (fire-and-forget)
      const { from: weekStartISO } = weekOf(new Date().toISOString().slice(0, 10))
      clearExpiredManualEdits(facility.id, weekStartISO)

      const customRows = await loadCustomDropRules(facility.id).catch(() => [])
      if (!cancelled) setCustomDropProjects(customRows)

      // ── Phase 1: critical core data (hourly + appointments) ──
      const [hourlyResult, apptsResult] = await Promise.allSettled([
        fetchHourlyData(facility.id, planDate),
        fetchHourlyAppointments(facility.id, planDate),
      ])
      if (cancelled) return

      if (hourlyResult.status === 'fulfilled') {
        setRawHourly(hourlyResult.value)
      } else {
        omniFailures.push('hourly labor data')
        console.warn('fetchHourlyData failed:', hourlyResult.reason?.message)
      }
      if (apptsResult.status === 'fulfilled') {
        setHourlyAppts(apptsResult.value)
      } else {
        omniFailures.push('appointment counts')
        console.warn('fetchHourlyAppointments failed:', apptsResult.reason?.message)
      }
      setFetchedAt(new Date())
      lastRefreshRef.current = Date.now()

      // ── Phase 2: project list ──
      let fetchedProjects = []
      try {
        fetchedProjects = await fetchProjectData(facility.id, planDate)
        if (!cancelled) setProjects(fetchedProjects)
      } catch (e) {
        omniFailures.push('project list')
        console.warn('fetchProjectData failed:', e.message)
      }
      if (cancelled) return

      if (isMad) {
        fetchActiveInventory(facility.id).then(d => { if (!cancelled) setActiveInventory(d) }).catch(() => { if (!cancelled) setActiveInventory([]) })
      }
      fetchHourlyAdjustments(facility.id, planDate).then(d => { if (!cancelled) setHourlyAdjustments(d) }).catch(() => {})

      if (!cancelled && omniFailures.length > 0) {
        setOmniWarning(`Omni couldn't load: ${omniFailures.join(', ')}. Showing empty data — click Retry to try again.`)
      }

      // ── Phase 3: EST drops seeding ──
      // Historical drops are fetched via the cached wrapper. On cache hit (< 24h
      // old), this is ~0ms instead of ~28 Omni queries on KEN. Cache TTL of 24h
      // guarantees daily refresh — avoids the future-date drift problem where a
      // cached aggregate goes stale as the rolling 4-week window shifts.
      const hasCustom = customRows.length > 0
      const shouldSeed = isKen || hasCustom || fetchedProjects.length > 0
      if (!shouldSeed) return

      setSeedingDrops(true)
      try {
        const [existing, historical] = await Promise.all([
          fetchProjectHourlyDrops(facility.id, planDate),
          fetchHistoricalProjectHourlyDropsCached(facility.id, planDate),
        ])
        if (cancelled) return

        if (isKen) {
          for (const p of KEN_GUARANTEED_PROJECTS) { if (!(p in historical)) historical[p] = { 17: 0 } }
        }
        for (const row of customRows) {
          if (!(row.project_name in historical)) historical[row.project_name] = { 17: 0 }
        }

        const filteredExisting = Object.fromEntries(
          Object.entries(existing).filter(([name]) => !KEN_STALE_KEYS.has(name))
        )

        // Build seed rows from historical — always overwrite so stale 0s from
        // prior seed runs don't persist.
        const seedRows = []
        for (const [project_name, hourMap] of Object.entries(historical)) {
          if (!isRuleProject(facility.id, project_name) && !isKen && !hasCustom) continue
          for (const [h, est_drops] of Object.entries(hourMap)) {
            seedRows.push({ project_name, h: Number(h), est_drops })
          }
        }

        if (seedRows.length > 0) {
          await upsertProjectHourlyDropsSeed(facility.id, planDate, seedRows)
        }

        // Build merged state in object shape { [project]: { [hour]: { est_drops, manually_edited } } }
        // historical returns plain numbers — wrap them; filteredExisting already returns objects.
        const merged = {}
        for (const [proj, hourMap] of Object.entries(historical)) {
          merged[proj] = {}
          for (const [h, v] of Object.entries(hourMap)) {
            merged[proj][h] = { est_drops: Number(v), manually_edited: false }
          }
        }
        for (const [project_name, hourMap] of Object.entries(filteredExisting)) {
          for (const [h, v] of Object.entries(hourMap)) {
            const row = typeof v === 'object' ? v : { est_drops: Number(v ?? 0), manually_edited: false }
            if (row.manually_edited) {
              if (!merged[project_name]) merged[project_name] = {}
              merged[project_name][h] = row
            }
          }
        }

        if (!cancelled) setProjectHourlyDrops(merged)
      } catch (e) {
        console.error('EST drops seed error:', e)
        try {
          const existing = await fetchProjectHourlyDrops(facility.id, planDate)
          if (!cancelled && Object.keys(existing).length > 0) setProjectHourlyDrops(existing)
        } catch { /* nothing to do */ }
      } finally {
        if (!cancelled) setSeedingDrops(false)
      }
    }

    loadData()
    return () => { cancelled = true }
  }, [facility.id, planDate, isMad, isKen, retryNonce])

  // Per-project refresh: delete stale rows then re-seed from fresh L4W data.
  // forceRefresh:true bypasses the historical drops cache so we hit Omni
  // directly — and the fresh result is written back to the cache, so the next
  // page load (and any other sessions today) get the updated value for free.
  async function handleRefreshProject(projectName) {
    setRefreshingProject(projectName)
    try {
      await deleteProjectHourlyDropsForProject(facility.id, planDate, projectName)
      const historical = await fetchHistoricalProjectHourlyDropsCached(
        facility.id,
        planDate,
        { forceRefresh: true }
      )
      const projectData = historical[projectName]
      if (projectData && Object.keys(projectData).length > 0) {
        const seedRows = Object.entries(projectData).map(([h, est_drops]) => ({
          project_name: projectName, h: Number(h), est_drops,
        }))
        await upsertProjectHourlyDropsSeed(facility.id, planDate, seedRows)
        setProjectHourlyDrops(prev => ({
          ...prev,
          [projectName]: Object.fromEntries(
            Object.entries(projectData).map(([h, v]) => [h, { est_drops: Number(v), manually_edited: false }])
          ),
        }))
      } else {
        await upsertProjectHourlyDropsSeed(facility.id, planDate, [{ project_name: projectName, h: 17, est_drops: 0 }])
        setProjectHourlyDrops(prev => ({ ...prev, [projectName]: { 17: { est_drops: 0, manually_edited: false } } }))
      }
    } catch (e) {
      console.error('Refresh project drops failed:', e)
    } finally {
      setRefreshingProject(null)
    }
  }

  function openCopy() {
    const names = Object.keys(projectHourlyDrops).sort((a, b) => a.localeCompare(b))
    const { from, to } = weekOf(planDate)
    setCopyFrom(from === planDate ? addDays(from, 1) : from)
    setCopyTo(to)
    setCopyProjects(new Set(names))
    setCopyMsg(null)
    setCopyOpen(true)
  }

  function toggleCopyProject(name) {
    setCopyProjects(prev => { const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next })
  }

  async function handleCopy() {
    if (!copyFrom || !copyTo || copyFrom > copyTo) { setCopyMsg({ err: true, text: 'Invalid date range.' }); return }
    if (copyProjects.size === 0) { setCopyMsg({ err: true, text: 'Select at least one project.' }); return }
    const dates = dateRange(copyFrom, copyTo).filter(d => d !== planDate)
    if (!dates.length) { setCopyMsg({ err: true, text: 'No dates to copy to.' }); return }
    setCopying(true); setCopyMsg(null)
    try {
      const rows = []
      for (const [project_name, hourMap] of Object.entries(projectHourlyDrops)) {
        if (!copyProjects.has(project_name)) continue
        for (const [h, v] of Object.entries(hourMap))
          rows.push({ project_name, h: Number(h), est_drops: typeof v === 'object' ? (v?.est_drops ?? 0) : (v ?? 0) })
      }
      await Promise.all(dates.map(d => upsertProjectHourlyDrops(facility.id, d, rows)))
      setCopyMsg({ err: false, text: `Copied ${copyProjects.size} project${copyProjects.size > 1 ? 's' : ''} to ${dates.length} date${dates.length > 1 ? 's' : ''}.` })
    } catch { setCopyMsg({ err: true, text: 'Copy failed -- try again.' }) }
    finally { setCopying(false) }
  }

  useEffect(() => {
    if (!isCal2 || sideTab === 'all') { setSideHourlyAppts({}); return }
    if (!projects.length) return
    const names = projects.map(p => p.name).filter(n => sideTab === 'side35' ? CAL2_SIDE35_PROJECTS.has(n) : !CAL2_SIDE35_PROJECTS.has(n))
    if (!names.length) { setSideHourlyAppts({}); return }
    fetchProjectHourlyAppointments(facility.id, planDate, names).then(setSideHourlyAppts).catch(() => setSideHourlyAppts({}))
  }, [isCal2, sideTab, projects, facility.id, planDate])

  const handleLaborCount   = useCallback((count) => setLaborCount(count), [])
  const handleRosterChange = useCallback(state => setRosterState(state), [])

  const visibleProjects = useMemo(() => {
    if (!isCal2 || sideTab === 'all') return projects
    if (sideTab === 'side35') return projects.filter(p => CAL2_SIDE35_PROJECTS.has(p.name))
    return projects.filter(p => !CAL2_SIDE35_PROJECTS.has(p.name))
  }, [projects, isCal2, sideTab])

  const laneFilter = useMemo(() => {
    if (!isCal2 || sideTab === 'all') return null
    return sideTab === 'side12' ? SIDE12_LANES : SIDE35_LANES
  }, [isCal2, sideTab])

  const rosterAvail = useMemo(() => {
    if (!rosterState.employees.length) return null
    return buildRosterAvailability(rosterState.employees, rosterState.laneMap, settings, rosterState.assignmentMap, laneFilter)
  }, [rosterState, settings, laneFilter])

  const rosterStaffed = useMemo(() => {
    if (!rosterState.employees.length) return null
    return buildRosterStaffedHeadcount(rosterState.employees, rosterState.laneMap, rosterState.assignmentMap, laneFilter)
  }, [rosterState, laneFilter])

  const visibleProjectHourlyDrops = useMemo(() => {
    if (!isCal2 || sideTab === 'all') return projectHourlyDrops
    return Object.fromEntries(
      Object.entries(projectHourlyDrops).filter(([name]) =>
        sideTab === 'side35' ? CAL2_SIDE35_PROJECTS.has(name) : !CAL2_SIDE35_PROJECTS.has(name)
      )
    )
  }, [projectHourlyDrops, isCal2, sideTab])

  // projectDrops: per-project total EST drops for the day, rounded to integer for display.
  // Raw decimal values are kept in visibleProjectHourlyDrops for accurate per-hour math
  // and req calculations; rounding only happens at display boundaries.
  const projectDrops = useMemo(() => {
    const result = {}
    for (const [name, hourMap] of Object.entries(visibleProjectHourlyDrops))
      result[name] = Math.round(Object.values(hourMap).reduce((s, v) => s + Number(typeof v === 'object' ? (v?.est_drops ?? 0) : v), 0))
    return result
  }, [visibleProjectHourlyDrops])

  const mergedProjects = useMemo(() => {
    const apptNames = new Set(visibleProjects.map(p => p.name))
    const dropsOnlyRows = Object.keys(projectDrops)
      .filter(name => name && !apptNames.has(name) && (projectDrops[name] ?? 0) > 0)
      .map(name => ({ name, inb: 0, out: 0, tot: 0 }))
    if (!dropsOnlyRows.length) return visibleProjects
    return [...visibleProjects, ...dropsOnlyRows]
  }, [visibleProjects, projectDrops])

  // estDrops: per-hour EST drops for the hourly table and req calc.
  // Kept as raw decimals so that req = appts * hpa uses accurate drop counts.
  // The hourly table renders these via HourlyTable which rounds for display.
  const estDrops = useMemo(() => {
    const sums = {}
    for (const hourMap of Object.values(visibleProjectHourlyDrops))
      for (const [h, v] of Object.entries(hourMap)) {
        const hour = Number(h)
        const val = typeof v === 'object' ? (v?.est_drops ?? 0) : Number(v ?? 0)
        sums[hour] = (sums[hour] ?? 0) + val
      }
    return sums
  }, [visibleProjectHourlyDrops])

  // Flat numeric map for HourlyTable's projectHourlyDrops prop (plain est_drops values)
  const visibleProjectHourlyDropsFlat = useMemo(() => {
    const result = {}
    for (const [name, hourMap] of Object.entries(visibleProjectHourlyDrops)) {
      result[name] = {}
      for (const [h, v] of Object.entries(hourMap)) {
        result[name][h] = typeof v === 'object' ? (v?.est_drops ?? 0) : Number(v ?? 0)
      }
    }
    return result
  }, [visibleProjectHourlyDrops])

  // manuallyEdited boolean map for HourlyTable visual indicators
  const manuallyEdited = useMemo(() => {
    const result = {}
    for (const [name, hourMap] of Object.entries(visibleProjectHourlyDrops)) {
      result[name] = {}
      for (const [h, v] of Object.entries(hourMap)) {
        result[name][h] = typeof v === 'object' ? (v?.manually_edited ?? false) : false
      }
    }
    return result
  }, [visibleProjectHourlyDrops])

  // totalDrops for KPI pill: rounded to integer — users don't track fractional appointments.
  const totalDrops = useMemo(() => Math.round(Object.values(estDrops).reduce((s, v) => s + Number(v), 0)), [estDrops])

  const rawWithAppts = useMemo(() => {
    if (!rawHourly.length) return rawHourly
    return rawHourly.map(row => {
      const est = estDrops[row.h] ?? 0
      const apptSrc = (isCal2 && sideTab !== 'all') ? (sideHourlyAppts[row.h] ?? { inb: 0, out: 0 }) : (hourlyAppts[row.h] ?? { inb: 0, out: 0 })
      return { ...row, inb: apptSrc.inb, out: apptSrc.out, drops: est, appts: apptSrc.inb + est + apptSrc.out }
    })
  }, [rawHourly, hourlyAppts, estDrops, isCal2, sideTab, sideHourlyAppts])

  const hourly = useMemo(() => {
    const base = settingsLoading ? rawWithAppts : applySettings(rawWithAppts, settings)
    if (!rosterAvail) return base
    return base.map(row => ({ ...row, avail: rosterAvail[row.h] ?? 0 }))
  }, [rawWithAppts, settings, settingsLoading, rosterAvail])

  const { util, delta } = computeDailyKpis(hourly)

  const totalLaborReq = useMemo(() => r1(hourly.reduce((s, r) => s + (r.req ?? 0), 0)), [hourly])
  const totalAdj      = useMemo(() => Object.values(hourlyAdjustments).reduce((s, v) => s + v, 0), [hourlyAdjustments])

  const totalHoursAvail = useMemo(() => r1(hourly.reduce((s, r) => s + (r.avail ?? 0), 0)), [hourly])

  useEffect(() => {
    if (onDeltaComputed && sideTab === 'all' && delta != null) onDeltaComputed(facility.id, delta)
  }, [delta, facility.id, sideTab, onDeltaComputed])

  const totalInb = visibleProjects.reduce((s, p) => s + p.inb, 0)
  const totalOut = visibleProjects.reduce((s, p) => s + p.out, 0)

  useEffect(() => {
    if (onKpiComputed && sideTab === 'all') {
      onKpiComputed(facility.id, { inb: totalInb, out: totalOut, drops: totalDrops })
    }
  }, [totalInb, totalOut, totalDrops, facility.id, sideTab, onKpiComputed])

  const sideHeadcount = isCal2 && sideTab !== 'all'
    ? Object.entries(rosterState.laneMap).filter(([, l]) => laneFilter?.has(l)).length
    : laborCount

  const kpiData = {
    appts: totalInb + totalOut + totalDrops, drops: totalDrops,
    inb: totalInb, out: totalOut, labor: sideHeadcount,
    totalHours: totalHoursAvail,
    laborReq: totalLaborReq,
    totalAdj,
    util: util ?? networkKpi?.util, delta: delta ?? networkKpi?.delta,
    fetchedAt,
  }

  const hasDropData = Object.keys(projectHourlyDrops).length > 0
  const copyProjectNames = Object.keys(projectHourlyDrops).sort((a, b) => a.localeCompare(b))

  const warehouseContent = (
    <div>
      {isCal2 && (
        <div className="cal2-tab-row">
          {CAL2_TABS.map(t => (
            <button key={t.id} data-side={t.id}
              className={`cal2-tab${sideTab === t.id ? ' active' : ''}`}
              onClick={() => setSideTab(t.id)}>{t.label}</button>
          ))}
        </div>
      )}

      {omniWarning && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">{omniWarning}</span>
          <button className="omni-warning-retry" onClick={() => { setOmniWarning(null); setRetryNonce(n => n + 1) }}>Retry</button>
        </div>
      )}

      <div className="panel-top-grid">
        <KpiPills data={kpiData} color={facility.color} />
        <div>
          <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>Projects</div>
          <ProjectList projects={mergedProjects} projectDrops={projectDrops} color={facility.color}
            inventoryData={isMad ? activeInventory : null} />
        </div>
      </div>

      <HourlyChart hourlyData={hourly} color={facility.color} />

      <div className="section-label" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Hourly Breakdown</span>
        {seedingDrops
          ? <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Loading forecast...</span>
          : hasDropData && (
            <>
              <button className="est-reset-btn" onClick={openCopy}>Copy to dates...</button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {copyProjectNames.map(name => (
                  <button
                    key={name}
                    className="est-reset-btn"
                    style={{ opacity: refreshingProject === name ? 0.6 : 1 }}
                    disabled={refreshingProject !== null}
                    onClick={() => handleRefreshProject(name)}
                    title={`Refresh L4W average for ${name}`}
                  >
                    {refreshingProject === name ? '...' : '↺'} {name.length > 22 ? name.slice(0, 22) + '…' : name}
                  </button>
                ))}
              </div>
            </>
          )
        }
      </div>

      {copyOpen && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 12, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Copy EST drops from {planDate} to:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>From<input type="date" className="settings-field-input" style={{ width: 130, padding: '2px 6px' }} value={copyFrom} onChange={e => setCopyFrom(e.target.value)} /></label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>To<input type="date" className="settings-field-input" style={{ width: 130, padding: '2px 6px' }} value={copyTo} onChange={e => setCopyTo(e.target.value)} /></label>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: 'var(--text-secondary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Projects to copy:</span>
              <button style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 10, padding: 0 }} onClick={() => setCopyProjects(new Set(copyProjectNames))}>Select all</button>
              <button style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 10, padding: 0 }} onClick={() => setCopyProjects(new Set())}>Clear</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
              {copyProjectNames.map(name => (
                <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={copyProjects.has(name)} onChange={() => toggleCopyProject(name)} />
                  <span style={{ color: copyProjects.has(name) ? 'var(--text-primary)' : 'var(--text-dim)' }}>{name.length > 28 ? name.slice(0, 28) + '...' : name}</span>
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="est-reset-btn" onClick={handleCopy} disabled={copying}>{copying ? 'Copying...' : 'Copy'}</button>
            <button className="est-reset-btn" onClick={() => { setCopyOpen(false); setCopyMsg(null) }}>Cancel</button>
            {copyMsg && <span style={{ color: copyMsg.err ? '#e05a5a' : 'var(--text-secondary)' }}>{copyMsg.text}</span>}
          </div>
        </div>
      )}

      {hourlyErr
        ? <div style={{ padding: '8px 12px', color: '#e05a5a', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg2)', borderRadius: 8, marginBottom: 12 }}>{hourlyErr}</div>
        : <HourlyTable
            hourlyData={hourly} estDrops={estDrops}
            projectHourlyDrops={visibleProjectHourlyDropsFlat}
            manuallyEdited={manuallyEdited}
            hourlyAdjustments={hourlyAdjustments}
            staffedHourly={rosterStaffed?.hourly}
            staffedByHour={rosterStaffed?.byHour}
            onProjectHourlyChange={(projectName, h, val) => {
              setProjectHourlyDrops(prev => ({
                ...prev,
                [projectName]: { ...(prev[projectName] ?? {}), [h]: { est_drops: val, manually_edited: true } },
              }))
              upsertProjectHourlyDrops(facility.id, planDate, [{ project_name: projectName, h, est_drops: val }])
            }}
            onAdjustmentChange={(h, val) => {
              setHourlyAdjustments(prev => ({ ...prev, [h]: val }))
              upsertHourlyAdjustment(facility.id, planDate, h, val)
            }}
            color={facility.color}
          />
      }

      <RosterBoard facility={facility.id} planDate={planDate} settings={settings}
        onLaborCount={handleLaborCount} onRosterChange={handleRosterChange} />
    </div>
  )

  if (isWr) {
    return (
      <div>
        <div className="cal2-tab-row">
          {WR_TABS.map(t => (
            <button key={t.id} data-side={t.id}
              className={`cal2-tab${wrTab === t.id ? ' active' : ''}`}
              onClick={() => setWrTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {wrTab === 'warehouse'
          ? warehouseContent
          : <PicklinePanel
              snapshot={picklineSnapshot}
              hourOverrides={picklineOverrides}
              onSnapshot={snap => { setPicklineSnapshot(snap); setPicklineOverrides({}) }}
              onOverridesChange={setPicklineOverrides}
              onClear={() => { setPicklineSnapshot(null); setPicklineOverrides({}) }}
              planDate={planDate}
            />
        }
      </div>
    )
  }

  return warehouseContent
}
