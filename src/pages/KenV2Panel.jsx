// src/pages/KenV2Panel.jsx
//
// "Pure Omni mirror" diagnostic view, designed so the displayed numbers match
// Omni's dashboard view exactly — zero App-side override of Omni values.
//
// Hourly table is fed from a single Omni query (fetchOmniLaborFullRow) that
// pulls every column from hourly_labor_required_vs_available using the same
// labor_shift_timestamp filter the dashboard uses.
//
// Roster is fetched fresh from Omni B2E on mount and lives in memory only.
// App-computed Staffed and Avail are shown next to Omni's so any divergence
// is immediately visible.
//
// Configurable via FACILITY prop — defaults to 'ken' but works for any of
// the five facilities. Useful for future debugging across the network.
//
// Props:
//   planDate, networkKpi, onDeltaComputed, onKpiComputed — same as FacilityPanel
//   facility — defaults to KEN; can be overridden to mirror another facility

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
  const fac = facility ?? FACILITIES.ken
  const facId = fac.id

  const [omniRows, setOmniRows]       = useState([])
  const [loadErr, setLoadErr]         = useState(null)
  const [loading, setLoading]         = useState(true)
  const [retryNonce, setRetryNonce]   = useState(0)
  const [rosterState, setRosterState] = useState({ employees: [], laneMap: {}, assignmentMap: {} })
  const [fetchedAt, setFetchedAt]     = useState(null)

  const { settings, loading: settingsLoading } = useSettings(facId)

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

  // App-computed labor — same logic FacilityPanel uses, but read-only display
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

  // Chart-shaped data: synthesize hourly rows so HourlyChart can render
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
    if (!omniRows.length) return { labor: 0, avail: 0, util: 0, delta: 0, appts: 0, inb: 0, out: 0, drops: 0, rawStaffed: 0, breaks: 0, whAdj: 0 }
    const labor      = omniRows.reduce((s, r) => s + r.req, 0)
    const avail      = omniRows.reduce((s, r) => s + r.availAw, 0)
    const appts      = omniRows.reduce((s, r) => s + r.appts, 0)
    const inb        = omniRows.reduce((s, r) => s + r.inb, 0)
    const out        = omniRows.reduce((s, r) => s + r.out, 0)
    const drops      = omniRows.reduce((s, r) => s + r.drops, 0)
    const rawStaffed = omniRows.reduce((s, r) => s + r.rawStaffed, 0)
    const breaks     = omniRows.reduce((s, r) => s + r.breaks, 0)
    const whAdj      = omniRows.reduce((s, r) => s + r.whAdj, 0)
    return {
      labor: r1(labor),
      avail: r1(avail),
      util:  avail > 0 ? Math.round(labor / avail * 100) : 0,
      delta: r1(avail - labor),
      appts, inb, out, drops,
      rawStaffed: r1(rawStaffed),
      breaks:     r1(breaks),
      whAdj:      r1(whAdj),
    }
  }, [omniRows])

  // Propagate delta + kpi up to LaborPlanning for the ALL tab if applicable
  useEffect(() => {
    if (onDeltaComputed) onDeltaComputed(`${facId}_v2`, omniTotals.delta)
  }, [omniTotals.delta, facId, onDeltaComputed])

  useEffect(() => {
    if (onKpiComputed) onKpiComputed(`${facId}_v2`, { inb: omniTotals.inb, out: omniTotals.out, drops: omniTotals.drops })
  }, [omniTotals.inb, omniTotals.out, omniTotals.drops, facId, onKpiComputed])

  // KPI pill data — same shape as the normal panel for visual consistency
  const kpiData = {
    appts: omniTotals.appts,
    drops: omniTotals.drops,
    inb:   omniTotals.inb,
    out:   omniTotals.out,
    labor: r1(omniTotals.rawStaffed),
    totalHours: omniTotals.avail,
    laborReq:   omniTotals.labor,
    totalAdj:   omniTotals.whAdj,
    util:  omniTotals.util,
    delta: omniTotals.delta,
    fetchedAt,
  }

  return (
    <div>
      <div className="omni-warning-banner" style={{ background: 'rgba(125, 165, 230, 0.08)', borderColor: 'rgba(125, 165, 230, 0.3)' }}>
        <span className="omni-warning-icon" style={{ color: '#7da5e6' }}>ℹ</span>
        <span className="omni-warning-text">
          <strong>Pure Omni Mirror</strong> — All hourly numbers below are read directly from Omni's <code>hourly_labor_required_vs_available</code> view
          using the same SQL filter as the Omni dashboard (5am→5am operational day). No App-side override.
          Roster lives in memory only — drag-drop changes don't save.
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
          <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>Omni Snapshot</div>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', fontSize: 11, fontFamily: 'var(--font-mono)', lineHeight: 1.7 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
              <div><span style={{ color: 'var(--text-dim)' }}>Raw Staffed:</span> <strong>{omniTotals.rawStaffed}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Adj Staffed:</span> <strong>{r1(omniTotals.avail - omniTotals.whAdj)}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Breaks:</span> <strong>{omniTotals.breaks}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>WH Adj:</span> <strong>{omniTotals.whAdj > 0 ? `+${omniTotals.whAdj}` : omniTotals.whAdj}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Labor Avail (AW):</span> <strong>{omniTotals.avail}</strong></div>
              <div><span style={{ color: 'var(--text-dim)' }}>Labor Req:</span> <strong>{omniTotals.labor}</strong></div>
              <div style={{ gridColumn: '1 / 3', paddingTop: 4, borderTop: '1px dashed var(--border)' }}>
                <span style={{ color: 'var(--text-dim)' }}>Daily Delta:</span> &nbsp;
                <strong style={{ color: omniTotals.delta >= 0 ? '#3dba7e' : '#e05a5a' }}>
                  {omniTotals.delta >= 0 ? `+${omniTotals.delta}` : omniTotals.delta}
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
