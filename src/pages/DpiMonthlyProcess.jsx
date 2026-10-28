import React, { useState, useCallback, useRef, useEffect } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase.js'
import { parseFdp201w, MAX_NAME_LENGTH } from '../lib/dpiMonthlyParser.js'
import { downloadDatexImportFile } from '../lib/dpiDatexImportExport.js'
import { colors, cardStyle } from './dpiMonthly/dpiMonthlyStyles.js'
import Phase2BuildFlag from './dpiMonthly/Phase2BuildFlag.jsx'
import Phase4AgencyComms from './dpiMonthly/Phase4AgencyComms.jsx'
import Phase5FinalPush from './dpiMonthly/Phase5FinalPush.jsx'
import TemplateEditor from './dpiMonthly/TemplateEditor.jsx'
import AgencyContactList from './dpiMonthly/AgencyContactList.jsx'

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
// 2026-10-28: Phase 1's live Datex push (dpi-import-push-background.cjs)
// is PAUSED per Dan — repeated test-cycle resets created duplicate REAL
// Datex orders under the same deterministic lookup code (root cause: the
// dedup check queries Datex's own API, which has read-after-write lag
// against a reset-and-rerun seconds later — see dpiDatexImportExport.js
// header comment for the full writeup). Phase 1 now generates a Datex
// "ExcelOrderImport" file (src/lib/dpiDatexImportExport.js) for a human
// to review and run through Datex's own native Excel import instead —
// nothing here calls Datex. The old push function/background job and
// forceSimulate plumbing are left in the repo untouched (just unused from
// this screen) in case the API path gets fixed and re-enabled later.
// Generated rows are tracked in dpi_import_batches with status='exported'
// (not 'success' — no Datex order actually exists until a human uploads
// the file), so resetTestCycle's "real orders already in Datex" warning
// below still only fires for rows from the old API path.
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
//
// 2026-09-18 FIX: the poll effect used to advance to Phase 2 whenever every
// batch row left "queued" — that included "failed" rows. A real push
// attempt failed entirely (wrong Azure client ID) and the app silently
// advanced anyway, looking successful. A CSR with no reason to check Front
// or Supabase would have had zero indication anything was wrong. Now the
// cycle only advances if every row succeeded or was simulated; any failure
// blocks advance and shows a clear, visible failure banner with a retry
// action, instead of a silent per-row ⚠ tooltip nobody has reason to hover.
//
// 2026-09-25 (A2 — route template editor): a new top-level view toggle
// (Monthly Cycle | Route Templates) alongside the existing Facility
// toggle. TemplateEditor.jsx edits dpi_route_templates/
// dpi_route_template_stops directly — the master annual pattern every
// cycle is seeded from — never a specific cycle's dpi_routes/
// dpi_route_stops. This is a standing configuration screen, not a phase
// of the monthly pipeline, so it sits beside the phase pipeline rather
// than as a 5th phase pill; PhasePills, the phase body, and "Reset test
// cycle" are all cycle-specific and hidden while viewing templates.
//
// 2026-09-28 (Agency Contacts): a third view alongside Monthly Cycle and
// Route Templates, same posture (standing config, not a phase) —
// AgencyContactList.jsx, the real recipient/phone-contact source for
// Phase 4's agency comms and Phase 5's route sheet.

// 2026-09-18: renamed Phase 1 and 2 for clarity per Dan, and dropped
// Phase 3 from this stepper display entirely — it was ALREADY never
// visited in practice (Phase2BuildFlag's advance() jumps current_phase
// straight from 2 to 4; nothing in this codebase ever sets it to 3), so
// showing "3. Carrier approval" in the stepper just misrepresented what
// actually happens. Using explicit {number, label} pairs instead of
// array index -> phase number, so real current_phase values (1, 2, 4, 5
// — genuinely non-contiguous) still match correctly after removing the
// entry, rather than the remaining labels silently shifting onto the
// wrong numbers.
//
// 2026-09-28: Phase 5's label renamed "Push final" -> "Appointment
// confirmation" per Dan (JW<>DF DPI Monthly Build call) — see
// Phase5FinalPush.jsx's own header comment for the full reasoning.
const PHASES = [
  { number: 1, label: 'Order Import Process' },
  { number: 2, label: 'Route Build and Assign Days' },
  { number: 4, label: 'Agency comms' },
  { number: 5, label: 'Appointment confirmation' },
]

function PhasePills({ currentPhase }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
      {PHASES.map(({ number, label }) => {
        const isCurrent = number === currentPhase
        return (
          <div
            key={number}
            style={{
              fontSize: 13, padding: '6px 12px', borderRadius: 6,
              border: `1px solid ${isCurrent ? colors.accent : colors.border}`,
              color: isCurrent ? colors.accent : colors.textFaint,
              background: isCurrent ? colors.accentBg : 'transparent',
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
    case 'exported': return { label: 'In export file', color: colors.success, bg: colors.successBg }
    case 'duplicate_skipped': return { label: 'Already imported', color: colors.textFaint }
    case 'failed': return { label: 'Failed', color: colors.danger, bg: colors.dangerBg }
    case 'simulated': return { label: 'Simulated — not pushed', color: colors.accent, bg: colors.accentBg }
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
        background: dragOver ? colors.accentBg : colors.panelAlt,
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

// NOTE: the old API-push path's expected_date (last day of the delivery
// month) has no equivalent column in Datex's Excel import template — see
// dpiDatexImportExport.js header comment ("known gaps"). Not reproduced
// here since the file-export path doesn't set it at all right now.

export default function DpiMonthlyProcess() {
  const [view, setView] = useState('cycle') // 'cycle' | 'templates' | 'contacts'
  const [facility, setFacility] = useState('Eau Claire')
  const [loading, setLoading] = useState(true)
  const [stage, setStage] = useState('empty') // empty | parsed | done (Phase 1 only)
  const [parseError, setParseError] = useState(null)
  const [exportError, setExportError] = useState(null)
  const [cycle, setCycle] = useState(null) // dpi_monthly_cycles row
  const [monthKey, setMonthKey] = useState(null)
  const [agencies, setAgencies] = useState([])
  const [editingIdx, setEditingIdx] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [batchRows, setBatchRows] = useState([])

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

    // 'exported'/'simulated'/'success' are all terminal, non-failure
    // outcomes (the latter two only ever come from the now-paused API
    // path, on a resumed older cycle) — anything else (no rows yet, or
    // only legacy 'failed'/'queued' rows from an old API-push attempt)
    // leaves this on 'parsed' so the export button is still available.
    const hasTerminalRow = (batch || []).some((r) => ['exported', 'simulated', 'success'].includes(r.status))
    setStage(hasTerminalRow ? 'done' : 'parsed')
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

  // Generates the Datex Excel Import file client-side (no network call to
  // Datex at all — see header comment) and triggers a browser download.
  // Tracks one dpi_import_batches row per agency with status='exported' so
  // the existing per-row badge UI and resetTestCycle's real-order warning
  // keep working unchanged; re-clicking after an edit (e.g. a shortened
  // name) regenerates the file and updates those rows rather than piling
  // up duplicates (dpi_import_batches has no unique constraint on
  // batch_id+lookup_code, so this is enforced here, not by the DB).
  const generateExportFile = async () => {
    if (!cycle) return
    setExportError(null)

    try {
      downloadDatexImportFile(agencies, facility, monthKey)
    } catch (err) {
      console.error('generate Datex export file:', err)
      setExportError(`Could not generate the export file: ${err.message}`)
      return
    }

    if (!supabase) { setExportError('Supabase not configured — file downloaded, but could not record export status.'); return }

    const existingByLookupCode = new Map(batchRows.map((r) => [r.lookup_code, r]))
    const toInsert = []
    const toUpdate = []
    const nowIso = new Date().toISOString()

    for (const agency of agencies) {
      const totalQuantity = agency.lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0)
      const existing = existingByLookupCode.get(agency.lookupCode)
      if (existing) {
        toUpdate.push({ id: existing.id, line_count: agency.lines.length, total_quantity: totalQuantity, updated_at: nowIso })
      } else {
        toInsert.push({
          batch_id: cycle.batch_id,
          facility,
          month_key: monthKey,
          agency_number: agency.agencyNumber,
          agency_name: agency.agencyName,
          first_name_sent: agency.firstName,
          lookup_code: agency.lookupCode,
          line_count: agency.lines.length,
          total_quantity: totalQuantity,
          status: 'exported',
        })
      }
    }

    if (toInsert.length > 0) {
      const { error: insertErr } = await supabase.from('dpi_import_batches').insert(toInsert)
      if (insertErr) { console.error('insert exported batch rows:', insertErr); setExportError(`File downloaded, but could not save export status: ${insertErr.message}`); return }
    }
    for (const update of toUpdate) {
      const { error: updateErr } = await supabase.from('dpi_import_batches').update(update).eq('id', update.id)
      if (updateErr) console.error('update exported batch row:', updateErr)
    }

    const { data: refreshed, error: refreshErr } = await supabase
      .from('dpi_import_batches')
      .select('*')
      .eq('batch_id', cycle.batch_id)
    if (refreshErr) console.error('reload batch rows after export:', refreshErr)
    setBatchRows(refreshed ?? [])
    setStage('done')
    // Deliberately does NOT auto-advance to Phase 2 — unlike the old API
    // push, generating this file proves nothing about Datex (no order
    // exists until a human actually runs the import there). Advancing is
    // the separate, explicit "Continue to Route Build" button below.
  }

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
  //
  // 2026-09-18 fix: this used to show the same generic confirm message
  // regardless of what was actually in the cycle. A real push (status=
  // 'success' rows — genuine orders already created in Datex) got reset
  // this way with no distinct warning, silently deleting the ONLY local
  // record of what those orders should contain — with reconciliation
  // unable to ever check them again, and no way to reconstruct it short
  // of re-parsing the original CSV by hand (see that investigation this
  // session). Datex itself is never touched by this button either way —
  // it only ever deletes rows in OUR OWN Supabase tables — but wiping the
  // tracking for orders that already exist for real is a fundamentally
  // bigger deal than wiping test-only or simulated data, so it now gets
  // its own explicit, specific warning naming exactly how many real
  // orders are involved, rather than being silently folded into the same
  // generic message. This does not block the reset — sometimes resetting
  // real-order tracking is exactly what's needed (e.g. deleting the
  // orders in Datex and resubmitting from scratch) — it just makes sure
  // that's a known, deliberate choice rather than an accidental one.
  const resetTestCycle = async () => {
    if (!cycle || !supabase) return

    const { data: realRows, error: realErr } = await supabase
      .from('dpi_import_batches')
      .select('id')
      .eq('batch_id', cycle.batch_id)
      .eq('status', 'success')
    if (realErr) console.error('check for real orders before reset:', realErr)
    const realCount = realRows?.length || 0

    const message = realCount > 0
      ? `This ${facility} cycle (${monthKey}) has ${realCount} REAL order${realCount === 1 ? '' : 's'} already created in Datex — this button does NOT delete them from Datex, but it WILL permanently delete our only local record of what they should contain, and reconciliation will no longer be able to check them. Only continue if you're intentionally starting over (e.g. you're about to delete and resubmit these orders in Datex). Continue?`
      : `Permanently delete this ${facility} test cycle (${monthKey}) — all staged agencies, routes, and comms progress? This cannot be undone.`

    if (!window.confirm(message)) {
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
    <div style={{ background: colors.bg, minHeight: '100vh', padding: 24, color: colors.text }}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>DPI Monthly Process</div>
      <div style={{ fontSize: 13, color: colors.textFaint, marginBottom: 20 }}>Eau Claire &amp; Madison monthly school-district delivery cycle</div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[{ key: 'cycle', label: 'Monthly Cycle' }, { key: 'templates', label: 'Route Templates' }, { key: 'contacts', label: 'Agency Contacts' }].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{
              fontSize: 13, padding: '6px 14px', borderRadius: 6,
              border: `1px solid ${view === key ? colors.accent : colors.border}`,
              background: view === key ? colors.accentBg : colors.panel,
              color: view === key ? colors.accent : colors.textMuted,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'cycle' && <PhasePills currentPhase={currentPhase} />}

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: colors.textFaint, marginBottom: 8 }}>Facility</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {['Eau Claire', 'Madison'].map((f) => (
              <button
                key={f}
                onClick={() => setFacility(f)}
                style={{
                  fontSize: 13, padding: '6px 14px', borderRadius: 6,
                  border: `1px solid ${facility === f ? colors.accent : colors.border}`,
                  background: facility === f ? colors.accentBg : colors.panel,
                  color: facility === f ? colors.accent : colors.textMuted,
                  cursor: 'pointer',
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        {view === 'cycle' && cycle && (
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

      {view === 'templates' && <TemplateEditor facility={facility} />}

      {view === 'contacts' && <AgencyContactList facility={facility} />}

      {view === 'cycle' && (
        <>
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
          <div style={{
            ...cardStyle, marginBottom: 16,
            border: `1px solid ${colors.border}`, background: colors.panelAlt,
          }}>
            <div style={{ fontSize: 13, color: colors.textMuted }}>
              Live Datex push is paused — this generates a Datex "ExcelOrderImport" file instead. Review it, then run it through Datex's own Excel import yourself; nothing here reaches Datex automatically.
            </div>
          </div>

          {exportError && (
            <div style={{
              ...cardStyle, marginBottom: 16,
              border: `1px solid ${colors.danger}`, background: colors.dangerBg,
            }}>
              <div style={{ fontSize: 13, color: colors.danger }}>{exportError}</div>
            </div>
          )}

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
              const status = liveRow?.status || null
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
                        style={{ fontSize: 12, padding: '5px 12px', borderRadius: 5, border: `1px solid ${colors.accent}`, background: colors.accentBg, color: colors.accent, cursor: 'pointer' }}
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
            <button
              onClick={generateExportFile}
              style={{
                fontSize: 14, padding: '9px 18px', borderRadius: 7, border: 'none',
                background: colors.accent, color: '#fff',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              {stage === 'done' ? `Re-download Datex import file (${agencies.length} orders)` : `Generate Datex import file (${agencies.length} orders)`}
            </button>
            <span style={{ fontSize: 12, color: colors.textFaint }}>
              {flaggedCount > 0 && `${flaggedCount} name${flaggedCount > 1 ? 's' : ''} shortened — review before generating.`}
            </span>
          </div>

          {stage === 'done' && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, color: colors.textFaint, marginBottom: 8 }}>
                File downloaded. Once it's actually been run through Datex's Excel import, continue on — this app can't confirm that for you.
              </div>
              <button
                onClick={async () => {
                  if (!cycle || !supabase) return
                  const { error } = await supabase
                    .from('dpi_monthly_cycles')
                    .update({ current_phase: 2, updated_at: new Date().toISOString() })
                    .eq('id', cycle.id)
                  if (error) { console.error('advance cycle phase:', error); return }
                  setCycle((prev) => (prev ? { ...prev, current_phase: 2 } : prev))
                }}
                style={{
                  fontSize: 13, padding: '7px 14px', borderRadius: 6,
                  border: `1px solid ${colors.accent}`, background: 'transparent', color: colors.accent, cursor: 'pointer',
                }}
              >
                Continue to Route Build
              </button>
            </div>
          )}
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
        </>
      )}
    </div>
  )
}
