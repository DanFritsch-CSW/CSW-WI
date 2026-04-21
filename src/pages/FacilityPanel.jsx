import { useState, useEffect, useCallback, useMemo } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import HourlyTable from '../components/HourlyTable.jsx'
import ProjectList from '../components/ProjectList.jsx'
import RosterBoard from '../components/RosterBoard.jsx'
import { fetchHourlyData, fetchProjectData, fetchHistoricalProjectHourlyDrops, isRuleProject } from '../lib/omni.js'
import { fetchProjectHourlyDrops, upsertProjectHourlyDrops } from '../lib/supabase.js'
import { useSettings } from '../hooks/useSettings.js'
import { applySettings, computeDailyKpis, buildRosterAvailability } from '../lib/laborCalc.js'

export default function FacilityPanel({ facility, planDate, networkKpi }) {
  const [rawHourly, setRawHourly]   = useState([])
  const [hourlyErr, setHourlyErr]   = useState(null)
  const [projects, setProjects]     = useState([])
  const [laborCount, setLaborCount] = useState(0)
  const [rosterState, setRosterState] = useState({ employees: [], laneMap: {} })
  const [projectHourlyDrops, setProjectHourlyDrops] = useState({})
  const [seedingDrops, setSeedingDrops]             = useState(false)

  const { settings, loading: settingsLoading } = useSettings(facility.id)

  useEffect(() => {
    setRawHourly([])
    setHourlyErr(null)
    setProjects([])
    setProjectHourlyDrops({})
    fetchHourlyData(facility.id, planDate)
      .then(setRawHourly)
      .catch(e => setHourlyErr(e.message))
    fetchProjectData(facility.id, planDate).then(setProjects)
    fetchProjectHourlyDrops(facility.id, planDate).then(async data => {
      // Strip any cross-facility entries seeded before facility guards were added
      const filtered = Object.fromEntries(
        Object.entries(data).filter(([name]) => isRuleProject(facility.id, name))
      )
      if (Object.keys(filtered).length > 0) {
        setProjectHourlyDrops(filtered)
        return
      }
      // No manual entries yet — auto-seed from historical per-project hourly average
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
    })
  }, [facility.id, planDate])

  const handleLaborCount   = useCallback(n => setLaborCount(n), [])
  const handleRosterChange = useCallback(state => setRosterState(state), [])

  // Per-hour availability derived from the live roster.
  // Returns a 24-element array once employees are loaded, or null to fall back to Omni avail.
  const rosterAvail = useMemo(() => {
    if (!rosterState.employees.length) return null
    return buildRosterAvailability(rosterState.employees, rosterState.laneMap, settings, rosterState.assignmentMap)
  }, [rosterState, settings])

  // Single source of truth: project day totals are always the sum of their hourly values.
  // This guarantees ProjectList and HourlyTable always show identical numbers.
  const projectDrops = useMemo(() => {
    const result = {}
    for (const [name, hourMap] of Object.entries(projectHourlyDrops)) {
      result[name] = Object.values(hourMap).reduce((s, v) => s + v, 0)
    }
    return result
  }, [projectHourlyDrops])

  // Sum per-project hourly drops into a single { [hour]: total } for labor calc.
  const estDrops = useMemo(() => {
    const sums = {}
    for (const hourMap of Object.values(projectHourlyDrops)) {
      for (const [h, v] of Object.entries(hourMap)) {
        sums[h] = (sums[h] ?? 0) + v
      }
    }
    return sums
  }, [projectHourlyDrops])

  // Override appts per hour using est drops (inb + est_drops + out).
  const rawWithEst = useMemo(() => {
    if (!rawHourly.length) return rawHourly
    return rawHourly.map(row => {
      const est = estDrops[row.h] ?? 0
      return { ...row, appts: row.inb + est + row.out }
    })
  }, [rawHourly, estDrops])

  // Apply settings (req from appts, break% on avail), then overlay roster-based avail.
  const hourly = useMemo(() => {
    const base = settingsLoading ? rawWithEst : applySettings(rawWithEst, settings)
    if (!rosterAvail) return base
    return base.map(row => ({ ...row, avail: rosterAvail[row.h] ?? 0 }))
  }, [rawWithEst, settings, settingsLoading, rosterAvail])

  const { util, delta } = computeDailyKpis(hourly)

  const kpiData = {
    appts:  projects.reduce((s, p) => s + p.inb + p.out + (projectDrops[p.name] ?? 0), 0),
    drops:  projects.reduce((s, p) => s + (projectDrops[p.name] ?? 0), 0),
    inb:    projects.reduce((s, p) => s + p.inb,           0),
    out:    projects.reduce((s, p) => s + p.out,           0),
    labor:  laborCount,
    util:   util  ?? networkKpi?.util,
    delta:  delta ?? networkKpi?.delta,
  }

  return (
    <div>
      <div className="panel-top-grid">
        <KpiPills data={kpiData} color={facility.color} />
        <div>
          <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>Projects</div>
          <ProjectList projects={projects} projectDrops={projectDrops} color={facility.color} />
        </div>
      </div>
      <HourlyChart hourlyData={hourly} color={facility.color} />
      <div className="section-label" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>Hourly Breakdown</span>
        {seedingDrops
          ? <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Loading forecast…</span>
          : <button
              className="est-reset-btn"
              title="Recalculate EST drops from last 4-week historical average, overwriting any manual edits"
              onClick={async () => {
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
              }}
            >
              ↺ Reset EST Drops
            </button>
        }
      </div>
      {hourlyErr
        ? <div style={{ padding: '8px 12px', color: '#e05a5a', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg2)', borderRadius: 8, marginBottom: 12 }}>{hourlyErr}</div>
        : <HourlyTable
            hourlyData={hourly}
            estDrops={estDrops}
            projectHourlyDrops={projectHourlyDrops}
            onProjectHourlyChange={(projectName, h, val) => {
              setProjectHourlyDrops(prev => ({
                ...prev,
                [projectName]: { ...(prev[projectName] ?? {}), [h]: val },
              }))
              upsertProjectHourlyDrops(facility.id, planDate, [{ project_name: projectName, h, est_drops: val }])
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
