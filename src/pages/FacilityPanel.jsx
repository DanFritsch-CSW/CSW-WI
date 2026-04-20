import { useState, useEffect, useCallback, useMemo } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import HourlyTable from '../components/HourlyTable.jsx'
import ProjectList from '../components/ProjectList.jsx'
import RosterBoard from '../components/RosterBoard.jsx'
import { fetchHourlyData, fetchProjectData, fetchHistoricalHourlyDrops } from '../lib/omni.js'
import { fetchEstDrops, fetchProjectDrops, upsertEstDrops } from '../lib/supabase.js'
import { useSettings } from '../hooks/useSettings.js'
import { applySettings, computeDailyKpis, buildRosterAvailability } from '../lib/laborCalc.js'

export default function FacilityPanel({ facility, planDate, networkKpi }) {
  const [rawHourly, setRawHourly]   = useState([])
  const [hourlyErr, setHourlyErr]   = useState(null)
  const [projects, setProjects]     = useState([])
  const [laborCount, setLaborCount] = useState(0)
  const [rosterState, setRosterState] = useState({ employees: [], laneMap: {} })
  const [estDrops, setEstDrops]           = useState({})
  const [projectDrops, setProjectDrops]   = useState({})
  const [seedingDrops, setSeedingDrops]   = useState(false)

  const { settings, loading: settingsLoading } = useSettings(facility.id)

  useEffect(() => {
    setRawHourly([])
    setHourlyErr(null)
    setProjects([])
    setEstDrops({})
    setProjectDrops({})
    fetchHourlyData(facility.id, planDate)
      .then(setRawHourly)
      .catch(e => setHourlyErr(e.message))
    fetchProjectData(facility.id, planDate).then(setProjects)
    fetchEstDrops(facility.id, planDate).then(async data => {
      if (Object.keys(data).length > 0) {
        setEstDrops(data)
        return
      }
      // No manual entries yet — auto-seed from historical average
      setSeedingDrops(true)
      try {
        const historical = await fetchHistoricalHourlyDrops(facility.id, planDate)
        if (historical.length) {
          await upsertEstDrops(facility.id, planDate, historical)
          setEstDrops(Object.fromEntries(historical.map(({ h, est }) => [h, est])))
        }
      } finally {
        setSeedingDrops(false)
      }
    })
    fetchProjectDrops(facility.id, planDate).then(setProjectDrops)
  }, [facility.id, planDate])

  const handleLaborCount   = useCallback(n => setLaborCount(n), [])
  const handleRosterChange = useCallback(state => setRosterState(state), [])

  // Per-hour availability derived from the live roster.
  // Returns a 24-element array once employees are loaded, or null to fall back to Omni avail.
  const rosterAvail = useMemo(() => {
    if (!rosterState.employees.length) return null
    return buildRosterAvailability(rosterState.employees, rosterState.laneMap, settings, rosterState.assignmentMap)
  }, [rosterState, settings])

  // Override appts per hour using est drops (inb + est_drops + out).
  // Falls back to 0 est drops for hours without an entry.
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
    appts: projects.reduce((s, p) => s + p.tot, 0),
    inb:   projects.reduce((s, p) => s + p.inb, 0),
    out:   projects.reduce((s, p) => s + p.out, 0),
    labor: laborCount,
    util:  util  ?? networkKpi?.util,
    delta: delta ?? networkKpi?.delta,
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
      <div className="section-label" style={{ marginTop: 8 }}>
        Hourly Breakdown
        {seedingDrops && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Loading forecast…</span>}
      </div>
      {hourlyErr
        ? <div style={{ padding: '8px 12px', color: '#e05a5a', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg2)', borderRadius: 8, marginBottom: 12 }}>{hourlyErr}</div>
        : <HourlyTable hourlyData={hourly} estDrops={estDrops} color={facility.color} />
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
