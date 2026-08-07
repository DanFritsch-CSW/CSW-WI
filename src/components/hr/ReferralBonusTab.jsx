import { useState, useEffect, useMemo } from 'react'

// Referral Bonus Tracker — HR sub-tab (added 2026-08-07). Same conventions
// as the other HR sub-tabs: no page-content/page-header wrapper, inherits
// HrPasswordGate. Single sheet, simplest tracker of the batch.

const FN_BASE = '/.netlify/functions/sharepoint-referral-bonus'

const PREVIEW = [
  { id: 'REF-P1', referrerName: 'Employee A', referredName: 'New Hire X', hireDate: '5/7/2026', bonus90Date: '8/5/26', bonus90Paid: false, bonus1yrDate: 'May 5th, 2027', bonus1yrPaid: false, rowIndex: 2, _colMap: {} },
  { id: 'REF-P2', referrerName: 'Employee B', referredName: 'New Hire Y', hireDate: '4/28/2026', bonus90Date: '7/27/26', bonus90Paid: true, bonus1yrDate: '', bonus1yrPaid: false, rowIndex: 3, _colMap: {} },
]

async function fetchAll() {
  const res = await fetch(FN_BASE)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export default function ReferralBonusTab() {
  const [records, setRecords] = useState(null)
  const [live, setLive] = useState(false)
  const [error, setError] = useState(null)
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
        setRecords(PREVIEW)
        setLive(false)
      })
    return () => { cancelled = true }
  }, [])

  const pending90 = useMemo(() => (records || []).filter((r) => r.bonus90Date && !r.bonus90Paid).length, [records])
  const pending1yr = useMemo(() => (records || []).filter((r) => r.bonus1yrDate && !r.bonus1yrPaid).length, [records])

  const markPaid = async (rec, field) => {
    const col = rec._colMap[field]
    if (!col) { alert('Missing column mapping — cannot save.'); return }
    setSavingId(`${rec.id}-${field}`)
    try {
      const res = await fetch(FN_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowIndex: rec.rowIndex, updates: { [field]: 'Yes' }, colMap: rec._colMap }),
      })
      if (!res.ok) throw new Error(await res.text())
      setRecords((prev) => prev.map((r) => (r.id === rec.id ? { ...r, [field]: true } : r)))
    } catch (err) {
      alert(`Save failed: ${err.message}`)
    } finally {
      setSavingId(null)
    }
  }

  if (!records) {
    return (
      <div className="stub-page" style={{ opacity: 0.6, marginTop: 16 }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</p>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <div className="page-subtitle">{records.length} referrals tracked · $200 at 90 days, $300 at 1 year</div>
        </div>
      </div>

      {!live && (
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">
            Preview data — SharePoint connection not yet configured{error ? ` (${error})` : ''}. Add
            {' '}<code>SHAREPOINT_REFERRAL_URL</code> in Netlify env vars to go live.
          </span>
        </div>
      )}

      <div className="kpi-row">
        <div className="kpill">
          <span className="kpill-label">Total Referrals</span>
          <span className="kpill-value">{records.length}</span>
        </div>
        <div className="kpill">
          <span className="kpill-label">90-Day Bonuses Pending</span>
          <span className="kpill-value" style={{ color: 'var(--yellow)' }}>{pending90}</span>
        </div>
        <div className="kpill">
          <span className="kpill-label">1-Year Bonuses Pending</span>
          <span className="kpill-value" style={{ color: 'var(--yellow)' }}>{pending1yr}</span>
        </div>
      </div>

      <div className="appt-list-section">
        <div className="appt-list-body">
          <table className="appt-list-table">
            <thead>
              <tr>
                <th>Referred By</th><th>New Hire</th><th>Hire Date</th>
                <th>90-Day ($200)</th><th>1-Year ($300)</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.referrerName || '—'}</td>
                  <td>{r.referredName}</td>
                  <td className="appt-list-mono">{r.hireDate}</td>
                  <td>
                    <BonusCell
                      date={r.bonus90Date} paid={r.bonus90Paid} live={live}
                      saving={savingId === `${r.id}-bonus90Paid`}
                      onMarkPaid={() => markPaid(r, 'bonus90Paid')}
                    />
                  </td>
                  <td>
                    <BonusCell
                      date={r.bonus1yrDate} paid={r.bonus1yrPaid} live={live}
                      saving={savingId === `${r.id}-bonus1yrPaid`}
                      onMarkPaid={() => markPaid(r, 'bonus1yrPaid')}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function BonusCell({ date, paid, live, saving, onMarkPaid }) {
  if (!date) return <span style={{ color: 'var(--text-dim)' }}>—</span>
  if (saving) return <span className="appt-list-mono" style={{ color: 'var(--brand)' }}>Saving…</span>
  if (paid) {
    return (
      <span className="appt-list-type-badge" style={{ background: 'transparent', border: '1px solid var(--green)', color: 'var(--green)' }}>
        Paid
      </span>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span className="appt-list-mono">{date}</span>
      {live && (
        <button className="b2e-sync-btn" onClick={onMarkPaid}>Mark Paid</button>
      )}
    </div>
  )
}
