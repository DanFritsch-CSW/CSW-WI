import CompareChart from '../components/CompareChart.jsx'
import { FACILITY_LIST } from '../lib/constants.js'

export default function AllFacilities({ networkData, facilityEstDrops = {}, facilityLaborCounts = {}, planDate }) {
  if (!networkData) return null

  return (
    <div>
      <CompareChart networkData={networkData} facilityEstDrops={facilityEstDrops} />
      <div className="scorecards-grid">
        {FACILITY_LIST.map(fac => {
          const d        = networkData[fac.id] || {}
          const estDrops = facilityEstDrops[fac.id] ?? 0
          const appts    = (d.inb ?? 0) + (d.out ?? 0) + estDrops
          const labor    = d.labor != null ? Math.round(d.labor * 10) / 10 : null
          const laborAvail = facilityLaborCounts[fac.id] ?? '--'
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
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Labor Avail</span>
                  <span className="scorecard-kpi-value">{laborAvail}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
