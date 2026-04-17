import CompareChart from '../components/CompareChart.jsx'
import { FACILITY_LIST } from '../lib/constants.js'

export default function AllFacilities({ networkData, planDate }) {
  if (!networkData) return null

  return (
    <div>
      <CompareChart networkData={networkData} />
      <div className="scorecards-grid">
        {FACILITY_LIST.map(fac => {
          const d = networkData[fac.id] || {}
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
                  <span className="scorecard-kpi-value">{d.appts ?? '--'}</span>
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
                  <span className="scorecard-kpi-label">Labor</span>
                  <span className="scorecard-kpi-value" style={{ color: fac.color }}>
                    {d.labor ?? '--'}
                  </span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Util</span>
                  <span className="scorecard-kpi-value">{d.util != null ? `${d.util}%` : '--'}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
