// src/pages/KenV2Panel.jsx
//
// Diagnostic mirror tab — displays ALL columns from Omni's
// hourly_labor_required_vs_available view, replicating the dashboard SQL's
// 5am→5am operational window by querying activity_date for the target date
// AND the next day, then client-side filtering to hours 5-28.
//
// Columns shown in the hourly table:
//   Hour | Appts | Inb | Out | Drops | Labor Req (Omni)
//        | Raw Staffed (Omni) | App Staffed | Δ
//        | Breaks (Omni) | WH Adj (Omni)
//        | Labor Avail AW (Omni) | App Avail | Δ
//        | Final +/- | Cumul +/-
//
// Roster is in-memory only — drag-drop doesn't persist to Supabase.
// This lets you compare Omni's computed roster vs App's computed roster
// and see divergence per hour.

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

  // App-computed roster labor — same logic as FacilityPanel
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

  // Chart uses Omni's avail (AW) as the avail line
  const chartRows = useMemo(() => omniRows.map(r => ({
    h:     r.h,
    appts: r.appts,
    req:   r.req,
    avail: r.availAw,
    inb:   r.inb,
    out:   r.out,
    drops: r.drops,
  })), [omniRows])

  const omniTotals = useMemo(() => {
    if (!omniRows.length) return { labor: 0, availAw: 0, rawStaffed: 0, breaks: 0, whAdj: 0, appts: 0, inb: 0, out: 0, drops: 0 }
    return {
      labor:      r1(omniRows.reduce((s, r) => s + r.req,        0)),
      availAw:    r1(omniRows.reduce((s, r) => s + r.availAw,    0)),
      rawStaffed: r1(omniRows.reduce((s, r) => s + r.rawStaffed, 0)),
      breaks:     r1(omniRows.reduce((s, r) => s + r.breaks,     0)),
      whAdj:      r1(omniRows.reduce((s, r) => s + r.whAdj,      0)),
      appts:         omniRows.reduce((s, r) => s + r.appts,      0),
      inb:           omniRows.reduce((s, r) => s + r.inb,        0),
      out:           omniRows.reduce((s, r) => s + r.out,        0),
      drops:         omniRows.reduce((s, r) => s + r.drops,      0),
    }
  }, [omniRows])

  const appTotals = useMemo(() => ({
    staffed: appStaffed ? r1(appStaffed.hourly.reduce((s, v) => s + v, 0)) : null,
    avail:   appAvail   ? r1(appAvail.reduce((s, v) => s + v, 0))          : null,
  }), [appStaffed, appAvail])

  // For KPI pills and delta propagation — use Omni avail vs Omni req
  const omniDelta = r1(omniTotals.availAw - omniTotals.labor)
  const omniUtil  = omniTotals.availAw > 0 ? Math.round(omniTotals.labor / omniTotals.availAw * 100) : 0

  useEffect(() => {
    if (onDeltaComputed) onDeltaComputed(`${facId}_v2`, omniDelta)
  }, [omniDelta, facId, onDeltaComputed])

  useEffect(() => {
    if (onKpiComputed) onKpiComputed(`${facId}_v2`, { inb: omniTotals.inb, out: omniTotals.out, drops: omniTotals.drops })
  }, [omniTotals.inb, omniTotals.out, omniTotals.drops, facId, onKpiComputed])

  const kpiData = {
    appts:      omniTotals.appts,
    drops:      omniTotals.drops,
    inb:        omniTotals.inb,
    out:        omniTotals.out,
    labor:      omniTotals.rawStaffed,
    totalHours: omniTotals.availAw,
    laborReq:   omniTotals.labor,
    totalAdj:   omniTotals.whAdj,
    util:       omniUtil,
    delta:      omniDelta,
    fetchedAt,
  }

  return (
    <div>
      <div className="omni-warning-banner" style={{ background: 'rgba(125, 165, 230, 0.08)', borderColor: 'rgba(125, 165, 230, 0.3)' }}>
        <span className="omni-warning-icon" style={{ color: '#7da5e6' }}>ℹ</span>
        <span className="omni-warning-text">
          <strong>Omni Mirror</strong> — All columns pulled directly from{' '}
          <code>hourly_labor_required_vs_available</code> using the same 5am→5am window as the dashboard.
          App Staffed &amp; App Avail columns computed from the live B2E roster for comparison.
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
          <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>Omni Totals</div>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', fontSize: 11, fontFamily: 'var(--font-mono)', lineHeight: 1.9 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
              <div><span style={{ color: 'var(--text-dim)' }}>Raw Staffed:</span> <strong>{omniTotals.rawStaffed}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Adj Staffed:</span> <strong>{r1(omniTotals.availAw - omniTotals.whAdj)}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Breaks:</span> <strong>{omniTotals.breaks}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>WH Adj:</span> <strong>{omniTotals.whAdj > 0 ? `+${omniTotals.whAdj}` : omniTotals.whAdj}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Labor Avail (AW):</span> <strong>{omniTotals.availAw}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Labor Req:</span> <strong>{omniTotals.labor}</strong></div>
              {appTotals.staffed != null && (
                <div><span style={{ color: 'var(--text-dim)' }}>App Staffed:</span> <strong>{appTotals.staffed}</strong></div>
              )}
              {appTotals.avail != null && (
                <div><span style={{ color: 'var(--text-dim)' }}>App Avail:</span> <strong>{appTotals.avail}</strong></div>
              )}
              <div style={{ gridColumn: '1 / 3', paddingTop: 4, borderTop: '1px dashed var(--border)' }}>
                <span style={{ color: 'var(--text-dim)' }}>Omni Daily +/-:</span> &nbsp;
                <strong style={{ color: omniDelta >= 0 ? '#3dba7e' : '#e05a5a' }}>
                  {omniDelta >= 0 ? `+${omniDelta}` : omniDelta}
                </strong>
              </div>
            </div>
          </div>
        </div>
      </div>

      {loading
        ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading Omni data…</div>
        : <>
            <HourlyChart hourlyData={chartRows} color={fac.color} />
            <div className="section-label" style={{ marginTop: 8 }}>Hourly Breakdown (Omni vs App)</div>
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
