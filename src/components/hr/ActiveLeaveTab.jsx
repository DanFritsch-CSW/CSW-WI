import { useState, useEffect } from 'react'

// Active Leave Tracker — HR sub-tab (added 2026-08-07). Same conventions as
// RecruitingTab.jsx / ThirtySixtyNinetyTab.jsx: no page-content/page-header
// wrapper, inherits HrPasswordGate.
//
// Covers FMLA, STD, Workman's Comp, LOA, and non-FMLA leaves — genuinely
// different schemas per leave type, confirmed live before writing parsers.
// Preview fallback data below is intentionally GENERIC/placeholder rather
// than real employee names or medical details — this tracker holds more
// sensitive data (FMLA reasons, surgery types, disability status) than
// Recruiting or 30/60/90, and that shouldn't sit in git history even
// behind a password gate.

const FN_BASE = '/.netlify/functions/sharepoint-active-leave'

const LEAVE_TYPES = [
  { key: 'fmla', label: 'FMLA — Active' },
  { key: 'fmlaHours', label: 'FMLA — Hours' },
  { key: 'std', label: 'Short-Term Disability' },
  { key: 'wc', label: "Workman's Comp" },
  { key: 'loa', label: 'LOA' },
  { key: 'nonFmla', label: 'Other Leaves' },
  { key: 'closedFmla', label: 'Closed FMLA Cases' },
]

const PREVIEW = {
  fmla: [
    { id: 'FMLA-P1', name: 'Employee A', location: 'CAL', status: 'Active', length: 'Intermittent', restrictions: '—', notes: '—', rowIndex: 2, _colMap: {} },
    { id: 'FMLA-P2', name: 'Employee B', location: 'MAD', status: 'Active', length: '12wk', restrictions: '—', notes: '—', rowIndex: 3, _colMap: {} },
  ],
  fmlaHours: [
    { id: 'FMLAH-P1', name: 'Employee A', location: 'CAL', status: 'Active', totalHours: 480, usedHours: 120, availableHours: 360 },
  ],
  std: [
    { id: 'STD-P1', name: 'Employee C', location: 'WR', status: 'Not Active', length: '—', restrictions: '—', notes: 'Closed', rowIndex: 2, _colMap: {} },
  ],
  wc: [
    { id: 'WC-P1', name: 'Employee D', location: 'KEN', status: 'Active', length: '—', restrictions: '—', notes: '—', rowIndex: 2, _colMap: {} },
  ],
  loa: [],
  nonFmla: [
    { id: 'NF-P1', name: 'Employee E', location: 'CAL', startDate: '—', stillOnLeave: 'Yes', expectedRtw: '—' },
  ],
  closedFmla: [],
}

async function fetchTab(tab) {
  const res = await fetch(`${FN_BASE}?tab=${tab}`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export default function ActiveLeaveTab() {
  const [activeType, setActiveType] = useState('fmla')
  const [records, setRecords] = useState(null)
  const [live, setLive] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setRecords(null)
    fetchTab(activeType)
      .then((d) => {
        if (cancelled) return
        setRecords(d.records)
        setLive(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setRecords(PREVIEW[activeType] || [])
        setLive(false)
      })
    return () => { cancelled = true }
  }, [activeType])


  return (
    <div style={{ marginTop: 16 }}>
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <div className="page-subtitle">FMLA, short-term disability, workman's comp, and other leave tracking</div>
        </div>
      </div>

      {!live && records !== null && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">
            Preview data (placeholder — not real employee info) — SharePoint connection not yet configured{error ? ` (${error})` : ''}. Add
            {' '}<code>SHAREPOINT_ACTIVE_LEAVE_URL</code> in Netlify env vars to go live.
          </span>
        </div>
      )}

      <div className="settings-tab-row" style={{ marginTop: 0 }}>
        {LEAVE_TYPES.map((t) => (
          <button
            key={t.key}
            className={`settings-tab${activeType === t.key ? ' active' : ''}`}
            onClick={() => setActiveType(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {records === null ? (
        <div className="stub-page" style={{ opacity: 0.6 }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</p>
        </div>
      ) : (
        <LeaveTable type={activeType} records={records} />
      )}
    </div>
  )
}

function LeaveTable({ type, records }) {
  if (records.length === 0) {
    return <div className="appt-list-empty">No records on this tab.</div>
  }

  if (type === 'closedFmla') {
    return (
      <div className="appt-list-section">
        <div className="appt-list-body">
          <table className="appt-list-table">
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  {r.cells.map((c, i) => <td key={i} className="appt-list-col-notes">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  if (type === 'fmlaHours') {
    return (
      <div className="appt-list-section">
        <div className="appt-list-body">
          <table className="appt-list-table">
            <thead><tr><th>Name</th><th>Location</th><th>Status</th><th>Total Hrs</th><th>Used</th><th>Available</th></tr></thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td>{r.location}</td>
                  <td><StatusBadge active={r.active} label={r.status} /></td>
                  <td className="appt-list-mono">{r.totalHours ?? '—'}</td>
                  <td className="appt-list-mono">{r.usedHours ?? '—'}</td>
                  <td className="appt-list-mono" style={{ color: r.availableHours < 0 ? 'var(--red)' : 'inherit' }}>{r.availableHours ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  if (type === 'nonFmla') {
    return (
      <div className="appt-list-section">
        <div className="appt-list-body">
          <table className="appt-list-table">
            <thead><tr><th>Name</th><th>Location</th><th>Start Date</th><th>Still On Leave?</th><th>Expected RTW</th></tr></thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td>{r.location}</td>
                  <td className="appt-list-mono">{r.startDate}</td>
                  <td>{r.stillOnLeave}</td>
                  <td className="appt-list-mono">{r.expectedRtw || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  if (type === 'loa') {
    return (
      <div className="appt-list-section">
        <div className="appt-list-body">
          <table className="appt-list-table">
            <thead><tr><th>Name</th><th>Location</th><th>Status</th><th>LOA Start</th><th>RTW Date</th><th>Notes</th></tr></thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td>{r.location}</td>
                  <td><StatusBadge active={r.active} label={r.status} /></td>
                  <td className="appt-list-mono">{r.loaStart || '—'}</td>
                  <td className="appt-list-mono">{r.rtwDate || '—'}</td>
                  <td className="appt-list-col-notes">{r.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // fmla, std, wc share the same rendered shape
  return (
    <div className="appt-list-section">
      <div className="appt-list-body">
        <table className="appt-list-table">
          <thead><tr><th>Name</th><th>Location</th><th>Status</th><th>Start / Length</th><th>Restrictions</th><th>Notes</th></tr></thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                <td>{r.location}</td>
                <td><StatusBadge active={r.active} label={r.status} /></td>
                <td className="appt-list-mono">{r.startDate ? `${r.startDate} · ` : ''}{r.length}</td>
                <td className="appt-list-col-notes">{r.restrictions}</td>
                <td className="appt-list-col-notes">{r.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatusBadge({ active, label }) {
  return (
    <span
      className="appt-list-type-badge"
      style={{
        background: 'transparent',
        border: `1px solid ${active ? 'var(--green)' : 'var(--text-dim)'}`,
        color: active ? 'var(--green)' : 'var(--text-dim)',
      }}
    >
      {label || (active ? 'Active' : 'Not Active')}
    </span>
  )
}
