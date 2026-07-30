import { useEffect, useState } from 'react'
import { fetchNotifySettings, upsertNotifySettings, triggerDigestTest } from '../../lib/supabase.js'
import { FEFO_PROJECTS } from '../../lib/fefo.js'

// FefoReallocationAlertSettings — added 2026-07-26 per Dean/Bry's Slack
// feedback (relayed via Dan): flag when a batch/lot allocated to an order
// gets cancelled and reallocated to a DIFFERENT (usually newer) lot without
// the office being notified — the exact gap that let the 7/22-vs-7/23 date
// code mixup ship before anyone caught it. Scoped to all FEFO projects
// EXCEPT JDF (Dan's explicit call, 2026-07-26) — JDF is a backward-looking
// closed-order retrospective audit, not a live allocation feed, so the
// "was allocated, got cancelled, got reallocated" event doesn't apply to it
// the same way.
//
// Deliberately a SEPARATE settings section from FefoNotifySettings (in
// FefoRotationTab.jsx), not folded into it — this posts an urgent,
// real-time alert (polls every ~30 min, whenever the detection function
// finds a new cancel+reallocate event whose age gap crosses the FEFO tab's
// own severity bands — critical >=4 days, warning 1-3, matching
// SEVERITY_THRESHOLDS in fefo.js, confirmed with Dan 2026-07-26), not a
// once-a-day status digest. Mixing the two risked exactly the kind of miss
// Bry described: routine nightly noise burying something that needs
// same-day eyes.
//
// CORRECTED 2026-07-26 (later, same day): the first version of this
// section reused the shared NotifySettingsPanel component as-is (same one
// every other digest on this tab uses), with the mismatch (its "Send
// time"/"Send on: days" controls don't apply to a continuously-polling
// alert) only called out in a description line. Dan flagged via screenshot
// that this reads as straightforwardly misleading in practice — a schedule
// picker sitting right there implies it does something — not just an
// edge-case caveat worth a footnote. Fixed by building a purpose-built
// minimal panel (RealtimeAlertPanel, below) instead of describing around
// the problem: Front conversation ID field + Enabled toggle + Save +
// "Send test alert now" only, no time/day controls at all. Built as a new
// component rather than forking NotifySettingsPanel itself, since that
// component is shared by 6 other (real, once-daily) digests and any change
// there risks all of them.
//
// Moved into this companion file the same day, after the first version
// pushed FefoRotationTab.jsx to ~65KB — past this project's documented
// fragile-push threshold (~50-60KB). Same pattern as
// SpacePlanningTab.jsx/SpaceStackingExceptions.jsx: new logic goes into a
// companion module once the main file approaches that size, rather than
// growing it further.
//
// Still uses the same prepick_notify_settings table/rows
// (dashboard_type=`fefo_realloc_<projectId>`, 8 rows seeded 2026-07-26,
// composite key with facility) and the same
// fetchNotifySettings/upsertNotifySettings/triggerDigestTest helpers from
// supabase.js every other digest on this tab uses — RealtimeAlertPanel just
// omits notifyHour/notifyMinute/notifyDays/skipToNextValidDay from what it
// reads and writes, so those columns keep whatever the row's DB defaults
// already are rather than being blanked out or faked in the UI.
//
// functionName points at fefo-lot-reallocation-alert-test (2026-07-30, was
// fefo-lot-reallocation-alert) — Netlify blocks direct HTTP invocation of
// any function carrying a `schedule`, which is what
// fefo-lot-reallocation-alert.cjs still has (it's the scheduled ~30-min
// tick). See lib/fefo-realloc-shared.cjs's header for the full story —
// same fix as the nightly digest's test button. The scheduled check itself
// is unaffected; only where the manual-test button points.
export default function FefoReallocationAlertSettings() {
  const [open, setOpen] = useState(false)
  const btnStyle = {
    background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text-primary)', fontSize: 11, fontFamily: 'var(--font-mono)',
    padding: '4px 10px', cursor: 'pointer',
  }
  const projects = FEFO_PROJECTS.filter(p => !p.closedOrders) // excludes JDF
  return (
    <div>
      <button type="button" style={btnStyle} onClick={() => setOpen(o => !o)}>
        {open ? 'Hide lot reallocation alerts' : 'FEFO lot reallocation alerts (per customer)'}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 4 }}>
            Urgent, real-time alert — not a daily digest, and not on a schedule you set. Checks every
            ~30 min and fires the moment a batch allocated to an order is cancelled and a different lot
            (crossing the same critical/warning age thresholds as the tab above) gets allocated in its
            place.
          </div>
          {projects.map(p => (
            <div key={p.id} style={{
              border: '1px solid var(--border)', borderLeft: `3px solid ${p.color}`,
              borderRadius: 'var(--r-md, 8px)', padding: '8px 12px',
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: p.color,
                fontFamily: 'var(--font-mono, ui-monospace, monospace)', marginBottom: 4,
              }}>{p.code} · {p.name}</div>
              <RealtimeAlertPanel
                facility={p.facility}
                dashboardType={`fefo_realloc_${p.id}`}
                functionName="fefo-lot-reallocation-alert-test"
                manualTestBody={{ dashboardType: `fefo_realloc_${p.id}` }}
                description={`Posts an urgent alert for ${p.name} the moment a lot allocated to an order gets cancelled and replaced with a different lot.`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// RealtimeAlertPanel — minimal notify-settings panel for continuously-polling
// alerts (see file header above for the full story on why this replaced a
// NotifySettingsPanel reuse). Deliberately NOT a fork of NotifySettingsPanel
// — no Send time / Send on controls at all, since there's nothing here for
// them to configure. Only Front conversation ID + Enabled toggle, which is
// everything this kind of alert actually needs.
//
// Reads/writes the same prepick_notify_settings row via the same
// fetchNotifySettings/upsertNotifySettings helpers every other digest on
// this tab uses, but only ever touches frontConversationId + active —
// notifyHour/notifyMinute/notifyDays/skipToNextValidDay are simply omitted
// from the upsert payload (upsertNotifySettings only sets columns present
// in the object it's given), so those columns keep whatever the row's
// defaults already are rather than being blanked out or faked in the UI.
function RealtimeAlertPanel({ facility, dashboardType, functionName, manualTestBody = {}, description }) {
  const [open, setOpen] = useState(false)
  const [conversationId, setConversationId] = useState('')
  const [conversationIdSaved, setConversationIdSaved] = useState('')
  const [active, setActive] = useState(true)
  const [activeSaved, setActiveSaved] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [sendingTest, setSendingTest] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchNotifySettings(facility, dashboardType)
      .then(row => {
        if (cancelled) return
        const id = row?.front_conversation_id || ''
        const isActive = row?.active ?? true
        setConversationId(id)
        setConversationIdSaved(id)
        setActive(isActive)
        setActiveSaved(isActive)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [facility, dashboardType])

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      await upsertNotifySettings(facility, dashboardType, {
        frontConversationId: conversationId.trim(),
        active,
      })
      setConversationIdSaved(conversationId.trim())
      setActiveSaved(active)
      setMsg({ err: false, text: 'Saved.' })
    } catch (e) {
      setMsg({ err: true, text: e.message || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    setSendingTest(true)
    setMsg(null)
    try {
      const result = await triggerDigestTest(functionName, manualTestBody)
      if (result?.success) {
        setMsg({ err: false, text: 'Sent — test alert posted.' })
      } else {
        setMsg({ err: true, text: result?.reason || 'Alert did not send.' })
      }
    } catch (e) {
      setMsg({ err: true, text: e.message || 'Send failed.' })
    } finally {
      setSendingTest(false)
    }
  }

  const dirty = conversationId.trim() !== conversationIdSaved || active !== activeSaved

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
    <div>
      <button type="button" style={btnStyle} onClick={() => setOpen(o => !o)}>
        {open ? 'Hide alert settings' : 'Alert settings'}
      </button>
      {open && (
        <div style={{
          marginTop: 8, background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '12px 16px', fontSize: 11, fontFamily: 'var(--font-mono)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            <label style={{ color: 'var(--text-secondary)' }}>Front conversation ID for this alert</label>
            <input
              type="text"
              placeholder="cnv_xxxxxxxx"
              value={conversationId}
              onChange={e => setConversationId(e.target.value)}
              style={{ ...selectStyle, width: 220 }}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
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
              {sendingTest ? 'Sending…' : 'Send test alert now'}
            </button>
          </div>
          {msg && (
            <div style={{ marginTop: 8, color: msg.err ? '#e05a5a' : 'var(--text-secondary)' }}>
              {msg.text}
            </div>
          )}
          <div style={{ marginTop: 8, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {description} Checks continuously (~30 min) when Enabled — there's no time or day to set;
            it fires whenever it finds a qualifying event, any day, any hour.
          </div>
        </div>
      )}
    </div>
  )
}
