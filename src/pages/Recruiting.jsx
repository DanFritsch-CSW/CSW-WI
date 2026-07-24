import { useState, useEffect, useMemo, useCallback } from 'react'

const FN_BASE = '/.netlify/functions/sharepoint-recruiting'

const FACILITY_COLOR = {
  Caledonia: 'var(--cal)', Kenosha: 'var(--ken)', Madison: 'var(--mad)',
  'Wisc. Rapids': 'var(--wr)', 'Wisc Rapids': 'var(--wr)', 'Eau Claire': 'var(--ec)',
}
const STAGE_ORDER = ['No Candidate', 'Internal Posting', 'Offer Sent', 'Offer Accepted', 'Background Cleared', 'Cleared to Start']

// Snapshot fallback — same real aggregates pulled from the source workbook,
// shown only until SHAREPOINT_RECRUITING_URL is configured in Netlify.
const PREVIEW_NEEDS = [
  { id: 'REQ-001', position: 'Warehouse (3pm-11:30pm)', shift: '2nd', facility: 'Kenosha', pipeline: 'Jose Arroyo Castro- Cleared to start 7/28 1pm', stage: 'Cleared to Start', reason: 'Backfill — Gael term, Dryce Brown no response', rowIndex: 3, _colMap: {} },
  { id: 'REQ-002', position: 'Warehouse (3pm-11:30pm)', shift: '2nd', facility: 'Kenosha', pipeline: 'Ryan Finley- Offer Accepted', stage: 'Offer Accepted', reason: 'Backfill — Eli internal move', rowIndex: 4, _colMap: {} },
  { id: 'REQ-003', position: 'Warehouse (3pm-11:30pm)', shift: '2nd', facility: 'Kenosha', pipeline: '', stage: 'No Candidate', reason: '—', rowIndex: 5, _colMap: {} },
  { id: 'REQ-004', position: 'DSM Ultra Cold', shift: '1st', facility: 'Kenosha', pipeline: 'Internal Posting', stage: 'Internal Posting', reason: '—', rowIndex: 6, _colMap: {} },
  { id: 'REQ-005', position: 'Customer Service Rep (12-8:30)', shift: '2nd', facility: 'Caledonia', pipeline: '', stage: 'No Candidate', reason: 'Posted 7/14', rowIndex: 7, _colMap: {} },
  { id: 'REQ-006', position: 'Inventory Control Specialist', shift: '—', facility: 'Caledonia', pipeline: 'Internal Posting', stage: 'Internal Posting', reason: '—', rowIndex: 8, _colMap: {} },
  { id: 'REQ-007', position: 'Warehouse', shift: '1st', facility: 'Caledonia', pipeline: 'Juan Salinas- internal transfer', stage: 'Internal Transfer', reason: 'Chris T replacement', rowIndex: 9, _colMap: {} },
  { id: 'REQ-008', position: 'Warehouse', shift: '2nd', facility: 'Caledonia', pipeline: 'Justin Gates- BKG cleared', stage: 'Background Cleared', reason: 'Jose Cuevas transfer', rowIndex: 10, _colMap: {} },
  { id: 'REQ-009', position: 'Replenisher', shift: '3rd', facility: 'Caledonia', pipeline: 'G-Poe- internal transfer', stage: 'Internal Transfer', reason: 'Juan transferring to 1st', rowIndex: 11, _colMap: {} },
  { id: 'REQ-010', position: 'Warehouse', shift: '3rd', facility: 'Caledonia', pipeline: 'Jose Cuevas- internal transfer', stage: 'Internal Transfer', reason: 'GPoe transfer to replen', rowIndex: 12, _colMap: {} },
  { id: 'REQ-011', position: 'Warehouse', shift: '1st', facility: 'Madison', pipeline: 'Internal Posting', stage: 'Internal Posting', reason: '—', rowIndex: 13, _colMap: {} },
  { id: 'REQ-012', position: 'Warehouse (8am-4:30pm)', shift: 'Mid', facility: 'Madison', pipeline: '', stage: 'No Candidate', reason: '—', rowIndex: 14, _colMap: {} },
  { id: 'REQ-013', position: 'Warehouse (8am-4:30pm)', shift: 'Mid', facility: 'Madison', pipeline: 'Jeffery Boyce- Offer Sent', stage: 'Offer Sent', reason: '—', rowIndex: 15, _colMap: {} },
  { id: 'REQ-014', position: 'Warehouse (8am-4:30pm)', shift: 'Mid', facility: 'Madison', pipeline: 'Isiah Conn- Cleared to start 7/27 11am', stage: 'Cleared to Start', reason: '—', rowIndex: 16, _colMap: {} },
  { id: 'REQ-015', position: 'Warehouse', shift: '2nd', facility: 'Madison', pipeline: '', stage: 'No Candidate', reason: '—', rowIndex: 17, _colMap: {} },
  { id: 'REQ-016', position: 'Warehouse', shift: '2nd', facility: 'Madison', pipeline: '', stage: 'No Candidate', reason: 'Shaquille term', rowIndex: 18, _colMap: {} },
  { id: 'REQ-017', position: 'Warehouse', shift: '2nd', facility: 'Madison', pipeline: 'Bradley Wilcox- Cleared to start 7/27 11am', stage: 'Cleared to Start', reason: '—', rowIndex: 19, _colMap: {} },
  { id: 'REQ-018', position: 'Warehouse', shift: '2nd', facility: 'Wisc. Rapids', pipeline: '', stage: 'No Candidate', reason: 'Jeremy term', rowIndex: 20, _colMap: {} },
  { id: 'REQ-019', position: 'Maintenance', shift: '1st', facility: 'Wisc. Rapids', pipeline: 'Kristofor Bucholtz- Cleared to start 7/27 11am', stage: 'Cleared to Start', reason: 'Jason Shultis preadverse, Cordell resigned', rowIndex: 21, _colMap: {} },
]
const TTS_BY_FACILITY_PREVIEW = { Caledonia: 40.2, Kenosha: 31.7, Madison: 79.6, 'Wisc. Rapids': 49.1, 'Eau Claire': null }

async function fetchTab(tab) {
  const res = await fetch(`${FN_BASE}?tab=${tab}`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export default function Recruiting() {
  const [needs, setNeeds] = useState(null)
  const [live, setLive] = useState(false)
  const [error, setError] = useState(null)
  const [facilityFilter, setFacilityFilter] = useState('All')
  const [editing, setEditing] = useState(null) // req being edited in modal
  const [savingId, setSavingId] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchTab('needs')
      .then((d) => {
        if (cancelled) return
        setNeeds(d.records)
        setLive(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setNeeds(PREVIEW_NEEDS)
        setLive(false)
      })
    return () => { cancelled = true }
  }, [])

  const facilities = useMemo(() => {
    if (!needs) return []
    return [...new Set(needs.map((r) => r.facility))].filter(Boolean)
  }, [needs])

  const filtered = useMemo(() => {
    if (!needs) return []
    return facilityFilter === 'All' ? needs : needs.filter((r) => r.facility === facilityFilter)
  }, [needs, facilityFilter])

  const facilityCounts = useMemo(() => {
    const counts = {}
    if (!needs) return counts
    needs.forEach((r) => { counts[r.facility] = (counts[r.facility] || 0) + 1 })
    return counts
  }, [needs])

  const stageCounts = useMemo(() => {
    const counts = {}
    STAGE_ORDER.forEach((s) => (counts[s] = 0))
    let internalTransfers = 0
    if (needs) needs.forEach((r) => { if (r.stage === 'Internal Transfer') internalTransfers++; else counts[r.stage] = (counts[r.stage] || 0) + 1 })
    return { counts, internalTransfers }
  }, [needs])

  const saveEdit = useCallback(async (req, updates) => {
    setSavingId(req.id)
    try {
      const res = await fetch(FN_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowIndex: req.rowIndex, updates, colMap: req._colMap }),
      })
      if (!res.ok) throw new Error(await res.text())
      setNeeds((prev) => prev.map((r) => (r.id === req.id ? { ...r, ...updates } : r)))
      setEditing(null)
    } catch (err) {
      alert(`Save failed: ${err.message}`)
    } finally {
      setSavingId(null)
    }
  }, [])

  const maxFacilityCount = Math.max(...Object.values(facilityCounts), 1)

  if (!needs) {
    return (
      <div className="page-content">
        <div className="stub-page" style={{ opacity: 0.6 }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading recruiting data…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">
            Recruiting <span className="page-title-gold">Pipeline</span>
          </div>
          <div className="page-subtitle">{needs.length} open reqs across {facilities.length} facilities</div>
        </div>
      </div>

      {!live && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">
            Preview data — SharePoint connection not yet configured{error ? ` (${error})` : ''}. Add
            {' '}<code>SHAREPOINT_RECRUITING_URL</code> in Netlify env vars to go live.
          </span>
        </div>
      )}

      {/* KPI row */}
      <div className="kpi-row">
        <div className="kpill">
          <span className="kpill-label">Open Reqs</span>
          <span className="kpill-value">{needs.length}</span>
        </div>
        <div className="kpill">
          <span className="kpill-label">Avg Time to Start</span>
          <span className="kpill-value">44<span style={{ fontSize: 13 }}>d</span></span>
        </div>
        <div className="kpill">
          <span className="kpill-label">Filled ≤30d to Accept</span>
          <span className="kpill-value" style={{ color: 'var(--green)' }}>39%</span>
        </div>
        <div className="kpill">
          <span className="kpill-label">Interview No-Show</span>
          <span className="kpill-value" style={{ color: 'var(--red)' }}>19%</span>
        </div>
      </div>

      {/* Facility tabs */}
      <div className="facility-tabs">
        <button className={`fac-tab${facilityFilter === 'All' ? ' active' : ''}`} onClick={() => setFacilityFilter('All')}>
          <span className="dot" style={{ background: 'var(--brand)' }} />ALL
        </button>
        {facilities.map((f) => (
          <button key={f} className={`fac-tab${facilityFilter === f ? ' active' : ''}`} onClick={() => setFacilityFilter(f)}>
            <span className="dot" style={{ background: FACILITY_COLOR[f] || 'var(--text-dim)' }} />
            {f} <span style={{ opacity: 0.6, marginLeft: 4 }}>({facilityCounts[f] || 0})</span>
          </button>
        ))}
      </div>

      <div className="two-col" style={{ marginBottom: 20 }}>
        {/* Facility load */}
        <div className="chart-card">
          <div className="chart-header"><span className="chart-title">Open Reqs by Facility</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {facilities.map((f) => {
              const count = facilityCounts[f] || 0
              const tts = TTS_BY_FACILITY_PREVIEW[f]
              return (
                <div key={f}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span>{f}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>{count} open{tts ? ` · ${tts}d avg` : ''}</span>
                  </div>
                  <div style={{ background: 'var(--bg3)', height: 7, borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${(count / maxFacilityCount) * 100}%`, height: '100%', background: FACILITY_COLOR[f] || 'var(--brand)', borderRadius: 4 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Stage funnel */}
        <div className="chart-card">
          <div className="chart-header"><span className="chart-title">Where the {needs.length} Open Reqs Sit</span></div>
          <div style={{ display: 'flex', gap: 6 }}>
            {STAGE_ORDER.map((stage) => (
              <div key={stage} style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: 'var(--brand)' }}>{stageCounts.counts[stage]}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4, lineHeight: 1.3 }}>{stage}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--blue)' }}>+{stageCounts.internalTransfers} internal transfers</strong> filled outside this funnel.
          </div>
        </div>
      </div>

      {/* Open needs table */}
      <div className="appt-list-section">
        <div className="appt-list-toggle" style={{ cursor: 'default' }}>
          <span className="appt-list-toggle-label">Open Needs{facilityFilter !== 'All' ? ` — ${facilityFilter}` : ''}</span>
          <span className="appt-list-toggle-count">{filtered.length}</span>
        </div>
        <div className="appt-list-body">
          <table className="appt-list-table">
            <thead>
              <tr>
                <th>Position</th><th>Shift</th><th>Facility</th><th>Candidate / Pipeline</th><th>Stage</th><th>Reason</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600, whiteSpace: 'normal' }}>{r.position}</td>
                  <td>{r.shift}</td>
                  <td>{r.facility}</td>
                  <td className="appt-list-col-notes">{r.pipeline || '—'}</td>
                  <td>
                    <span className="appt-list-type-badge appt-list-type-badge--inbound">{r.stage}</span>
                  </td>
                  <td className="appt-list-col-notes">{r.reason}</td>
                  <td>
                    <button
                      className="b2e-sync-btn"
                      disabled={!live || savingId === r.id}
                      onClick={() => setEditing(r)}
                      title={live ? 'Update stage/notes' : 'Connect SharePoint to enable editing'}
                    >
                      {savingId === r.id ? 'Saving…' : 'Edit'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <EditReqModal
          req={editing}
          onCancel={() => setEditing(null)}
          onSave={(updates) => saveEdit(editing, updates)}
        />
      )}
    </div>
  )
}

function EditReqModal({ req, onCancel, onSave }) {
  const [pipeline, setPipeline] = useState(req.pipeline || '')
  const [reason, setReason] = useState(req.reason === '—' ? '' : req.reason || '')

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{req.position}</span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>
        <div className="modal-form">
          <label className="modal-label">
            Candidate / Pipeline note
            <input className="modal-input" value={pipeline} onChange={(e) => setPipeline(e.target.value)} placeholder="e.g. Jane Doe- Offer Sent" />
          </label>
          <label className="modal-label">
            Reason <span className="modal-optional">(optional)</span>
            <input className="modal-input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="modal-btn-submit" onClick={() => onSave({ pipeline, reason })}>Save</button>
        </div>
      </div>
    </div>
  )
}
