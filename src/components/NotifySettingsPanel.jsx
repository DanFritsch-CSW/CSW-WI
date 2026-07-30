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
//
// Time-picker clarity fix (2026-07-14, later): Dan flagged that "5:00 PM"
// (hour dropdown) sitting right next to ":15" (minute dropdown) read
// ambiguously — looked like it might mean "5:00:15" rather than 5:15 PM.
// Fixed two ways: (1) the hour dropdown now shows just "5 PM" instead of
// "5:00 PM", removing the stray ":00" that caused the confusion, and
// (2) added a live "→ 5:15 PM" resolved-time readout next to both
// dropdowns so the combined result is unambiguous at a glance.
//
// Day-of-week filter (2026-07-14, even later): Dan wants Mon-Fri only, no
// weekend sends, with a visible day indicator rather than a hidden
// default. Seven toggle buttons (Mon-first display order, ISO weekday
// numbers 1-7 stored in the DB), defaulting to Mon-Fri selected. The
// scheduled function checks this against the CONTENT date (tomorrow), not
// the date it fires on — see prepick-digest-run.cjs's "Weekday filter"
// note for why.
//
// Skip-to-next-valid-day checkbox (2026-07-14, still later): Dan's
// follow-up — for a Mon-Fri facility, Friday night computes Saturday as
// content date, which isn't checked, so nothing sends until Sunday night
// (covering Monday). Two dead nights. New opt-in checkbox lets the
// scheduled function advance forward to the next checked day instead of
// skipping — thinking ahead to facilities that run 7 days/week (where
// this box should stay unchecked, since every day is already valid) vs
// Mon-Fri operations (where checking it closes the Fri/Sat/Sun gap). Off
// by default so nothing changes unless explicitly opted in.
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const MINUTE_BUCKETS = [0, 15, 30, 45]
const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' }, { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 7, label: 'Sun' },
]
const DEFAULT_DAYS = [1, 2, 3, 4, 5]

function sameDays(a, b) {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every(d => setB.has(d))
}

function hourLabel(h) {
  const period = h >= 12 ? 'PM' : 'AM'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve} ${period}`
}

function resolvedTimeLabel(h, m) {
  const period = h >= 12 ? 'PM' : 'AM'
  const twelve = h % 12 === 0 ? 12 : h % 12
  const bucket = Math.floor(m / 15) * 15
  return `${twelve}:${String(bucket).padStart(2, '0')} ${period}`
}

// contentDateLabel (added 2026-07-14, FEFO digests) — the appointment-based
// digests (Pre-Pick, Cases, Daily Ops) summarize TOMORROW since they fire
// the night before a shift. FEFO summarizes TODAY (rotation compliance
// right now, no lead-time reason to look ahead) — see fefo-digest-run.cjs
// header. Defaults to 'tomorrow' so existing callers are unaffected.
//
// manualTestBody (added 2026-07-14, FEFO per-project digests) — optional
// extra POST body merged into the manual-test call. Needed when
// functionName backs multiple settings rows sharing one Netlify function
// (fefo-digest-run.cjs backs one row per FEFO project) so the manual test
// can say which row to run, e.g. { dashboardType: 'fefo_faioa5' }. Omit for
// single-row digests (Pre-Pick, Cases To Pick, Daily Ops) — defaults to {}.
//
// showSkipToNextValidDay (added 2026-07-14, FEFO digests) — hides the
// lookahead checkbox for digests where content date === fire date (FEFO),
// since "skip to next valid day" only makes sense when content date is
// offset from the fire date (the appointment-based digests). Defaults to
// true so existing callers are unaffected.
//
// children (added 2026-07-30, Dock Counts fold-in) — optional extra
// content rendered INSIDE this same collapsible dropdown, below the
// Save/Send-test-now controls. Added because Dan wanted Dock Counts to
// live inside the Daily Ops digest's own "Notify settings" dropdown
// (same expand/collapse, same conversation/toggle) rather than as a
// separate always-visible section on the page. Only rendered when the
// panel is open, so it shares the exact same collapsed/expanded state as
// the rest of the panel — no separate open/close state to keep in sync.
// Every other caller simply omits this prop and gets identical behavior
// to before.
export default function NotifySettingsPanel({ facility, dashboardType, functionName, digestDescription, manualTestBody = {}, contentDateLabel = 'tomorrow', showSkipToNextValidDay = true, children }) {
  const [open, setOpen] = useState(false)
  const [conversationId, setConversationId] = useState('')
  const [conversationIdSaved, setConversationIdSaved] = useState('')
  const [notifyHour, setNotifyHour] = useState(22)
  const [notifyMinute, setNotifyMinute] = useState(15)
  const [notifyDays, setNotifyDays] = useState(DEFAULT_DAYS)
  const [skipToNextValidDay, setSkipToNextValidDay] = useState(false)
  const [active, setActive] = useState(true)
  const [saved, setSaved] = useState({ notifyHour: 22, notifyMinute: 15, notifyDays: DEFAULT_DAYS, active: true, skipToNextValidDay: false })
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
        const days = row?.notify_days ?? DEFAULT_DAYS
        const isActive = row?.active ?? true
        const skipNext = row?.skip_to_next_valid_day ?? false
        setConversationId(id)
        setConversationIdSaved(id)
        setNotifyHour(hour)
        setNotifyMinute(minute)
        setNotifyDays(days)
        setActive(isActive)
        setSkipToNextValidDay(skipNext)
        setSaved({ notifyHour: hour, notifyMinute: minute, notifyDays: days, active: isActive, skipToNextValidDay: skipNext })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [facility, dashboardType])

  const toggleDay = useCallback((n) => {
    setNotifyDays(prev => prev.includes(n) ? prev.filter(d => d !== n) : [...prev, n].sort())
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    setMsg(null)
    try {
      await upsertNotifySettings(facility, dashboardType, {
        frontConversationId: conversationId.trim(),
        notifyHour, notifyMinute, notifyDays, active, skipToNextValidDay,
      })
      setConversationIdSaved(conversationId.trim())
      setSaved({ notifyHour, notifyMinute, notifyDays, active, skipToNextValidDay })
      setMsg({ err: false, text: 'Saved.' })
    } catch (e) {
      setMsg({ err: true, text: e.message || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }, [facility, dashboardType, conversationId, notifyHour, notifyMinute, notifyDays, active, skipToNextValidDay])

  const sendTest = useCallback(async () => {
    setSendingTest(true)
    setMsg(null)
    try {
      const result = await triggerDigestTest(functionName, manualTestBody)
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
  }, [functionName, manualTestBody])

  const dirty = conversationId.trim() !== conversationIdSaved
    || notifyHour !== saved.notifyHour
    || notifyMinute !== saved.notifyMinute
    || !sameDays(notifyDays, saved.notifyDays)
    || active !== saved.active
    || skipToNextValidDay !== saved.skipToNextValidDay

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
            <span style={{ color: 'var(--text-dim)' }}>
              → {resolvedTimeLabel(notifyHour, notifyMinute)}
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
              Enabled
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            <label style={{ color: 'var(--text-secondary)' }}>Send on:</label>
            {DAYS.map(d => {
              const isOn = notifyDays.includes(d.n)
              return (
                <button
                  key={d.n}
                  type="button"
                  onClick={() => toggleDay(d.n)}
                  style={{
                    ...btnStyle,
                    padding: '3px 8px',
                    background: isOn ? 'var(--accent, #4a7)' : 'var(--bg0)',
                    color: isOn ? '#fff' : 'var(--text-dim)',
                    borderColor: isOn ? 'var(--accent, #4a7)' : 'var(--border)',
                  }}
                >
                  {d.label}
                </button>
              )
            })}
          </div>

          {showSkipToNextValidDay && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={skipToNextValidDay} onChange={e => setSkipToNextValidDay(e.target.checked)} />
                Look ahead to next valid day (e.g. Fri → Mon for Mon-Fri operations)
              </label>
              <div style={{ marginTop: 4, marginLeft: 22, color: 'var(--text-dim)', fontSize: 10, lineHeight: 1.4 }}>
                Off (default): a night whose content date isn't checked above just skips — nothing posts. On: instead of skipping, advances to the next checked day and sends that day's numbers. Leave unchecked for facilities that run every day of the week.
              </div>
            </div>
          )}

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
            {digestDescription} Fires automatically at the time above (Central) on the checked days, when Enabled is checked — the day checked is the date being summarized ({contentDateLabel}), not the night it sends. "Send test digest now" fires immediately for {contentDateLabel}'s date regardless of the time/day/enabled settings.
          </div>

          {children && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
              {children}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
