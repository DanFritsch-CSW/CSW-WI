// src/components/customers/ExpCheckNotifySettings.jsx
//
// EXP Check nightly digest settings — added 2026-08-02, per Dan's ask for
// a notify element "similar to the FEFO tab" (per-project settings rows,
// each with its own Front conversation/send time, not one combined
// digest per customer). Split into its own file rather than growing
// ExpCheckTab.jsx further (same file-size hygiene pattern as
// FefoReallocationAlerts.jsx/SpaceStackingExceptions.jsx).
//
// Uses the shared NotifySettingsPanel component (same one FEFO/Pre-Pick/
// Cases/Daily Ops/WR Pick Check use) — a real once-daily digest with a
// configurable send time, not a continuous alert, so this is NOT the
// stripped-down RealtimeAlertPanel pattern FEFO's lot-reallocation alert
// uses. contentDateLabel="today" since this is a live status check with
// no forecast lead-time (same reasoning as FEFO's own digest).
import { useState } from 'react'
import NotifySettingsPanel from '../NotifySettingsPanel.jsx'
import { EXP_CHECK_PROJECTS, EXP_CHECK_CUSTOMERS } from '../../lib/expCheck.js'

const CUSTOMER_COLOR = { pretzilla: '#a07818', bernatellos: '#5b9bd5' }

export default function ExpCheckNotifySettings() {
  const [open, setOpen] = useState(false)
  const btnStyle = {
    background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text-primary)', fontSize: 11, fontFamily: 'var(--font-mono)',
    padding: '4px 10px', cursor: 'pointer',
  }
  return (
    <div style={{ marginTop: 16 }}>
      <button type="button" style={btnStyle} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide notify settings' : 'Notify settings (per project)'}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {EXP_CHECK_CUSTOMERS.map((c) => (
            <div key={c.key}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: CUSTOMER_COLOR[c.key] || 'var(--text-primary)',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)', marginBottom: 4,
              }}>
                {c.label}
              </div>
              {EXP_CHECK_PROJECTS.filter((p) => p.customer === c.key).map((p) => (
                <div key={p.id} style={{
                  border: '1px solid var(--border)', borderLeft: `3px solid ${CUSTOMER_COLOR[c.key] || 'var(--border)'}`,
                  borderRadius: 'var(--r-md, 8px)', padding: '8px 12px', marginBottom: 6,
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)', marginBottom: 4,
                  }}>{p.code} · {p.name}</div>
                  <NotifySettingsPanel
                    facility={p.facility}
                    dashboardType={`exp_check_${p.key}`}
                    functionName="exp-check-digest-test"
                    manualTestBody={{ dashboardType: `exp_check_${p.key}` }}
                    contentDateLabel="today"
                    showSkipToNextValidDay={false}
                    digestDescription={`Posts Julian Mismatch, EXP Mismatch, No Shelf Life, and Relabeled counts for ${p.name} to Front.`}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
