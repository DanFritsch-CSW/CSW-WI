import { useState, useEffect, useMemo } from 'react'

const FN_BASE = '/.netlify/functions/sharepoint-30-60-90'

const FACILITY_LABEL = { cal: 'Caledonia', ken: 'Kenosha', wr: 'Wisc. Rapids', mad: 'Madison' }
const FACILITY_COLOR = { cal: 'var(--cal)', ken: 'var(--ken)', wr: 'var(--wr)', mad: 'var(--mad)' }

const STATUS_COLOR = {
  'Done': 'var(--green)',
  'Reached Out': 'var(--blue)',
  'N/A': 'var(--text-dim)',
  'Overdue': 'var(--red)',
  'Upcoming': 'var(--text-secondary)',
}

// Preview fallback — real 2026-08-07 snapshot, trimmed to a few rows per
// facility, shown only until SHAREPOINT_306090_URL is configured.
const PREVIEW_RECORDS = [
  { id: 'CAL-001', rowIndex: 2, facility: 'cal', name: 'Ivan Campuzano', shift: '2nd', startDate: '2025-12-29', milestones: { d30: { date: '2026-01-28', status: 'Done' }, d60: { date: '2026-02-27', status: 'Done' }, d90: { date: '2026-03-29', status: 'Done' } }, benefitsEnrolled: '', _colMap: {} },
  { id: 'CAL-020', rowIndex: 21, facility: 'cal', name: 'Misael Barrios', shift: 'Mid', startDate: '2026-05-05', milestones: { d30: { date: '2026-06-04', status: 'Done' }, d60: { date: '2026-07-04', status: 'Done' }, d90: { date: '2026-08-03', status: 'Overdue' } }, benefitsEnrolled: '', _colMap: {} },
  { id: 'CAL-030', rowIndex: 31, facility: 'cal', name: 'Christian Schrecengost', shift: '2nd', startDate: '2026-07-21', milestones: { d30: { date: '2026-08-20', status: 'Upcoming' }, d60: { date: '2026-09-19', status: 'Upcoming' }, d90: { date: '2026-10-19', status: 'Upcoming' } }, benefitsEnrolled: '', _colMap: {} },
  { id: 'KEN-014', rowIndex: 15, facility: 'ken', name: 'Dillon Londre', shift: '2nd', startDate: '2026-07-20', milestones: { d30: { date: '2026-08-19', status: 'Upcoming' }, d60: { date: '2026-09-18', status: 'Upcoming' }, d90: { date: '2026-10-18', status: 'Upcoming' } }, benefitsEnrolled: '', _colMap: {} },
  { id: 'WR-007', rowIndex: 8, facility: 'wr', name: 'Anthony Sari', shift: '1st', startDate: '2026-07-06', milestones: { d30: { date: '2026-08-05', status: 'Overdue' }, d60: { date: '2026-09-04', status: 'Upcoming' }, d90: { date: '2026-10-04', status: 'Upcoming' } }, benefitsEnrolled: '', _colMap: {} },
  { id: 'MAD-002', rowIndex: 3, facility: 'mad', name: 'Bradley Wilcox', shift: '2nd', startDate: '2026-07-27', milestones: { d30: { date: '2026-08-26', status: 'Upcoming' }, d60: { date: '2026-09-25', status: 'Upcoming' }, d90: { date: '2026-10-25', status: 'Upcoming' } }, benefitsEnrolled: '', _colMap: {} },
]

async function fetchAll() {
  const res = await fetch(`${FN_BASE}?facility=all`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export default function ThirtySixtyNinety() {
  const [records, setRecords] = useState(null)
  const [live, setLive] = useState(false)
  const [error, setError] = useState(null)
  const [facilityFilter, setFacilityFilter] = useState('All')
  const [savingId, setSavingId] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchAll()
      .then((d) => {
        if (cancelled) return
        setRecords(d.records)
        setLive(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setRecords(PREVIEW_RECORDS)
        setLive(false)
      })
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() => {
    if (!records) return []
    return facilityFilter === 'All' ? records : records.filter((r) => r.facility === facilityFilter)
  }, [records, facilityFilter])

  const overdueCount = useMemo(() => (records || []).filter((r) => Object.values(r.milestones).some((m) => m.status === 'Overdue')).length, [records])
  const dueSoonCount = useMemo(() => {
    if (!records) return 0
    const in7d = Date.now() + 7 * 86400000
    return records.filter((r) => Object.values(r.milestones).some((m) => m.status === 'Upcoming' && m.date && new Date(m.date).getTime() < in7d)).length
  }, [records])

  const facilities = useMemo(() => [...new Set((records || []).map((r) => r.facility))], [records])

  const markStatus = async (rec, field, newStatus) => {
    const colKey = { d30: 's30', d60: 's60', d90: 's90' }[field]
    const col = rec._colMap[colKey]
    if (!col) { alert('Missing column mapping — cannot save.'); return }
    setSavingId(`${rec.id}-${field}`)
    const value = newStatus === 'Done' ? `Done ${new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}` : newStatus === 'Reached Out' ? `Reached out ${new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}` : ''
    try {
      const res = await fetch(FN_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facility: rec.facility, rowIndex: rec.rowIndex, updates: { [colKey]: value }, colMap: rec._colMap }),
      })
      if (!res.ok) throw new Error(await res.text())
      setRecords((prev) => prev.map((r) => (r.id === rec.id ? { ...r, milestones: { ...r.milestones, [field]: { ...r.milestones[field], status: newStatus, statusRaw: value } } } : r)))
    } catch (err) {
      alert(`Save failed: ${err.message}`)
    } finally {
      setSavingId(null)
    }
  }

  if (!records) {
    return (
      <div className="page-content">
        <div className="stub-page" style={{ opacity: 0.6 }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading check-in data…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">
            30/60/90 <span className="page-title-gold">Check-Ins</span>
          </div>
          <div className="page-subtitle">{records.length} new hires being tracked across {facilities.length} facilities</div>
        </div>
      </div>

      {!live && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">
            Preview data — SharePoint connection not yet configured{error ? ` (${error})` : ''}. Add
            {' '}<code>SHAREPOINT_306090_URL</code> in Netlify env vars to go live.
          </span>
        </div>
      )}

      <div className="kpi-row">
        <div className="kpill">
          <span className="kpill-label">Being Tracked</span>
          <span className="kpill-value">{records.length}</span>
        </div>
        <div className="kpill">
          <span className="kpill-label">Overdue Check-Ins</span>
          <span className="kpill-value" style={{ color: 'var(--red)' }}>{overdueCount}</span>
        </div>
        <div className="kpill">
          <span className="kpill-label">Due Within 7 Days</span>
          <span className="kpill-value" style={{ color: 'var(--yellow)' }}>{dueSoonCount}</span>
        </div>
      </div>

      <div className="facility-tabs">
        <button className={`fac-tab${facilityFilter === 'All' ? ' active' : ''}`} onClick={() => setFacilityFilter('All')}>
          <span className="dot" style={{ background: 'var(--brand)' }} />ALL
        </button>
        {facilities.map((f) => (
          <button key={f} className={`fac-tab${facilityFilter === f ? ' active' : ''}`} onClick={() => setFacilityFilter(f)}>
            <span className="dot" style={{ background: FACILITY_COLOR[f] || 'var(--text-dim)' }} />
            {FACILITY_LABEL[f] || f}
          </button>
        ))}
      </div>

      <div className="appt-list-section">
        <div className="appt-list-toggle" style={{ cursor: 'default' }}>
          <span className="appt-list-toggle-label">Check-In Roster{facilityFilter !== 'All' ? ` — ${FACILITY_LABEL[facilityFilter]}` : ''}</span>
          <span className="appt-list-toggle-count">{filtered.length}</span>
        </div>
        <div className="appt-list-body">
          <table className="appt-list-table">
            <thead>
              <tr>
                <th>Name</th><th>Facility</th><th>Shift</th><th>Start Date</th>
                <th>30-Day</th><th>60-Day</th><th>90-Day</th><th>Benefits</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td>{FACILITY_LABEL[r.facility] || r.facility}</td>
                  <td>{r.shift}</td>
                  <td className="appt-list-mono">{r.startDate}</td>
                  {['d30', 'd60', 'd90'].map((field) => (
                    <td key={field}>
                      <MilestoneCell
                        milestone={r.milestones[field]}
                        saving={savingId === `${r.id}-${field}`}
                        live={live}
                        onMark={(status) => markStatus(r, field, status)}
                      />
                    </td>
                  ))}
                  <td>{r.benefitsEnrolled || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function MilestoneCell({ milestone, saving, live, onMark }) {
  const [open, setOpen] = useState(false)
  const color = STATUS_COLOR[milestone.status] || 'var(--text-secondary)'

  if (saving) return <span className="appt-list-mono" style={{ color: 'var(--brand)' }}>Saving…</span>

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="appt-list-type-badge"
        style={{ background: 'transparent', border: `1px solid ${color}`, color, cursor: live ? 'pointer' : 'default' }}
        onClick={() => live && setOpen((o) => !o)}
        title={milestone.date ? `Target: ${milestone.date}` : ''}
      >
        {milestone.status}
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 6, padding: 6, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 }}>
          {['Done', 'Reached Out', 'N/A'].map((opt) => (
            <button key={opt} className="b2e-sync-btn" style={{ textAlign: 'left' }} onClick={() => { onMark(opt); setOpen(false) }}>
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
