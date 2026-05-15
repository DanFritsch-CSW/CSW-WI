import { useState, useRef, useCallback, useEffect, forwardRef } from 'react'

function fmtHour(h) {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function r1(n) { return Math.round(n * 10) / 10 }
function fmtDelta(v) { const n = r1(v); return n >= 0 ? `+${n}` : `${n}` }

// EditableCell forwards its outer ref so the table can programmatically
// call .click() on the visible span to open the cell.
const EditableCell = forwardRef(function EditableCell({ value, onSave, onNavigate }, ref) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(0)

  function open() { setDraft(value ?? 0); setEditing(true) }

  function commit() {
    const parsed = Number(draft)
    const val = isNaN(parsed) ? 0 : Math.round(parsed)
    setEditing(false)
    if (val !== (value ?? 0)) onSave(val)
  }

  function handleKeyDown(e) {
    if (e.key === 'Tab') {
      e.preventDefault()
      commit()
      onNavigate?.(e.shiftKey ? 'up' : 'down')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setDraft(prev => { const n = Number(prev); return isNaN(n) ? 1 : n + 1 })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setDraft(prev => { const n = Number(prev); return isNaN(n) ? 0 : Math.max(0, n - 1) })
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <input
        className="ht-cell-input"
        type="number"
        step={1}
        value={draft}
        autoFocus
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        onClick={e => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      ref={ref}
      className="ht-cell-editable"
      title="Tab = next hour. Shift+Tab = prev hour. Up/Down = +/-1. Enter = commit."
      onClick={open}
    >
      {value ?? 0}
    </span>
  )
})

// StaffedCell — click to open popover with names of employees on clock that hour.
// Used in the Raw Staffed column to reconcile against Omni's Raw Staffed Employee.
function StaffedCell({ value, names, hour, openHour, setOpenHour }) {
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
    function handleEscape(e) {
      if (e.key === 'Escape') setOpenHour(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, setOpenHour])

  const hasNames = Array.isArray(names) && names.length > 0
  const display = value == null ? '--' : r1(value)

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span
        ref={triggerRef}
        className={`ht-staffed-trigger${hasNames ? ' ht-staffed-trigger--clickable' : ''}`}
        title={hasNames ? `Click to see ${names.length} employee${names.length === 1 ? '' : 's'} on clock at ${fmtHour(hour)}` : 'No employees on clock'}
        onClick={hasNames ? () => setOpenHour(isOpen ? null : hour) : undefined}
      >
        {display}
      </span>
      {isOpen && hasNames && (
        <div ref={popoverRef} className="ht-staffed-popover">
          <div className="ht-staffed-popover-header">
            {fmtHour(hour)} &mdash; {names.length} on clock
          </div>
          <div className="ht-staffed-popover-body">
            {names.map((n, i) => (
              <div key={i} className="ht-staffed-popover-name">{n}</div>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}

export default function HourlyTable({
  hourlyData,
  estDrops = {},
  projectHourlyDrops = {},
  hourlyAdjustments = {},
  staffedHourly = null,
  staffedByHour = null,
  onProjectHourlyChange,
  onAdjustmentChange,
  color,
}) {
  const [expanded, setExpanded] = useState(false)
  // compact=true hides EST Drops, Inb, Out columns (default for screenshots)
  const [compact, setCompact] = useState(true)
  // openStaffedHour: which hour's popover is open (single open at a time)
  const [openStaffedHour, setOpenStaffedHour] = useState(null)
  // cellRefs[projIdx][rowIdx] = ref to the visible EditableCell span
  const cellRefs = useRef({})

  const getCellRef = useCallback((projIdx, rowIdx) => el => {
    if (!cellRefs.current[projIdx]) cellRefs.current[projIdx] = {}
    cellRefs.current[projIdx][rowIdx] = el
  }, [])

  function navigate(projIdx, rowIdx, dir, numProjects, numRows) {
    let p = projIdx, r = rowIdx
    if (dir === 'down') {
      r += 1
      if (r >= numRows) { r = 0; p += 1 }
      if (p >= numProjects) p = numProjects - 1
    } else {
      r -= 1
      if (r < 0) { r = numRows - 1; p -= 1 }
      if (p < 0) p = 0
    }
    cellRefs.current[p]?.[r]?.click()
  }

  if (!hourlyData?.length) return null

  const projects = Object.keys(projectHourlyDrops).sort((a, b) => a.localeCompare(b))
  const multiProject = projects.length >= 1
  const showStaffed = Array.isArray(staffedHourly)

  const sorted = [...hourlyData].sort((a, b) => {
    const sa = a.h < 5 ? a.h + 24 : a.h
    const sb = b.h < 5 ? b.h + 24 : b.h
    return sa - sb
  })

  let cumul = 0
  const rows = sorted.map(r => {
    const adj = hourlyAdjustments[r.h] ?? 0
    const final = r1((r.avail + adj) - r.req)
    cumul = r1(cumul + final)
    return { ...r, adj, final, cumul, est: estDrops[r.h] ?? null, staffed: showStaffed ? (staffedHourly[r.h] ?? 0) : null }
  })

  const tot = {
    est:   rows.reduce((s, r) => s + (r.est ?? 0), 0),
    inb:   rows.reduce((s, r) => s + r.inb,   0),
    out:   rows.reduce((s, r) => s + r.out,   0),
    appts: rows.reduce((s, r) => s + r.appts, 0),
    req:   r1(rows.reduce((s, r) => s + r.req,   0)),
    avail: r1(rows.reduce((s, r) => s + r.avail, 0)),
    adj:   rows.reduce((s, r) => s + r.adj, 0),
    staffed: showStaffed ? r1(rows.reduce((s, r) => s + (r.staffed ?? 0), 0)) : null,
    cumul: rows[rows.length - 1]?.cumul ?? 0,
  }

  const projectTotals = {}
  for (const p of projects)
    projectTotals[p] = Object.values(projectHourlyDrops[p] ?? {}).reduce((s, v) => s + v, 0)

  const numRows = rows.length
  const numProjects = projects.length

  return (
    <div className="hourly-table-wrap">
      <div className="ht-toolbar">
        <button
          className={`ht-compact-toggle${compact ? ' ht-compact-toggle--active' : ''}`}
          onClick={() => setCompact(c => !c)}
          title={compact ? 'Show all columns (EST Drops, Inb, Out)' : 'Hide EST Drops, Inb, Out columns'}
        >
          {compact ? 'Full View' : 'Compact'}
        </button>
      </div>
      <table className="hourly-table">
        <thead>
          <tr>
            <th className="ht-hour-col">Hour</th>
            {!compact && (
              multiProject && expanded
                ? <>
                    {projects.map(p => (
                      <th key={p} className="ht-est-col ht-proj-col" title={p}>
                        {p.length > 12 ? p.slice(0, 12) + '...' : p}
                      </th>
                    ))}
                    <th className="ht-est-col">
                      Total EST
                      <button className="ht-expand-btn" onClick={() => setExpanded(false)}>Collapse</button>
                    </th>
                  </>
                : <th className="ht-est-col">
                    EST Drops
                    {multiProject && (
                      <button className="ht-expand-btn" onClick={() => setExpanded(true)}>Expand</button>
                    )}
                  </th>
            )}
            {!compact && <th>Inb</th>}
            {!compact && <th>Out</th>}
            <th>Appts</th>
            <th>Labor Req</th>
            <th>Labor Avail</th>
            {showStaffed && (
              <th className="ht-staffed-col" title="Raw staffed headcount — bodies on the clock this hour. No break math. Click a value to see names.">Staffed</th>
            )}
            <th className="ht-adj-col" title="Adjustment to labor available this hour.">Adj</th>
            <th>Final +/-</th>
            <th>Cumul +/-</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, rowIdx) => (
            <tr key={rowIdx} className={r.final < 0 ? 'ht-deficit' : ''}>
              <td className="ht-hour ht-hour-col">{fmtHour(r.h)}</td>
              {!compact && (
                multiProject && expanded
                  ? <>
                      {projects.map((p, projIdx) => (
                        <td key={p} className="ht-est-col ht-proj-col">
                          <EditableCell
                            ref={getCellRef(projIdx, rowIdx)}
                            value={projectHourlyDrops[p]?.[r.h] ?? 0}
                            onSave={val => onProjectHourlyChange?.(p, r.h, val)}
                            onNavigate={dir => navigate(projIdx, rowIdx, dir, numProjects, numRows)}
                          />
                        </td>
                      ))}
                      <td className="ht-est-col">
                        {r.est !== null ? r.est : <span className="ht-est-empty">--</span>}
                      </td>
                    </>
                  : <td className="ht-est-col">
                      {r.est !== null ? r.est : <span className="ht-est-empty">--</span>}
                    </td>
              )}
              {!compact && <td>{r.inb}</td>}
              {!compact && <td>{r.out}</td>}
              <td style={{ color }}>{r.appts}</td>
              <td>{r.req}</td>
              <td>{r1(r.avail)}</td>
              {showStaffed && (
                <td className="ht-staffed-col">
                  <StaffedCell
                    value={r.staffed}
                    names={staffedByHour?.[r.h] ?? []}
                    hour={r.h}
                    openHour={openStaffedHour}
                    setOpenHour={setOpenStaffedHour}
                  />
                </td>
              )}
              <td className="ht-adj-col">
                <EditableCell value={r.adj} onSave={val => onAdjustmentChange?.(r.h, val)} />
              </td>
              <td className={r.final < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(r.final)}</td>
              <td className={r.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(r.cumul)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="ht-total">
            <td className="ht-hour-col">Total</td>
            {!compact && (
              multiProject && expanded
                ? <>
                    {projects.map(p => (
                      <td key={p} className="ht-est-col ht-proj-col">{projectTotals[p] ?? 0}</td>
                    ))}
                    <td className="ht-est-col">{tot.est}</td>
                  </>
                : <td className="ht-est-col">{tot.est}</td>
            )}
            {!compact && <td>{tot.inb}</td>}
            {!compact && <td>{tot.out}</td>}
            <td style={{ color }}>{tot.appts}</td>
            <td>{tot.req}</td>
            <td>{tot.avail}</td>
            {showStaffed && (
              <td className="ht-staffed-col">{tot.staffed}</td>
            )}
            <td className="ht-adj-col">{
              tot.adj !== 0
                ? <span className={tot.adj > 0 ? 'ht-pos' : 'ht-neg'}>{tot.adj > 0 ? `+${tot.adj}` : tot.adj}</span>
                : '--'
            }</td>
            <td></td>
            <td className={tot.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(tot.cumul)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
