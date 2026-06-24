import { Fragment } from 'react'

// Weekly projects table.
//
// Renders the current week (7 days, Mon–Sun) as a grid:
//   Project name | Mon | Tue | Wed | Thu | Fri | Sat | Sun | Wk Total
//
// Each day cell shows 4 numbers in a compact 2-line layout:
//   line 1 (small, dim): "<drops>d  <inb>·<out>"
//   line 2 (bold):       "<inb+out>"           ← the headline appointment count
//
// The selected day's column is tinted with the facility brand color so the
// planner sees at a glance which day is driving the rest of the page below.
//
// Empty cells render a centered em-dash.
//
// MAD no longer gets a special inventory split — it uses the same layout
// as every other facility. Dan/Dean asked for parity in the rebuild.
//
// Props:
//   weekDays     — array of 7 ISO date strings (Mon..Sun)
//   selectedDate — ISO string of the day driving the rest of the page
//                  (highlighted column)
//   weeklyAppts  — { [iso]: { [projectName]: { inb, out } } }
//   weeklyDrops  — { [iso]: { [projectName]: totalDropsForDay } }
//   color        — facility brand color (hex / CSS color)
//   projectFilter — optional (projectName: string) => boolean predicate;
//                   used by CAL split tabs (1-2 / 3.5)

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function formatMDD(iso) {
  const d = new Date(iso + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const CSW_SUFFIXES = [
  ' - CSW-Madison', ' - CSW-Franksville', ' - CSW-Kenosha',
  ' - CSW-Wisconsin Rapids', ' - CSW-Eau Claire',
  '-CSW-Madison', ' - Madison',
]
function stripSuffix(name) {
  if (!name) return name
  for (const s of CSW_SUFFIXES) {
    if (name.endsWith(s)) return name.slice(0, -s.length)
  }
  return name
}

export default function ProjectList({
  weekDays = [],
  selectedDate,
  weeklyAppts = {},
  weeklyDrops = {},
  color,
  projectFilter,
}) {
  if (!weekDays.length) return null

  // Gather the union of all project names that appear ANYWHERE in the week —
  // appts OR drops. A drops-only project still gets a row.
  const projectNamesSet = new Set()
  for (const d of weekDays) {
    for (const name of Object.keys(weeklyAppts[d] || {})) projectNamesSet.add(name)
    for (const name of Object.keys(weeklyDrops[d] || {})) projectNamesSet.add(name)
  }

  const rows = []
  for (const name of projectNamesSet) {
    if (projectFilter && !projectFilter(name)) continue
    let wkIn = 0, wkOut = 0, wkDrops = 0
    const perDay = {}
    for (const d of weekDays) {
      const appt  = (weeklyAppts[d] || {})[name] || { inb: 0, out: 0 }
      const drops = Number((weeklyDrops[d] || {})[name] ?? 0)
      const inb   = Number(appt.inb ?? 0)
      const out   = Number(appt.out ?? 0)
      perDay[d]   = { drops, inb, out, tot: inb + out }
      wkIn       += inb
      wkOut      += out
      wkDrops    += drops
    }
    rows.push({ name, perDay, wkIn, wkOut, wkDrops, wkTot: wkIn + wkOut })
  }

  // Sort by busiest first — appts dominate, then drops as tiebreak so
  // drops-only projects still rank by activity.
  rows.sort((a, b) => (b.wkTot - a.wkTot) || (b.wkDrops - a.wkDrops))

  if (!rows.length) return null

  // Grid template: project name | 7 days | week total
  // Min widths chosen so the table works at the existing right-half width
  // (~620–700px on desktop) and gracefully scrolls horizontally on narrower
  // viewports without breaking the layout.
  const gridTemplate = 'minmax(140px, 1.5fr) repeat(7, minmax(56px, 1fr)) minmax(64px, 0.9fr)'

  const dimLabelStyle = { fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', lineHeight: 1.15 }
  const totalStyle    = { fontSize: 13, fontWeight: 600, lineHeight: 1.15, fontFamily: 'var(--font-mono)' }
  const headerCellBase = {
    padding: '6px 4px',
    fontSize: 10,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    textAlign: 'center',
    borderBottom: '1px solid var(--border)',
  }

  function selectedBg(d) {
    return d === selectedDate ? { background: 'rgba(255,255,255,0.04)', boxShadow: `inset 0 0 0 1px ${color}40` } : null
  }

  return (
    <div className="project-list" style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: gridTemplate, minWidth: 620 }}>
        {/* ── Header row ── */}
        <div style={{ ...headerCellBase, textAlign: 'left', paddingLeft: 8 }}>Project</div>
        {weekDays.map((d, i) => {
          const sel = d === selectedDate
          return (
            <div
              key={d}
              style={{
                ...headerCellBase,
                ...(sel ? { color, fontWeight: 600 } : {}),
                ...(selectedBg(d) || {}),
              }}
            >
              <div>{DAY_LABELS[i]}</div>
              <div style={{ fontSize: 9, opacity: 0.7 }}>{formatMDD(d)}</div>
            </div>
          )
        })}
        <div style={{ ...headerCellBase, color: 'var(--text-secondary)', fontWeight: 600 }}>Wk Tot</div>

        {/* ── Data rows ── */}
        {rows.map(r => (
          <Fragment key={r.name}>
            <div
              style={{
                padding: '6px 8px',
                fontSize: 11,
                color: 'var(--text-primary)',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={r.name}
            >
              {stripSuffix(r.name)}
            </div>
            {weekDays.map(d => {
              const cell = r.perDay[d]
              const empty = cell.drops === 0 && cell.inb === 0 && cell.out === 0
              const sel = d === selectedDate
              return (
                <div
                  key={d}
                  style={{
                    padding: '4px 2px',
                    textAlign: 'center',
                    borderBottom: '1px solid var(--border-subtle)',
                    ...(selectedBg(d) || {}),
                  }}
                >
                  {empty ? (
                    <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>—</span>
                  ) : (
                    <>
                      <div style={dimLabelStyle}>
                        {cell.drops > 0 ? `${cell.drops}d` : ''}
                        {cell.drops > 0 && (cell.inb > 0 || cell.out > 0) ? '  ' : ''}
                        {(cell.inb > 0 || cell.out > 0) ? `${cell.inb}·${cell.out}` : ''}
                      </div>
                      <div style={{ ...totalStyle, color: cell.tot > 0 ? color : 'var(--text-dim)' }}>
                        {cell.tot > 0 ? cell.tot : (cell.drops > 0 ? cell.drops : '—')}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
            {/* Week total cell */}
            <div
              style={{
                padding: '4px 4px',
                textAlign: 'center',
                borderBottom: '1px solid var(--border-subtle)',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              <div style={dimLabelStyle}>
                {r.wkDrops > 0 ? `${r.wkDrops}d` : ''}
                {r.wkDrops > 0 && (r.wkIn > 0 || r.wkOut > 0) ? '  ' : ''}
                {(r.wkIn > 0 || r.wkOut > 0) ? `${r.wkIn}·${r.wkOut}` : ''}
              </div>
              <div style={{ ...totalStyle, color }}>
                {r.wkTot > 0 ? r.wkTot : (r.wkDrops > 0 ? r.wkDrops : '—')}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}
