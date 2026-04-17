import { useState, useEffect, useCallback } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import InsightChips from '../components/InsightChips.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import DeltaChart from '../components/DeltaChart.jsx'
import ProjectList from '../components/ProjectList.jsx'
import RosterBoard from '../components/RosterBoard.jsx'
import { fetchHourlyData, fetchProjectData } from '../lib/omni.js'

export default function FacilityPanel({ facility, planDate, networkKpi }) {
  const [hourly, setHourly]     = useState([])
  const [projects, setProjects] = useState([])
  const [laborCount, setLaborCount] = useState(0)

  useEffect(() => {
    setHourly([])
    setProjects([])
    fetchHourlyData(facility.id, planDate).then(setHourly)
    fetchProjectData(facility.id, planDate).then(setProjects)
  }, [facility.id, planDate])

  const handleLaborCount = useCallback(n => setLaborCount(n), [])

  const kpiData = {
    appts: networkKpi?.appts,
    inb:   networkKpi?.inb,
    out:   networkKpi?.out,
    labor: laborCount,
    util:  networkKpi?.util,
    delta: networkKpi?.delta,
  }

  return (
    <div>
      <KpiPills data={kpiData} color={facility.color} />
      <InsightChips data={kpiData} labor={laborCount} />
      <div className="two-col">
        <HourlyChart hourlyData={hourly} color={facility.color} />
        <DeltaChart  hourlyData={hourly} />
      </div>
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
