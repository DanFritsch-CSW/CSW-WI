import { useState, useEffect, useCallback } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import InsightChips from '../components/InsightChips.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import DeltaChart from '../components/DeltaChart.jsx'
import HourlyTable from '../components/HourlyTable.jsx'
import ProjectList from '../components/ProjectList.jsx'
import RosterBoard from '../components/RosterBoard.jsx'
import { fetchHourlyData, fetchProjectData } from '../lib/omni.js'
import { useSettings } from '../hooks/useSettings.js'
import { applySettings, computeDailyKpis } from '../lib/laborCalc.js'

export default function FacilityPanel({ facility, planDate, networkKpi }) {
  const [rawHourly, setRawHourly]   = useState([])
  const [hourlyErr, setHourlyErr]   = useState(null)
  const [projects, setProjects]     = useState([])
  const [laborCount, setLaborCount] = useState(0)

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

  const handleLaborCount = useCallback(n => setLaborCount(n), [])

  // Apply settings override once both hourly data and settings are ready
  const hourly = settingsLoading ? rawHourly : applySettings(rawHourly, settings)

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
      />
    </div>
  )
}
