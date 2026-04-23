import CompareChart from '../components/CompareChart.jsx'
import { FACILITY_LIST } from '../lib/constants.js'

// Exclude cal2 from the ALL-tab scorecards grid — same facility as CAL
const SCORECARD_FACILITIES = FACILITY_LIST.filter(f => f.id !== 'cal2')

export default function AllFacilities({ networkData, facilityEstDrops = {}, facilityLaborCounts = {}, planDate, onFacilityClick }) {
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
              className="scorecard scorecard--clickable"
              style={{ '--accent': fac.color }}
              onClick={() => onFacilityClick?.(fac.id)}
              title={`Open ${fac.code}`}
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

                {/* — Est Drops → Warehousemen → Total Hours → Labor Req — */}
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Est Drops</span>
                  <span className="scorecard-kpi-value">{estDrops}</span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Warehousemen</span>
                  <span className="scorecard-kpi-value">{headcount}</span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Total Hrs Avail</span>
                  <span className="scorecard-kpi-value">{totalHours}</span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Labor Req</span>
                  <span className="scorecard-kpi-value" style={{ color: fac.color }}>
                    {labor ?? '--'}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
