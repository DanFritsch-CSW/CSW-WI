// src/components/OmniHourlyTable.jsx
//
// Read-only mirror of Omni's hourly_labor_required_vs_available view.
// Identical 5am→5am operational-day ordering as the regular HourlyTable.
//
// Shows BOTH Omni's numbers (as-is) and App-computed roster values when
// available, with a Δ column for at-a-glance reconciliation.
//
// Props:
//   omniRows:           Array of { h, rawStaffed, adjStaffed, breaks, whAdj,
//                                  avail, availAw, req, inb, out, drops, appts }
//   appStaffed:         Optional 24-element array of app-computed staffed
//                       headcount per hour (from buildRosterStaffedHeadcount)
//   appAvail:           Optional 24-element array of app-computed avail per hour
//                       (from buildRosterAvailability)
//   appStaffedByHour:   Optional { [h]: Array<{name, contribution}> } for popover
//   color:              Accent color for the facility
//
// Columns shown:
//   Hour | Appts | Inb | Out | Drops | Labor Req
//        | Raw Staffed (Omni) | App Staffed | Δ Staffed
//        | Breaks (Omni) | WH Adj (Omni)
//        | Labor Avail (Omni AW) | App Avail | Δ Avail
//        | Final +/- | Cumul +/-

import { useState, useRef, useEffect } from 'react'

function fmtHour(h) {
  if (h === 0)  return '12am'
  if (h < 12)   return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}
function r1(n) { return Math.round(n * 10) / 10 }
function r2(n) { return Math.round(n * 100) / 100 }
function fmtDelta(v) { const n = r1(v); return n >= 0 ? `+${n}` : `${n}` }
function fmtContribution(c) {
  if (c >= 1) return '1.0'
  return r2(c).toString()
}

// Tolerance for "match" highlighting (in person-hours)
const MATCH_TOL = 0.6

// ── Staffed cell with popover (like HourlyTable's StaffedCell) ──
function StaffedCell({ value, entries, hour, openHour, setOpenHour }) {
  const popoverRef = useRef(null)
  const triggerRef = useRef(null)
  const isOpen = openHour === hour

  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(e) {
      if (popoverRef.current?.contains(e.target)) return
      if (triggerRef.current?.contains(e.target)) return
      setOpenHour(null)
    }
    function handleEscape(e) { if (e.key === 'Escape') setOpenHour(null) }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, setOpenHour])

  const hasEntries = Array.isArray(entries) && entries.length > 0
  const display = value == null ? '--' : r1(value)
  const partialCount = hasEntries ? entries.filter(e => e.contribution < 1).length : 0

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span
        ref={triggerRef}
        className={`ht-staffed-trigger${hasEntries ? ' ht-staffed-trigger--clickable' : ''}`}
        title={hasEntries ? `Click to see ${entries.length} employee${entries.length === 1 ? '' : 's'} on clock at ${fmtHour(hour)}${partialCount > 0 ? ` (${partialCount} partial)` : ''}` : 'No employees on clock'}
        onClick={hasEntries ? () => setOpenHour(isOpen ? null : hour) : undefined}
      >
        {display}
      </span>
      {isOpen && hasEntries && (
        <div ref={popoverRef} className="ht-staffed-popover">
          <div className="ht-staffed-popover-header">
            <span>{fmtHour(hour)} &mdash; {entries.length} on clock</span>
            {partialCount > 0 && (
              <span className="ht-staffed-popover-partial-count">{partialCount} partial</span>
            )}
          </div>
          <div className="ht-staffed-popover-body">
            {entries.map((e, i) => (
              <div key={i} className={`ht-staffed-popover-row${e.contribution < 1 ? ' ht-staffed-popover-row--partial' : ''}`}>
                <span className="ht-staffed-popover-name">{e.name}</span>
                <span className={`ht-staffed-popover-contrib${e.contribution < 1 ? ' ht-staffed-popover-contrib--partial' : ''}`}>
                  {fmtContribution(e.contribution)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}

function deltaClass(delta) {
  if (Math.abs(delta) <= MATCH_TOL) return 'ht-pos'   // within tolerance — green
  return delta > 0 ? 'ht-warn' : 'ht-neg'              // diverge — amber if app over, red if app under
}

export default function OmniHourlyTable({
  omniRows,
  appStaffed = null,
  appAvail = null,
  appStaffedByHour = null,
  color,
}) {
  const [openStaffedHour, setOpenStaffedHour] = useState(null)

  if (!omniRows?.length) {
    return (
      <div className="hourly-table-wrap">
        <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          No Omni data for this date.
        </div>
      </div>
    )
  }

  const sorted = [...omniRows].sort((a, b) => {
    const sa = a.h < 5 ? a.h + 24 : a.h
    const sb = b.h < 5 ? b.h + 24 : b.h
    return sa - sb
  })

  let cumul = 0
  const rows = sorted.map(r => {
    const appS = appStaffed?.[r.h] ?? null
    const appA = appAvail?.[r.h] ?? null
    const dStaff = appS != null ? r1(appS - r.rawStaffed) : null
    const dAvail = appA != null ? r1(appA - r.availAw)    : null
    // Final +/- uses Omni's avail (AW) minus Omni's req — true Omni P/L per hour
    const final = r1(r.availAw - r.req)
    cumul = r1(cumul + final)
    return { ...r, appS, appA, dStaff, dAvail, final, cumul }
  })

  const tot = {
    appts: rows.reduce((s, r) => s + r.appts, 0),
    inb:   rows.reduce((s, r) => s + r.inb, 0),
    out:   rows.reduce((s, r) => s + r.out, 0),
    drops: rows.reduce((s, r) => s + r.drops, 0),
    req:        r1(rows.reduce((s, r) => s + r.req, 0)),
    rawStaffed: r1(rows.reduce((s, r) => s + r.rawStaffed, 0)),
    breaks:     r1(rows.reduce((s, r) => s + r.breaks, 0)),
    whAdj:      r1(rows.reduce((s, r) => s + r.whAdj, 0)),
    availAw:    r1(rows.reduce((s, r) => s + r.availAw, 0)),
    appS:       appStaffed ? r1(rows.reduce((s, r) => s + (r.appS ?? 0), 0)) : null,
    appA:       appAvail   ? r1(rows.reduce((s, r) => s + (r.appA ?? 0), 0)) : null,
    cumul: rows[rows.length - 1]?.cumul ?? 0,
  }
  const totDStaff = tot.appS != null ? r1(tot.appS - tot.rawStaffed) : null
  const totDAvail = tot.appA != null ? r1(tot.appA - tot.availAw)    : null

  const showApp = appStaffed != null || appAvail != null

  return (
    <div className="hourly-table-wrap">
      <table className="hourly-table">
        <thead>
          <tr>
            <th className="ht-hour-col">Hour</th>
            <th>Appts</th>
            <th title="Omni inbound_count">Inb</th>
            <th title="Omni outbound_count">Out</th>
            <th title="Omni drops">Drops</th>
            <th title="Omni labor_required">Labor Req</th>
            <th className="ht-staffed-col" title="Omni raw_staffed_employee">Raw Staffed (Omni)</th>
            {showApp && <th className="ht-staffed-col" title="App-computed roster staffed">App Staffed</th>}
            {showApp && <th title="App − Omni (within ±0.6 = green)">Δ</th>}
            <th title="Omni employees_on_break">Breaks (Omni)</th>
            <th title="Omni warehouse_labor_adjustment">WH Adj</th>
            <th title="Omni labor_available_aw_update_ (= adj_staffed + wh_adj)">Labor Avail (Omni)</th>
            {showApp && <th title="App-computed roster avail">App Avail</th>}
            {showApp && <th title="App − Omni (within ±0.6 = green)">Δ</th>}
            <th>Final +/-</th>
            <th>Cumul +/-</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx} className={r.final < 0 ? 'ht-deficit' : ''}>
              <td className="ht-hour ht-hour-col">{fmtHour(r.h)}</td>
              <td style={{ color }}>{r.appts}</td>
              <td>{r.inb}</td>
              <td>{r.out}</td>
              <td>{r.drops}</td>
              <td>{r1(r.req)}</td>
              <td className="ht-staffed-col">{r1(r.rawStaffed)}</td>
              {showApp && (
                <td className="ht-staffed-col">
                  <StaffedCell
                    value={r.appS}
                    entries={appStaffedByHour?.[r.h] ?? []}
                    hour={r.h}
                    openHour={openStaffedHour}
                    setOpenHour={setOpenStaffedHour}
                  />
                </td>
              )}
              {showApp && (
                <td className={r.dStaff == null ? '' : deltaClass(r.dStaff)}>
                  {r.dStaff == null ? '--' : fmtDelta(r.dStaff)}
                </td>
              )}
              <td>{r1(r.breaks)}</td>
              <td className={r.whAdj === 0 ? '' : (r.whAdj > 0 ? 'ht-pos' : 'ht-neg')}>
                {r.whAdj === 0 ? 0 : fmtDelta(r.whAdj)}
              </td>
              <td>{r1(r.availAw)}</td>
              {showApp && <td>{r.appA == null ? '--' : r1(r.appA)}</td>}
              {showApp && (
                <td className={r.dAvail == null ? '' : deltaClass(r.dAvail)}>
                  {r.dAvail == null ? '--' : fmtDelta(r.dAvail)}
                </td>
              )}
              <td className={r.final < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(r.final)}</td>
              <td className={r.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(r.cumul)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="ht-total">
            <td className="ht-hour-col">Total</td>
            <td style={{ color }}>{tot.appts}</td>
            <td>{tot.inb}</td>
            <td>{tot.out}</td>
            <td>{tot.drops}</td>
            <td>{tot.req}</td>
            <td className="ht-staffed-col">{tot.rawStaffed}</td>
            {showApp && <td className="ht-staffed-col">{tot.appS ?? '--'}</td>}
            {showApp && (
              <td className={totDStaff == null ? '' : deltaClass(totDStaff)}>
                {totDStaff == null ? '--' : fmtDelta(totDStaff)}
              </td>
            )}
            <td>{tot.breaks}</td>
            <td className={tot.whAdj === 0 ? '' : (tot.whAdj > 0 ? 'ht-pos' : 'ht-neg')}>
              {tot.whAdj === 0 ? 0 : fmtDelta(tot.whAdj)}
            </td>
            <td>{tot.availAw}</td>
            {showApp && <td>{tot.appA ?? '--'}</td>}
            {showApp && (
              <td className={totDAvail == null ? '' : deltaClass(totDAvail)}>
                {totDAvail == null ? '--' : fmtDelta(totDAvail)}
              </td>
            )}
            <td></td>
            <td className={tot.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(tot.cumul)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
