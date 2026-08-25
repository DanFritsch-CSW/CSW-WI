import { useState, useEffect, useCallback } from 'react'
import {
  fetchAllScorecardConfigs, updateScorecardPromptStyle, updateScorecardActive,
  updateScorecardConfigField, insertScorecardConfig, triggerScorecardDraftTest,
  triggerDashboardCoverageCheck,
} from '../../lib/customerScorecard.js'

// Scorecard Drafts tab — added 2026-08-06 per Dan's ask: "build the tab
// within the UI so that I can see and test the prompt." Bernatello's-only
// pilot at first (see lib/scorecard-draft-shared.cjs on the backend for
// the full design writeup).
//
// EXTENDED 2026-08-06 (later same day), "Add Customer" ask: config fields
// are now editable inline (not just prompt style), and a new customer can
// be added entirely from this tab — no dev/Claude session needed, AS LONG
// AS the new customer's scorecard only needs metrics this app already
// computes (OTT 2hr/3hr, Case Pick Accuracy, Carrier % On-Time Arrival —
// all from motherduck-scorecard-metrics.cjs).
//
// Warehouse names are a fixed dropdown, not free text — confirmed live via
// Omni (gold__truck_appointments) that exactly 5 values exist: CSW-Eau
// Claire, CSW-Franksville, CSW-Kenosha, CSW-Madison, CSW-Wisconsin Rapids.
//
// front_inbox_name (added 2026-08-24) — the PRIMARY detection field. Must
// be the EXACT Front inbox name a customer's scorecard emails land in,
// and that inbox must be a SHARED one the app connection can actually
// read — not a personal/restricted inbox.
//
// to_recipients / cc_recipients / reviewer_emails (added 2026-08-25) —
// per Dan's ask: "we also need to add a place to TO, CC contact points
// for this email draft -- and a place for us to 'notify' within Front the
// different humans that need to review before sending." Real, load-
// bearing fields: confirmed live on a real Grassland draft
// (cnv_1c84haz8) that WITHOUT to_recipients set, the draft's actual
// recipients defaulted to Omni's own delivery address + our own internal
// inbox — never the real customer. If to_recipients is empty, this tab
// shows a warning identical in severity to the missing-inbox one.
// reviewer_emails adds Front teammates as conversation FOLLOWERS (not an
// inline @mention — see scorecard-draft-shared.cjs for why) so the right
// humans get notified to review before sending.
//
// Dashboard Coverage Check (added 2026-08-25, "Option B") — Dan asked
// whether the app could show which of a customer's real Omni dashboard
// metrics are actually available to the prompt, after Claude correctly
// declined to speculate about a day-by-day breakdown it wasn't given.
// Calls omni-dashboard-coverage.cjs, which live-reads the dashboard's
// real tiles and flags which ones this app doesn't compute a metric for.
// First real run (Grassland) found 12 real tiles against ~4 metrics this
// app computes — including a tile that looks like a leftover from a
// different customer's dashboard template.

const WAREHOUSE_OPTIONS = [
  { warehouseName: 'CSW-Franksville',      facility: 'cal' },
  { warehouseName: 'CSW-Kenosha',          facility: 'ken' },
  { warehouseName: 'CSW-Madison',          facility: 'mad' },
  { warehouseName: 'CSW-Wisconsin Rapids', facility: 'wr' },
  { warehouseName: 'CSW-Eau Claire',       facility: 'ec' },
]

const inputStyle = {
  width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-mono)', fontSize: 12,
  padding: '6px 10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border-subtle)',
  background: 'var(--bg2, transparent)', color: 'inherit',
}
const labelStyle = {
  fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase',
  letterSpacing: '0.04em', marginBottom: 4, display: 'block',
}
const primaryBtnStyle = (disabled) => ({
  padding: '6px 16px', borderRadius: 'var(--r-md)', border: '1px solid var(--border-subtle)',
  background: 'var(--brand, #a07818)', color: '#fff', fontSize: 12, fontWeight: 600,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
})
const warningBoxStyle = {
  marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--r-md)',
  border: '1px solid var(--red)', background: 'rgba(220,50,50,0.08)',
  fontSize: 12, color: 'var(--red)',
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  )
}

// EditableConfigField — a single config value with inline edit-and-save.
// Text fields get a plain input; warehouse gets the fixed dropdown (also
// drives facility automatically); case pick accuracy gets a checkbox.
function EditableConfigField({ label, field, value, customerKey, type = 'text', placeholder, onSaved }) {
  const [draft, setDraft] = useState(value ?? (type === 'checkbox' ? false : ''))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => { setDraft(value ?? (type === 'checkbox' ? false : '')) }, [value])

  const dirty = type === 'checkbox' ? draft !== !!value : draft !== (value ?? '')

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      if (field === 'warehouse_name') {
        const match = WAREHOUSE_OPTIONS.find((w) => w.warehouseName === draft)
        await updateScorecardConfigField(customerKey, 'warehouse_name', draft)
        if (match) await updateScorecardConfigField(customerKey, 'facility', match.facility)
        onSaved({ warehouse_name: draft, facility: match?.facility ?? null })
      } else {
        await updateScorecardConfigField(customerKey, field, draft)
        onSaved({ [field]: draft })
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>{label}</label>
      {type === 'checkbox' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!draft} onChange={(e) => setDraft(e.target.checked)} />
          Included
        </label>
      ) : type === 'select' ? (
        <select value={draft} onChange={(e) => setDraft(e.target.value)} style={inputStyle}>
          <option value="">— select —</option>
          {WAREHOUSE_OPTIONS.map((w) => (
            <option key={w.warehouseName} value={w.warehouseName}>{w.warehouseName}</option>
          ))}
        </select>
      ) : (
        <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} style={inputStyle} placeholder={placeholder} />
      )}
      {dirty && (
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...primaryBtnStyle(saving), padding: '3px 10px', fontSize: 11 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {err && <span style={{ fontSize: 11, color: 'var(--red)' }}>{err}</span>}
        </div>
      )}
    </div>
  )
}

// AddCustomerForm — collapsible, creates a new customer_scorecard_config
// row. Always inserted active=false.
function AddCustomerForm({ onAdded }) {
  const [open, setOpen] = useState(false)
  const [customerKey, setCustomerKey] = useState('')
  const [customerLabel, setCustomerLabel] = useState('')
  const [omniDashboardId, setOmniDashboardId] = useState('')
  const [projectNameContains, setProjectNameContains] = useState('')
  const [warehouseName, setWarehouseName] = useState('')
  const [includeCasePickAccuracy, setIncludeCasePickAccuracy] = useState(false)
  const [frontSubjectContains, setFrontSubjectContains] = useState('')
  const [frontInboxName, setFrontInboxName] = useState('')
  const [toRecipients, setToRecipients] = useState('')
  const [ccRecipients, setCcRecipients] = useState('')
  const [reviewerEmails, setReviewerEmails] = useState('')
  const [promptStyle, setPromptStyle] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  function reset() {
    setCustomerKey(''); setCustomerLabel(''); setOmniDashboardId('')
    setProjectNameContains(''); setWarehouseName(''); setIncludeCasePickAccuracy(false)
    setFrontSubjectContains(''); setFrontInboxName('')
    setToRecipients(''); setCcRecipients(''); setReviewerEmails('')
    setPromptStyle(''); setErr(null)
  }

  async function handleCreate() {
    setSaving(true)
    setErr(null)
    try {
      const match = WAREHOUSE_OPTIONS.find((w) => w.warehouseName === warehouseName)
      const row = await insertScorecardConfig({
        customerKey, customerLabel, omniDashboardId, projectNameContains,
        warehouseName, facility: match?.facility, includeCasePickAccuracy,
        frontSubjectContains, frontInboxName,
        toRecipients, ccRecipients, reviewerEmails, promptStyle,
      })
      reset()
      setOpen(false)
      onAdded(row)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  const canCreate = customerKey.trim() && customerLabel.trim() && projectNameContains.trim()
    && warehouseName && frontSubjectContains.trim()

  return (
    <div style={{ marginBottom: 20 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: '8px 16px', borderRadius: 'var(--r-md)', border: '1px dashed var(--border-subtle)',
          background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
        }}
      >
        {open ? '− Cancel' : '+ Add Customer'}
      </button>

      {open && (
        <div className="chart-card" style={{ marginTop: 10 }}>
          <div className="chart-header">
            <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>New Customer</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 12px' }}>
            Only covers metrics this app already computes (OTT, Case Pick Accuracy, Carrier % On-Time Arrival). A customer needing a new metric type still needs that built once first.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Field label="Customer Key (unique, e.g. mccain)">
              <input type="text" value={customerKey} onChange={(e) => setCustomerKey(e.target.value)} style={inputStyle} placeholder="mccain" />
            </Field>
            <Field label="Customer Label (display name)">
              <input type="text" value={customerLabel} onChange={(e) => setCustomerLabel(e.target.value)} style={inputStyle} placeholder="McCain Foods" />
            </Field>
            <Field label="Omni Dashboard ID">
              <input type="text" value={omniDashboardId} onChange={(e) => setOmniDashboardId(e.target.value)} style={inputStyle} placeholder="aa9ac42a" />
            </Field>
            <Field label="MotherDuck Project Filter">
              <input type="text" value={projectNameContains} onChange={(e) => setProjectNameContains(e.target.value)} style={inputStyle} placeholder="McCain" />
            </Field>
            <Field label="Warehouse">
              <select value={warehouseName} onChange={(e) => setWarehouseName(e.target.value)} style={inputStyle}>
                <option value="">— select —</option>
                {WAREHOUSE_OPTIONS.map((w) => (
                  <option key={w.warehouseName} value={w.warehouseName}>{w.warehouseName}</option>
                ))}
              </select>
            </Field>
            <Field label="Case Pick Accuracy">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={includeCasePickAccuracy} onChange={(e) => setIncludeCasePickAccuracy(e.target.checked)} />
                Include this metric
              </label>
            </Field>
            <Field label="Front Subject Match">
              <input type="text" value={frontSubjectContains} onChange={(e) => setFrontSubjectContains(e.target.value)} style={inputStyle} placeholder="McCain YTD OTT Scorecard" />
            </Field>
            <Field label="Front Inbox Name (must be a SHARED inbox)">
              <input type="text" value={frontInboxName} onChange={(e) => setFrontInboxName(e.target.value)} style={inputStyle} placeholder="Madison" />
            </Field>
            <Field label="To Recipients (real customer emails, comma-separated)">
              <input type="text" value={toRecipients} onChange={(e) => setToRecipients(e.target.value)} style={inputStyle} placeholder="jsmith@customer.com, ops@customer.com" />
            </Field>
            <Field label="CC Recipients (comma-separated, optional)">
              <input type="text" value={ccRecipients} onChange={(e) => setCcRecipients(e.target.value)} style={inputStyle} placeholder="manager@customer.com" />
            </Field>
            <Field label="Reviewer Emails (Front teammates to notify, comma-separated)">
              <input type="text" value={reviewerEmails} onChange={(e) => setReviewerEmails(e.target.value)} style={inputStyle} placeholder="ayoung@csw-wi.com" />
            </Field>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
            Route this customer's Omni scorecard email to a SHARED Front inbox before setting Front Inbox Name — a personal/restricted inbox will silently fail to draft.
            To Recipients must be the real customer's own email address(es) — without it the draft has no recipients at all (safe default, but won't send until filled in).
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>Prompt Style (tone/emphasis guidance — can refine later)</label>
            <textarea
              value={promptStyle}
              onChange={(e) => setPromptStyle(e.target.value)}
              rows={4}
              style={{ ...inputStyle, lineHeight: 1.5, resize: 'vertical' }}
              placeholder="Write in the voice of a warehouse GM writing directly to a long-standing customer contact..."
            />
          </div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={handleCreate} disabled={saving || !canCreate} style={primaryBtnStyle(saving || !canCreate)}>
              {saving ? 'Creating…' : 'Create Customer (inactive)'}
            </button>
            {err && <span style={{ fontSize: 11, color: 'var(--red)' }}>{err}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// DashboardCoverageCheck — collapsible panel, live-reads the selected
// customer's Omni dashboard and shows which real tiles this app doesn't
// compute a metric for. Requires omni_dashboard_id to be set. See
// omni-dashboard-coverage.cjs for the full design writeup and matching
// heuristic (simple keyword matching, not a full semantic mapping).
function DashboardCoverageCheck({ dashboardId }) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)

  async function handleCheck() {
    setRunning(true)
    setResult(null)
    setErr(null)
    try {
      const res = await triggerDashboardCoverageCheck(dashboardId)
      setResult(res)
    } catch (e) {
      setErr(e.message)
    } finally {
      setRunning(false)
    }
  }

  if (!dashboardId) {
    return (
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-header">
          <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Dashboard Coverage</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '4px 0' }}>
          Set an Omni Dashboard ID above to check which of this customer's real dashboard metrics this app currently computes.
        </div>
      </div>
    )
  }

  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div className="chart-header">
        <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Dashboard Coverage</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', margin: '4px 0 10px' }}>
        Live-reads this customer's real Omni dashboard and flags tiles this app doesn't currently compute a metric for — so a gap
        (like a day-by-day breakdown, or a metric Claude has no data for) shows up here instead of by accident in a real draft.
        Matching is simple keyword-based (OTT, carrier, case pick/audit) — a tile flagged "not covered" may still be fine, this is a
        starting point for review, not a definitive answer.
      </div>
      <button onClick={handleCheck} disabled={running} style={primaryBtnStyle(running)}>
        {running ? 'Checking…' : 'Check Dashboard Coverage'}
      </button>
      {err && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>Error: {err}</div>}
      {result && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {result.totalTiles} tile(s) on the dashboard — {result.coveredCount} likely covered, {result.notCoveredCount} not covered / needs review.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {result.tiles.map((tile, i) => (
              <div
                key={tile.id || i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  borderRadius: 'var(--r-md)', border: '1px solid var(--border-subtle)',
                  background: tile.covered ? 'transparent' : 'rgba(220,50,50,0.06)',
                }}
              >
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, flexShrink: 0,
                  background: tile.covered ? 'var(--green)' : 'var(--red)', color: '#fff',
                }}>
                  {tile.covered ? 'COVERED' : 'NOT COVERED'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-primary, #fff)' }}>{tile.name}</span>
                {tile.matchedCategory && (
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>({tile.matchedCategory})</span>
                )}
                {tile.url && (
                  <a href={tile.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--brand, #a07818)', marginLeft: 'auto' }}>
                    View in Omni
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function ScorecardDraftsTab() {
  const [configs, setConfigs] = useState(null)
  const [selectedKey, setSelectedKey] = useState(null)
  const [promptDraft, setPromptDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const [activeSaving, setActiveSaving] = useState(false)

  const [testConversationId, setTestConversationId] = useState('')
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testErr, setTestErr] = useState(null)

  const load = useCallback(async () => {
    const rows = await fetchAllScorecardConfigs()
    setConfigs(rows)
    if (rows.length && !selectedKey) setSelectedKey(rows[0].customer_key)
    const current = rows.find((r) => r.customer_key === (selectedKey || rows[0]?.customer_key))
    if (current) setPromptDraft(current.prompt_style || '')
  }, [selectedKey])

  useEffect(() => { load() }, [load])

  const selected = (configs || []).find((c) => c.customer_key === selectedKey)

  function handleSelect(key) {
    setSelectedKey(key)
    const c = (configs || []).find((r) => r.customer_key === key)
    setPromptDraft(c?.prompt_style || '')
    setSaveErr(null)
    setSavedAt(null)
    setTestResult(null)
    setTestErr(null)
  }

  function handleFieldSaved(patch) {
    setConfigs((prev) => prev.map((c) => (c.customer_key === selected.customer_key ? { ...c, ...patch } : c)))
  }

  async function handleCustomerAdded(row) {
    await load()
    if (row?.customer_key) handleSelect(row.customer_key)
  }

  async function handleSavePrompt() {
    if (!selected) return
    setSaving(true)
    setSaveErr(null)
    try {
      await updateScorecardPromptStyle(selected.customer_key, promptDraft)
      setSavedAt(new Date())
      setConfigs((prev) => prev.map((c) => (c.customer_key === selected.customer_key ? { ...c, prompt_style: promptDraft } : c)))
    } catch (e) {
      setSaveErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleActive() {
    if (!selected) return
    setActiveSaving(true)
    try {
      const next = !selected.active
      await updateScorecardActive(selected.customer_key, next)
      setConfigs((prev) => prev.map((c) => (c.customer_key === selected.customer_key ? { ...c, active: next } : c)))
    } catch (e) {
      setSaveErr(e.message)
    } finally {
      setActiveSaving(false)
    }
  }

  async function handleRunTest() {
    if (!selected || !testConversationId.trim()) return
    setTestRunning(true)
    setTestResult(null)
    setTestErr(null)
    try {
      const result = await triggerScorecardDraftTest(selected.customer_key, testConversationId.trim())
      setTestResult(result)
    } catch (e) {
      setTestErr(e.message)
    } finally {
      setTestRunning(false)
    }
  }

  if (configs === null) {
    return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0' }}>Loading…</div>
  }

  return (
    <div>
      <AddCustomerForm onAdded={handleCustomerAdded} />

      {configs.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0' }}>
          No customers configured yet — use "+ Add Customer" above to create the first one.
        </div>
      ) : (
        <>
          {/* Customer selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
            {configs.map((c) => (
              <button
                key={c.customer_key}
                onClick={() => handleSelect(c.customer_key)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 'var(--r-md)',
                  border: c.customer_key === selectedKey ? '1px solid var(--brand, #a07818)' : '1px solid var(--border-subtle)',
                  background: c.customer_key === selectedKey ? 'var(--brand-bg, #fef9ec)' : 'transparent',
                  color: c.customer_key === selectedKey ? 'var(--brand, #a07818)' : 'var(--text-secondary)',
                  fontSize: 13,
                  fontWeight: c.customer_key === selectedKey ? 600 : 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {c.customer_label}
                <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 10,
                  background: c.active ? 'var(--green)' : 'var(--bg3)',
                  color: c.active ? '#fff' : 'var(--text-dim)',
                }}>
                  {c.active ? 'ACTIVE' : 'INACTIVE'}
                </span>
                {!c.front_inbox_name && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: 'var(--red)', color: '#fff' }}>
                    NO INBOX SET
                  </span>
                )}
                {!c.to_recipients && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: 'var(--red)', color: '#fff' }}>
                    NO RECIPIENTS SET
                  </span>
                )}
              </button>
            ))}
          </div>

          {selected && (
            <>
              {!selected.front_inbox_name && (
                <div style={warningBoxStyle}>
                  No Front Inbox Name set — the scheduled auto-draft will fall back to a full-text search
                  that has NEVER successfully found a real production email for this feature. Set Front
                  Inbox Name below (must be a SHARED inbox the app can read) before relying on the
                  schedule for this customer.
                </div>
              )}
              {!selected.to_recipients && (
                <div style={warningBoxStyle}>
                  No To Recipients set — confirmed live that without this, the draft's recipients default
                  to Omni's own delivery address and our own internal inbox, NEVER the real customer.
                  Set To Recipients below before sending any draft for this customer.
                </div>
              )}

              {/* Editable config */}
              <div className="chart-card" style={{ marginBottom: 20 }}>
                <div className="chart-header">
                  <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Config</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, padding: '4px 0' }}>
                  <EditableConfigField
                    label="Omni Dashboard ID" field="omni_dashboard_id" value={selected.omni_dashboard_id}
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                  />
                  <EditableConfigField
                    label="MotherDuck Project Filter" field="project_name_contains" value={selected.project_name_contains}
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                  />
                  <EditableConfigField
                    label="Warehouse" field="warehouse_name" value={selected.warehouse_name} type="select"
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                  />
                  <EditableConfigField
                    label="Case Pick Accuracy Included" field="include_case_pick_accuracy" value={selected.include_case_pick_accuracy} type="checkbox"
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                  />
                  <EditableConfigField
                    label="Front Subject Match" field="front_subject_contains" value={selected.front_subject_contains}
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                  />
                  <EditableConfigField
                    label="Front Inbox Name (must be SHARED)" field="front_inbox_name" value={selected.front_inbox_name}
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                  />
                  <EditableConfigField
                    label="To Recipients (real customer emails)" field="to_recipients" value={selected.to_recipients}
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                    placeholder="jsmith@customer.com, ops@customer.com"
                  />
                  <EditableConfigField
                    label="CC Recipients (optional)" field="cc_recipients" value={selected.cc_recipients}
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                    placeholder="manager@customer.com"
                  />
                  <EditableConfigField
                    label="Reviewer Emails (Front teammates to notify)" field="reviewer_emails" value={selected.reviewer_emails}
                    customerKey={selected.customer_key} onSaved={handleFieldSaved}
                    placeholder="ayoung@csw-wi.com"
                  />
                  <Field label="Facility (auto-set from Warehouse)">
                    <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text-primary, #fff)', padding: '6px 0' }}>
                      {selected.facility || '—'}
                    </div>
                  </Field>
                </div>
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    onClick={handleToggleActive}
                    disabled={activeSaving}
                    style={{
                      padding: '6px 14px', borderRadius: 'var(--r-md)',
                      border: '1px solid var(--border-subtle)',
                      background: selected.active ? 'var(--red)' : 'var(--green)',
                      color: '#fff', fontSize: 12, fontWeight: 600, cursor: activeSaving ? 'default' : 'pointer',
                      opacity: activeSaving ? 0.6 : 1,
                    }}
                  >
                    {activeSaving ? 'Saving…' : selected.active ? 'Deactivate' : 'Activate (enables scheduled auto-drafting)'}
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    Active controls the scheduled */15 run only — the manual test below always works regardless.
                  </span>
                </div>
              </div>

              {/* Dashboard Coverage Check */}
              <DashboardCoverageCheck dashboardId={selected.omni_dashboard_id} />

              {/* Prompt style editor */}
              <div className="chart-card" style={{ marginBottom: 20 }}>
                <div className="chart-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Prompt Style</span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    Tone/emphasis guidance only — metrics come from MotherDuck/Omni, not this text
                  </span>
                </div>
                <textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  rows={10}
                  style={{
                    width: '100%', boxSizing: 'border-box', marginTop: 8,
                    fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5,
                    padding: 10, borderRadius: 'var(--r-md)',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg2, transparent)', color: 'inherit',
                    resize: 'vertical',
                  }}
                />
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    onClick={handleSavePrompt}
                    disabled={saving || promptDraft === (selected.prompt_style || '')}
                    style={primaryBtnStyle(saving || promptDraft === (selected.prompt_style || ''))}
                  >
                    {saving ? 'Saving…' : 'Save Prompt'}
                  </button>
                  {savedAt && <span style={{ fontSize: 11, color: 'var(--green)' }}>Saved {savedAt.toLocaleTimeString()}</span>}
                  {saveErr && <span style={{ fontSize: 11, color: 'var(--red)' }}>Error: {saveErr}</span>}
                </div>
              </div>

              {/* Manual test */}
              <div className="chart-card">
                <div className="chart-header">
                  <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Test the Prompt</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', margin: '4px 0 10px' }}>
                  Not a dry run — this creates a real Front draft on the conversation below and really calls the Claude API.
                  Point it at a known past scorecard conversation for this customer (a real Front thread ID).
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={testConversationId}
                    onChange={(e) => setTestConversationId(e.target.value)}
                    placeholder="Front conversation ID (e.g. cnv_1c1dcmvo)"
                    style={{ ...inputStyle, flex: 1, minWidth: 240, padding: '7px 10px' }}
                  />
                  <button
                    onClick={handleRunTest}
                    disabled={testRunning || !testConversationId.trim()}
                    style={primaryBtnStyle(testRunning || !testConversationId.trim())}
                  >
                    {testRunning ? 'Running…' : 'Run Test Draft'}
                  </button>
                </div>

                {testErr && (
                  <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>Error: {testErr}</div>
                )}

                {testResult && (
                  <div style={{ marginTop: 12, padding: 12, borderRadius: 'var(--r-md)', border: '1px solid var(--border-subtle)' }}>
                    {testResult.ok ? (
                      <>
                        <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600, marginBottom: 6 }}>
                          Draft created — open it in Front to review/edit/send: {testResult.draftId}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
                          Week of {testResult.weekStart} to {testResult.weekEndExclusive} · {testResult.flaggedContextCount} flagged thread line(s)
                        </div>
                        <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                          {testResult.draftPreview}{testResult.draftPreview?.length >= 300 ? '…' : ''}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--red)' }}>
                        Failed: {testResult.reason}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
