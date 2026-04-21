import { useState } from 'react'

function fmtHour(h) {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function r1(n) { return Math.round(n * 10) / 10 }
function fmtDelta(v) { const n = r1(v); return n >= 0 ? `+${n}` : `${n}` }

function EditableCell({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(0)

  function open() {
    setDraft(value ?? 0)
    setEditing(true)
  }

  function commit() {
    const val = Math.max(0, Math.round(Number(draft) || 0))
    setEditing(false)
    if (val !== (value ?? 0)) onSave(val)
  }

  if (editing) {
    return (
      <input
        className="ht-cell-input"
        type="number"
        min={0}
        step={1}
        value={draft}
        autoFocus
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        onClick={e => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      className="ht-cell-editable"
      title="Click to edit"
      onClick={open}
    >
      {value ?? 0}
    </span>
  )
}

export default function HourlyTable({ hourlyData, estDrops = {}, projectHourlyDrops = {}, onProjectHourlyChange, color }) {
  const [expanded, setExpanded] = useState(false)

  if (!hourlyData?.length) return null

  const projects = Object.keys(projectHourlyDrops)
  const multiProject = projects.length > 1

  const sorted = [...hourlyData].sort((a, b) => {
    const sa = a.h < 5 ? a.h + 24 : a.h
    const sb = b.h < 5 ? b.h + 24 : b.h
    return sa - sb
  })

  let cumul = 0
  const rows = sorted.map(r => {
    const final = r1(r.avail - r.req)
    cumul = r1(cumul + final)
    return { ...r, final, cumul, est: estDrops[r.h] ?? null }
  })

  const tot = {
    est:   rows.reduce((s, r) => s + (r.est ?? 0), 0),
    inb:   rows.reduce((s, r) => s + r.inb,   0),
    out:   rows.reduce((s, r) => s + r.out,   0),
    appts: rows.reduce((s, r) => s + r.appts, 0),
    req:   r1(rows.reduce((s, r) => s + r.req,   0)),
    avail: r1(rows.reduce((s, r) => s + r.avail, 0)),
    cumul: rows[rows.length - 1]?.cumul ?? 0,
  }

  const projectTotals = {}
  for (const p of projects) {
    projectTotals[p] = Object.values(projectHourlyDrops[p] ?? {}).reduce((s, v) => s + v, 0)
  }

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
                      {p.length > 12 ? p.slice(0, 12) + '…' : p}
                    </th>
                  ))}
                  <th className="ht-est-col">
                    Total EST
                    <button className="ht-expand-btn" onClick={() => setExpanded(false)} title="Collapse project columns">▾</button>
                  </th>
                </>
              : <th className="ht-est-col">
                  EST Drops
                  {multiProject && (
                    <button className="ht-expand-btn" onClick={() => setExpanded(true)} title="Show per-project breakdown">▸</button>
                  )}
                </th>
            }
            <th>Inb</th>
            <th>Out</th>
            <th>Appts</th>
            <th>Labor Req</th>
            <th>Labor Avail</th>
            <th>Final +/-</th>
            <th>Cumul +/-</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.final < 0 ? 'ht-deficit' : ''}>
              <td className="ht-hour">{fmtHour(r.h)}</td>
              {multiProject && expanded
                ? <>
                    {projects.map(p => (
                      <td key={p} className="ht-est-col ht-proj-col">
                        <EditableCell
                          value={projectHourlyDrops[p]?.[r.h] ?? 0}
                          onSave={val => onProjectHourlyChange?.(p, r.h, val)}
                        />
                      </td>
                    ))}
                    <td className="ht-est-col">
                      {r.est !== null ? r.est : <span className="ht-est-empty">—</span>}
                    </td>
                  </>
                : <td className="ht-est-col">
                    {r.est !== null ? r.est : <span className="ht-est-empty">—</span>}
                  </td>
              }
              <td>{r.inb}</td>
              <td>{r.out}</td>
              <td style={{ color }}>{r.appts}</td>
              <td>{r.req}</td>
              <td>{r1(r.avail)}</td>
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
            <td></td>
            <td className={tot.cumul < 0 ? 'ht-neg' : 'ht-pos'}>{fmtDelta(tot.cumul)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
