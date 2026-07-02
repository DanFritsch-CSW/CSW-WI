import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  fetchPviCanonicalAccounts,
  fetchPviAccountNameMap,
  fetchPviShelfNotes,
  insertPviShelfNote,
  updatePviShelfNoteStatus,
  deletePviShelfNote,
} from '../lib/supabase.js'
import {
  buildRawNameToCanonical,
  projectFefo,
  STAGE_META,
  STAGE_ORDER,
  DEFAULT_STAGES,
  formatLotForEmail,
  bulkCopyForEmail,
} from '../lib/pviShelfLife.js'

// PVI Shelf Life dashboard.
//
// Loads three things in parallel:
//   1. Live risk snapshot from /.netlify/functions/pvi-shelf-life
//   2. Canonical accounts + raw-name map from Supabase
//   3. Notes from Supabase
//
// Then runs FEFO projection client-side (src/lib/pviShelfLife.js) and renders
// a filterable table. Side drawer for per-lot notes. Copy-for-email buttons
// per-lot and bulk. Stage filter defaults to "At Risk and worse".

const STAGES_FOR_TABS = ['expired', 'unshippable', 'critical', 'at_risk', 'watch']

export default function PviShelfLife() {
  const [snapshot, setSnapshot]         = useState(null)   // response from function
  const [canonicals, setCanonicals]     = useState([])
  const [nameMap, setNameMap]           = useState([])
  const [notes, setNotes]               = useState([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState(null)
  const [reloadTick, setReloadTick]     = useState(0)

  // Filters
  const [enabledStages, setEnabledStages] = useState(new Set(DEFAULT_STAGES))
  const [accountFilter, setAccountFilter] = useState('')  // canonical_id string or ''
  const [textFilter, setTextFilter]       = useState('')

  // Selection
  const [selectedLotId, setSelectedLotId] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const [snap, canon, map, noteRows] = await Promise.all([
          fetch('/.netlify/functions/pvi-shelf-life', { method: 'POST' })
            .then(async r => {
              if (!r.ok) throw new Error(`Shelf-life fetch failed (${r.status}): ${(await r.text()).slice(0, 200)}`)
              return r.json()
            }),
          fetchPviCanonicalAccounts(),
          fetchPviAccountNameMap(),
          fetchPviShelfNotes(),
        ])
        if (cancelled) return
        setSnapshot(snap)
        setCanonicals(canon)
        setNameMap(map)
        setNotes(noteRows)
      } catch (e) {
        if (!cancelled) setError(e.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [reloadTick])

  const canonicalIndex = useMemo(
    () => buildRawNameToCanonical(canonicals, nameMap),
    [canonicals, nameMap],
  )

  // Run FEFO projection whenever the inputs change.
  const rows = useMemo(() => {
    if (!snapshot) return []
    return projectFefo({
      lots:           snapshot.lots || [],
      pendingOrders:  snapshot.pendingOrders || [],
      velocity:       snapshot.velocity || [],
      canonicalIndex,
    })
  }, [snapshot, canonicalIndex])

  // Stage counts for the tab row (ignoring account/text filter — always
  // reflect the raw universe so the operator sees the full workload).
  const stageCounts = useMemo(() => {
    const c = { expired: 0, unshippable: 0, critical: 0, at_risk: 0, watch: 0 }
    for (const r of rows) c[r.verdict.stage] = (c[r.verdict.stage] || 0) + 1
    return c
  }, [rows])

  // Filtered rows for the table.
  const filteredRows = useMemo(() => {
    return rows.filter(r => {
      if (!enabledStages.has(r.verdict.stage)) return false
      if (accountFilter) {
        const canonId = r.primary?.canonical?.id ?? null
        if (String(canonId) !== accountFilter) return false
      }
      if (textFilter.trim()) {
        const q = textFilter.trim().toUpperCase()
        const hay = `${r.material_code} ${r.material_desc} ${r.lot_code}`.toUpperCase()
        if (!hay.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      // Sort by stage severity DESC, then by days-to-code ASC (worst first).
      const sa = STAGE_ORDER.indexOf(a.verdict.stage)
      const sb = STAGE_ORDER.indexOf(b.verdict.stage)
      if (sa !== sb) return sa - sb
      const da = a.days_to_code_today ?? 9999
      const db = b.days_to_code_today ?? 9999
      return da - db
    })
  }, [rows, enabledStages, accountFilter, textFilter])

  const selectedRow = useMemo(
    () => filteredRows.find(r => r.lot_id === selectedLotId) || rows.find(r => r.lot_id === selectedLotId) || null,
    [filteredRows, rows, selectedLotId],
  )

  const toggleStage = (stage) => {
    setEnabledStages(prev => {
      const next = new Set(prev)
      if (next.has(stage)) next.delete(stage); else next.add(stage)
      return next
    })
  }

  const handleCopyLot = useCallback((row) => {
    navigator.clipboard.writeText(formatLotForEmail(row)).then(
      () => flash('Copied to clipboard'),
      () => flash('Copy failed — check clipboard permissions'),
    )
  }, [])

  const handleCopyBulk = useCallback(() => {
    if (filteredRows.length === 0) return
    navigator.clipboard.writeText(bulkCopyForEmail(filteredRows)).then(
      () => flash(`Copied ${filteredRows.length} lot(s) to clipboard`),
      () => flash('Copy failed'),
    )
  }, [filteredRows])

  const reload = () => setReloadTick(t => t + 1)

  if (loading) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        Loading PVI shelf-life snapshot…
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ color: '#e05a5a', fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 12 }}>
          Error: {error}
        </div>
        <button className="settings-save-btn" onClick={reload}>Retry</button>
      </div>
    )
  }

  const accountOptions = canonicals
    .filter(c => c.account_type === 'end_customer')
    .sort((a, b) => a.canonical_name.localeCompare(b.canonical_name))

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Meta line */}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
          {snapshot && (
            <>
              {snapshot.rowCounts?.lots ?? 0} lots · {snapshot.rowCounts?.pendingOrders ?? 0} pending order lines ·
              scanned in {((snapshot.elapsedMs ?? 0) / 1000).toFixed(1)}s ·
              fetched {new Date(snapshot.fetchedAt).toLocaleTimeString()}
              <button className="settings-save-btn" style={{ marginLeft: 8, fontSize: 10 }} onClick={reload}>↻ Refresh</button>
            </>
          )}
        </div>

        {/* Stage tabs */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {STAGES_FOR_TABS.map(stage => {
            const meta = STAGE_META[stage]
            const active = enabledStages.has(stage)
            const count = stageCounts[stage] || 0
            return (
              <button
                key={stage}
                type="button"
                onClick={() => toggleStage(stage)}
                style={{
                  padding: '6px 12px',
                  border: `1px solid ${active ? meta.color : 'var(--border)'}`,
                  background: active ? meta.bg : 'transparent',
                  color: active ? meta.color : 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                  borderRadius: 2,
                  transition: 'all 0.15s ease',
                }}
              >
                {meta.label} <span style={{ opacity: 0.7 }}>({count})</span>
              </button>
            )
          })}
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            className="est-drops-select"
            value={accountFilter}
            onChange={e => setAccountFilter(e.target.value)}
            style={{ fontSize: 11 }}
          >
            <option value="">All accounts</option>
            {accountOptions.map(c => (
              <option key={c.id} value={c.id}>{c.canonical_name}</option>
            ))}
          </select>
          <input
            className="settings-field-input"
            placeholder="Filter by item, lot, or description…"
            value={textFilter}
            onChange={e => setTextFilter(e.target.value)}
            style={{ width: 260, fontSize: 11 }}
          />
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            {filteredRows.length} of {rows.length} lot(s)
          </span>
          <button
            className="settings-save-btn"
            onClick={handleCopyBulk}
            disabled={filteredRows.length === 0}
            style={{ fontSize: 11 }}
          >
            Copy all ({filteredRows.length}) for email
          </button>
        </div>

        {/* Table */}
        {rows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            No lots found. Either PVI inventory is empty at CAL or the risk engine returned no rows.
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            No lots match the current filters. Toggle a stage or clear filters above.
          </div>
        ) : (
          <table className="hourly-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Stage</th>
                <th style={{ textAlign: 'left' }}>Item</th>
                <th style={{ textAlign: 'left' }}>Lot</th>
                <th style={{ textAlign: 'left' }}>Code date</th>
                <th style={{ textAlign: 'right' }}>Days to code</th>
                <th style={{ textAlign: 'right' }}>Available</th>
                <th style={{ textAlign: 'left' }}>Projected ship</th>
                <th style={{ textAlign: 'left' }}>Velocity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(r => (
                <ShelfLifeRow
                  key={r.lot_id}
                  row={r}
                  isSelected={r.lot_id === selectedLotId}
                  onSelect={() => setSelectedLotId(r.lot_id)}
                  onCopy={() => handleCopyLot(r)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Notes drawer */}
      {selectedRow && (
        <NotesDrawer
          row={selectedRow}
          notes={notes.filter(n =>
            (n.item === selectedRow.material_code || n.item === selectedRow.material_desc) ||
            n.lot_code === selectedRow.lot_code
          )}
          allNotesForItem={notes.filter(n =>
            n.item === selectedRow.material_code
          )}
          onClose={() => setSelectedLotId(null)}
          onNotesChanged={async () => {
            const fresh = await fetchPviShelfNotes()
            setNotes(fresh)
          }}
        />
      )}
    </div>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────

function ShelfLifeRow({ row, isSelected, onSelect, onCopy }) {
  const meta = STAGE_META[row.verdict.stage]
  const prim = row.primary
  const acct = prim?.canonical?.canonical_name
    || (prim?.ship_to_raw_name ? `(unmapped: ${prim.ship_to_raw_name})` : '(unallocated)')
  const shipIso = prim?.projected_ship_iso ? prim.projected_ship_iso.slice(0, 10) : ''
  const shipSrc = prim?.source === 'scheduled' ? 'sched' : prim?.source === 'projected' ? 'proj' : '—'
  const daysToCode = row.days_to_code_today
  const daysAtShip = row.days_to_code_at_ship
  const vc = row.velocity_confidence

  return (
    <tr
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        background: isSelected ? 'var(--brand-bg, #fef9ec)' : 'transparent',
      }}
    >
      <td>
        <span style={{
          display: 'inline-block',
          padding: '2px 6px',
          background: meta.bg,
          color: meta.color,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 700,
          borderRadius: 2,
        }}>
          {meta.label}
        </span>
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <div>{row.material_code}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{row.material_desc}</div>
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {row.lot_code}
        {row.lot_status && row.lot_status !== 'Available' && (
          <div style={{ fontSize: 9, color: '#c88a2a', fontStyle: 'italic' }}>{row.lot_status}</div>
        )}
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {row.expiration_date_iso || <span style={{ color: 'var(--text-dim)' }}>—</span>}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {daysToCode == null ? '—' : (
          <>
            <div>{daysToCode}</div>
            {daysAtShip != null && daysAtShip !== daysToCode && (
              <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>@ship: {daysAtShip}</div>
            )}
          </>
        )}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <div>{row.cases_available}</div>
        {row.cases_committed > 0 && (
          <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
            {row.cases_onhand} on / {row.cases_committed} cmt
          </div>
        )}
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <div>{acct}</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
          {shipIso} · {shipSrc}
        </div>
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        <span style={{ color: vc.color, fontWeight: 600 }}>{vc.label}</span>
        {row.velocity && (
          <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
            {row.velocity.shipments_30d} ship/30d
          </div>
        )}
      </td>
      <td>
        <button
          className="settings-save-btn"
          onClick={(e) => { e.stopPropagation(); onCopy() }}
          style={{ fontSize: 10 }}
          title="Copy this lot's summary to clipboard for pasting into email"
        >
          Copy
        </button>
      </td>
    </tr>
  )
}

// ── Notes Drawer ──────────────────────────────────────────────────────────

const NOTE_STATUS_OPTIONS = [
  { value: 'open',                label: 'Open' },
  { value: 'awaiting_approval',   label: 'Awaiting approval' },
  { value: 'approved_to_ship',    label: 'Approved to ship' },
  { value: 'resolved',            label: 'Resolved' },
  { value: 'dispose',             label: 'Dispose' },
]

function NotesDrawer({ row, notes, allNotesForItem, onClose, onNotesChanged }) {
  const [newNote, setNewNote]   = useState('')
  const [author, setAuthor]     = useState(loadAuthor())
  const [status, setStatus]     = useState('open')
  const [busy, setBusy]         = useState(false)
  const [err, setErr]           = useState(null)

  function loadAuthor() {
    try { return localStorage.getItem('pvi_notes_author') || '' } catch { return '' }
  }
  function saveAuthor(v) {
    try { localStorage.setItem('pvi_notes_author', v) } catch (_) {}
  }

  async function handleAdd() {
    setErr(null)
    if (!newNote.trim()) { setErr('Note text required.'); return }
    if (!author.trim())  { setErr('Author required — enter your name once and it will be remembered.'); return }
    setBusy(true)
    try {
      saveAuthor(author.trim())
      await insertPviShelfNote({
        item:     row.material_code,
        lot_code: row.lot_code,
        note:     newNote.trim(),
        status,
        author:   author.trim(),
      })
      setNewNote('')
      await onNotesChanged()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleStatusChange(id, next) {
    try {
      await updatePviShelfNoteStatus(id, next)
      await onNotesChanged()
    } catch (e) {
      alert(`Failed to update status: ${e.message}`)
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this note?')) return
    try {
      await deletePviShelfNote(id)
      await onNotesChanged()
    } catch (e) {
      alert(`Failed to delete: ${e.message}`)
    }
  }

  const lotNotes  = notes
  const itemOnly  = allNotesForItem.filter(n => !lotNotes.some(ln => ln.id === n.id))

  return (
    <div style={{
      width: 380,
      flexShrink: 0,
      borderLeft: '1px solid var(--border)',
      background: 'var(--bg1, #fafafa)',
      display: 'flex',
      flexDirection: 'column',
      maxHeight: 'calc(100vh - 200px)',
      position: 'sticky',
      top: 16,
    }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{row.material_code}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
            {row.material_desc}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
            Lot {row.lot_code} · {row.cases_available} cs available
          </div>
        </div>
        <button className="settings-save-btn" onClick={onClose} style={{ fontSize: 10 }}>Close</button>
      </div>

      <div style={{ padding: '12px 16px', overflowY: 'auto', flex: 1 }}>
        {/* Add new note */}
        <div className="section-label" style={{ marginBottom: 6 }}>Add note</div>
        <textarea
          value={newNote}
          onChange={e => setNewNote(e.target.value)}
          placeholder="What's the situation? Include any customer conversation details…"
          rows={3}
          style={{
            width: '100%', fontSize: 11, fontFamily: 'var(--font-mono)',
            padding: 6, boxSizing: 'border-box', marginBottom: 6,
          }}
        />
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <input
            className="settings-field-input"
            placeholder="Your name"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            style={{ flex: 1, minWidth: 120, fontSize: 11 }}
          />
          <select
            className="est-drops-select"
            value={status}
            onChange={e => setStatus(e.target.value)}
            style={{ fontSize: 11 }}
          >
            {NOTE_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            className="settings-save-btn"
            onClick={handleAdd}
            disabled={busy}
            style={{ fontSize: 11 }}
          >
            {busy ? '…' : 'Add'}
          </button>
        </div>
        {err && <div style={{ fontSize: 10, color: '#e05a5a', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>{err}</div>}

        {/* Notes for this specific lot */}
        <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>
          This lot ({lotNotes.length})
        </div>
        {lotNotes.length === 0
          ? <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>No notes yet.</div>
          : lotNotes.map(n => (
              <NoteCard
                key={n.id}
                note={n}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
              />
            ))
        }

        {itemOnly.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>
              Other lots of this item ({itemOnly.length})
            </div>
            {itemOnly.map(n => (
              <NoteCard
                key={n.id}
                note={n}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
                showLot
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function NoteCard({ note, onStatusChange, onDelete, showLot }) {
  const created = note.created_at ? new Date(note.created_at) : null
  return (
    <div style={{
      padding: 8,
      background: 'var(--bg0, white)',
      border: '1px solid var(--border)',
      marginBottom: 6,
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>{note.author || '(anon)'}</span>
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
          {created ? created.toLocaleString() : ''}
        </span>
      </div>
      <div style={{ marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note.note}</div>
      {showLot && (
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 4 }}>Lot: {note.lot_code || '(none)'}</div>
      )}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="est-drops-select"
          value={note.status || 'open'}
          onChange={e => onStatusChange(note.id, e.target.value)}
          style={{ fontSize: 10, flex: 1, minWidth: 100 }}
        >
          {NOTE_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          className="settings-save-btn"
          onClick={() => onDelete(note.id)}
          style={{ fontSize: 9, color: '#e05a5a', borderColor: '#e05a5a' }}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

// ── Toast (dead simple, no library) ───────────────────────────────────────

let _flashTimer = null
function flash(msg) {
  let el = document.getElementById('pvi-flash-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'pvi-flash-toast'
    Object.assign(el.style, {
      position:  'fixed',
      bottom:    '24px',
      right:     '24px',
      padding:   '10px 16px',
      background: 'rgba(30, 30, 30, 0.92)',
      color:     'white',
      fontFamily: 'var(--font-mono, monospace)',
      fontSize:  '12px',
      borderRadius: '4px',
      zIndex:    9999,
      transition: 'opacity 0.2s ease',
      opacity:   '0',
      pointerEvents: 'none',
    })
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.style.opacity = '1'
  clearTimeout(_flashTimer)
  _flashTimer = setTimeout(() => { el.style.opacity = '0' }, 2200)
}
