// src/pages/KenV2Panel.jsx
//
// Diagnostic tab: Omni's appointment/labor-req data + App-computed roster math.
//
// Data sources:
//   - Labor Required, appointments, inbound, outbound, drops → Omni labor model
//     (hourly_labor_required_vs_available, labor_shift_timestamp 5am→5am filter)
//   - Staffed headcount, Labor Available → computed client-side from the live
//     B2E roster using the same laborCalc.js logic as the main FacilityPanel.
//     (The base Omni table only materializes roster columns for past dates after
//     nightly jobs run; current-day values are always zero via the API.)
//
// The hourly table shows both Omni's Labor Req and the App's Staffed/Avail
// side-by-side with Δ columns, so any divergence from Omni's workbook is visible.
// Roster is in-memory only — drag-drop changes don't persist to Supabase.
//
// Props: planDate, networkKpi, onDeltaComputed, onKpiComputed, facility

import { useState, useEffect, useCallback, useMemo } from 'react'
import KpiPills from '../components/KpiPills.jsx'
import HourlyChart from '../components/HourlyChart.jsx'
import OmniHourlyTable from '../components/OmniHourlyTable.jsx'
import RosterBoardMemory from '../components/RosterBoardMemory.jsx'
import { fetchOmniLaborFullRow } from '../lib/omni.js'
import { useSettings } from '../hooks/useSettings.js'
import { buildRosterAvailability, buildRosterStaffedHeadcount } from '../lib/laborCalc.js'
import { FACILITIES } from '../lib/constants.js'

function r1(n) { return Math.round(n * 10) / 10 }

export default function KenV2Panel({ planDate, networkKpi, onDeltaComputed, onKpiComputed, facility }) {
  const fac   = facility ?? FACILITIES.ken
  const facId = fac.id

  const [omniRows, setOmniRows]       = useState([])
  const [loadErr, setLoadErr]         = useState(null)
  const [loading, setLoading]         = useState(true)
  const [retryNonce, setRetryNonce]   = useState(0)
  const [rosterState, setRosterState] = useState({ employees: [], laneMap: {}, assignmentMap: {} })
  const [fetchedAt, setFetchedAt]     = useState(null)

  const { settings } = useSettings(facId)

  useEffect(() => {
    let cancelled = false
    setOmniRows([])
    setLoadErr(null)
    setLoading(true)
    setFetchedAt(null)

    fetchOmniLaborFullRow(facId, planDate)
      .then(rows => {
        if (cancelled) return
        setOmniRows(rows)
        setFetchedAt(new Date())
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        console.error('fetchOmniLaborFullRow failed:', err)
        setLoadErr(err.message || 'Failed to load Omni labor data')
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [facId, planDate, retryNonce])

  const handleRosterChange = useCallback(s => setRosterState(s), [])

  // App-computed roster labor — same logic as FacilityPanel, read-only here
  const appAvail = useMemo(() => {
    if (!rosterState.employees.length) return null
    return buildRosterAvailability(
      rosterState.employees, rosterState.laneMap, settings, rosterState.assignmentMap, null
    )
  }, [rosterState, settings])

  const appStaffed = useMemo(() => {
    if (!rosterState.employees.length) return null
    return buildRosterStaffedHeadcount(
      rosterState.employees, rosterState.laneMap, rosterState.assignmentMap, null
    )
  }, [rosterState])

  // Merge Omni req/appts with App avail for chart + KPIs
  const mergedRows = useMemo(() => omniRows.map(r => ({
    h:     r.h,
    appts: r.appts,
    req:   r.req,
    avail: appAvail?.[r.h] ?? 0,
    inb:   r.inb,
    out:   r.out,
    drops: r.drops,
  })), [omniRows, appAvail])

  const totals = useMemo(() => {
    const labor  = r1(omniRows.reduce((s, r) => s + r.req,   0))
    const avail  = r1(appAvail ? appAvail.reduce((s, v) => s + v, 0) : 0)
    const appts  = omniRows.reduce((s, r) => s + r.appts, 0)
    const inb    = omniRows.reduce((s, r) => s + r.inb,   0)
    const out    = omniRows.reduce((s, r) => s + r.out,   0)
    const drops  = omniRows.reduce((s, r) => s + r.drops, 0)
    const staffed = appStaffed ? r1(appStaffed.hourly.reduce((s, v) => s + v, 0)) : 0
    return {
      labor, avail, appts, inb, out, drops, staffed,
      util:  avail > 0 ? Math.round(labor / avail * 100) : 0,
      delta: r1(avail - labor),
    }
  }, [omniRows, appAvail, appStaffed])

  useEffect(() => {
    if (onDeltaComputed) onDeltaComputed(`${facId}_v2`, totals.delta)
  }, [totals.delta, facId, onDeltaComputed])

  useEffect(() => {
    if (onKpiComputed) onKpiComputed(`${facId}_v2`, { inb: totals.inb, out: totals.out, drops: totals.drops })
  }, [totals.inb, totals.out, totals.drops, facId, onKpiComputed])

  const kpiData = {
    appts: totals.appts,
    drops: totals.drops,
    inb:   totals.inb,
    out:   totals.out,
    labor: totals.staffed,
    totalHours: totals.avail,
    laborReq:   totals.labor,
    totalAdj:   0,
    util:  totals.util,
    delta: totals.delta,
    fetchedAt,
  }

  return (
    <div>
      <div className="omni-warning-banner" style={{ background: 'rgba(125, 165, 230, 0.08)', borderColor: 'rgba(125, 165, 230, 0.3)' }}>
        <span className="omni-warning-icon" style={{ color: '#7da5e6' }}>ℹ</span>
        <span className="omni-warning-text">
          <strong>Diagnostic mirror</strong> — Labor Req &amp; appointments from Omni's{' '}
          <code>hourly_labor_required_vs_available</code> (5am→5am shift filter).
          Staffed &amp; Labor Available computed from the live B2E roster using the same App logic as the KEN tab.
          Roster is in-memory only — drag-drop changes don't save.
        </span>
      </div>

      {loadErr && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">Omni labor load failed: {loadErr}</span>
          <button className="omni-warning-retry" onClick={() => setRetryNonce(n => n + 1)}>Retry</button>
        </div>
      )}

      <div className="panel-top-grid">
        <KpiPills data={kpiData} color={fac.color} />
        <div>
          <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>Day Totals</div>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', fontSize: 11, fontFamily: 'var(--font-mono)', lineHeight: 1.9 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
              <div><span style={{ color: 'var(--text-dim)' }}>Appts (Omni):</span> <strong>{totals.appts}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Labor Req (Omni):</span> <strong>{totals.labor}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Staffed (App):</span> <strong>{totals.staffed}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Avail (App):</span> <strong>{totals.avail}</strong></div>
              <div style={{ gridColumn: '1 / 3', paddingTop: 4, borderTop: '1px dashed var(--border)' }}>
                <span style={{ color: 'var(--text-dim)' }}>Daily +/-:</span> &nbsp;
                <strong style={{ color: totals.delta >= 0 ? '#3dba7e' : '#e05a5a' }}>
                  {totals.delta >= 0 ? `+${totals.delta}` : totals.delta}
                </strong>
              </div>
            </div>
          </div>
        </div>
      </div>

      {loading
        ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading Omni data…</div>
        : <>
            <HourlyChart hourlyData={mergedRows} color={fac.color} />
            <div className="section-label" style={{ marginTop: 8 }}>Hourly Breakdown</div>
            <OmniHourlyTable
              omniRows={omniRows}
              appStaffed={appStaffed?.hourly}
              appAvail={appAvail}
              appStaffedByHour={appStaffed?.byHour}
              color={fac.color}
            />
          </>
      }

      <RosterBoardMemory
        facility={facId}
        planDate={planDate}
        onRosterChange={handleRosterChange}
      />
    </div>
  )
}
