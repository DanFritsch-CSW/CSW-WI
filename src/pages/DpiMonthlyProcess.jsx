import React, { useState, useCallback, useRef, useEffect } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase.js'
import { parseFdp201w, MAX_NAME_LENGTH } from '../lib/dpiMonthlyParser.js'
import { colors, cardStyle } from './dpiMonthly/dpiMonthlyStyles.js'
import Phase2BuildFlag from './dpiMonthly/Phase2BuildFlag.jsx'
import Phase4AgencyComms from './dpiMonthly/Phase4AgencyComms.jsx'
import Phase5FinalPush from './dpiMonthly/Phase5FinalPush.jsx'

// DPI Monthly Process — full pipeline, hidden route (/dpimonthly, see
// src/App.jsx) — not linked from any nav.
//
// This shell owns Phase 1 (import) directly and Supabase-backed cycle
// state/resume logic; Phases 2, 4, 5 are separate components rendered
// based on cycle.current_phase (Phase 3 has no screen — folded into
// Phase 2's capacity flag, per the original design discussion).
//
// State persists in Supabase (dpi_monthly_cycles + dpi_staged_agencies), not
// just React state — a CSR may work this across multiple days and multiple
// sessions, so reopening this page resumes wherever the facility's active
// cycle currently sits. Only one in_progress cycle per facility at a time
// (partial unique index).
//
// AS OF 2026-09-06: Phases 2, 4, 5 are SIMULATE-ONLY — no real Datex
// pushes, no real Front sends, no real PDF generation. Built to let Dan
// click through the entire pipeline UI with real test data before any of
// those integrations are wired up for real. See each phase component's
// header comment for its specific simplifications.
//
// "Start next month" lives ONLY in Phase5FinalPush, at the true end of the
// pipeline — NOT here. An earlier version of this page showed that button
// right after Phase 1, which was wrong (see 2026-09-06 fix): a cycle should
// never be resettable while routes/comms/final push haven't happened yet.
//
// "Reset test cycle" (in the header row below) is a SEPARATE, deliberately
// destructive testing convenience — deletes the whole in_progress cycle
// outright, at any phase, so a test run can be abandoned without dragging
// every agency back into place. Not part of the real workflow; added
// 2026-09-06 specifically for iterating on test data.

const PHASE_LABELS = ['1. Import', '2. Build & flag', '3. Carrier approval', '4. Agency comms', '5. Push final']

function PhasePills({ currentPhase }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
      {PHASE_LABELS.map((label, i) => {
        const phaseNum = i + 1
        const isCurrent = phaseNum === currentPhase
        return (
          <div
            key={label}
            style={{
              fontSize: 13, padding: '6px 12px', borderRadius: 6,
              border: `1px solid ${isCurrent ? colors.accent : colors.border}`,
              color: isCurrent ? colors.accent : colors.textFaint,
              background: isCurrent ? 'rgba(77,141,255,0.08)' : 'transparent',
              opacity: isCurrent ? 1 : 0.55,
            }}
          >
            {label}
          </div>
        )
      })}
    </div>
  )
}

function statusMeta(status) {
  switch (status) {
    case 'queued': return { label: 'Queued', color: colors.textMuted }
    case 'success': return { label: 'Pushed', color: colors.success, bg: colors.successBg }
    case 'duplicate_skipped': return { label: 'Already imported', color: colors.textFaint }
    case 'failed': return { label: 'Failed', color: colors.danger, bg: colors.dangerBg }
    case 'simulated': return { label: 'Simulated — not pushed', color: colors.accent, bg: 'rgba(77,141,255,0.12)' }
    default: return { label: status, color: colors.textMuted }
  }
}

function Badge({ status }) {
  const meta = statusMeta(status)
  return (
    <span style={{
      display: 'inline-block', fontSize: 12, color: meta.color,
      background: meta.bg || 'transparent', padding: '3px 10px', borderRadius: 6,
    }}>
      {meta.label}
    </span>
  )
}

function StatCard({ label, value, tone }) {
  return (
    <div style={{ ...cardStyle, flex: 1, minWidth: 130 }}>
      <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, color: tone || colors.text }}>{value}</div>
    </div>
  )
}

function DropZone({ facility, onFile, disabled }) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)

  return (
    <div
      onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (disabled) return
        const file = e.dataTransfer.files?.[0]
        if (file) onFile(file)
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      style={{
        border: `1.5px dashed ${dragOver ? colors.accent : colors.borderStrong}`,
        borderRadius: 10, padding: '36px 20px', textAlign: 'center',
        background: dragOver ? 'rgba(77,141,255,0.06)' : colors.panelAlt,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        disabled={disabled}
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }}
      />
      <div style={{ fontSize: 14, color: colors.text, marginBottom: 4 }}>
        Drop this month's {facility} FDP201W.csv here
      </div>
      <div style={{ fontSize: 12, color: colors.textFaint }}>or click to browse</div>
    </div>
  )
}

// Maps a dpi_staged_agencies row (Supabase, snake_case) to the shape the
// rest of this component works with (matches dpiMonthlyParser's output).
function rowToAgency(row) {
  return {
    stagedId: row.id,
    agencyNumber: row.agency_number,
    agencyName: row.agency_name,
    firstName: row.first_name,
    nameWasAbbreviated: row.name_was_abbreviated,
    line1: row.line1,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    lookupCode: row.lookup_code,
    lines: row.lines,
  }
}

export default function DpiMonthlyProcess() {
  const [facility, setFacility] = useState('Eau Claire')
  const [loading, setLoading] = useState(true)
  const [stage, setStage] = useState('empty') // empty | parsed | pushing | done (Phase 1 only)
  const [parseError, setParseError] = useState(null)
  const [cycle, setCycle] = useState(null) // dpi_monthly_cycles row
  const [monthKey, setMonthKey] = useState(null)
  const [agencies, setAgencies] = useState([])
  const [editingIdx, setEditingIdx] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [batchRows, setBatchRows] = useState([])
  const [forceSimulate, setForceSimulate] = useState(false)
  const pollRef = useRef(null)

  // Load (or resume) whatever cycle is active for the selected facility.
  const loadCycleState = useCallback(async (fac) => {
    if (!supabase) { setLoading(false); return }
    setLoading(true)

    const { data: cycles, error: cycleErr } = await supabase
      .from('dpi_monthly_cycles')
      .select('*')
      .eq('facility', fac)
      .eq('status', 'in_progress')
      .limit(1)
    if (cycleErr) { console.error('load cycle:', cycleErr); setLoading(false); return }

    const activeCycle = cycles?.[0] || null
    if (!activeCycle) {
      setCycle(null)
      setAgencies([])
      setMonthKey(null)
      setStage('empty')
      setLoading(false)
      return
    }

    setCycle(activeCycle)
    setMonthKey(activeCycle.month_key)

    const { data: staged, error: stagedErr } = await supabase
      .from('dpi_staged_agencies')
      .select('*')
      .eq('cycle_id', activeCycle.id)
      .order('agency_number')
    if (stagedErr) console.error('load staged agencies:', stagedErr)
    setAgencies((staged || []).map(rowToAgency))

    const { data: batch, error: batchErr } = await supabase
      .from('dpi_import_batches')
      .select('*')
      .eq('batch_id', activeCycle.batch_id)
    if (batchErr) console.error('load batch rows:', batchErr)
    setBatchRows(batch || [])

    if (!batch || batch.length === 0) {
      setStage('parsed')
    } else if (batch.every((r) => r.status !== 'queued')) {
      setStage('done')
    } else {
      setStage('pushing')
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadCycleState(facility) }, [facility, loadCycleState])

  const handleFile = useCallback((file) => {
    setParseError(null)
    Papa.parse(file, {
      skipEmptyLines: false,
      complete: async (results) => {
        let parsed
        try {
          parsed = parseFdp201w(results.data)
        } catch (err) {
          setParseError(err.message)
          return
        }
        if (!supabase) { setParseError('Supabase not configured — cannot persist staged agencies.'); return }

        const { data: newCycle, error: cycleErr } = await supabase
          .from('dpi_monthly_cycles')
          .insert({ facility, month_key: parsed.monthKey })
          .select()
          .single()
        if (cycleErr) {
          console.error('create cycle:', cycleErr)
          setParseError('Could not start a new cycle — reloading current state.')
          loadCycleState(facility)
          return
        }

        const { data: insertedRows, error: insertErr } = await supabase
          .from('dpi_staged_agencies')
          .insert(parsed.agencies.map((a) => ({
            cycle_id: newCycle.id,
            agency_number: a.agencyNumber,
            agency_name: a.agencyName,
            first_name: a.firstName,
            name_was_abbreviated: a.nameWasAbbreviated,
            line1: a.line1,
            city: a.city,
            state: a.state,
            postal_code: a.postalCode,
            lookup_code: a.lookupCode,
            lines: a.lines,
          })))
          .select()
        if (insertErr) {
          console.error('insert staged agencies:', insertErr)
          setParseError(`Parsed but failed to save: ${insertErr.message}`)
          return
        }

        setCycle(newCycle)
        setMonthKey(newCycle.month_key)
        setAgencies((insertedRows || []).map(rowToAgency))
        setBatchRows([])
        setStage('parsed')
      },
      error: (err) => setParseError(err.message),
    })
  }, [facility, loadCycleState])

  const startEdit = (idx) => {
    setEditingIdx(idx)
    setEditValue(agencies[idx].firstName)
  }

  const saveEdit = async (idx) => {
    const agency = agencies[idx]
    setAgencies((prev) => prev.map((a, i) => (i === idx ? { ...a, firstName: editValue } : a)))
    setEditingIdx(null)
    if (supabase && agency.stagedId) {
      const { error } = await supabase
        .from('dpi_staged_agencies')
        .update({ first_name: editValue, updated_at: new Date().toISOString() })
        .eq('id', agency.stagedId)
      if (error) console.error('save name edit:', error)
    }
  }

  const pushToDatex = async () => {
    if (!cycle) return
    setStage('pushing')

    const expectedDate = monthKey ? `${monthKey}-01T00:00:00.000Z` : null

    await fetch('/.netlify/functions/dpi-import-push-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: cycle.batch_id,
        facility,
        monthKey,
        forceSimulate,
        agencies: agencies.map((a) => ({ ...a, expectedDate })),
      }),
    }).catch(() => {
      // Background functions don't return a useful body — real failures
      // show up per-row via the dpi_import_batches poll below.
    })
  }

  // Poll dpi_import_batches while a push is in flight. Once every row is
  // terminal, advance the cycle to Phase 2 — the cycle stays in_progress.
  useEffect(() => {
    if (stage !== 'pushing' || !cycle || !supabase) return

    pollRef.current = setInterval(async () => {
      const { data, error } = await supabase
        .from('dpi_import_batches')
        .select('*')
        .eq('batch_id', cycle.batch_id)
      if (error) { console.error('poll dpi_import_batches:', error); return }
      setBatchRows(data ?? [])

      const allDone = data?.length > 0 && data.every((r) => r.status !== 'queued')
      if (allDone) {
        clearInterval(pollRef.current)
        setStage('done')
        if (cycle.current_phase < 2) {
          const { error: advanceErr } = await supabase
            .from('dpi_monthly_cycles')
            .update({ current_phase: 2, updated_at: new Date().toISOString() })
            .eq('id', cycle.id)
          if (advanceErr) console.error('advance cycle phase:', advanceErr)
          else setCycle((prev) => (prev ? { ...prev, current_phase: 2 } : prev))
        }
      }
    }, 2000)

    return () => clearInterval(pollRef.current)
  }, [stage, cycle])

  // Phase 2/4 components call this after they advance current_phase
  // themselves — just reloads so the shell picks up the new phase + any
  // refreshed data (e.g. phase_data).
  const handlePhaseAdvance = useCallback(() => { loadCycleState(facility) }, [facility, loadCycleState])

  const resetToEmpty = useCallback(() => {
    setCycle(null)
    setAgencies([])
    setBatchRows([])
    setMonthKey(null)
    setStage('empty')
  }, [])

  // Testing convenience — NOT the real "cycle complete" flow (that's
  // Phase5FinalPush's "Start next month", gated to actual completion).
  // This permanently deletes the current in_progress cycle and everything
  // under it (staged agencies, routes/stops via cascade, import batch
  // rows), so a test run can be abandoned at any phase without dragging
  // every agency back into place. Added 2026-09-06 after leftover manual
  // test routes (from before the template auto-seed existed) got stuck in
  // a cycle with no easy way out.
  const resetTestCycle = async () => {
    if (!cycle || !supabase) return
    if (!window.confirm(`Permanently delete this ${facility} test cycle (${monthKey}) — all staged agencies, routes, and comms progress? This cannot be undone.`)) {
      return
    }
    const { error: batchDeleteErr } = await supabase
      .from('dpi_import_batches')
      .delete()
      .eq('batch_id', cycle.batch_id)
    if (batchDeleteErr) console.error('delete batch rows:', batchDeleteErr)

    const { error: cycleDeleteErr } = await supabase
      .from('dpi_monthly_cycles')
      .delete()
      .eq('id', cycle.id)
    if (cycleDeleteErr) { console.error('delete cycle:', cycleDeleteErr); return }

    resetToEmpty()
  }

  const flaggedCount = agencies.filter((a) => a.nameWasAbbreviated).length
  const currentPhase = cycle?.current_phase ?? 1

  return (
    <div style={{ background: colors.bg, minHeight: '100vh', padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: colors.text }}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>DPI Monthly Process</div>
      <div style={{ fontSize: 13, color: colors.textFaint, marginBottom: 20 }}>Eau Claire &amp; Madison monthly school-district delivery cycle</div>

      <PhasePills currentPhase={currentPhase} />

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: colors.textFaint, marginBottom: 8 }}>Facility</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {['Eau Claire', 'Madison'].map((f) => (
              <button
                key={f}
                onClick={() => setFacility(f)}
                disabled={stage === 'pushing'}
                style={{
                  fontSize: 13, padding: '6px 14px', borderRadius: 6,
                  border: `1px solid ${facility === f ? colors.accent : colors.border}`,
                  background: facility === f ? 'rgba(77,141,255,0.1)' : colors.panel,
                  color: facility === f ? colors.accent : colors.textMuted,
                  cursor: stage === 'pushing' ? 'default' : 'pointer',
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        {cycle && (
          <button
            onClick={resetTestCycle}
            style={{
              fontSize: 12, padding: '5px 10px', borderRadius: 6,
              border: `1px solid ${colors.danger}`, background: 'transparent',
              color: colors.danger, cursor: 'pointer',
            }}
          >
            Reset test cycle
          </button>
        )}
      </div>

      {loading && <div style={{ fontSize: 13, color: colors.textFaint }}>Loading…</div>}

      {!loading && !cycle && (
        <div style={{ maxWidth: 520 }}>
          <DropZone facility={facility} onFile={handleFile} />
          {parseError && (
            <div style={{ marginTop: 10, fontSize: 13, color: colors.danger }}>
              {parseError}
            </div>
          )}
        </div>
      )}

      {!loading && cycle && currentPhase === 1 && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <StatCard label="Orders parsed" value={agencies.length} />
            <StatCard label="Delivery month" value={monthKey || '—'} />
            <StatCard label="Name abbreviated" value={flaggedCount} tone={flaggedCount ? colors.warning : undefined} />
          </div>

          <div style={{ ...cardStyle, padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1.4fr 1.6fr 70px 160px', padding: '10px 16px', fontSize: 12, color: colors.textFaint, borderBottom: `1px solid ${colors.border}` }}>
              <div>Agency #</div>
              <div>Sponsor name</div>
              <div>Delivery address</div>
              <div>Lines</div>
              <div>Status</div>
            </div>
            {agencies.map((agency, idx) => {
              const liveRow = batchRows.find((r) => r.lookup_code === agency.lookupCode)
              const status = liveRow?.status || (stage === 'pushing' ? 'queued' : null)
              return (
                <React.Fragment key={agency.agencyNumber}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '90px 1.4fr 1.6fr 70px 160px',
                    padding: '11px 16px', fontSize: 13, borderBottom: `1px solid ${colors.border}`,
                    background: agency.nameWasAbbreviated ? colors.warningBg : 'transparent',
                    alignItems: 'center',
                  }}>
                    <div style={{ color: colors.textFaint }}>{agency.agencyNumber}</div>
                    <div>
                      {agency.nameWasAbbreviated ? (
                        <>
                          <span>{agency.firstName}</span>
                          <div style={{ fontSize: 11, color: colors.textFaint, textDecoration: 'line-through' }}>{agency.agencyName}</div>
                        </>
                      ) : agency.agencyName}
                    </div>
                    <div style={{ color: colors.textMuted }}>
                      {agency.line1 ? `${agency.line1}, ${agency.city}, ${agency.state} ${agency.postalCode}` : (
                        <span style={{ color: colors.danger }}>Could not parse address</span>
                      )}
                    </div>
                    <div style={{ color: colors.textMuted }}>{agency.lines.length}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {status ? <Badge status={status} /> : (
                        agency.nameWasAbbreviated && (
                          <button
                            onClick={() => startEdit(idx)}
                            style={{ fontSize: 11, color: colors.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                          >
                            Edit name
                          </button>
                        )
                      )}
                      {liveRow?.error_message && (
                        <span title={liveRow.error_message} style={{ fontSize: 11, color: colors.danger, cursor: 'help' }}>⚠</span>
                      )}
                    </div>
                  </div>
                  {editingIdx === idx && (
                    <div style={{ padding: '10px 16px', borderBottom: `1px solid ${colors.border}`, background: colors.panelAlt, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: colors.textFaint }}>Shortened name (max {MAX_NAME_LENGTH} chars):</span>
                      <input
                        value={editValue}
                        maxLength={MAX_NAME_LENGTH}
                        onChange={(e) => setEditValue(e.target.value)}
                        style={{ flex: 1, maxWidth: 320, fontSize: 13, padding: '5px 8px', borderRadius: 5, border: `1px solid ${colors.borderStrong}`, background: colors.bg, color: colors.text }}
                      />
                      <span style={{ fontSize: 11, color: colors.textFaint }}>{editValue.length}/{MAX_NAME_LENGTH}</span>
                      <button
                        onClick={() => saveEdit(idx)}
                        style={{ fontSize: 12, padding: '5px 12px', borderRadius: 5, border: `1px solid ${colors.accent}`, background: 'rgba(77,141,255,0.1)', color: colors.accent, cursor: 'pointer' }}
                      >
                        Save
                      </button>
                    </div>
                  )}
                </React.Fragment>
              )
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.textFaint, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={forceSimulate}
                onChange={(e) => setForceSimulate(e.target.checked)}
              />
              Force simulate (skip real Datex push)
            </label>
            <button
              onClick={pushToDatex}
              disabled={stage === 'pushing'}
              style={{
                fontSize: 14, padding: '9px 18px', borderRadius: 7, border: 'none',
                background: colors.accent, color: '#fff',
                cursor: stage === 'pushing' ? 'default' : 'pointer',
                fontWeight: 500,
              }}
            >
              {stage === 'pushing' ? 'Pushing to Datex…' : `Push ${agencies.length} orders to Datex`}
            </button>
            <span style={{ fontSize: 12, color: colors.textFaint }}>
              {flaggedCount > 0 && `${flaggedCount} name${flaggedCount > 1 ? 's' : ''} shortened — review before pushing.`}
            </span>
          </div>
        </>
      )}

      {!loading && cycle && currentPhase === 2 && (
        <Phase2BuildFlag cycle={cycle} stagedAgencies={agencies} onAdvance={handlePhaseAdvance} />
      )}

      {!loading && cycle && currentPhase === 4 && (
        <Phase4AgencyComms cycle={cycle} onAdvance={handlePhaseAdvance} />
      )}

      {!loading && cycle && currentPhase === 5 && (
        <Phase5FinalPush cycle={cycle} onCycleComplete={resetToEmpty} />
      )}
    </div>
  )
}
