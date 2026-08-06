import { useState, useEffect, useCallback } from 'react'
import {
  fetchAllScorecardConfigs, updateScorecardPromptStyle, updateScorecardActive,
  triggerScorecardDraftTest,
} from '../../lib/customerScorecard.js'

// Scorecard Drafts tab — added 2026-08-06 per Dan's ask: "build the tab
// within the UI so that I can see and test the prompt." Bernatello's-only
// pilot (see lib/scorecard-draft-shared.cjs on the backend for the full
// design writeup). Deliberately simple for this first pass — view/edit the
// prompt style, see the read-only config that drives detection + metrics,
// and run a real test draft against a known Front conversation. No
// customer picker/multi-row management yet since there's only one
// customer_scorecard_config row (bernatellos) as of this build.

function ConfigField({ label, value, mono }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontFamily: mono ? 'var(--font-mono)' : 'inherit', color: 'var(--text-primary, #fff)' }}>
        {value == null || value === '' ? '—' : String(value)}
      </div>
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

  if (configs.length === 0) {
    return (
      <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0' }}>
        No customer_scorecard_config rows found. Seed a row via SQL before this tab has anything to show.
      </div>
    )
  }

  return (
    <div>
      {/* Customer selector — currently just Bernatello's, but built as a
          list so extending to more customers later doesn't need new UI. */}
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
          </button>
        ))}
      </div>

      {selected && (
        <>
          {/* Read-only config — what drives detection + metrics. Editing
              these needs a SQL change for now (dashboard_id, project
              filters, etc. are precise identifiers, not free text worth
              risking a UI typo on for a one-customer pilot). */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div className="chart-header">
              <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Config (read-only)</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, padding: '4px 0' }}>
              <ConfigField label="Omni Dashboard ID" value={selected.omni_dashboard_id} mono />
              <ConfigField label="MotherDuck Project Filter" value={selected.project_name_contains} mono />
              <ConfigField label="Warehouse Name" value={selected.warehouse_name} mono />
              <ConfigField label="Facility" value={selected.facility} mono />
              <ConfigField label="Case Pick Accuracy Included" value={selected.include_case_pick_accuracy ? 'Yes' : 'No'} />
              <ConfigField label="Front Subject Match" value={selected.front_subject_contains} mono />
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

          {/* Prompt style editor — the actual "see and test the prompt" ask. */}
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
                style={{
                  padding: '6px 16px', borderRadius: 'var(--r-md)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--brand, #a07818)', color: '#fff',
                  fontSize: 12, fontWeight: 600,
                  cursor: saving || promptDraft === (selected.prompt_style || '') ? 'default' : 'pointer',
                  opacity: saving || promptDraft === (selected.prompt_style || '') ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save Prompt'}
              </button>
              {savedAt && <span style={{ fontSize: 11, color: 'var(--green)' }}>Saved {savedAt.toLocaleTimeString()}</span>}
              {saveErr && <span style={{ fontSize: 11, color: 'var(--red)' }}>Error: {saveErr}</span>}
            </div>
          </div>

          {/* Manual test — creates a REAL Front draft and really calls
              Claude. Not a dry run. See scorecard-draft-test.cjs. */}
          <div className="chart-card">
            <div className="chart-header">
              <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>Test the Prompt</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', margin: '4px 0 10px' }}>
              Not a dry run — this creates a real Front draft on the conversation below and really calls the Claude API.
              Point it at a known past scorecard conversation (e.g. a real Bernatello's "YTD OTT Scorecard" thread ID from Front).
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                value={testConversationId}
                onChange={(e) => setTestConversationId(e.target.value)}
                placeholder="Front conversation ID (e.g. cnv_1c1dcmvo)"
                style={{
                  flex: 1, minWidth: 240, fontFamily: 'var(--font-mono)', fontSize: 12,
                  padding: '7px 10px', borderRadius: 'var(--r-md)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg2, transparent)', color: 'inherit',
                }}
              />
              <button
                onClick={handleRunTest}
                disabled={testRunning || !testConversationId.trim()}
                style={{
                  padding: '7px 16px', borderRadius: 'var(--r-md)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--brand, #a07818)', color: '#fff',
                  fontSize: 12, fontWeight: 600,
                  cursor: testRunning || !testConversationId.trim() ? 'default' : 'pointer',
                  opacity: testRunning || !testConversationId.trim() ? 0.5 : 1,
                }}
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
    </div>
  )
}
