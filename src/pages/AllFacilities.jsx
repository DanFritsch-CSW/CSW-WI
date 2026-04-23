import CompareChart from '../components/CompareChart.jsx'
import { FACILITY_LIST } from '../lib/constants.js'

// Exclude cal2 from the ALL-tab scorecards grid — it's the same facility as CAL
const SCORECARD_FACILITIES = FACILITY_LIST.filter(f => f.id !== 'cal2')

export default function AllFacilities({ networkData, facilityEstDrops = {}, facilityLaborCounts = {}, planDate }) {
  if (!networkData) return null

  return (
    <div>
      <CompareChart networkData={networkData} facilityEstDrops={facilityEstDrops} />
      <div className="scorecards-grid">
        {SCORECARD_FACILITIES.map(fac => {
          const d          = networkData[fac.id] || {}
          const estDrops   = facilityEstDrops[fac.id] ?? 0
          const appts      = (d.inb ?? 0) + (d.out ?? 0) + estDrops
          const labor      = d.labor != null ? Math.round(d.labor * 10) / 10 : null
          const laborData  = facilityLaborCounts[fac.id]
          const headcount  = laborData?.headcount  ?? '--'
          const totalHours = laborData?.totalHours != null
            ? Math.round(laborData.totalHours * 10) / 10
            : '--'

          return (
            <div
              key={fac.id}
              className="scorecard"
              style={{ '--accent': fac.color }}
            >
              <div className="scorecard-name">{fac.code}</div>
              <div className="scorecard-kpis">
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Appts</span>
                  <span className="scorecard-kpi-value">{appts}</span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Inbound</span>
                  <span className="scorecard-kpi-value">{d.inb ?? '--'}</span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Outbound</span>
                  <span className="scorecard-kpi-value">{d.out ?? '--'}</span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Est Drops</span>
                  <span className="scorecard-kpi-value">{estDrops}</span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Labor Req</span>
                  <span className="scorecard-kpi-value" style={{ color: fac.color }}>
                    {labor ?? '--'}
                  </span>
                </div>
                {/* Labor Available — dual metric tile */}
                <div className="scorecard-kpi scorecard-kpi--labor-avail">
                  <span className="scorecard-kpi-label">Labor Available</span>
                  <div className="labor-avail-metrics">
                    <div className="labor-avail-metric">
                      <span className="labor-avail-value">{headcount}</span>
                      <span className="labor-avail-sub">Warehousemen</span>
                    </div>
                    <div className="labor-avail-divider" />
                    <div className="labor-avail-metric">
                      <span className="labor-avail-value">{totalHours}</span>
                      <span className="labor-avail-sub">Total Hours</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
