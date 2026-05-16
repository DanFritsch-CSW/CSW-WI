import CompareChart from '../components/CompareChart.jsx'
import { FACILITY_LIST } from '../lib/constants.js'

const DEFAULT_HPA = 1.5

export default function AllFacilities({ networkData, facilityEstDrops = {}, facilityLaborCounts = {}, facilitySettings = {}, facilityDeltas = {}, facilityKpis = {}, planDate, onFacilityClick }) {
  if (!networkData) return null

  return (
    <div>
      <CompareChart networkData={networkData} facilityEstDrops={facilityEstDrops} />
      <div className="scorecards-grid">
        {FACILITY_LIST.map(fac => {
          const d        = networkData[fac.id] || {}
          const panelKpi = facilityKpis[fac.id]

          const inb      = panelKpi?.inb   ?? d.inb ?? 0
          const out      = panelKpi?.out   ?? d.out ?? 0
          const estDrops = Math.round(panelKpi?.drops ?? facilityEstDrops[fac.id] ?? 0)
          const appts    = Math.round(inb + out + estDrops)

          const laborData  = facilityLaborCounts[fac.id]
          const headcount  = laborData?.headcount  ?? '--'
          const totalHours = laborData?.totalHours != null
            ? Math.round(laborData.totalHours * 10) / 10
            : '--'

          const hpa   = facilitySettings[fac.id] ?? DEFAULT_HPA
          const labor = Math.round(appts * hpa * 10) / 10

          const facilityDelta = facilityDeltas[fac.id]
          const flatDelta = (typeof totalHours === 'number')
            ? Math.round((totalHours - labor) * 10) / 10
            : null
          const delta = facilityDelta != null
            ? Math.round(facilityDelta * 10) / 10
            : flatDelta

          const deltaPositive = delta != null && delta >= 0
          const deltaLabel    = delta != null ? `${delta >= 0 ? '+' : ''}${delta}` : '--'

          return (
            <div key={fac.id}
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
                  <span className="scorecard-kpi-value">{inb}</span>
                </div>
                <div className="scorecard-kpi">
                  <span className="scorecard-kpi-label">Outbound</span>
                  <span className="scorecard-kpi-value">{out}</span>
                </div>
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
                  <span className="scorecard-kpi-value" style={{ color: fac.color }}>{labor}</span>
                </div>
                <div className="scorecard-kpi scorecard-kpi--delta">
                  <span className="scorecard-kpi-label">Daily +/-</span>
                  <span className="scorecard-kpi-value scorecard-delta-value"
                    style={{ color: delta == null ? 'var(--text-dim)' : deltaPositive ? 'var(--green)' : 'var(--red)' }}>
                    {deltaLabel}
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
