import { useState, useMemo, useCallback, useEffect } from 'react'
import { fetchInventoryLocations } from '../lib/omniInventory.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FACILITY_LIST = [
  { id: 'cal', label: 'Caledonia',       whName: 'CSW-Franksville' },
  { id: 'mad', label: 'Madison',          whName: 'CSW-Madison' },
  { id: 'ken', label: 'Kenosha',          whName: 'CSW-Kenosha' },
  { id: 'wr',  label: 'Wisconsin Rapids', whName: 'CSW-Wisconsin Rapids' },
  { id: 'ec',  label: 'Eau Claire',       whName: 'CSW-Eau Claire' },
]

const MODES = ['All', 'Occupied', 'Empty']

// Discrepancy types — drives the form dropdown and reconciliation action
const DISC_TYPES = [
  { value: 'pallet_missing',   label: 'Pallet missing — in system, not physically there' },
  { value: 'pallet_extra',     label: 'Pallet extra — physically there, not in system' },
  { value: 'wrong_location',   label: 'Pallet in wrong location' },
  { value: 'count_mismatch',   label: 'Count mismatch — system qty vs physical qty differ' },
  { value: 'damaged',          label: 'Pallet damaged / unsaleable' },
  { value: 'other',            label: 'Other — see notes' },
]

// ---------------------------------------------------------------------------
// Shared modal shell
// ---------------------------------------------------------------------------
function Modal({ onClose, children, maxWidth = 520 }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200, padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg1)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)', padding: '1.4rem',
          width: '100%', maxWidth, maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flag form modal — opens when user taps "+ flag"
// ---------------------------------------------------------------------------
function FlagFormModal({ loc, existing, onSave, onRemove, onClose }) {
  const [discType, setDiscType] = useState(existing?.discType || '')
  const [lpRef,    setLpRef]    = useState(existing?.lpRef    || '')
  const [notes,    setNotes]    = useState(existing?.notes    || '')
  const [initials, setInitials] = useState(existing?.initials || '')

  const canSave = discType.trim() !== ''

  const inp = {
    padding: '6px 10px', borderRadius: 'var(--r-md)',
    border: '1px solid var(--border)', background: 'var(--bg2)',
    color: 'var(--text-primary)', fontSize: 12, width: '100%',
    outline: 'none', boxSizing: 'border-box',
  }
  const lbl = {
    fontSize: 10, fontWeight: 600, letterSpacing: '.05em',
    color: 'var(--text-secondary)', display: 'block', marginBottom: 4,
  }
  const field = { marginBottom: 14 }

  return (
    <Modal onClose={onClose} maxWidth={480}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: 'var(--red)' }}>
          ⚑ Flag discrepancy
        </h3>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
          Location: <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{loc.id}</strong>
          <span style={{ marginLeft: 12, opacity: 0.5 }}>·</span>
          <span style={{ marginLeft: 12 }}>{loc.palletCount} pallet{loc.palletCount !== 1 ? 's' : ''} in system</span>
        </p>
      </div>

      {/* System LPs for reference */}
      {loc.pallets.length > 0 && (
        <div style={{
          padding: '8px 10px', borderRadius: 'var(--r-md)',
          background: 'var(--bg2)', marginBottom: 16, fontSize: 11,
        }}>
          <span style={{ ...lbl, marginBottom: 6 }}>SYSTEM LPs IN THIS LOCATION</span>
          {loc.pallets.map(p => (
            <div key={p.lp} style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              {p.lp}
              <span style={{ marginLeft: 10, color: 'var(--text-secondary)', opacity: 0.6, fontSize: 10 }}>
                {p.materialCode} · VL: {p.vendorLot} · SL: {p.sysLot} · {p.qty} units
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Form */}
      <div style={field}>
        <label style={lbl}>DISCREPANCY TYPE <span style={{ color: 'var(--red)' }}>*</span></label>
        <select
          value={discType}
          onChange={e => setDiscType(e.target.value)}
          style={{ ...inp, cursor: 'pointer' }}
        >
          <option value="">— Select type —</option>
          {DISC_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>

      <div style={field}>
        <label style={lbl}>LP REFERENCE (physical LP found, if applicable)</label>
        <input
          type="text"
          value={lpRef}
          onChange={e => setLpRef(e.target.value)}
          placeholder="e.g. CSW235182 or unknown"
          style={inp}
        />
      </div>

      <div style={field}>
        <label style={lbl}>NOTES</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Describe what you found physically. Include any LP numbers, material codes, pallet counts, or other details needed for WMS correction."
          rows={3}
          style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      <div style={{ ...field, marginBottom: 0 }}>
        <label style={lbl}>INITIALS</label>
        <input
          type="text"
          value={initials}
          onChange={e => setInitials(e.target.value.toUpperCase().slice(0, 4))}
          placeholder="e.g. JD"
          style={{ ...inp, width: 80 }}
        />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 20 }}>
        <div>
          {existing && (
            <button
              onClick={onRemove}
              style={{
                padding: '7px 14px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 500,
                border: '1px solid rgba(239,68,68,0.4)', background: 'transparent',
                color: 'var(--red)', cursor: 'pointer',
              }}
            >
              Remove flag
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: '7px 14px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 500,
              border: '1px solid var(--border)', background: 'var(--bg3)',
              color: 'var(--text-secondary)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => canSave && onSave({ discType, lpRef, notes, initials, flaggedAt: new Date().toISOString() })}
            disabled={!canSave}
            style={{
              padding: '7px 16px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 600,
              border: '1px solid',
              borderColor: canSave ? 'rgba(239,68,68,0.5)' : 'var(--border)',
              background: canSave ? 'rgba(239,68,68,0.15)' : 'var(--bg3)',
              color: canSave ? 'var(--red)' : 'var(--text-secondary)',
              cursor: canSave ? 'pointer' : 'not-allowed',
            }}
          >
            Save flag
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Discrepancy log modal — opened from the header button
// Shows all flagged locations with full notes, printable
// ---------------------------------------------------------------------------
function DiscrepancyLogModal({ discrepancies, allData, onClose }) {
  const flaggedIds = [...discrepancies.keys()]
  const items = flaggedIds.map(id => ({
    loc: allData.find(l => l.id === id),
    note: discrepancies.get(id),
  })).filter(x => x.loc)

  const typeLabel = val => DISC_TYPES.find(t => t.value === val)?.label ?? val

  return (
    <Modal onClose={onClose} maxWidth={620}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: 'var(--red)' }}>
          ⚑ Discrepancy log — cycle count
        </h3>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          {' · '}{items.length} location{items.length !== 1 ? 's' : ''} flagged
        </p>
      </div>

      {items.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No discrepancies logged.</p>
      ) : (
        items.map(({ loc, note }) => (
          <div
            key={loc.id}
            style={{
              padding: '12px 14px', marginBottom: 10,
              background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 'var(--r-md)',
            }}
          >
            {/* Location + type header */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                {loc.id}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '1px 7px',
                borderRadius: 8, background: 'rgba(239,68,68,0.15)', color: 'var(--red)',
              }}>
                {typeLabel(note.discType)}
              </span>
              {note.initials && (
                <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                  {note.initials} · {new Date(note.flaggedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>

            {/* System inventory snapshot */}
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: note.notes || note.lpRef ? 8 : 0 }}>
              <strong style={{ color: 'var(--text-primary)' }}>System:</strong>{' '}
              {loc.palletCount === 0
                ? 'No inventory in system'
                : `${loc.palletCount} pallet${loc.palletCount !== 1 ? 's' : ''} · ${loc.onHand.toLocaleString()} units`
              }
              {loc.pallets.slice(0, 3).map(p => (
                <span key={p.lp} style={{ display: 'block', paddingLeft: 12, fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 2 }}>
                  ↳ {p.lp} · {p.materialCode} · VL: {p.vendorLot} · {p.qty} units
                </span>
              ))}
              {loc.pallets.length > 3 && (
                <span style={{ display: 'block', paddingLeft: 12, fontSize: 10, marginTop: 2 }}>
                  + {loc.pallets.length - 3} more…
                </span>
              )}
            </div>

            {/* LP reference */}
            {note.lpRef && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                <strong style={{ color: 'var(--text-primary)' }}>Physical LP:</strong>{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{note.lpRef}</span>
              </div>
            )}

            {/* Free text notes */}
            {note.notes && (
              <div style={{
                marginTop: 6, padding: '6px 10px',
                background: 'var(--bg2)', borderRadius: 6,
                fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5,
              }}>
                {note.notes}
              </div>
            )}
          </div>
        ))
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          onClick={() => window.print()}
          style={{
            padding: '7px 14px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 500,
            border: '1px solid var(--border)', background: 'var(--bg2)',
            color: 'var(--text-primary)', cursor: 'pointer',
          }}
        >
          Print / Save PDF
        </button>
        <button
          onClick={onClose}
          style={{
            padding: '7px 14px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 500,
            border: '1px solid var(--border)', background: 'var(--bg3)',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}
        >
          Close
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function FilterPills({ items, active, onSelect }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {items.map(item => (
        <button
          key={item}
          onClick={() => onSelect(item)}
          style={{
            padding: '4px 12px', borderRadius: 'var(--r-md)', border: '1px solid',
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
            borderColor: active === item ? 'var(--gold)'           : 'var(--border)',
            background:  active === item ? 'rgba(196,160,80,0.12)' : 'var(--bg2)',
            color:       active === item ? 'var(--gold)'           : 'var(--text-secondary)',
          }}
        >
          {item}
        </button>
      ))}
    </div>
  )
}

function StatBar({ rows, discCount }) {
  const occ   = rows.filter(l => l.palletCount > 0).length
  const emp   = rows.filter(l => l.palletCount === 0).length
  const total = rows.reduce((s, l) => s + l.palletCount, 0)
  return (
    <div style={{
      display: 'flex', gap: '1.5rem', padding: '7px 14px',
      background: 'var(--bg2)', borderRadius: 'var(--r-md)',
      fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap', marginBottom: 10,
    }}>
      <span><strong style={{ color: 'var(--text-primary)' }}>{rows.length}</strong> locations</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{occ}</strong> occupied</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{emp}</strong> empty</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{total}</strong> total pallets</span>
      {discCount > 0 && (
        <span><strong style={{ color: 'var(--red)' }}>{discCount}</strong> flagged</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function InventoryReport() {
  const [data,        setData]        = useState([])
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const [facilityId, setFacilityId] = useState('cal')
  const [mode,       setMode]       = useState('All')
  const [search,     setSearch]     = useState('')
  const [expanded,   setExpanded]   = useState(new Set())

  // discrepancies: Map<locationId, { discType, lpRef, notes, initials, flaggedAt }>
  const [discrepancies, setDiscrepancies] = useState(new Map())

  // Modal state
  const [flagModal, setFlagModal] = useState(null)
  const [showLog,   setShowLog]   = useState(false)

  // ---------------------------------------------------------------------------
  // Fetch
  // Intentionally does NOT reset search — user may be filtered to an aisle
  // and want to refresh data without losing their filter context.
  // Search is only cleared when switching facilities.
  // ---------------------------------------------------------------------------
  const doFetch = useCallback(async (facId, clearSearch = false) => {
    setLoading(true)
    setError(null)
    setDiscrepancies(new Map())
    setExpanded(new Set())
    if (clearSearch) setSearch('')
    try {
      const result = await fetchInventoryLocations(facId)
      setData(result)
      setLastRefresh(new Date())
    } catch (e) {
      setError(e.message || 'Unknown error fetching inventory')
    } finally {
      setLoading(false)
    }
  }, [])

  // On mount — load default facility, no search to clear
  useEffect(() => { doFetch(facilityId) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Facility tab switch — clear search since location IDs differ between facilities
  const handleFacilitySwitch = (facId) => {
    setFacilityId(facId)
    doFetch(facId, true)
  }

  // Refresh button — keep search intact
  const handleRefresh = () => doFetch(facilityId, false)

  // ---------------------------------------------------------------------------
  // Flag handlers
  // ---------------------------------------------------------------------------
  const openFlagForm = useCallback((loc, e) => {
    e.stopPropagation()
    setFlagModal(loc)
  }, [])

  const saveFlag = useCallback((locId, note) => {
    setDiscrepancies(prev => {
      const next = new Map(prev)
      next.set(locId, note)
      return next
    })
    setFlagModal(null)
  }, [])

  const removeFlag = useCallback((locId) => {
    setDiscrepancies(prev => {
      const next = new Map(prev)
      next.delete(locId)
      return next
    })
    setFlagModal(null)
  }, [])

  // ---------------------------------------------------------------------------
  // Expand/collapse
  // ---------------------------------------------------------------------------
  const toggleExpand = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Filter
  // ---------------------------------------------------------------------------
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return data.filter(loc => {
      const mm = mode === 'All'
             || (mode === 'Occupied' && loc.palletCount > 0)
             || (mode === 'Empty'    && loc.palletCount === 0)
      const sm = !q
             || loc.id.toLowerCase().includes(q)
             || loc.pallets.some(p =>
                  p.lp.toLowerCase().includes(q) ||
                  p.materialCode.toLowerCase().includes(q) ||
                  p.vendorLot.toLowerCase().includes(q)
                )
      return mm && sm
    })
  }, [data, mode, search])

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const S = {
    page:        { padding: '1.5rem', maxWidth: 1200, margin: '0 auto' },
    pageHeader:  { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.25rem', gap: 12, flexWrap: 'wrap' },
    h1:          { fontSize: 22, fontWeight: 700, margin: '0 0 2px', color: 'var(--text-primary)', letterSpacing: '-0.5px' },
    sub:         { fontSize: 12, color: 'var(--text-secondary)', margin: 0 },
    btnRow:      { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
    btn:         { padding: '7px 14px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 },
    btnDanger:   { padding: '7px 14px', borderRadius: 'var(--r-md)', border: '1px solid rgba(239,68,68,0.5)', background: 'rgba(239,68,68,0.12)', color: 'var(--red)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 },
    filterRow:   { display: 'flex', gap: '1.25rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' },
    filterGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
    filterLabel: { fontSize: 10, color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '.06em' },
    tableWrap:   { border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' },
    table:       { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th:          { background: 'var(--bg2)', color: 'var(--text-secondary)', fontWeight: 600, textAlign: 'left',  padding: '7px 10px', borderBottom: '1px solid var(--border)', fontSize: 11 },
    thR:         { background: 'var(--bg2)', color: 'var(--text-secondary)', fontWeight: 600, textAlign: 'right', padding: '7px 10px', borderBottom: '1px solid var(--border)', fontSize: 11 },
  }

  const statusStyle = {
    occupied: { background: 'rgba(34,197,94,0.15)', color: '#4ade80' },
    empty:    { background: 'var(--bg3)',            color: 'var(--text-secondary)' },
  }

  const currentFacility = FACILITY_LIST.find(f => f.id === facilityId)

  return (
    <div className="page-content">
      <div style={S.page}>

        {/* ── Header ── */}
        <div style={S.pageHeader}>
          <div>
            <h1 style={S.h1}>
              INVENTORY <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>Location Contents</span>
            </h1>
            <p style={S.sub}>
              {currentFacility?.whName} · {lastRefresh
                ? `Last refreshed ${lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
                : 'Loading…'
              }
              <span style={{ margin: '0 8px', opacity: 0.3 }}>|</span>
              Omni · ~10–15 min WMS lag
            </p>
          </div>
          <div style={S.btnRow}>
            {discrepancies.size > 0 && (
              <button style={S.btnDanger} onClick={() => setShowLog(true)}>
                ⚑ {discrepancies.size} Discrepanc{discrepancies.size > 1 ? 'ies' : 'y'}
              </button>
            )}
            <button style={S.btn} onClick={handleRefresh} disabled={loading}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>

        {/* ── Facility tabs ── */}
        <div style={{ display: 'flex', gap: 4, marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          {FACILITY_LIST.map(f => (
            <button
              key={f.id}
              onClick={() => handleFacilitySwitch(f.id)}
              style={{
                padding: '5px 14px', borderRadius: 'var(--r-md)', border: '1px solid',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                borderColor: facilityId === f.id ? 'var(--gold)' : 'var(--border)',
                background:  facilityId === f.id ? 'rgba(196,160,80,0.12)' : 'var(--bg2)',
                color:       facilityId === f.id ? 'var(--gold)' : 'var(--text-secondary)',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* ── Filters ── */}
        <div style={S.filterRow}>
          <div style={S.filterGroup}>
            <span style={S.filterLabel}>SHOW</span>
            <FilterPills items={MODES} active={mode} onSelect={setMode} />
          </div>
          <div style={S.filterGroup}>
            <span style={S.filterLabel}>SEARCH (location / LP / material)</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="AA001A, LP-12345, 10003922…"
              style={{
                padding: '5px 10px', borderRadius: 'var(--r-md)',
                border: '1px solid var(--border)', background: 'var(--bg2)',
                color: 'var(--text-primary)', fontSize: 12, width: 240, outline: 'none',
              }}
            />
          </div>
        </div>

        {/* ── Stats ── */}
        {!loading && !error && <StatBar rows={filtered} discCount={discrepancies.size} />}

        {/* ── Loading ── */}
        {loading && (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>
            Fetching inventory from Omni…
          </div>
        )}

        {/* ── Error ── */}
        {!loading && error && (
          <div style={{
            padding: '1.25rem', borderRadius: 'var(--r-md)',
            border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.07)',
            color: 'var(--red)', fontSize: 13, marginBottom: 12,
          }}>
            <strong>Error loading inventory:</strong> {error}
            <button onClick={handleRefresh} style={{ marginLeft: 12, ...S.btn, fontSize: 11 }}>Retry</button>
          </div>
        )}

        {/* ── Table ── */}
        {!loading && !error && (
          <div style={S.tableWrap}>
            {filtered.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
                {data.length === 0 ? 'No inventory data returned from Omni.' : 'No locations match current filter.'}
              </div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={{ ...S.th,  width: 110 }}>Location</th>
                    <th style={{ ...S.thR, width: 70  }}>Pallets</th>
                    <th style={{ ...S.thR, width: 80  }}>Total Qty</th>
                    <th style={{ ...S.th,  width: 90  }}>Status</th>
                    <th style={S.th}>LP · Material · Lots</th>
                    <th style={{ ...S.th,  width: 80  }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(loc => {
                    const isEmpty      = loc.palletCount === 0
                    const isFlagged    = discrepancies.has(loc.id)
                    const isExpanded   = expanded.has(loc.id)
                    const hasInventory = loc.pallets.length > 0

                    return (
                      <>
                        {/* Location row */}
                        <tr
                          key={loc.id}
                          onClick={() => hasInventory && toggleExpand(loc.id)}
                          style={{
                            borderBottom: '1px solid var(--border)',
                            background: isFlagged ? 'rgba(239,68,68,0.06)' : 'transparent',
                            cursor: hasInventory ? 'pointer' : 'default',
                          }}
                        >
                          <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                            {hasInventory && (
                              <span style={{ color: 'var(--text-secondary)', marginRight: 4, fontSize: 10 }}>
                                {isExpanded ? '▾' : '▸'}
                              </span>
                            )}
                            {loc.id}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-primary)', fontWeight: 600 }}>
                            {loc.palletCount || '—'}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {loc.onHand > 0 ? loc.onHand.toLocaleString() : '—'}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <span style={{
                              ...(isEmpty ? statusStyle.empty : statusStyle.occupied),
                              padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600,
                            }}>
                              {isEmpty ? 'Empty' : 'Occupied'}
                            </span>
                          </td>
                          <td style={{ padding: '8px 10px', color: 'var(--text-secondary)', fontSize: 11 }}>
                            {isFlagged
                              ? <span style={{ color: 'var(--red)', fontSize: 10, fontWeight: 600 }}>
                                  ⚑ {DISC_TYPES.find(t => t.value === discrepancies.get(loc.id)?.discType)?.label ?? 'Flagged'}
                                </span>
                              : hasInventory && !isExpanded
                                ? `${loc.pallets.length} pallet${loc.pallets.length > 1 ? 's' : ''} — tap to expand`
                                : ''
                            }
                          </td>
                          <td style={{ padding: '8px 10px' }} onClick={e => e.stopPropagation()}>
                            <button
                              onClick={e => openFlagForm(loc, e)}
                              style={{
                                background: isFlagged ? 'rgba(239,68,68,0.1)' : 'transparent',
                                border: '1px solid',
                                borderColor: isFlagged ? 'rgba(239,68,68,0.5)' : 'var(--border)',
                                borderRadius: 'var(--r-md)',
                                padding: '3px 9px', fontSize: 10, fontWeight: 600,
                                color: isFlagged ? 'var(--red)' : 'var(--text-secondary)',
                                cursor: 'pointer',
                              }}
                            >
                              {isFlagged ? '⚑ edit flag' : '+ flag'}
                            </button>
                          </td>
                        </tr>

                        {/* Pallet detail rows */}
                        {hasInventory && isExpanded && loc.pallets.map((p, pi) => (
                          <tr
                            key={`${loc.id}-${pi}`}
                            style={{
                              borderBottom: pi === loc.pallets.length - 1
                                ? '1px solid var(--border)'
                                : '1px solid rgba(255,255,255,0.04)',
                              background: 'rgba(255,255,255,0.015)',
                            }}
                          >
                            <td style={{ padding: '4px 10px 4px 22px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                              ↳ {p.lp}
                            </td>
                            <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: 11 }}>1</td>
                            <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: 11 }}>
                              {p.qty.toLocaleString()}
                            </td>
                            <td />
                            <td style={{ padding: '4px 10px', fontSize: 11 }}>
                              <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{p.materialCode}</span>
                              {p.vendorLot && <span style={{ color: 'var(--text-secondary)', marginLeft: 10, fontSize: 10 }}>VL: {p.vendorLot}</span>}
                              {p.sysLot    && <span style={{ color: 'var(--text-secondary)', marginLeft: 8,  fontSize: 10 }}>SL: {p.sysLot}</span>}
                            </td>
                            <td />
                          </tr>
                        ))}
                      </>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Flag form modal ── */}
        {flagModal && (
          <FlagFormModal
            loc={flagModal}
            existing={discrepancies.get(flagModal.id) ?? null}
            onSave={note => saveFlag(flagModal.id, note)}
            onRemove={() => removeFlag(flagModal.id)}
            onClose={() => setFlagModal(null)}
          />
        )}

        {/* ── Discrepancy log modal ── */}
        {showLog && (
          <DiscrepancyLogModal
            discrepancies={discrepancies}
            allData={data}
            onClose={() => setShowLog(false)}
          />
        )}

      </div>
    </div>
  )
}
