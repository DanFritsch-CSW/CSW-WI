import { useState, useEffect } from 'react'

// PalermosPasswordGate — simple client-side password screen for the
// standalone Palermo's build (cswpvi.netlify.app).
//
// Hill asked for the URL to be password protected (2026-07-07). This is
// deliberately lightweight rather than real auth:
//   - No backend, no user accounts, one shared password for the whole team.
//   - Once entered correctly, the unlock is remembered in this browser via
//     localStorage — no repeated prompts on the same device.
//   - IMPORTANT LIMITATION: because this is a static site with no server,
//     the password check happens in the browser. Anyone who opens dev
//     tools and reads the JS bundle can find the password string, and the
//     page content itself is not encrypted — someone could theoretically
//     bypass this by disabling JS execution of the check. This stops
//     casual link-sharing / accidental discovery, not a determined
//     attacker. If Palermo's data ever becomes more sensitive than "our
//     own at-risk inventory report," this should move to real server-side
//     auth (e.g. Netlify's paid Visitor Access add-on, or a Netlify
//     Function checking a cookie).
//
// To change the password: edit PASSWORD below and redeploy. Existing
// unlocked sessions stay unlocked (the check only runs when the gate
// isn't already marked unlocked) — bump STORAGE_KEY's suffix if you need
// to force everyone to re-enter after a password change.

const PASSWORD = 'palermos2026'
const STORAGE_KEY = 'pvi_gate_unlocked_v1'

export default function PalermosPasswordGate({ children }) {
  const [unlocked, setUnlocked] = useState(false)
  const [checked, setChecked]   = useState(false) // avoids a flash of the prompt before localStorage is read
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

  if (!checked) return null // brief instant, avoids prompt flicker on repeat visits
  if (unlocked) return children

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f2ee',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: 'white',
          padding: '40px 36px',
          borderRadius: 8,
          boxShadow: '0 2px 16px rgba(0,0,0,0.08)',
          width: 320,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: '#8b1a1a', letterSpacing: '0.02em', marginBottom: 4 }}>
          PALERMO'S
        </div>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 24 }}>
          At Risk Inventory Manager
        </div>
        <input
          type="password"
          autoFocus
          value={input}
          onChange={e => { setInput(e.target.value); setErr(false) }}
          placeholder="Password"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 14,
            border: `1px solid ${err ? '#d1583a' : '#ddd'}`,
            borderRadius: 4,
            boxSizing: 'border-box',
            marginBottom: 12,
            outline: 'none',
          }}
        />
        {err && (
          <div style={{ fontSize: 12, color: '#d1583a', marginBottom: 12, marginTop: -4 }}>
            Incorrect password
          </div>
        )}
        <button
          type="submit"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 14,
            fontWeight: 600,
            background: '#8b1a1a',
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
