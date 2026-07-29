import { useState, useEffect } from 'react'

// ManagerPasswordGate — simple client-side password screen for the Manager
// tab, same pattern as RecruitingPasswordGate / PalermosPasswordGate.
//
// Added 2026-07-28 for the quarterly bonus scorecard build. Password is
// deliberately the same as Recruiting's ('csw') per Dan's explicit request
// "for now" — bump PASSWORD + STORAGE_KEY suffix together if this needs to
// diverge later.
//
// Same limitation as every other gate in this app: this only hides the
// page shell. The JS bundle contains the password string, and it does NOT
// protect any Netlify function endpoints the Manager tab calls (none yet —
// this page is Supabase-only so far). Fine for "keep casual browsers off
// this tab"; not real access control. Move to real auth (Netlify Visitor
// Access or a login system) if this needs to be locked down for real.

const PASSWORD = 'csw'
const STORAGE_KEY = 'manager_gate_unlocked_v1'

export default function ManagerPasswordGate({ children }) {
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
          CSW Manager
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #4b5a72)', marginBottom: 24 }}>
          This tab is password protected
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
