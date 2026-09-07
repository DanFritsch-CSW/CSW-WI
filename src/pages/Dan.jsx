import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchKnownCustomersForFacility } from '../lib/spacePlanning.js'
import { fetchFootprintTargets, upsertFootprintTarget, deleteFootprintTarget } from '../lib/danFootprint.js'
import { fetchNotifySettings, upsertNotifySettings, triggerDigestTest } from '../lib/supabase.js'

// /dan — Dan's private area for personal automations/dashboards. Not linked
// in TopNav (App.jsx's NO_TOPNAV_ROUTES also hides the nav shell on this
// route) — reached only by knowing the URL, same "URL obscurity is the only
// barrier" posture as /dpimonthly (Dan, 2026-09-05). Add a real password
// gate later if this needs to be locked down further.
//
// First module: Madison Active LPs by customer/project vs. a manually-set
// Projected Footprint that persists until Dan changes it. Active LPs are
// live (Omni, via fetchKnownCustomersForFacility — same path the Customer
// Stacking dropdown already uses); Projected Footprint + which projects are
// tracked live in dan_footprint_targets (add/remove supported).
//
// Notify is NOT the shared NotifySettingsPanel pattern (that posts into one
// fixed, pre-existing Front conversation) — per Dan's explicit ask, this
// creates a BRAND NEW Front discussion every time it fires, addressed only
// to him (front_teammates tea_a3e8k, via notification_recipients list_name
// 'dan_footprint_variance'). Mirrors front-daily-discussion-run.cjs's
// pattern rather than prepick-digest-run.cjs's. Backed by the existing
// prepick_notify_settings table (facility='dan', dashboard_type=
// 'footprint_variance') — no schema change needed, front_conversation_id
// just stays unused/null for this row, same as other inert-column cases
// elsewhere in that table.

const FACILITY = 'mad'
const DASHBOARD_TYPE = 'footprint_variance'
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const MINUTE_BUCKETS = [0, 15, 30, 45]
const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' }, { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 7, label: 'Sun' },
]
const DEFAULT_DAYS = [1, 2, 3, 4, 5]

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

function sameDays(a, b) {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every(d => setB.has(d))
}

function varianceClass(v, projected) {
  if (v >= 0) return 'pos'
  const pctOff = projected ? Math.abs(v) / projected : 0
  return pctOff > 0.1 ? 'neg' : 'warn'
}

export default function Dan() {
  const [liveLps, setLiveLps] = useState(null) // Map<name, lps> | null while loading
  const [liveError, setLiveError] = useState(null)
  const [liveFetchedAt, setLiveFetchedAt] = useState(null)
  const [allProjects, setAllProjects] = useState([]) // [{name, lps}] full live list, for add dropdown
  const [targets, setTargets] = useState([]) // dan_footprint_targets rows
  const [loading, setLoading] = useState(true)

  const [editingProject, setEditingProject] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(null)

  const [adding, setAdding] = useState(false)
  const [newProject, setNewProject] = useState('')
  const [newFootprint, setNewFootprint] = useState('')
  const [addErr, setAddErr] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [rows, liveResult] = await Promise.all([
      fetchFootprintTargets(FACILITY),
      fetchKnownCustomersForFacility(FACILITY),
    ])
    setTargets(rows)
    if (liveResult == null) {
      setLiveError('Live Datex fetch failed — Active LPs may be stale or unavailable.')
      setLiveLps(new Map())
      setAllProjects([])
    } else {
      setLiveError(null)
      setLiveLps(new Map(liveResult.map(p => [p.name, p.lps])))
      setAllProjects(liveResult)
      setLiveFetchedAt(new Date().toISOString())
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const rows = useMemo(() => {
    return targets.map(t => ({
      projectName: t.project_name,
      activeLps: liveLps?.get(t.project_name) ?? 0,
      projected: Number(t.projected_footprint) || 0,
    }))
  }, [targets, liveLps])

  const trackedNames = useMemo(() => new Set(targets.map(t => t.project_name)), [targets])
  const availableToAdd = useMemo(
    () => allProjects.filter(p => !trackedNames.has(p.name)).sort((a, b) => b.lps - a.lps),
    [allProjects, trackedNames]
  )

  function startEdit(row) {
    setEditingProject(row.projectName)
    setEditValue(String(row.projected))
  }

  async function saveEdit(projectName) {
    const val = Number(editValue)
    if (!Number.isNaN(val)) {
      const result = await upsertFootprintTarget(FACILITY, projectName, val)
      if (result.success) {
        setTargets(prev => prev.map(t => t.project_name === projectName ? { ...t, projected_footprint: val } : t))
      }
    }
    setEditingProject(null)
  }

  async function removeRow(projectName) {
    const result = await deleteFootprintTarget(FACILITY, projectName)
    if (result.success) {
      setTargets(prev => prev.filter(t => t.project_name !== projectName))
    }
    setConfirmRemove(null)
  }

  async function addRow() {
    setAddErr(null)
    if (!newProject || newFootprint === '') { setAddErr('Pick a project and enter a footprint.'); return }
    const result = await upsertFootprintTarget(FACILITY, newProject, Number(newFootprint))
    if (!result.success) { setAddErr(result.error || 'Could not add project.'); return }
    setTargets(prev => [...prev, result.row].sort((a, b) => a.project_name.localeCompare(b.project_name)))
    setAdding(false)
    setNewProject('')
    setNewFootprint('')
  }

  return (
    <div className="dan-root">
      <style>{STYLES}</style>

      <div className="dan-topbar">
        <div className="dan-badge">D</div>
        <div className="dan-topbar-text">
          <div className="dan-topbar-title">DAN / OPS HUB</div>
          <div className="dan-topbar-sub">csw-wi.netlify.app/dan</div>
        </div>
        <div className="dan-private-tag">Private · not in main nav</div>
      </div>

      <div className="dan-content">
        <div className="dan-page-header">
          <div>
            <div className="dan-page-title">Madison — Active LPs by Customer</div>
            <div className="dan-page-sub">Live Datex count vs. manual projected footprint</div>
          </div>
          <div className="dan-fresh">
            <span className={`dan-fresh-dot ${liveError ? 'err' : ''}`} />
            {loading ? 'Loading…' : liveError ? liveError : `LIVE · synced ${new Date(liveFetchedAt).toLocaleTimeString()}`}
          </div>
        </div>

        <div className="dan-table-wrap">
          <div className="dan-row-header">
            <div>Customer / Project</div>
            <div style={{ textAlign: 'right' }}>Active LPs</div>
            <div style={{ textAlign: 'right' }}>Projected Footprint</div>
            <div style={{ textAlign: 'right' }}>Variance</div>
            <div />
          </div>

          {!loading && rows.length === 0 && (
            <div style={{ padding: '18px 16px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              No projects tracked yet — add one below.
            </div>
          )}

          {rows.map(row => {
            const variance = row.activeLps - row.projected
            const vClass = varianceClass(variance, row.projected)
            const isEditing = editingProject === row.projectName

            return (
              <div className="dan-row" key={row.projectName}>
                <div className="dan-project-name">{row.projectName}</div>
                <div className="dan-num strong">{row.activeLps.toLocaleString()}</div>

                {isEditing ? (
                  <input
                    className="dan-edit-input"
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveEdit(row.projectName)}
                  />
                ) : (
                  <div
                    className="dan-num dan-edit-trigger"
                    onClick={() => startEdit(row)}
                    title="Click to edit projected footprint"
                  >
                    {row.projected.toLocaleString()}
                  </div>
                )}

                <div className={`dan-variance ${vClass}`}>
                  {variance >= 0 ? '+' : ''}
                  {variance.toLocaleString()}
                </div>

                {confirmRemove === row.projectName ? (
                  <div className="dan-confirm-remove">
                    <span>Remove?</span>
                    <button className="dan-icon-btn remove" onClick={() => removeRow(row.projectName)}>Yes</button>
                    <button className="dan-icon-btn" onClick={() => setConfirmRemove(null)}>No</button>
                  </div>
                ) : (
                  <div className="dan-edit-actions">
                    {isEditing ? (
                      <button className="dan-icon-btn save" onClick={() => saveEdit(row.projectName)}>Save</button>
                    ) : (
                      <button className="dan-icon-btn" onClick={() => startEdit(row)}>Edit</button>
                    )}
                    <button className="dan-icon-btn remove" onClick={() => setConfirmRemove(row.projectName)}>Remove</button>
                  </div>
                )}
              </div>
            )
          })}

          {adding && (
            <div className="dan-add-form">
              <select className="dan-select" value={newProject} onChange={e => setNewProject(e.target.value)}>
                <option value="">Select a project…</option>
                {availableToAdd.map(p => (
                  <option key={p.name} value={p.name}>
                    {p.name} ({p.lps.toLocaleString()} LPs live)
                  </option>
                ))}
              </select>
              <input
                className="dan-add-input"
                placeholder="Projected footprint"
                value={newFootprint}
                onChange={e => setNewFootprint(e.target.value)}
              />
              <button className="dan-icon-btn save" onClick={addRow}>Save</button>
              <button className="dan-icon-btn" onClick={() => { setAdding(false); setAddErr(null) }}>Cancel</button>
            </div>
          )}
          {addErr && <div style={{ padding: '6px 16px', color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{addErr}</div>}
        </div>

        {!adding && (
          <button className="dan-add-row-btn" onClick={() => setAdding(true)}>
            + Add customer / project
          </button>
        )}

        <FootprintNotifyPanel />

        <div className="dan-footnote">
          Active LPs: live Datex query for Madison (Omni, same path as the Customer Stacking dropdown).
          Projected Footprint + tracked-project list: dan_footprint_targets (Supabase). Notify: creates a
          brand-new Front discussion on the schedule below, addressed only to Dan — see
          dan-footprint-digest-shared.cjs.
        </div>
      </div>
    </div>
  )
}

function FootprintNotifyPanel() {
  const [open, setOpen] = useState(false)
  const [notifyHour, setNotifyHour] = useState(7)
  const [notifyMinute, setNotifyMinute] = useState(0)
  const [notifyDays, setNotifyDays] = useState(DEFAULT_DAYS)
  const [active, setActive] = useState(false)
  const [saved, setSaved] = useState({ notifyHour: 7, notifyMinute: 0, notifyDays: DEFAULT_DAYS, active: false })
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchNotifySettings('dan', DASHBOARD_TYPE).then(row => {
      if (cancelled) return
      const hour = row?.notify_hour ?? 7
      const minute = row?.notify_minute ?? 0
      const days = row?.notify_days ?? DEFAULT_DAYS
      const isActive = row?.active ?? false
      setNotifyHour(hour); setNotifyMinute(minute); setNotifyDays(days); setActive(isActive)
      setSaved({ notifyHour: hour, notifyMinute: minute, notifyDays: days, active: isActive })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const toggleDay = useCallback((n) => {
    setNotifyDays(prev => prev.includes(n) ? prev.filter(d => d !== n) : [...prev, n].sort())
  }, [])

  const dirty = notifyHour !== saved.notifyHour
    || notifyMinute !== saved.notifyMinute
    || !sameDays(notifyDays, saved.notifyDays)
    || active !== saved.active

  async function save() {
    setSaving(true); setMsg(null)
    try {
      await upsertNotifySettings('dan', DASHBOARD_TYPE, {
        frontConversationId: '', // unused for this dashboard_type — new thread every send
        notifyHour, notifyMinute, notifyDays, active, skipToNextValidDay: false,
      })
      setSaved({ notifyHour, notifyMinute, notifyDays, active })
      setMsg({ err: false, text: 'Saved.' })
    } catch (e) {
      setMsg({ err: true, text: e.message || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  async function createNow() {
    setCreating(true); setMsg(null)
    try {
      const result = await triggerDigestTest('dan-footprint-digest-run', {})
      if (result?.success) {
        setMsg({ err: false, text: 'Thread created — check Front.' })
      } else {
        setMsg({ err: true, text: result?.reason || 'Did not create a thread.' })
      }
    } catch (e) {
      setMsg({ err: true, text: e.message || 'Failed.' })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <button className="dan-notify-btn" onClick={() => setOpen(o => !o)}>
        {open ? 'Hide notify settings' : 'Notify settings'}
      </button>

      {open && (
        <div className="dan-notify-panel">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            <label className="dan-notify-label">Recipient</label>
            <span className="dan-recipient-pill">👤 Dan Fritsch — only me</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <label className="dan-notify-label">Trigger time (Central):</label>
            <select className="dan-select" value={notifyHour} onChange={e => setNotifyHour(Number(e.target.value))}>
              {HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
            <select className="dan-select" value={Math.floor(notifyMinute / 15) * 15} onChange={e => setNotifyMinute(Number(e.target.value))}>
              {MINUTE_BUCKETS.map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
            </select>
            <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              → {resolvedTimeLabel(notifyHour, notifyMinute)}
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', cursor: 'pointer', marginLeft: 8 }}>
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
              Enabled
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            <label className="dan-notify-label">Trigger on:</label>
            {DAYS.map(d => (
              <button
                key={d.n}
                type="button"
                className={`dan-day-btn ${notifyDays.includes(d.n) ? 'on' : ''}`}
                onClick={() => toggleDay(d.n)}
              >
                {d.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="dan-icon-btn save" onClick={save} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="dan-icon-btn" onClick={createNow} disabled={creating}>
              {creating ? 'Creating…' : 'Create thread now'}
            </button>
          </div>

          {msg && (
            <div style={{ marginTop: 8, color: msg.err ? 'var(--red)' : 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {msg.text}
            </div>
          )}

          <div style={{ marginTop: 10, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            At the time above on the checked days (Central), creates a brand-new Front discussion — not
            posted to an existing thread — with the current Active LPs / Projected Footprint / Variance
            table, addressed only to Dan. "Create thread now" fires immediately regardless of the schedule.
          </div>
        </div>
      )}
    </div>
  )
}

const STYLES = `
  .dan-root * { box-sizing: border-box; }
  .dan-root {
    background: var(--bg0); color: var(--text-primary); font-family: var(--font-display);
    font-size: 14px; line-height: 1.5; min-height: 100vh; padding-bottom: 60px;
  }
  .dan-topbar {
    display: flex; align-items: center; gap: 12px; padding: 0 24px; height: 56px;
    background: var(--bg1); border-bottom: 2px solid var(--brand-dim);
  }
  .dan-badge {
    width: 34px; height: 34px; border-radius: var(--r-sm); background: var(--brand);
    display: flex; align-items: center; justify-content: center; color: #fff;
    font-weight: 800; font-size: 15px; flex-shrink: 0;
  }
  .dan-topbar-text { display: flex; flex-direction: column; gap: 1px; }
  .dan-topbar-title { font-weight: 800; font-size: 16px; letter-spacing: 0.10em; color: var(--brand); }
  .dan-topbar-sub {
    font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.12em; color: var(--text-dim);
    text-transform: uppercase;
  }
  .dan-private-tag {
    margin-left: auto; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em;
    color: var(--text-dim); text-transform: uppercase; border: 1px solid var(--border);
    border-radius: 20px; padding: 3px 10px; background: var(--bg2);
  }
  .dan-content { padding: 20px 24px 0; max-width: 980px; margin: 0 auto; }

  .dan-page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
    padding: 4px 0 16px; border-bottom: 1px solid var(--border-subtle); margin-bottom: 18px; }
  .dan-page-title { font-size: 18px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; }
  .dan-page-sub { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim);
    letter-spacing: 0.06em; text-transform: uppercase; margin-top: 3px; }
  .dan-fresh { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 10px;
    color: var(--text-dim); }
  .dan-fresh-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green);
    box-shadow: 0 0 5px var(--green); }
  .dan-fresh-dot.err { background: var(--red); box-shadow: 0 0 5px var(--red); }

  .dan-table-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--r-xl);
    overflow: hidden; margin-bottom: 14px; }
  .dan-row-header, .dan-row {
    display: grid; grid-template-columns: 1fr 130px 150px 120px 130px; align-items: center;
    padding: 9px 16px; gap: 10px;
  }
  .dan-row-header { font-family: var(--font-mono); font-size: 9px; color: var(--text-dim);
    text-transform: uppercase; letter-spacing: 0.08em; background: var(--bg1);
    border-bottom: 1px solid var(--border-subtle); }
  .dan-row { border-bottom: 1px solid var(--border-subtle); transition: background 0.1s; }
  .dan-row:last-child { border-bottom: none; }
  .dan-row:hover { background: var(--bg3); }
  .dan-project-name { font-size: 13px; font-weight: 600; }
  .dan-num { font-family: var(--font-mono); font-size: 13px; text-align: right; color: var(--text-secondary); }
  .dan-num.strong { color: var(--text-primary); font-weight: 600; }
  .dan-variance { font-family: var(--font-mono); font-size: 13px; font-weight: 700; text-align: right;
    padding: 2px 8px; border-radius: 10px; justify-self: end; }
  .dan-variance.pos { color: var(--green); background: #edfaf4; border: 1px solid #a8dfc4; }
  .dan-variance.neg { color: var(--red); background: #fdf0f0; border: 1px solid #f0aaaa; }
  .dan-variance.warn { color: var(--yellow); background: var(--brand-bg); border: 1px solid var(--brand-dim); }

  .dan-edit-input { width: 96px; font-family: var(--font-mono); font-size: 12px; background: var(--bg1);
    border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--text-primary); padding: 4px 8px;
    text-align: right; outline: none; }
  .dan-edit-input:focus { border-color: var(--brand); }
  .dan-edit-actions { display: flex; gap: 4px; justify-self: end; }
  .dan-icon-btn { font-family: var(--font-mono); font-size: 10px; padding: 3px 8px; border-radius: var(--r-sm);
    border: 1px solid var(--border); background: var(--bg1); color: var(--text-secondary); cursor: pointer; }
  .dan-icon-btn:hover { background: var(--bg4); color: var(--text-primary); }
  .dan-icon-btn.save { border-color: var(--brand-dim); color: var(--brand); background: var(--brand-bg); }
  .dan-icon-btn.remove { border-color: #f0aaaa; color: var(--red); background: transparent; }
  .dan-icon-btn.remove:hover { background: #fdf0f0; }
  .dan-icon-btn:disabled { opacity: 0.5; cursor: default; }
  .dan-edit-trigger { cursor: pointer; border-bottom: 1px dashed var(--brand); }
  .dan-edit-trigger:hover { opacity: 0.75; }

  .dan-add-row-btn { font-family: var(--font-mono); font-size: 11px; padding: 6px 14px; border-radius: var(--r-md);
    border: 1px solid var(--brand-dim); background: var(--brand-bg); color: var(--brand); cursor: pointer;
    margin-bottom: 24px; }
  .dan-add-row-btn:hover { background: var(--bg3); color: var(--brand-light); }

  .dan-add-form { display: grid; grid-template-columns: 1fr 130px auto auto; gap: 10px; align-items: center;
    padding: 10px 16px; background: var(--bg3); border-bottom: 1px solid var(--border-subtle); }
  .dan-select, .dan-add-input { font-family: var(--font-mono); font-size: 12px; background: var(--bg1);
    border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--text-primary); padding: 5px 8px; }
  .dan-add-input { text-align: right; }

  .dan-notify-btn { font-family: var(--font-mono); font-size: 11px; padding: 5px 12px; border-radius: var(--r-md);
    border: 1px solid var(--border); background: var(--bg2); color: var(--text-primary); cursor: pointer; }
  .dan-notify-btn:hover { background: var(--bg3); }
  .dan-notify-panel { margin-top: 10px; background: var(--bg2); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px 18px; font-size: 11px; font-family: var(--font-mono); }
  .dan-notify-label { color: var(--text-secondary); }
  .dan-day-btn { font-family: var(--font-mono); font-size: 10px; font-weight: 700; padding: 3px 9px;
    border-radius: 4px; border: 1px solid var(--border); background: var(--bg0); color: var(--text-dim);
    cursor: pointer; }
  .dan-day-btn.on { background: var(--brand); color: #fff; border-color: var(--brand); }
  .dan-recipient-pill { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono);
    font-size: 11px; color: var(--brand); background: var(--brand-bg); border: 1px solid var(--brand-dim);
    border-radius: 20px; padding: 3px 12px; width: fit-content; }
  .dan-confirm-remove { display: flex; align-items: center; gap: 6px; justify-self: end; }
  .dan-confirm-remove span { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); }
  .dan-footnote { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); line-height: 1.6;
    margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
`
