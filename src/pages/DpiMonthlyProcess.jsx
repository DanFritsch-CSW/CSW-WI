import React, { useState, useCallback, useRef, useEffect } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase.js'
import { parseFdp201w, MAX_NAME_LENGTH } from '../lib/dpiMonthlyParser.js'

// DPI Monthly Process — Phase 1 (Import).
// Hidden route (/dpimonthly, see src/App.jsx) — not linked from any nav.
//
// Flow: drop CSV -> parse client-side -> staging table (flagged rows
// editable inline) -> "Push to Datex" -> background function creates
// Datex orders -> this page polls dpi_import_batches for live progress.
//
// Phases 2-5 are placeholders here; only Phase 1 is built.

const colors = {
  bg: '#0f1115',
  panel: '#171a21',
  panelAlt: '#1d2129',
  border: '#2a2f3a',
  borderStrong: '#3a4150',
  text: '#e8eaed',
  textMuted: '#9aa1ad',
  textFaint: '#6b7280',
  accent: '#4d8dff',
  success: '#3ecf8e',
  successBg: 'rgba(62,207,142,0.12)',
  warning: '#e0a83e',
  warningBg: 'rgba(224,168,62,0.12)',
  danger: '#e05a4e',
  dangerBg: 'rgba(224,90,78,0.12)',
}

const cardStyle = {
  background: colors.panel,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: '14px 16px',
}

function statusMeta(status) {
  switch (status) {
    case 'queued': return { label: 'Queued', color: colors.textMuted }
    case 'success': return { label: 'Pushed', color: colors.success, bg: colors.successBg }
    case 'duplicate_skipped': return { label: 'Already imported', color: colors.textFaint }
    case 'failed': return { label: 'Failed', color: colors.danger, bg: colors.dangerBg }
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

function DropZone({ facility, onFile }) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files?.[0]
        if (file) onFile(file)
      }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `1.5px dashed ${dragOver ? colors.accent : colors.borderStrong}`,
        borderRadius: 10, padding: '36px 20px', textAlign: 'center',
        background: dragOver ? 'rgba(77,141,255,0.06)' : colors.panelAlt,
        cursor: 'pointer',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
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

export default function DpiMonthlyProcess() {
  const [facility, setFacility] = useState('Eau Claire')
  const [stage, setStage] = useState('empty') // empty | parsed | pushing | done
  const [parseError, setParseError] = useState(null)
  const [monthKey, setMonthKey] = useState(null)
  const [agencies, setAgencies] = useState([])
  const [editingIdx, setEditingIdx] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [batchId, setBatchId] = useState(null)
  const [batchRows, setBatchRows] = useState([]) // live status from dpi_import_batches
  const pollRef = useRef(null)

  const handleFile = useCallback((file) => {
    setParseError(null)
    Papa.parse(file, {
      skipEmptyLines: false,
      complete: (results) => {
        try {
          const { monthKey: mk, agencies: parsedAgencies } = parseFdp201w(results.data)
          setMonthKey(mk)
          setAgencies(parsedAgencies)
          setStage('parsed')
        } catch (err) {
          setParseError(err.message)
        }
      },
      error: (err) => setParseError(err.message),
    })
  }, [])

  const startEdit = (idx) => {
    setEditingIdx(idx)
    setEditValue(agencies[idx].firstName)
  }

  const saveEdit = (idx) => {
    setAgencies((prev) => prev.map((a, i) => (i === idx ? { ...a, firstName: editValue } : a)))
    setEditingIdx(null)
  }

  const pushToDatex = async () => {
    const newBatchId = crypto.randomUUID()
    setBatchId(newBatchId)
    setStage('pushing')

    // expectedDate is a placeholder (1st of the delivery month) — real
    // delivery date isn't known until Phase 2/4 route + agency confirmation.
    // Flagged as open: whether this order field can even be corrected later
    // (no update_outbound_order endpoint seen in the SmartUp API function
    // list — needs a live check before this matters for real).
    const expectedDate = monthKey ? `${monthKey}-01T00:00:00.000Z` : null

    await fetch('/.netlify/functions/dpi-import-push-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: newBatchId,
        facility,
        monthKey,
        agencies: agencies.map((a) => ({ ...a, expectedDate })),
      }),
    }).catch(() => {
      // Background functions don't return a useful body — errors here are
      // just network-level (request never reached Netlify). Real push
      // failures show up per-row via the dpi_import_batches poll below.
    })
  }

  // Poll dpi_import_batches while a push is in flight.
  useEffect(() => {
    if (stage !== 'pushing' || !batchId || !supabase) return

    pollRef.current = setInterval(async () => {
      const { data, error } = await supabase
        .from('dpi_import_batches')
        .select('*')
        .eq('batch_id', batchId)
      if (error) { console.error('poll dpi_import_batches:', error); return }
      setBatchRows(data ?? [])

      const allDone = data?.length > 0 && data.every((r) => r.status !== 'queued')
      if (allDone) {
        clearInterval(pollRef.current)
        setStage('done')
      }
    }, 2000)

    return () => clearInterval(pollRef.current)
  }, [stage, batchId])

  const flaggedCount = agencies.filter((a) => a.nameWasAbbreviated).length

  return (
    <div style={{ background: colors.bg, minHeight: '100vh', padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: colors.text }}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>DPI Monthly Process</div>
      <div style={{ fontSize: 13, color: colors.textFaint, marginBottom: 20 }}>Phase 1 — Import</div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: colors.textFaint, marginBottom: 8 }}>Facility</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['Eau Claire', 'Madison'].map((f) => (
            <button
              key={f}
              onClick={() => { setFacility(f); setStage('empty'); setAgencies([]) }}
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

      {stage === 'empty' && (
        <div style={{ maxWidth: 520 }}>
          <DropZone facility={facility} onFile={handleFile} />
          {parseError && (
            <div style={{ marginTop: 10, fontSize: 13, color: colors.danger }}>
              Could not parse file: {parseError}
            </div>
          )}
        </div>
      )}

      {stage !== 'empty' && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <StatCard label="Orders parsed" value={agencies.length} />
            <StatCard label="Delivery month" value={monthKey || '—'} />
            <StatCard label="Name abbreviated" value={flaggedCount} tone={flaggedCount ? colors.warning : undefined} />
            {stage === 'done' && (
              <StatCard
                label="Pushed"
                value={batchRows.filter((r) => r.status === 'success').length}
                tone={colors.success}
              />
            )}
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
              const status = liveRow?.status || (stage === 'pushing' || stage === 'done' ? 'queued' : null)
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={pushToDatex}
              disabled={stage === 'pushing' || stage === 'done'}
              style={{
                fontSize: 14, padding: '9px 18px', borderRadius: 7, border: 'none',
                background: stage === 'done' ? colors.borderStrong : colors.accent,
                color: stage === 'done' ? colors.textFaint : '#fff',
                cursor: stage === 'pushing' || stage === 'done' ? 'default' : 'pointer',
                fontWeight: 500,
              }}
            >
              {stage === 'pushing' ? 'Pushing to Datex…' : stage === 'done' ? 'Pushed' : `Push ${agencies.length} orders to Datex`}
            </button>
            <span style={{ fontSize: 12, color: colors.textFaint }}>
              {flaggedCount > 0 && stage === 'parsed' && `${flaggedCount} name${flaggedCount > 1 ? 's' : ''} shortened — review before pushing.`}
              {stage === 'done' && `${batchRows.filter((r) => r.status === 'duplicate_skipped').length} already in Datex, skipped. ${batchRows.filter((r) => r.status === 'failed').length} failed — hover ⚠ for details.`}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
