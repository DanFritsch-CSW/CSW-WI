import { useState, useEffect } from 'react'

// HRPasswordGate — client-side password screen shared by all HR tabs
// (Recruiting, 30/60/90 Check-Ins, and future ones: Active Leave,
// Disciplinary Action, Referral Bonus). Replaces the earlier per-tab
// RecruitingPasswordGate (2026-07-24) — Dan/Tim's 2026-08-07 HR call
// explicitly framed this as one "HR section" password, not one per tracker.
//
// Same lightweight pattern throughout the app: no backend, one shared
// password, unlock remembered via localStorage per browser/device.
//   - LIMITATION: gates the page shell only. The password lives in the JS
//     bundle, and it does NOT protect the underlying sharepoint-*.cjs
//     Netlify function endpoints — those remain directly callable by URL
//     regardless of this gate. Fine for keeping casual browsers off
//     sensitive tabs; not real access control. Tim flagged this data
//     (FMLA status, disciplinary actions) as sensitive enough to want a
//     stronger password than the app's other tabs — if it needs to be
//     properly locked down, move to real auth (Netlify Visitor Access or
//     a login system).
//
// To change the password: edit PASSWORD below and redeploy. Bump the
// STORAGE_KEY suffix to force everyone to re-enter after a change.

const PASSWORD = 'csw' // TODO(Dan): replace with the stronger password from the 8/7 HR call
const STORAGE_KEY = 'hr_gate_unlocked_v1'

export default function HRPasswordGate({ children }) {
  const [unlocked, setUnlocked] = useState(false)
  const [checked, setChecked]   = useState(false)
  const [input, setInput]       = useState('')
  const [err, setErr]           = useState(false)

  useEffect(() => {
    let ok = false
    try { ok = localStorage.getItem(STORAGE_KEY) === 'true' } catch (_) {}
    setUnlocked(ok)
    setChecked(true)
  }, [])

  function handleSubmit(e) {
    e.preventDefault()
    if (input === PASSWORD) {
      try { localStorage.setItem(STORAGE_KEY, 'true') } catch (_) {}
      setUnlocked(true)
      setErr(false)
    } else {
      setErr(true)
    }
  }

  if (!checked) return null
  if (unlocked) return children

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg0, #f3f5f8)',
      fontFamily: "'Syne', system-ui, sans-serif",
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: 'var(--bg1, #fff)',
          padding: '40px 36px',
          borderRadius: 8,
          boxShadow: '0 2px 16px rgba(0,0,0,0.08)',
          width: 320,
          textAlign: 'center',
          border: '1px solid var(--border, #dce2ec)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--brand, #a07818)', letterSpacing: '0.08em', marginBottom: 4, textTransform: 'uppercase' }}>
          CSW HR
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #4b5a72)', marginBottom: 24 }}>
          This section is password protected
        </div>
        <input
          type="password"
          autoFocus
          value={input}
          onChange={(e) => { setInput(e.target.value); setErr(false) }}
          placeholder="Password"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 14,
            border: `1px solid ${err ? '#c0392b' : '#dce2ec'}`,
            borderRadius: 4,
            boxSizing: 'border-box',
            marginBottom: 12,
            outline: 'none',
          }}
        />
        {err && (
          <div style={{ fontSize: 12, color: '#c0392b', marginBottom: 12, marginTop: -4 }}>
            Incorrect password
          </div>
        )}
        <button
          type="submit"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 14,
            fontWeight: 700,
            background: 'var(--brand, #a07818)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Enter
        </button>
      </form>
    </div>
  )
}
