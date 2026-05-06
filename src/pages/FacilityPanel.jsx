import { useState, useEffect, useCallback, useMemo } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import HourlyTable from '../components/HourlyTable.jsx'
import ProjectList from '../components/ProjectList.jsx'
import RosterBoard from '../components/RosterBoard.jsx'
import {
  fetchHourlyData,
  fetchHourlyAppointments,
  fetchProjectData,
  fetchHistoricalProjectHourlyDrops,
  fetchProjectHourlyAppointments,
  isRuleProject,
  fetchActiveInventory,
  KEN_GUARANTEED_PROJECTS,
} from '../lib/omni.js'
import { fetchProjectHourlyDrops, upsertProjectHourlyDrops, fetchHourlyAdjustments, upsertHourlyAdjustment } from '../lib/supabase.js'
import { useSettings } from '../hooks/useSettings.js'
import { applySettings, computeDailyKpis, buildRosterAvailability, computeBreakAdjustedTotalHours } from '../lib/laborCalc.js'

const CAL2_SIDE35_PROJECTS = new Set([
  'Palermos CALEDONIA finished',
  "Palermo's CALEDONIA finished",
  'PALERMOS CALEDONIA FINISHED',
])

const SIDE12_LANES = new Set(['side12_shift1','side12_mid','side12_shift2','side12_shift3'])
const SIDE35_LANES = new Set(['side35_shift1','side35_mid','side35_shift2','side35_shift3'])

const CAL2_TABS = [
  { id: 'all',    label: 'All' },
  { id: 'side12', label: '1-2 Side' },
  { id: 'side35', label: '3.5 Side' },
]

export default function FacilityPanel({ facility, planDate, networkKpi, onDeltaComputed }) {
  const [rawHourly, setRawHourly]           = useState([])
  const [hourlyAppts, setHourlyAppts]       = useState({})
  const [hourlyErr, setHourlyErr]           = useState(null)
  const [projects, setProjects]             = useState([])
  const [laborCount, setLaborCount]         = useState(0)
  const [rosterState, setRosterState]       = useState({ employees: [], laneMap: {}, assignmentMap: {} })
  const [projectHourlyDrops, setProjectHourlyDrops] = useState({})
  const [seedingDrops, setSeedingDrops]             = useState(false)
  const [hourlyAdjustments, setHourlyAdjustments]   = useState({})
  const [activeInventory, setActiveInventory]       = useState(null)
  const [sideHourlyAppts, setSideHourlyAppts]       = useState({})

  const isCal2 = facility.id === 'cal'
  const isMad  = facility.id === 'mad'
  const isKen  = facility.id === 'ken'
  const [sideTab, setSideTab] = useState('all')

  const { settings, loading: settingsLoading } = useSettings(facility.id)

  useEffect(() => {
    let cancelled = false

    setRawHourly([])
    setHourlyAppts({})
    setHourlyErr(null)
    setProjects([])
    setProjectHourlyDrops({})
    setHourlyAdjustments({})
    setSideHourlyAppts({})
    setActiveInventory(null)

    async function loadData() {
      // Phase 1: hourly labor + appointments (parallel — same model, low collision risk)
      const [hourlyResult, apptsResult] = await Promise.allSettled([
        fetchHourlyData(facility.id, planDate),
        fetchHourlyAppointments(facility.id, planDate),
      ])
      if (cancelled) return

      if (hourlyResult.status === 'fulfilled') setRawHourly(hourlyResult.value)
      else setHourlyErr(hourlyResult.reason?.message ?? 'Failed to load hourly data')

      if (apptsResult.status === 'fulfilled') setHourlyAppts(apptsResult.value)

      // Phase 2: project list (sequential — waits for phase 1)
      let fetchedProjects = []
      try {
        fetchedProjects = await fetchProjectData(facility.id, planDate)
        if (!cancelled) setProjects(fetchedProjects)
      } catch {
        // non-fatal
      }
      if (cancelled) return

      // Phase 2b: MAD inventory + hourly adjustments (Supabase, no Omni load)
      if (isMad) {
        fetchActiveInventory(facility.id)
          .then(d => { if (!cancelled) setActiveInventory(d) })
          .catch(() => { if (!cancelled) setActiveInventory([]) })
      }
      fetchHourlyAdjustments(facility.id, planDate)
        .then(d => { if (!cancelled) setHourlyAdjustments(d) })

      // Phase 3: EST drops seed
      // For KEN: always run seeding — guaranteed projects need to appear even on empty-appointment days.
      // For other facilities: skip if no projects returned (avoids 24+ Omni queries on future empty dates).
      const shouldSeed = isKen || fetchedProjects.length > 0
      if (!shouldSeed) return

      try {
        const data = await fetchProjectHourlyDrops(facility.id, planDate)
        if (cancelled) return
        const filtered = Object.fromEntries(
          Object.entries(data).filter(([name]) => isRuleProject(facility.id, name))
        )
        if (Object.keys(filtered).length > 0) {
          setProjectHourlyDrops(filtered)
          return
        }
        setSeedingDrops(true)
        try {
          const historical = await fetchHistoricalProjectHourlyDrops(facility.id, planDate)
          if (cancelled) return
          if (Object.keys(historical).length) {
            const rows = []
            for (const [project_name, hourMap] of Object.entries(historical)) {
              for (const [h, est_drops] of Object.entries(hourMap)) {
                rows.push({ project_name, h: Number(h), est_drops })
              }
            }
            await upsertProjectHourlyDrops(facility.id, planDate, rows)
            if (!cancelled) setProjectHourlyDrops(historical)
          }
        } finally {
          if (!cancelled) setSeedingDrops(false)
        }
      } catch {
        if (!cancelled) setSeedingDrops(false)
      }
    }

    loadData()
    return () => { cancelled = true }
  }, [facility.id, planDate, isMad, isKen])

  useEffect(() => {
    if (!isCal2 || sideTab === 'all') {
      setSideHourlyAppts({})
      return
    }
    if (!projects.length) return
    const sideProjectNames = projects
      .map(p => p.name)
      .filter(n => sideTab === 'side35' ? CAL2_SIDE35_PROJECTS.has(n) : !CAL2_SIDE35_PROJECTS.has(n))
    if (!sideProjectNames.length) {
      setSideHourlyAppts({})
      return
    }
    fetchProjectHourlyAppointments(facility.id, planDate, sideProjectNames)
      .then(setSideHourlyAppts)
      .catch(() => setSideHourlyAppts({}))
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
    return buildRosterAvailability(
      rosterState.employees, rosterState.laneMap, settings,
      rosterState.assignmentMap, laneFilter
    )
  }, [rosterState, settings, laneFilter])

  const breakAdjustedTotalHours = useMemo(() => {
    if (!rosterState.employees.length || settingsLoading) return 0
    return computeBreakAdjustedTotalHours(
      rosterState.employees, rosterState.laneMap, settings,
      rosterState.assignmentMap, laneFilter
    )
  }, [rosterState, settings, settingsLoading, laneFilter])

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
    for (const [name, hourMap] of Object.entries(visibleProjectHourlyDrops)) {
      result[name] = Object.values(hourMap).reduce((s, v) => s + v, 0)
    }
    return result
  }, [visibleProjectHourlyDrops])

  const estDrops = useMemo(() => {
    const sums = {}
    for (const hourMap of Object.values(visibleProjectHourlyDrops)) {
      for (const [h, v] of Object.entries(hourMap)) {
        sums[h] = (sums[h] ?? 0) + v
      }
    }
    return sums
  }, [visibleProjectHourlyDrops])

  const rawWithAppts = useMemo(() => {
    if (!rawHourly.length) return rawHourly
    return rawHourly.map(row => {
      const est = estDrops[row.h] ?? 0
      let inb, out
      if (isCal2 && sideTab !== 'all') {
        const sideAppt = sideHourlyAppts[row.h] ?? { inb: 0, out: 0 }
        inb = sideAppt.inb
        out = sideAppt.out
      } else {
        const appt = hourlyAppts[row.h] ?? { inb: 0, out: 0 }
        inb = appt.inb
        out = appt.out
      }
      return { ...row, inb, out, drops: est, appts: inb + est + out }
    })
  }, [rawHourly, hourlyAppts, estDrops, isCal2, sideTab, sideHourlyAppts])

  const hourly = useMemo(() => {
    const base = settingsLoading ? rawWithAppts : applySettings(rawWithAppts, settings)
    if (!rosterAvail) return base
    return base.map(row => ({ ...row, avail: rosterAvail[row.h] ?? 0 }))
  }, [rawWithAppts, settings, settingsLoading, rosterAvail])

  const { util, delta } = computeDailyKpis(hourly)

  useEffect(() => {
    if (onDeltaComputed && sideTab === 'all' && delta != null) {
      onDeltaComputed(facility.id, delta)
    }
  }, [delta, facility.id, sideTab, onDeltaComputed])

  const sideHeadcount = isCal2 && sideTab !== 'all'
    ? Object.entries(rosterState.laneMap).filter(([, l]) => laneFilter?.has(l)).length
    : laborCount

  const totalInb   = visibleProjects.reduce((s, p) => s + p.inb, 0)
  const totalOut   = visibleProjects.reduce((s, p) => s + p.out, 0)
  const totalDrops = visibleProjects.reduce((s, p) => s + (projectDrops[p.name] ?? 0), 0)

  const kpiData = {
    appts:      totalInb + totalOut + totalDrops,
    drops:      totalDrops,
    inb:        totalInb,
    out:        totalOut,
    labor:      sideHeadcount,
    totalHours: breakAdjustedTotalHours,
    util:       util  ?? networkKpi?.util,
    delta:      delta ?? networkKpi?.delta,
  }

  const resetEstDrops = async () => {
    setSeedingDrops(true)
    try {
      const historical = await fetchHistoricalProjectHourlyDrops(facility.id, planDate)
      if (Object.keys(historical).length) {
        const rows = []
        for (const [project_name, hourMap] of Object.entries(historical)) {
          for (const [h, est_drops] of Object.entries(hourMap)) {
            rows.push({ project_name, h: Number(h), est_drops })
          }
        }
        await upsertProjectHourlyDrops(facility.id, planDate, rows)
        setProjectHourlyDrops(historical)
      }
    } finally {
      setSeedingDrops(false)
    }
  }

  return (
    <div>
      {isCal2 && (
        <div className="cal2-tab-row">
          {CAL2_TABS.map(t => (
            <button
              key={t.id}
              data-side={t.id}
              className={`cal2-tab${sideTab === t.id ? ' active' : ''}`}
              onClick={() => setSideTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="panel-top-grid">
        <KpiPills data={kpiData} color={facility.color} />
        <div>
          <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>Projects</div>
          <ProjectList
            projects={visibleProjects}
            projectDrops={projectDrops}
            color={facility.color}
            inventoryData={isMad ? activeInventory : null}
          />
        </div>
      </div>

      <HourlyChart hourlyData={hourly} color={facility.color} />

      <div className="section-label" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>Hourly Breakdown</span>
        {seedingDrops
          ? <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Loading forecast…</span>
          : <button className="est-reset-btn" title="Recalculate EST drops from last 4-week historical average" onClick={resetEstDrops}>
              ↺ Reset EST Drops
            </button>
        }
      </div>

      {hourlyErr
        ? <div style={{ padding: '8px 12px', color: '#e05a5a', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg2)', borderRadius: 8, marginBottom: 12 }}>{hourlyErr}</div>
        : <HourlyTable
            hourlyData={hourly}
            estDrops={estDrops}
            projectHourlyDrops={visibleProjectHourlyDrops}
            hourlyAdjustments={hourlyAdjustments}
            onProjectHourlyChange={(projectName, h, val) => {
              setProjectHourlyDrops(prev => ({
                ...prev,
                [projectName]: { ...(prev[projectName] ?? {}), [h]: val },
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

      <RosterBoard
        facility={facility.id}
        planDate={planDate}
        settings={settings}
        onLaborCount={handleLaborCount}
        onRosterChange={handleRosterChange}
      />
    </div>
  )
}
