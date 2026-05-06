import { useState, useRef, useCallback, forwardRef } from 'react'

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

export default function HourlyTable({ hourlyData, estDrops = {}, projectHourlyDrops = {}, hourlyAdjustments = {}, onProjectHourlyChange, onAdjustmentChange, color }) {
  const [expanded, setExpanded] = useState(false)
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
    return { ...r, adj, final, cumul, est: estDrops[r.h] ?? null }
  })

  const tot = {
    est:   rows.reduce((s, r) => s + (r.est ?? 0), 0),
    inb:   rows.reduce((s, r) => s + r.inb,   0),
    out:   rows.reduce((s, r) => s + r.out,   0),
    appts: rows.reduce((s, r) => s + r.appts, 0),
    req:   r1(rows.reduce((s, r) => s + r.req,   0)),
    avail: r1(rows.reduce((s, r) => s + r.avail, 0)),
    adj:   rows.reduce((s, r) => s + r.adj, 0),
    cumul: rows[rows.length - 1]?.cumul ?? 0,
  }

  const projectTotals = {}
  for (const p of projects)
    projectTotals[p] = Object.values(projectHourlyDrops[p] ?? {}).reduce((s, v) => s + v, 0)

  const numRows = rows.length
  const numProjects = projects.length

  return (
    <div className="hourly-table-wrap">
      <table className="hourly-table">
        <thead>
          <tr>
            <th>Hour</th>
            {multiProject && expanded
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
            }
            <th>Inb</th>
            <th>Out</th>
            <th>Appts</th>
            <th>Labor Req</th>
            <th>Labor Avail</th>
            <th className="ht-adj-col" title="Adjustment to labor available this hour.">Adj</th>
            <th>Final +/-</th>
            <th>Cumul +/-</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, rowIdx) => (
            <tr key={rowIdx} className={r.final < 0 ? 'ht-deficit' : ''}>
              <td className="ht-hour">{fmtHour(r.h)}</td>
              {multiProject && expanded
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
              }
              <td>{r.inb}</td>
              <td>{r.out}</td>
              <td style={{ color }}>{r.appts}</td>
              <td>{r.req}</td>
              <td>{r1(r.avail)}</td>
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
            <td>Total</td>
            {multiProject && expanded
              ? <>
                  {projects.map(p => (
                    <td key={p} className="ht-est-col ht-proj-col">{projectTotals[p] ?? 0}</td>
                  ))}
                  <td className="ht-est-col">{tot.est}</td>
                </>
              : <td className="ht-est-col">{tot.est}</td>
            }
            <td>{tot.inb}</td>
            <td>{tot.out}</td>
            <td style={{ color }}>{tot.appts}</td>
            <td>{tot.req}</td>
            <td>{tot.avail}</td>
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
