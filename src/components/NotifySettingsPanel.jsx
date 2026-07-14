import { useState, useEffect, useCallback } from 'react'
import { fetchNotifySettings, upsertNotifySettings, triggerDigestTest } from '../lib/supabase.js'

// Shared Notify Settings panel — added 2026-07-14, factored out of
// PrePickStatus.jsx's original inline panel (2026-07-13) so the same UI
// backs both the Madison Pre-Pick Status digest and the new WR Cases To
// Pick digest, per Dan's "just as we did in Madison" request. Also adds
// the configurable send-time controls Dan asked for on both tabs — see
// netlify/functions/prepick-digest-run.cjs's file header for how the
// scheduled function actually honors this (netlify.toml cron ticks every
// 15 min; the function itself checks the current America/Chicago time
// against notify_hour/notify_minute stored here).
//
// facility + dashboardType identify the row in prepick_notify_settings
// (composite key as of 2026-07-14). functionName is the Netlify function
// to hit for a manual test send ('prepick-digest-run' or
// 'wr-cases-digest-run'). digestDescription is the one-line explainer
// shown under the controls, customized per caller.
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const MINUTE_BUCKETS = [0, 15, 30, 45]

function hourLabel(h) {
  const period = h >= 12 ? 'PM' : 'AM'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve}:00 ${period}`
}

export default function NotifySettingsPanel({ facility, dashboardType, functionName, digestDescription }) {
  const [open, setOpen] = useState(false)
  const [conversationId, setConversationId] = useState('')
  const [conversationIdSaved, setConversationIdSaved] = useState('')
  const [notifyHour, setNotifyHour] = useState(22)
  const [notifyMinute, setNotifyMinute] = useState(15)
  const [active, setActive] = useState(true)
  const [saved, setSaved] = useState({ notifyHour: 22, notifyMinute: 15, active: true })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [sendingTest, setSendingTest] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchNotifySettings(facility, dashboardType)
      .then(row => {
        if (cancelled) return
        const id = row?.front_conversation_id || ''
        const hour = row?.notify_hour ?? 22
        const minute = row?.notify_minute ?? 15
        const isActive = row?.active ?? true
        setConversationId(id)
        setConversationIdSaved(id)
        setNotifyHour(hour)
        setNotifyMinute(minute)
        setActive(isActive)
        setSaved({ notifyHour: hour, notifyMinute: minute, active: isActive })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [facility, dashboardType])

  const save = useCallback(async () => {
    setSaving(true)
    setMsg(null)
    try {
      await upsertNotifySettings(facility, dashboardType, {
        frontConversationId: conversationId.trim(),
        notifyHour, notifyMinute, active,
      })
      setConversationIdSaved(conversationId.trim())
      setSaved({ notifyHour, notifyMinute, active })
      setMsg({ err: false, text: 'Saved.' })
    } catch (e) {
      setMsg({ err: true, text: e.message || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }, [facility, dashboardType, conversationId, notifyHour, notifyMinute, active])

  const sendTest = useCallback(async () => {
    setSendingTest(true)
    setMsg(null)
    try {
      const result = await triggerDigestTest(functionName)
      if (result?.success) {
        setMsg({ err: false, text: `Sent — comment posted for ${result.date}.` })
      } else {
        setMsg({ err: true, text: result?.reason || 'Digest did not send.' })
      }
    } catch (e) {
      setMsg({ err: true, text: e.message || 'Send failed.' })
    } finally {
      setSendingTest(false)
    }
  }, [functionName])

  const dirty = conversationId.trim() !== conversationIdSaved
    || notifyHour !== saved.notifyHour
    || notifyMinute !== saved.notifyMinute
    || active !== saved.active

  const btnStyle = {
    background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text-primary)', fontSize: 11, fontFamily: 'var(--font-mono)',
    padding: '4px 10px', cursor: 'pointer',
  }
  const selectStyle = {
    background: 'var(--bg0)', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text-primary)', fontSize: 11, fontFamily: 'var(--font-mono)',
    padding: '3px 6px',
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <button type="button" style={btnStyle} onClick={() => setOpen(o => !o)}>
        {open ? 'Hide notify settings' : 'Notify settings'}
      </button>

      {open && (
        <div style={{
          marginTop: 8, background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '12px 16px', fontSize: 11, fontFamily: 'var(--font-mono)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            <label style={{ color: 'var(--text-secondary)' }}>Front conversation ID for nightly digest</label>
            <input
              type="text"
              placeholder="cnv_xxxxxxxx"
              value={conversationId}
              onChange={e => setConversationId(e.target.value)}
              style={{ ...selectStyle, width: 220 }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <label style={{ color: 'var(--text-secondary)' }}>Send time (Central):</label>
            <select value={notifyHour} onChange={e => setNotifyHour(Number(e.target.value))} style={selectStyle}>
              {HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
            <select value={Math.floor(notifyMinute / 15) * 15} onChange={e => setNotifyMinute(Number(e.target.value))} style={selectStyle}>
              {MINUTE_BUCKETS.map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
              Enabled
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" style={btnStyle} onClick={save} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              style={btnStyle}
              onClick={sendTest}
              disabled={sendingTest || !conversationIdSaved}
              title={!conversationIdSaved ? 'Save a conversation ID first' : ''}
            >
              {sendingTest ? 'Sending…' : 'Send test digest now'}
            </button>
          </div>

          {msg && (
            <div style={{ marginTop: 8, color: msg.err ? '#e05a5a' : 'var(--text-secondary)' }}>
              {msg.text}
            </div>
          )}

          <div style={{ marginTop: 8, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {digestDescription} Fires automatically at the time above (Central) when Enabled is checked. "Send test digest now" fires immediately for tomorrow's date regardless of the time/enabled setting.
          </div>
        </div>
      )}
    </div>
  )
}
