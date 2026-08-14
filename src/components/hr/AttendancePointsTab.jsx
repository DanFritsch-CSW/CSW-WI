import { useState, useEffect, useCallback } from 'react'
import { FACILITY_LIST } from '../../lib/constants.js'
import {
  fetchNotifySettings, upsertNotifySettings,
  fetchPointBalances, triggerDigestTest, fetchRecentActions,
} from '../../lib/attendancePoints.js'
import SignedDocumentCell from './SignedDocumentCell.jsx'

const FACILITY_COLOR_VAR = { cal: 'var(--cal)', ken: 'var(--ken)', mad: 'var(--mad)', wr: 'var(--wr)', ec: 'var(--ec)' }

function tierColor(tier) {
  if (tier === 'Termination') return 'var(--red)'
  if (tier === 'Final Warning' || tier === 'Written Warning') return 'var(--amber, #d4b84a)'
  return 'var(--text-dim)'
}

function SettingsPanel({ facility }) {
  const [conversationId, setConversationId] = useState('')
  const [active, setActive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saveState, setSave] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchNotifySettings(facility).then(s => {
      if (cancelled) return
      setConversationId(s.front_conversation_id || '')
      setActive(!!s.active)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [facility])

  async function handleSave() {
    setSave('saving')
    try {
      await upsertNotifySettings(facility, { frontConversationId: conversationId || null, active })
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  if (loading) {
    return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>Loading settings…</div>
  }

  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div className="chart-header">
        <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Notify Settings</span>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', padding: '12px 0' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Front conversation ID (cnv_xxxxx)</span>
          <input
            className="settings-field-input"
            style={{ width: 240 }}
            value={conversationId}
            onChange={e => setConversationId(e.target.value)}
            placeholder="cnv_xxxxx"
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          Auto-post daily (unattended)
        </label>
        <button className="settings-save-btn" onClick={handleSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
      </div>
      {!active && (
        <p className="settings-page-sub" style={{ fontStyle: 'italic' }}>
          Auto-post is off — the daily cron skips this facility. Use "Run check now (test)" below to validate before
          turning this on. That button is not a dry run — it posts real comments and logs real actions.
        </p>
      )}
    </div>
  )
}

function BalancesTable({ facility, refreshKey }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setErr(null)
    fetchPointBalances(facility)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(e.message) })
    return () => { cancelled = true }
  }, [facility, refreshKey])

  if (err) return <div style={{ color: 'var(--red)', fontSize: 13, padding: '12px 0' }}>Error: {err}</div>
  if (!data) return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0' }}>Loading balances…</div>

  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div className="chart-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Current Point Balances</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {data.employees.length} active employee(s) · B2E balance as of {data.employees[0]?.updatedToDate || '—'}
        </span>
      </div>
      {data.employees.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '8px 0' }}>No active employees found for this facility in B2E.</div>
      ) : (
        <table className="appt-list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Points</th>
              <th>Current Tier</th>
              <th>New Crossing?</th>
              <th>Likely Last Category</th>
            </tr>
          </thead>
          <tbody>
            {data.employees.map(e => (
              <tr key={e.employeeId}>
                <td style={{ fontWeight: 600 }}>{e.name}</td>
                <td>{e.points}</td>
                <td style={{ color: tierColor(e.currentTier), fontWeight: 700 }}>{e.currentTier || '—'}</td>
                <td>
                  {e.newCrossings.length > 0
                    ? <span style={{ color: 'var(--red)', fontWeight: 700 }}>{e.newCrossings.join(', ')} pt{e.newCrossings.length > 1 ? 's' : ''}</span>
                    : '—'}
                </td>
                <td style={{ color: 'var(--text-secondary)' }}>{e.latestCategory || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function RecentActionsLog({ facility, refreshKey }) {
  const [rows, setRows] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchRecentActions(facility).then(r => { if (!cancelled) setRows(r) })
    return () => { cancelled = true }
  }, [facility, refreshKey])

  if (!rows) return null
  if (rows.length === 0) {
    return <p className="settings-page-sub">No disciplinary actions logged yet for this facility.</p>
  }

  return (
    <div className="chart-card">
      <div className="chart-header">
        <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Recent Actions Log</span>
      </div>
      <table className="appt-list-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Employee ID</th>
            <th>Threshold</th>
            <th>Points at Flag</th>
            <th>Category</th>
            <th>Triggering Date</th>
            <th>Posted</th>
            <th>Signed Form</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.employee_id}</td>
              <td>{r.threshold_hit}</td>
              <td>{r.points_at_flag}</td>
              <td>{r.triggering_category || '—'}</td>
              <td>{r.triggering_date || '—'}</td>
              <td>{r.front_comment_id ? '✓ Front' : '—'}</td>
              <td>
                <SignedDocumentCell
                  tracker="attendance_points"
                  recordRef={r.id}
                  facility={facility}
                  employeeName={String(r.employee_id)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AttendancePointsTab() {
  const [facility, setFacility] = useState('cal')
  const [refreshKey, setRefreshKey] = useState(0)
  const [testState, setTestState] = useState(null)
  const [testDetail, setTestDetail] = useState(null)

  const runTest = useCallback(async () => {
    setTestState('running')
    setTestDetail(null)
    try {
      const result = await triggerDigestTest(facility)
      const count = result.newActions?.length || 0
      setTestState('ok')
      setTestDetail(count > 0
        ? `Posted ${count} new disciplinary notice(s) to Front.`
        : (result.reason || 'No new threshold crossings found.'))
      setRefreshKey(k => k + 1)
    } catch (err) {
      setTestState('error')
      setTestDetail(err.message)
    }
    setTimeout(() => { setTestState(null); setTestDetail(null) }, 8000)
  }, [facility])

  return (
    <div style={{ marginTop: 16 }}>
      <p className="settings-page-sub" style={{ marginBottom: 16 }}>
        Watches B2E's own attendance-points balance for new 6/8/10-point crossings (per the non-union Attendance Policy)
        and posts a disciplinary-action summary to this facility's Front thread. Signature lines are never filled —
        a human still signs the real form. <strong>Data caveat:</strong> B2E's points feed isn't on a recurring sync yet
        (single historical load as of this build) — results reflect whatever snapshot MotherDuck currently has.
      </p>

      <div className="facility-tabs" style={{ marginBottom: 16 }}>
        {FACILITY_LIST.map(f => (
          <button
            key={f.id}
            className={`fac-tab${facility === f.id ? ' active' : ''}`}
            onClick={() => setFacility(f.id)}
          >
            <span className="dot" style={{ background: FACILITY_COLOR_VAR[f.id] || 'var(--text-dim)' }} />
            {f.code}
          </button>
        ))}
      </div>

      <SettingsPanel key={`settings-${facility}`} facility={facility} />

      <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="settings-save-btn" onClick={runTest} disabled={testState === 'running'}>
          {testState === 'running' ? 'Checking…' : testState === 'ok' ? 'Done ✓' : testState === 'error' ? 'Failed' : 'Run check now (test)'}
        </button>
        {testDetail && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: testState === 'error' ? '#e05a5a' : 'var(--text-dim)' }}>
            {testDetail}
          </span>
        )}
      </div>
      <p className="settings-page-sub" style={{ marginTop: 0, marginBottom: 20, fontStyle: 'italic' }}>
        This button really posts to Front and really logs the action — it is not a dry run. That's how you validate
        accuracy before flipping "Auto-post daily" on above.
      </p>

      <BalancesTable key={`bal-${facility}`} facility={facility} refreshKey={refreshKey} />
      <RecentActionsLog key={`log-${facility}`} facility={facility} refreshKey={refreshKey} />
    </div>
  )
}
