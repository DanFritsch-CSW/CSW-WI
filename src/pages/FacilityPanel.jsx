import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import HourlyTable from '../components/HourlyTable.jsx'
import ProjectList from '../components/ProjectList.jsx'
import RosterBoard from '../components/RosterBoard.jsx'
import AppointmentList from '../components/AppointmentList.jsx'
import CustomerSnapshot from '../components/CustomerSnapshot.jsx'
import {
  fetchHourlyData, fetchHourlyAppointments, fetchProjectData,
  fetchHistoricalProjectHourlyDropsCached, fetchProjectHourlyAppointments,
  isRuleProject, KEN_GUARANTEED_PROJECTS, loadCustomDropRules,
  fetchAppointmentList,
} from '../lib/omni.js'
import {
  fetchProjectHourlyDrops,
  upsertProjectHourlyDrops,
  upsertProjectHourlyDropsSeed,
  deleteProjectHourlyDropsForProject,
  deleteOrphanSeedRows,
  clearExpiredManualEdits,
  fetchHourlyAdjustments,
  upsertHourlyAdjustment,
  fetchWeeklyProjectDrops,
} from '../lib/supabase.js'
import { useSettings } from '../hooks/useSettings.js'
import { applySettings, computeDailyKpis, buildRosterAvailability, buildRosterStaffedHeadcount } from '../lib/laborCalc.js'

// PicklinePanel is WR-only and ships the CSV parser + full pick planning UI.
// Lazy-loaded so users on non-WR facilities never download that chunk.
const PicklinePanel = lazy(() => import('../components/PicklinePanel.jsx'))

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

// Monday of week containing iso (UTC, Mon=1..Sun=0 → -6 shift)
function mondayOfWeek(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

export default function FacilityPanel({ facility, planDate, view, networkKpi, onDeltaComputed, onKpiComputed }) {
  const [rawHourly, setRawHourly]           = useState([])
  const [hourlyAppts, setHourlyAppts]       = useState({})
  const [hourlyErr, setHourlyErr]           = useState(null)
  const [omniWarning, setOmniWarning]       = useState(null)
  const [projects, setProjects]             = useState([])
  const [laborCount, setLaborCount]         = useState(0)
  const [rosterState, setRosterState]       = useState({ employees: [], laneMap: {}, assignmentMap: {}, breaksMap: new Map() })
  const [projectHourlyDrops, setProjectHourlyDrops] = useState({})
  const [seedingDrops, setSeedingDrops]             = useState(false)
  const [refreshingProject, setRefreshingProject]   = useState(null) // project name being refreshed
  const [hourlyAdjustments, setHourlyAdjustments]   = useState({})
  const [sideHourlyAppts, setSideHourlyAppts]       = useState({})
  const [customDropProjects, setCustomDropProjects] = useState([])
  const [copyOpen, setCopyOpen]         = useState(false)
  const [copyFrom, setCopyFrom]         = useState('')
  const [copyTo, setCopyTo]             = useState('')
  const [copyProjects, setCopyProjects] = useState(new Set())
  const [copying, setCopying]           = useState(false)
  const [copyMsg, setCopyMsg]           = useState(null)
  const [fetchedAt, setFetchedAt]             = useState(null)
  const [retryNonce, setRetryNonce]           = useState(0)
  const [appointmentList, setAppointmentList]           = useState([])
  const [appointmentListLoading, setAppointmentListLoading] = useState(false)
  const [perProjectHourly, setPerProjectHourly] = useState(null)
  const [weeklyProjectAppts, setWeeklyProjectAppts] = useState({})
  const [weeklyProjectDrops, setWeeklyProjectDrops] = useState({})
  const [weeklyLoading, setWeeklyLoading]           = useState(false)
  // Per Fathom call 2026-06-25 (Dean): HourlyChart defaults to collapsed in the
  // Daily view so the panel reads less cluttered. Click the header to expand.
  // State is per-FacilityPanel-mount; switching facilities resets to collapsed.
  const [hourlyChartOpen, setHourlyChartOpen] = useState(false)

  const isCal2 = facility.id === 'cal'
  const isMad  = facility.id === 'mad'
  const isKen  = facility.id === 'ken'
  const isWr   = facility.id === 'wr'
  const isDaily = view !== 'weekly'

  const [sideTab, setSideTab] = useState('all')
  const [wrTab, setWrTab]     = useState('warehouse')

  const [picklineSnapshot,  setPicklineSnapshot]  = useState(null)
  const [picklineOverrides, setPicklineOverrides] = useState({})

  const { settings, loading: settingsLoading, projectHpa } = useSettings(facility.id)

  const lastRefreshRef = useRef(0)

  // ── Weekly projects table data — current Mon–Sun window ──
  // Refetches only when the week changes, not on every planDate within the
  // same week. Clicking Mon→Tue within the same week reuses the cached set.
  const weekStart = useMemo(() => mondayOfWeek(planDate), [planDate])
  const weekDays  = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])
  const weekEnd   = weekDays[6]

  useEffect(() => {
    let cancelled = false
    setWeeklyLoading(true)
    async function loadWeekly() {
      try {
        const [apptsResults, dropsMap] = await Promise.all([
          Promise.all(weekDays.map(d => fetchProjectData(facility.id, d).catch(() => []))),
          fetchWeeklyProjectDrops(facility.id, weekStart, weekEnd).catch(() => ({})),
        ])
        if (cancelled) return
        const appts = {}
        for (let i = 0; i < weekDays.length; i++) {
          const day = weekDays[i]
          appts[day] = {}
          for (const p of apptsResults[i]) {
            if (!p.name) continue
            appts[day][p.name] = { inb: p.inb ?? 0, out: p.out ?? 0 }
          }
        }
        setWeeklyProjectAppts(appts)
        setWeeklyProjectDrops(dropsMap)
      } catch (e) {
        console.warn('Weekly projects fetch failed (non-fatal):', e?.message)
      } finally {
        if (!cancelled) setWeeklyLoading(false)
      }
    }
    loadWeekly()
    return () => { cancelled = true }
  }, [facility.id, weekStart, weekEnd, retryNonce])

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
    // Also refresh the row-level appointment list (independent, non-fatal)
    try {
      setAppointmentListLoading(true)
      const list = await fetchAppointmentList(facility.id, planDate)
      setAppointmentList(list)
    } catch { /* non-fatal */ } finally {
      setAppointmentListLoading(false)
    }
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

  // ── Appointment list fetch (independent of main loadData flow) ──────────
  // A failure here does not block KPIs or the roster board.
  useEffect(() => {
    let cancelled = false
    setAppointmentList([])
    setAppointmentListLoading(true)
    fetchAppointmentList(facility.id, planDate)
      .then(list => { if (!cancelled) setAppointmentList(list) })
      .catch(() => { if (!cancelled) setAppointmentList([]) })
      .finally(() => { if (!cancelled) setAppointmentListLoading(false) })
    return () => { cancelled = true }
  }, [facility.id, planDate, retryNonce])

  useEffect(() => {
    let cancelled = false
    setRawHourly([]); setHourlyAppts({}); setHourlyErr(null); setOmniWarning(null); setProjects([])
    setProjectHourlyDrops({}); setHourlyAdjustments({}); setSideHourlyAppts({})
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

      fetchHourlyAdjustments(facility.id, planDate).then(d => { if (!cancelled) setHourlyAdjustments(d) }).catch(() => {})

      if (!cancelled && omniFailures.length > 0) {
        const hasHourly  = hourlyResult.status === 'fulfilled' && hourlyResult.value.length > 0
        const hasAppts   = apptsResult.status === 'fulfilled' && Object.keys(apptsResult.value || {}).length > 0
        const hasProjects = fetchedProjects.length > 0
        if (!hasHourly && !hasAppts && !hasProjects) {
          setOmniWarning(`Live Omni data unavailable (${omniFailures.join(', ')}). Showing cached values where available.`)
        }
      }

      // ── Phase 3: EST drops seeding + sync (DB-is-truth model) ──
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

        const manualKeys = new Set()
        for (const [project_name, hourMap] of Object.entries(filteredExisting)) {
          for (const [h, v] of Object.entries(hourMap)) {
            const row = typeof v === 'object' ? v : null
            if (row && row.manually_edited) {
              manualKeys.add(`${project_name}|${h}`)
            }
          }
        }

        const seedRows = []
        const seedKeys = new Set()
        for (const [project_name, hourMap] of Object.entries(historical)) {
          if (!isRuleProject(facility.id, project_name) && !isKen && !hasCustom) continue
          for (const [h, est_drops] of Object.entries(hourMap)) {
            const key = `${project_name}|${h}`
            if (manualKeys.has(key)) continue
            seedRows.push({ project_name, h: Number(h), est_drops })
            seedKeys.add(key)
          }
        }

        const validKeys = [...seedKeys, ...manualKeys]

        await Promise.all([
          deleteOrphanSeedRows(facility.id, planDate, validKeys),
          seedRows.length > 0 ? upsertProjectHourlyDropsSeed(facility.id, planDate, seedRows) : Promise.resolve(),
        ])
        if (cancelled) return

        const finalState = await fetchProjectHourlyDrops(facility.id, planDate)
        if (cancelled) return
        const finalFiltered = Object.fromEntries(
          Object.entries(finalState).filter(([name]) => !KEN_STALE_KEYS.has(name))
        )
        setProjectHourlyDrops(finalFiltered)
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

  // handleCopy — copy EST drops from current planDate to a range of destination dates.
  //
  // BOLD-EVERYWHERE BEHAVIOR (per Dean, 2026-06-03):
  // For each selected project, write all 24 hours (0–23) on each destination
  // date. Source value if the hour exists in the source map, else 0. Every
  // cell written goes through upsertProjectHourlyDrops, which stamps
  // manually_edited=true. Result on the destination day:
  //   1. The entire column for that project shows bold in HourlyTable
  //      (the manuallyEdited prop drives the .ht-cell-manual class).
  //   2. The L4W seed in Phase 3 of loadData() reads manualKeys from DB and
  //      skips those (project, hour) pairs entirely — so the column is
  //      locked from automatic re-seeding.
  //   3. deleteOrphanSeedRows filters on manually_edited=false at the query
  //      level, so the cells can't be deleted by orphan cleanup either.
  //
  // The lock is released when (a) the CSR edits a cell again (still manual),
  // (b) the CSR clicks the per-project ⇺ refresh button (which deletes + re-
  // seeds from fresh L4W), or (c) the week rolls over and
  // clearExpiredManualEdits prunes the past-week rows.
  async function handleCopy() {
    if (!copyFrom || !copyTo || copyFrom > copyTo) { setCopyMsg({ err: true, text: 'Invalid date range.' }); return }
    if (copyProjects.size === 0) { setCopyMsg({ err: true, text: 'Select at least one project.' }); return }
    const dates = dateRange(copyFrom, copyTo).filter(d => d !== planDate)
    if (!dates.length) { setCopyMsg({ err: true, text: 'No dates to copy to.' }); return }
    setCopying(true); setCopyMsg(null)
    try {
      // Build full 24-hour rows for each selected project. This is what
      // makes the destination column bold across every hour, including
      // hours where the source had no value (those write as 0).
      const rows = []
      for (const [project_name, hourMap] of Object.entries(projectHourlyDrops)) {
        if (!copyProjects.has(project_name)) continue
        for (let h = 0; h < 24; h++) {
          const v = hourMap[h]
          const est_drops = v == null
            ? 0
            : (typeof v === 'object' ? (v?.est_drops ?? 0) : (v ?? 0))
          rows.push({ project_name, h, est_drops })
        }
      }
      await Promise.all(dates.map(d => upsertProjectHourlyDrops(facility.id, d, rows)))
      setCopyMsg({ err: false, text: `Copied ${copyProjects.size} project${copyProjects.size > 1 ? 's' : ''} to ${dates.length} date${dates.length > 1 ? 's' : ''}. All 24 hours marked manual.` })
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

  // Fetch per-project hourly appointments when HPA overrides exist for this facility.
  // Only fires when there are overrides — zero perf cost for facilities without them.
  useEffect(() => {
    if (!projects || projects.length === 0) { setPerProjectHourly(null); return }
    if (!projectHpa || projectHpa.size === 0) { setPerProjectHourly(null); return }
    let cancelled = false
    const names = projects.map(p => p.name)
    fetchProjectHourlyAppointments(facility.id, planDate, names)
      .then(map => { if (!cancelled) setPerProjectHourly(map) })
      .catch(err => {
        console.warn('per-project HPA fetch failed, falling back to aggregate', err)
        if (!cancelled) setPerProjectHourly(null)
      })
    return () => { cancelled = true }
  }, [facility.id, planDate, projects, projectHpa, retryNonce])

  const handleLaborCount   = useCallback((count) => setLaborCount(count), [])
  const handleRosterChange = useCallback(state => setRosterState(state), [])

  const visibleProjects = useMemo(() => {
    if (!isCal2 || sideTab === 'all') return projects
    if (sideTab === 'side35') return projects.filter(p => CAL2_SIDE35_PROJECTS.has(p.name))
    return projects.filter(p => !CAL2_SIDE35_PROJECTS.has(p.name))
  }, [projects, isCal2, sideTab])

  // Filter applied to the weekly projects table (CAL split).
  const projectFilter = useMemo(() => {
    if (!isCal2 || sideTab === 'all') return null
    if (sideTab === 'side35') return (name) => CAL2_SIDE35_PROJECTS.has(name)
    return (name) => !CAL2_SIDE35_PROJECTS.has(name)
  }, [isCal2, sideTab])

  const laneFilter = useMemo(() => {
    if (!isCal2 || sideTab === 'all') return null
    return sideTab === 'side12' ? SIDE12_LANES : SIDE35_LANES
  }, [isCal2, sideTab])

  const rosterAvail = useMemo(() => {
    if (!rosterState.employees.length) return null
    return buildRosterAvailability(
      rosterState.employees,
      rosterState.laneMap,
      settings,
      rosterState.assignmentMap,
      laneFilter,
      rosterState.breaksMap
    )
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

  const projectDrops = useMemo(() => {
    const result = {}
    for (const [name, hourMap] of Object.entries(visibleProjectHourlyDrops))
      result[name] = Math.round(Object.values(hourMap).reduce((s, v) => s + Number(typeof v === 'object' ? (v?.est_drops ?? 0) : v), 0))
    return result
  }, [visibleProjectHourlyDrops])

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

  const totalDrops = useMemo(() => Math.round(Object.values(estDrops).reduce((s, v) => s + Number(v), 0)), [estDrops])

  // Daily projects list (busiest first) — used only in Daily view.
  // Combines today's live appointments with seeded/edited drops for the day.
  const dailyProjectRows = useMemo(() => {
    const rows = visibleProjects.map(p => {
      const dr = projectDrops[p.name] ?? 0
      const inb = p.inb ?? 0
      const out = p.out ?? 0
      return { name: p.name, dr, inb, out, total: dr + inb + out }
    })
    // Surface drops-only projects that may not be in the appt-derived projects list
    for (const name of Object.keys(projectDrops)) {
      if (rows.some(r => r.name === name)) continue
      if (!projectDrops[name]) continue
      rows.push({ name, dr: projectDrops[name], inb: 0, out: 0, total: projectDrops[name] })
    }
    return rows.sort((a, b) => b.total - a.total)
  }, [visibleProjects, projectDrops])

  const rawWithAppts = useMemo(() => {
    if (!rawHourly.length) return rawHourly
    return rawHourly.map(row => {
      const est = estDrops[row.h] ?? 0
      const apptSrc = (isCal2 && sideTab !== 'all') ? (sideHourlyAppts[row.h] ?? { inb: 0, out: 0 }) : (hourlyAppts[row.h] ?? { inb: 0, out: 0 })
      return { ...row, inb: apptSrc.inb, out: apptSrc.out, drops: est, appts: apptSrc.inb + est + apptSrc.out }
    })
  }, [rawHourly, hourlyAppts, estDrops, isCal2, sideTab, sideHourlyAppts])

  // Per-hour labor req with project-level HPA overrides applied.
  //
  // Strategy: for each overridden project, sum its full contribution at the
  // hour — live appointments (inb + out from the per-project Omni fetch) PLUS
  // its EST drops (from visibleProjectHourlyDropsFlat). Apply the override
  // HPA to that combined count. Everything else (non-overridden projects,
  // unattributed appts) gets the facility default HPA.
  //
  //   req(h) = Σ_overridden ( (projectAppts_h + projectDrops_h) × overrideHpa )
  //          + (totalAppts_h − overrideAttributedAppts_h) × defaultHpa
  //
  // Guarantees:
  //   1. No overrides set → returns null → applySettings uses pure aggregate.
  //   2. Override exists but project has 0 appts AND 0 drops at this hour →
  //      contribution is 0, falls through to facility default.
  //   3. perProjectHourly is empty {} → override-via-live-appts portion is 0,
  //      but override-via-drops portion still applies (drops live in
  //      visibleProjectHourlyDropsFlat which is from the DB, not Omni).
  //   4. Overall: when no override actually applies to any visible activity,
  //      result equals aggregate (totalAppts × defaultHpa).
  const perHourReq = useMemo(() => {
    if (!projectHpa || projectHpa.size === 0) return null
    if (!projects || projects.length === 0) return null
    const defaultHpa = settings?.hours_per_appt ?? 1.5
    const arr = new Array(24).fill(0)
    // Build a quick lookup of projects-with-overrides so we can include
    // drops-only override projects that may not appear in `projects`
    // (e.g. a project we have drops for but no live appts).
    const overrideNames = new Set([
      ...projects.map(p => p.name),
      ...projectHpa.keys(),
    ])
    for (let h = 0; h < 24; h++) {
      const hourMap = (perProjectHourly && perProjectHourly[h]) || {}
      const row = rawWithAppts.find(r => r.h === h)
      const totalAppts = row?.appts ?? 0
      let overrideHours = 0
      let overrideAppts = 0
      for (const name of overrideNames) {
        if (!projectHpa.has(name)) continue
        const counts = hourMap[name]
        const liveAppts = (counts?.inb ?? 0) + (counts?.out ?? 0)
        const dropCount = Number(visibleProjectHourlyDropsFlat?.[name]?.[h] ?? 0) || 0
        const projectTotal = liveAppts + dropCount
        if (projectTotal === 0) continue
        overrideHours += projectTotal * projectHpa.get(name)
        overrideAppts += projectTotal
      }
      const remainingAppts = Math.max(0, totalAppts - overrideAppts)
      arr[h] = overrideHours + remainingAppts * defaultHpa
    }
    return arr
  }, [perProjectHourly, projectHpa, settings?.hours_per_appt, projects, rawWithAppts, visibleProjectHourlyDropsFlat])

  const hourly = useMemo(() => {
    const base = settingsLoading ? rawWithAppts : applySettings(rawWithAppts, settings, perHourReq)
    if (!rosterAvail) return base
    return base.map(row => ({ ...row, avail: rosterAvail[row.h] ?? 0 }))
  }, [rawWithAppts, settings, settingsLoading, rosterAvail, perHourReq])

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

      {isDaily && (
        <div className="panel-top-grid">
          <KpiPills data={kpiData} color={facility.color} />
          <div>
            <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>Projects</div>
            <div className="daily-project-list">
              <div className="dpl-header">
                <div>Project</div>
                <div className="dpl-r">Drops</div>
                <div className="dpl-r">Inb</div>
                <div className="dpl-r">Out</div>
                <div className="dpl-r">Total</div>
              </div>
              {dailyProjectRows.length === 0 ? (
                <div className="dpl-empty">No projects scheduled.</div>
              ) : (
                dailyProjectRows.map(r => (
                  <div key={r.name} className="dpl-row">
                    <div className="dpl-name">{r.name}</div>
                    <div className="dpl-num">{r.dr || '—'}</div>
                    <div className="dpl-num">{r.inb || '—'}</div>
                    <div className="dpl-num">{r.out || '—'}</div>
                    <div className="dpl-num dpl-tot" style={{ color: facility.color }}>{r.total || '—'}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {isDaily && (
        <>
          <div className="collapsible-section">
            <button
              type="button"
              className="collapsible-header"
              onClick={() => setHourlyChartOpen(o => !o)}
              aria-expanded={hourlyChartOpen}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                width: '100%', padding: '8px 10px', marginTop: 8,
                background: 'var(--bg0)', border: '1px solid var(--border)', borderRadius: 4,
                cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12,
                color: 'var(--text-primary)', textAlign: 'left',
              }}
            >
              <span style={{ fontWeight: 600 }}>Hourly Chart</span>
              <span style={{
                fontSize: 10, color: 'var(--text-secondary)',
                transform: hourlyChartOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s ease',
              }}>▶</span>
            </button>
            {hourlyChartOpen && (
              <div style={{ marginTop: 6 }}>
                <HourlyChart hourlyData={hourly} color={facility.color} />
              </div>
            )}
          </div>

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
              <div style={{ marginBottom: 8, padding: '6px 10px', background: 'var(--bg1)', border: '1px solid var(--border-subtle)', borderRadius: 6, color: 'var(--text-secondary)', fontSize: 10, lineHeight: 1.5 }}>
                All 24 hours of each selected project will be marked as manually edited on the destination dates (entire column bolds). This locks those columns from L4W auto-reseed until you edit them again or click the ↺ refresh button.
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

          <AppointmentList
            appointments={appointmentList}
            loading={appointmentListLoading}
            facilityCode={facility.code}
            date={planDate}
          />
        </>
      )}

      {!isDaily && (
        <CustomerSnapshot
          facilityId={facility.id}
          planDate={planDate}
          color={facility.color}
        />
      )}
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
          : <Suspense fallback={<div style={{ padding: 20, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Loading Pickline…</div>}>
              <PicklinePanel
                snapshot={picklineSnapshot}
                hourOverrides={picklineOverrides}
                onSnapshot={snap => { setPicklineSnapshot(snap); setPicklineOverrides({}) }}
                onOverridesChange={setPicklineOverrides}
                onClear={() => { setPicklineSnapshot(null); setPicklineOverrides({}) }}
                planDate={planDate}
              />
            </Suspense>
        }
      </div>
    )
  }

  return warehouseContent
}
