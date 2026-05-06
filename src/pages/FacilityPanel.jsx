import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
  loadCustomDropRules,
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

const KEN_STALE_KEYS = new Set(['FAIR OAKS FARMS', 'FAIR OAKS FARMS WEST'])

// Generate ISO date strings for a range [from, to] inclusive
function dateRange(from, to) {
  const dates = []
  const cur = new Date(from + 'T00:00:00Z')
  const end = new Date(to   + 'T00:00:00Z')
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return dates
}

// Mon–Fri of the ISO week containing a given date
function weekOf(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z')
  const day = d.getUTCDay() || 7  // Mon=1 … Sun=7
  const mon = new Date(d)
  mon.setUTCDate(d.getUTCDate() - (day - 1))
  const fri = new Date(mon)
  fri.setUTCDate(mon.getUTCDate() + 4)
  return {
    from: mon.toISOString().slice(0, 10),
    to:   fri.toISOString().slice(0, 10),
  }
}

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
  const [customDropProjects, setCustomDropProjects] = useState([])

  // Copy-to-dates state
  const [copyOpen, setCopyOpen]   = useState(false)
  const [copyFrom, setCopyFrom]   = useState('')
  const [copyTo, setCopyTo]       = useState('')
  const [copying, setCopying]     = useState(false)
  const [copyMsg, setCopyMsg]     = useState(null)

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
      const customRows = await loadCustomDropRules(facility.id)
      if (!cancelled) setCustomDropProjects(customRows)

      const [hourlyResult, apptsResult] = await Promise.allSettled([
        fetchHourlyData(facility.id, planDate),
        fetchHourlyAppointments(facility.id, planDate),
      ])
      if (cancelled) return

      if (hourlyResult.status === 'fulfilled') setRawHourly(hourlyResult.value)
      else setHourlyErr(hourlyResult.reason?.message ?? 'Failed to load hourly data')

      if (apptsResult.status === 'fulfilled') setHourlyAppts(apptsResult.value)

      let fetchedProjects = []
      try {
        fetchedProjects = await fetchProjectData(facility.id, planDate)
        if (!cancelled) setProjects(fetchedProjects)
      } catch { /* non-fatal */ }
      if (cancelled) return

      if (isMad) {
        fetchActiveInventory(facility.id)
          .then(d => { if (!cancelled) setActiveInventory(d) })
          .catch(() => { if (!cancelled) setActiveInventory([]) })
      }
      fetchHourlyAdjustments(facility.id, planDate)
        .then(d => { if (!cancelled) setHourlyAdjustments(d) })

      const hasCustom = customRows.length > 0
      const shouldSeed = isKen || hasCustom || fetchedProjects.length > 0
      if (!shouldSeed) return

      try {
        const data = await fetchProjectHourlyDrops(facility.id, planDate)
        if (cancelled) return

        const filtered = Object.fromEntries(
          Object.entries(data).filter(([name]) => isRuleProject(facility.id, name) && !KEN_STALE_KEYS.has(name))
        )

        if (isKen || hasCustom) {
          const allRequired = [
            ...(isKen ? KEN_GUARANTEED_PROJECTS : []),
            ...customRows.map(r => r.project_name),
          ]
          const missingProjects = allRequired.filter(p => !(p in filtered))

          if (missingProjects.length > 0) {
            setSeedingDrops(true)
            try {
              const historical = await fetchHistoricalProjectHourlyDrops(facility.id, planDate)
              if (cancelled) return
              const patch = {}
              for (const p of missingProjects) {
                patch[p] = historical[p] ?? { 17: 0 }
              }
              const rows = []
              for (const [project_name, hourMap] of Object.entries(patch)) {
                for (const [h, est_drops] of Object.entries(hourMap)) {
                  rows.push({ project_name, h: Number(h), est_drops })
                }
              }
              if (rows.length) await upsertProjectHourlyDrops(facility.id, planDate, rows)
              if (!cancelled) setProjectHourlyDrops({ ...filtered, ...patch })
            } finally {
              if (!cancelled) setSeedingDrops(false)
            }
          } else {
            setProjectHourlyDrops(filtered)
          }
          return
        }

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

  // Open copy panel: default to Mon–Fri of planDate's week, excluding planDate itself
  function openCopy() {
    const { from, to } = weekOf(planDate)
    setCopyFrom(from === planDate ? addDays(from, 1) : from)
    setCopyTo(to)
    setCopyMsg(null)
    setCopyOpen(true)
  }

  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }

  async function handleCopy() {
    if (!copyFrom || !copyTo || copyFrom > copyTo) {
      setCopyMsg({ err: true, text: 'Invalid date range.' })
      return
    }
    const dates = dateRange(copyFrom, copyTo).filter(d => d !== planDate)
    if (!dates.length) { setCopyMsg({ err: true, text: 'No dates to copy to.' }); return }

    setCopying(true)
    setCopyMsg(null)
    try {
      // Build rows from current projectHourlyDrops state
      const rows = []
      for (const [project_name, hourMap] of Object.entries(projectHourlyDrops)) {
        for (const [h, est_drops] of Object.entries(hourMap)) {
          rows.push({ project_name, h: Number(h), est_drops })
        }
      }
      // Write to each target date
      await Promise.all(dates.map(d => upsertProjectHourlyDrops(facility.id, d, rows)))
      setCopyMsg({ err: false, text: `Copied to ${dates.length} date${dates.length > 1 ? 's' : ''}.` })
    } catch {
      setCopyMsg({ err: true, text: 'Copy failed — try again.' })
    } finally {
      setCopying(false)
    }
  }

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
        const hour = Number(h)
        sums[hour] = (sums[hour] ?? 0) + v
      }
    }
    return sums
  }, [visibleProjectHourlyDrops])

  const totalDrops = useMemo(() => Object.values(estDrops).reduce((s, v) => s + v, 0), [estDrops])

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

  const totalInb = visibleProjects.reduce((s, p) => s + p.inb, 0)
  const totalOut = visibleProjects.reduce((s, p) => s + p.out, 0)

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
      if (isKen) {
        for (const p of KEN_GUARANTEED_PROJECTS) {
          if (!(p in historical)) historical[p] = { 17: 0 }
        }
      }
      for (const row of customDropProjects) {
        if (!(row.project_name in historical)) historical[row.project_name] = { 17: 0 }
      }
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

  const hasDropData = Object.keys(projectHourlyDrops).length > 0

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

      <div className="section-label" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Hourly Breakdown</span>
        {seedingDrops
          ? <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Loading forecast\u2026</span>
          : <>
              <button className="est-reset-btn" title="Recalculate EST drops from last 4-week historical average" onClick={resetEstDrops}>
                \u21ba Reset EST Drops
              </button>
              {hasDropData && (
                <button className="est-reset-btn" title="Copy current EST drop values to other dates" onClick={openCopy}>
                  \u29c9 Copy to dates\u2026
                </button>
              )}
            </>
        }

        {/* Inline copy panel */}
        {copyOpen && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            background: 'var(--bg2)', borderRadius: 6, padding: '6px 10px',
            border: '1px solid var(--border)', fontSize: 11, fontFamily: 'var(--font-mono)',
          }}>
            <span style={{ color: 'var(--text-secondary)' }}>Copy EST drops from <strong>{planDate}</strong> to:</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              From
              <input type="date" className="settings-field-input" style={{ width: 130, padding: '2px 6px' }}
                value={copyFrom} onChange={e => setCopyFrom(e.target.value)} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              To
              <input type="date" className="settings-field-input" style={{ width: 130, padding: '2px 6px' }}
                value={copyTo} onChange={e => setCopyTo(e.target.value)} />
            </label>
            <button className="est-reset-btn" onClick={handleCopy} disabled={copying}>
              {copying ? 'Copying\u2026' : 'Copy'}
            </button>
            <button className="est-reset-btn" onClick={() => { setCopyOpen(false); setCopyMsg(null) }}>Cancel</button>
            {copyMsg && (
              <span style={{ color: copyMsg.err ? '#e05a5a' : 'var(--text-secondary)' }}>{copyMsg.text}</span>
            )}
          </div>
        )}
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
