import { useState, useEffect, useCallback, useMemo } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import InsightChips from '../components/InsightChips.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import DeltaChart from '../components/DeltaChart.jsx'
import HourlyTable from '../components/HourlyTable.jsx'
import ProjectList from '../components/ProjectList.jsx'
import RosterBoard from '../components/RosterBoard.jsx'
import { fetchHourlyData, fetchProjectData } from '../lib/omni.js'
import { useSettings } from '../hooks/useSettings.js'
import { applySettings, computeDailyKpis, buildRosterAvailability } from '../lib/laborCalc.js'

export default function FacilityPanel({ facility, planDate, networkKpi }) {
  const [rawHourly, setRawHourly]   = useState([])
  const [hourlyErr, setHourlyErr]   = useState(null)
  const [projects, setProjects]     = useState([])
  const [laborCount, setLaborCount] = useState(0)
  const [rosterState, setRosterState] = useState({ employees: [], laneMap: {} })

  const { settings, loading: settingsLoading } = useSettings(facility.id)

  useEffect(() => {
    setRawHourly([])
    setHourlyErr(null)
    setProjects([])
    fetchHourlyData(facility.id, planDate)
      .then(setRawHourly)
      .catch(e => setHourlyErr(e.message))
    fetchProjectData(facility.id, planDate).then(setProjects)
  }, [facility.id, planDate])

  const handleLaborCount  = useCallback(n => setLaborCount(n), [])
  const handleRosterChange = useCallback(state => setRosterState(state), [])

  // Per-hour availability derived from the live roster.
  // Returns a 24-element array once employees are loaded, or null to fall back to Omni avail.
  const rosterAvail = useMemo(() => {
    if (!rosterState.employees.length) return null
    return buildRosterAvailability(rosterState.employees, rosterState.laneMap, settings)
  }, [rosterState, settings])

  // Apply settings (req from appts, break% on avail), then overlay roster-based avail.
  const hourly = useMemo(() => {
    const base = settingsLoading ? rawHourly : applySettings(rawHourly, settings)
    if (!rosterAvail) return base
    return base.map(row => ({ ...row, avail: rosterAvail[row.h] ?? 0 }))
  }, [rawHourly, settings, settingsLoading, rosterAvail])

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
      <KpiPills data={kpiData} color={facility.color} />
      <InsightChips data={kpiData} labor={laborCount} />
      <div className="two-col">
        <HourlyChart hourlyData={hourly} color={facility.color} />
        <DeltaChart  hourlyData={hourly} />
      </div>
      <div className="section-label" style={{ marginTop: 8 }}>Hourly Breakdown</div>
      {hourlyErr
        ? <div style={{ padding: '8px 12px', color: '#e05a5a', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg2)', borderRadius: 8, marginBottom: 12 }}>{hourlyErr}</div>
        : <HourlyTable hourlyData={hourly} color={facility.color} />
      }
      <div className="section-label" style={{ marginTop: 8 }}>Projects</div>
      <ProjectList projects={projects} color={facility.color} />
      <RosterBoard
        facility={facility.id}
        planDate={planDate}
        onLaborCount={handleLaborCount}
        onRosterChange={handleRosterChange}
      />
    </div>
  )
}
