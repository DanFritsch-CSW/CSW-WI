import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { fetchInventoryLocations, mergeEmptyLocations } from '../lib/omniInventory.js'
import {
  fetchInventoryDiscrepancies,
  upsertInventoryDiscrepancy,
  deleteInventoryDiscrepancy,
  purgeExpiredInventoryDiscrepancies,
} from '../lib/supabase.js'
import '../styles/inventory-report.css'

const FACILITY_LIST = [
  { id: 'cal', label: 'Caledonia',       whName: 'CSW-Franksville' },
  { id: 'mad', label: 'Madison',          whName: 'CSW-Madison' },
  { id: 'ken', label: 'Kenosha',          whName: 'CSW-Kenosha' },
  { id: 'wr',  label: 'Wisconsin Rapids', whName: 'CSW-Wisconsin Rapids' },
  { id: 'ec',  label: 'Eau Claire',       whName: 'CSW-Eau Claire' },
]

// 2026-08-29 (Nate/Josh, cnv_1az0gqac): the app's binary Occupied/Empty
// split doesn't match the legacy "available locations" report the team is
// used to. A location with exactly 1 LP in it still has open, usable
// space -- it isn't "occupied" in the sense that matters for putaway/
// replenishment planning, per Nate's ask: "could we add a flag for
// locations with only 1 license plate in it?" Rather than merge that into
// a broader "Available" bucket (an earlier pass at this did that, then
// Dan asked for it split back out into its own explicit tab instead), "1
// LP" is its own precise SHOW option -- Empty stays strictly 0 pallets,
// Occupied stays >0 (still includes 1-pallet locations too, since they do
// have something in them -- these tabs are independent lenses, not a
// mutually-exclusive partition), and "1 LP" is exactly 1 pallet.
//
// EXTENDED same day: added "3 LPs" (exactly 3 pallets) alongside "1 LP" --
// same independent-lens pattern, no new logic needed beyond one more
// literal count. This directly serves Dean's question in the same thread
// ("Are we flagging locations that have products with 3 lps when the
// product is double stacked so there should be 4?") in its simplest form:
// a raw exactly-3 count, with no material-group-aware "is this actually
// short of full" judgment attached. Still deliberately NOT building the
// full capacity-aware version -- that needs a material-group-to-capacity
// mapping Datex doesn't store anywhere (confirmed live:
// max_license_plate_quantity is null for all 20,299 locations at
// Caledonia) and real input from Nate on the exact capacity per material
// group before it can be built correctly.
const MODES = ['All', 'Occupied', 'Empty', '1 LP', '3 LPs']

const DISC_TYPES = [
  { value: 'pallet_missing',  label: 'Pallet missing — in system, not physically there' },
  { value: 'pallet_extra',    label: 'Pallet extra — physically there, not in system' },
  { value: 'wrong_location',  label: 'Pallet in wrong location' },
  { value: 'count_mismatch',  label: 'Count mismatch — system qty vs physical qty differ' },
  { value: 'damaged',         label: 'Pallet damaged / unsaleable' },
  { value: 'other',           label: 'Other — see notes' },
]

// 2026-08-27 (Dan, after the aisle-search fix above): the team physically
// refers to Room F1 locations at Caledonia in the older no-dash
// "A<letter><bay><level>" style (e.g. "AQ001A") -- confirmed by the one
// still-legacy-named location, AQ116B, which is literally F1-Q-116-B in
// that same shorthand. Datex's actual location_container_name for
// everything else in Room F1 uses the newer "F1-<letter>-<bay>-<level>"
// format, which Dan flagged as confusing on-screen since nobody on the
// floor calls it that. This is a DISPLAY-ONLY transform -- loc.id stays
// the real Datex name for every actual system interaction (the aisle
// search above, discrepancy-flag keys in Supabase, print-sheet grouping);
// only what's rendered for a human gets reformatted. Locations outside
// Room F1 (BA, BB, C9, Do, etc.) already use their native on-floor code
// as the raw name, so they pass through this function unchanged.
function friendlyLocationName(id) {
  const parts = id.split('-')
  if (parts.length === 4 && parts[0] === 'F1') {
    return `A${parts[1]}${parts[2]}${parts[3]}`
  }
  return id
}

function Modal({ onClose, children, maxWidth = 520 }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1.4rem', width: '100%', maxWidth, maxHeight: '90vh', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  )
}

function FlagFormModal({ loc, existing, onSave, onRemove, onClose }) {
  const [discType, setDiscType] = useState(existing?.discType || '')
  const [lpRef,    setLpRef]    = useState(existing?.lpRef    || '')
  const [notes,    setNotes]    = useState(existing?.notes    || '')
  const [initials, setInitials] = useState(existing?.initials || '')
  const canSave = discType.trim() !== ''
  const inp = { padding: '6px 10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text-primary)', fontSize: 12, width: '100%', outline: 'none', boxSizing: 'border-box' }
  const lbl = { fontSize: 10, fontWeight: 600, letterSpacing: '.05em', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }
  const field = { marginBottom: 14 }
  return (
    <Modal onClose={onClose} maxWidth={480}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: 'var(--red)' }}>⚑ Flag discrepancy</h3>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
          Location: <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{loc.displayId}</strong>
          <span style={{ marginLeft: 12, opacity: 0.5 }}>·</span>
          <span style={{ marginLeft: 12 }}>{loc.palletCount} pallet{loc.palletCount !== 1 ? 's' : ''} in system</span>
        </p>
      </div>
      {loc.pallets.length > 0 && (
        <div style={{ padding: '8px 10px', borderRadius: 'var(--r-md)', background: 'var(--bg2)', marginBottom: 16, fontSize: 11 }}>
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
      <div style={field}>
        <label style={lbl}>DISCREPANCY TYPE <span style={{ color: 'var(--red)' }}>*</span></label>
        <select value={discType} onChange={e => setDiscType(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="">— Select type —</option>
          {DISC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <div style={field}>
        <label style={lbl}>LP REFERENCE (physical LP found, if applicable)</label>
        <input type="text" value={lpRef} onChange={e => setLpRef(e.target.value)} placeholder="e.g. CSW235182 or unknown" style={inp} />
      </div>
      <div style={field}>
        <label style={lbl}>NOTES</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Describe what you found physically. Include any LP numbers, material codes, pallet counts, or other details needed for WMS correction." rows={3} style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
      </div>
      <div style={{ ...field, marginBottom: 0 }}>
        <label style={lbl}>INITIALS</label>
        <input type="text" value={initials} onChange={e => setInitials(e.target.value.toUpperCase().slice(0, 4))} placeholder="e.g. JD" style={{ ...inp, width: 80 }} />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 20 }}>
        <div>
          {existing && (
            <button onClick={onRemove} style={{ padding: '7px 14px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 500, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: 'var(--red)', cursor: 'pointer' }}>Remove flag</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 500, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => canSave && onSave({ discType, lpRef, notes, initials, flaggedAt: new Date().toISOString() })} disabled={!canSave} style={{ padding: '7px 16px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 600, border: '1px solid', borderColor: canSave ? 'rgba(239,68,68,0.5)' : 'var(--border)', background: canSave ? 'rgba(239,68,68,0.15)' : 'var(--bg3)', color: canSave ? 'var(--red)' : 'var(--text-secondary)', cursor: canSave ? 'pointer' : 'not-allowed' }}>Save flag</button>
        </div>
      </div>
    </Modal>
  )
}

function DiscrepancyLogModal({ discrepancies, allData, onClose }) {
  const flaggedIds = [...discrepancies.keys()]
  const items = flaggedIds.map(id => ({ loc: allData.find(l => l.id === id), note: discrepancies.get(id) })).filter(x => x.loc)
  const typeLabel = val => DISC_TYPES.find(t => t.value === val)?.label ?? val
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  const handlePrint = () => {
    const rows = items.map(({ loc, note }) => {
      const palletLines = loc.pallets.slice(0, 3).map(p =>
        `<div style="padding-left:14px;font-family:monospace;font-size:11px;color:#666;margin-top:2px">↳ ${p.lp} · ${p.materialCode} · VL: ${p.vendorLot} · ${p.qty} units</div>`
      ).join('')
      const moreLine = loc.pallets.length > 3
        ? `<div style="padding-left:14px;font-size:10px;color:#999">+ ${loc.pallets.length - 3} more…</div>`
        : ''
      const systemLine = loc.palletCount === 0
        ? 'No inventory in system'
        : `${loc.palletCount} pallet${loc.palletCount !== 1 ? 's' : ''} · ${loc.onHand.toLocaleString()} units`
      return `
        <div style="border:1px solid #e5e5e5;border-radius:6px;padding:12px 14px;margin-bottom:10px;page-break-inside:avoid">
          <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap">
            <span style="font-family:monospace;font-weight:700;font-size:13px">${loc.displayId}</span>
            <span style="font-size:10px;font-weight:600;padding:1px 7px;border-radius:8px;background:#fee2e2;color:#dc2626">${typeLabel(note.discType)}</span>
            ${note.initials ? `<span style="font-size:10px;color:#999;margin-left:auto">${note.initials} · ${new Date(note.flaggedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}
          </div>
          <div style="font-size:11px;color:#555;margin-bottom:${note.notes || note.lpRef ? '8' : '0'}px">
            <strong>System:</strong> ${systemLine}
            ${palletLines}${moreLine}
          </div>
          ${note.lpRef ? `<div style="font-size:11px;color:#555;margin-bottom:4px"><strong>Physical LP:</strong> <span style="font-family:monospace">${note.lpRef}</span></div>` : ''}
          ${note.notes ? `<div style="margin-top:6px;padding:6px 10px;background:#f9f9f9;border-radius:4px;font-size:12px;line-height:1.5">${note.notes}</div>` : ''}
        </div>`
    }).join('')

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Discrepancy Log</title>
      <style>
        body { font-family: -apple-system, sans-serif; padding: 24px; color: #111; }
        h2 { margin: 0 0 4px; font-size: 18px; }
        p  { margin: 0 0 16px; font-size: 12px; color: #666; }
        @page { margin: 0.75in; }
        @media print { body { padding: 0; } }
      </style></head><body>
      <h2>⚑ Discrepancy Log — Cycle Count</h2>
      <p>${dateStr} · ${items.length} location${items.length !== 1 ? 's' : ''} flagged</p>
      ${rows}
    </body></html>`

    const win = window.open('', '_blank', 'width=800,height=900')
    if (!win) { alert('Please allow popups to print the discrepancy log.'); return }
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print(); win.close() }, 300)
  }

  return (
    <Modal onClose={onClose} maxWidth={620}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: 'var(--red)' }}>⚑ Discrepancy log — cycle count</h3>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
          {dateStr}{' · '}{items.length} location{items.length !== 1 ? 's' : ''} flagged
        </p>
      </div>
      {items.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No discrepancies logged.</p>
      ) : items.map(({ loc, note }) => (
        <div key={loc.id} style={{ padding: '12px 14px', marginBottom: 10, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--r-md)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{loc.displayId}</span>
            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 8, background: 'rgba(239,68,68,0.15)', color: 'var(--red)' }}>{typeLabel(note.discType)}</span>
            {note.initials && <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 'auto' }}>{note.initials} · {new Date(note.flaggedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: note.notes || note.lpRef ? 8 : 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>System:</strong>{' '}
            {loc.palletCount === 0 ? 'No inventory in system' : `${loc.palletCount} pallet${loc.palletCount !== 1 ? 's' : ''} · ${loc.onHand.toLocaleString()} units`}
            {loc.pallets.slice(0, 3).map(p => (
              <span key={p.lp} style={{ display: 'block', paddingLeft: 12, fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 2 }}>↳ {p.lp} · {p.materialCode} · VL: {p.vendorLot} · {p.qty} units</span>
            ))}
            {loc.pallets.length > 3 && <span style={{ display: 'block', paddingLeft: 12, fontSize: 10, marginTop: 2 }}>+ {loc.pallets.length - 3} more…</span>}
          </div>
          {note.lpRef && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}><strong style={{ color: 'var(--text-primary)' }}>Physical LP:</strong> <span style={{ fontFamily: 'var(--font-mono)' }}>{note.lpRef}</span></div>}
          {note.notes && <div style={{ marginTop: 6, padding: '6px 10px', background: 'var(--bg2)', borderRadius: 6, fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 }}>{note.notes}</div>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={handlePrint} style={{ padding: '7px 14px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 500, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text-primary)', cursor: 'pointer' }}>Print / Save PDF</button>
        <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 500, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Close</button>
      </div>
    </Modal>
  )
}

function FilterPills({ items, active, onSelect }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {items.map(item => (
        <button key={item} onClick={() => onSelect(item)} style={{ padding: '4px 12px', borderRadius: 'var(--r-md)', border: '1px solid', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderColor: active === item ? 'var(--gold)' : 'var(--border)', background: active === item ? 'rgba(196,160,80,0.12)' : 'var(--bg2)', color: active === item ? 'var(--gold)' : 'var(--text-secondary)' }}>{item}</button>
      ))}
    </div>
  )
}

function StatBar({ rows, discCount, loadingEmpty }) {
  const occ     = rows.filter(l => l.palletCount > 0).length
  const emp     = rows.filter(l => l.palletCount === 0).length
  const oneLp   = rows.filter(l => l.palletCount === 1).length
  const threeLp = rows.filter(l => l.palletCount === 3).length
  const total   = rows.reduce((s, l) => s + l.palletCount, 0)
  return (
    <div style={{ display: 'flex', gap: '1.5rem', padding: '7px 14px', background: 'var(--bg2)', borderRadius: 'var(--r-md)', fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
      <span><strong style={{ color: 'var(--text-primary)' }}>{rows.length}</strong> locations</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{occ}</strong> occupied</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{loadingEmpty ? '…' : emp}</strong> empty</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{oneLp}</strong> with 1 LP</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{threeLp}</strong> with 3 LPs</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{total}</strong> total pallets</span>
      {discCount > 0 && <span><strong style={{ color: 'var(--red)' }}>{discCount}</strong> flagged</span>}
      {loadingEmpty && <span style={{ fontSize: 10, opacity: 0.5, fontStyle: 'italic' }}>loading empty locations…</span>}
    </div>
  )
}

export default function InventoryReport() {
  const [data,         setData]         = useState([])
  const [loading,      setLoading]      = useState(false)
  const [loadingEmpty, setLoadingEmpty] = useState(false)
  const [error,        setError]        = useState(null)
  const [lastRefresh,  setLastRefresh]  = useState(null)

  const [facilityId, setFacilityId] = useState('cal')
  const [mode,       setMode]       = useState('All')
  const [search,     setSearch]     = useState('')
  const [expanded,   setExpanded]   = useState(new Set())
  // 2026-08-28 (Cory/inventory team via Front, relayed by Dan): no tablets
  // on the floor yet, so the printed cycle-count sheet -- not the on-screen
  // "tap to expand" view -- is what they actually use. Legacy always
  // printed every location already expanded to pallet level; this sheet
  // only does that when this checkbox is checked, and it was defaulting to
  // off, so every print came out collapsed unless someone remembered to
  // check it first. Defaulting to true so printed sheets open already
  // expanded, matching legacy's always-open behavior, with zero change to
  // the underlying detailed-row/print-table logic (rev 4 pagination, see
  // the comment block below) -- still fully toggleable if a facility ever
  // wants the compact collapsed sheet instead.
  const [printDetailed, setPrintDetailed] = useState(true)

  const [discrepancies, setDiscrepancies] = useState(new Map())
  const [flagModal,     setFlagModal]     = useState(null)
  const [showLog,       setShowLog]       = useState(false)

  // 2026-08-28 (caught live: a WR print showed locations like "AD003D" --
  // real raw name "F1-D-003-D", which only exists at Caledonia/Franksville,
  // confirmed live in MotherDuck. Root cause: doFetch/loadDiscrepancies had
  // no guard against overlapping requests. Switching facilities (e.g. CAL
  // -> WR) fires a new doFetch while the previous facility's async
  // fetchInventoryLocations/mergeEmptyLocations/fetchInventoryDiscrepancies
  // calls may still be in flight; whichever one's setData/setDiscrepancies
  // call happened to resolve LAST won, even if it was for a facility the
  // user had already switched away from -- so the on-screen header
  // (currentFacility, derived purely from the facilityId state) could show
  // one facility while `data` silently still held another's rows. This
  // fetchSeqRef is a simple request-sequence guard: every doFetch call gets
  // a strictly increasing sequence number, and every state-setting callback
  // (including loadDiscrepancies, which runs concurrently and un-awaited)
  // checks its own sequence number is still the latest before writing state
  // -- any response for a since-superseded request is silently discarded
  // instead of overwriting newer data.
  const fetchSeqRef = useRef(0)

  const loadDiscrepancies = useCallback(async (facId, seq) => {
    const map = await fetchInventoryDiscrepancies(facId)
    if (fetchSeqRef.current !== seq) return // superseded by a newer facility switch/refresh
    setDiscrepancies(map)
  }, [])

  // Attaches the human-friendly display name (see friendlyLocationName above)
  // once, at load time, so every consumer of `data`/`filtered` has it --
  // including DiscrepancyLogModal, which renders from `allData={data}`
  // directly rather than the `filtered` derived list.
  const withDisplayId = (rows) => rows.map(loc => ({ ...loc, displayId: friendlyLocationName(loc.id) }))

  const doFetch = useCallback(async (facId, clearSearch = false) => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    setError(null)
    setExpanded(new Set())
    if (clearSearch) setSearch('')
    loadDiscrepancies(facId, seq)
    purgeExpiredInventoryDiscrepancies()
    try {
      const occupied = await fetchInventoryLocations(facId)
      if (fetchSeqRef.current !== seq) return // a newer facility switch/refresh already started
      setData(withDisplayId(occupied))
      setLastRefresh(new Date())
      setLoading(false)
      setLoadingEmpty(true)
      const merged = await mergeEmptyLocations(facId, occupied)
      if (fetchSeqRef.current !== seq) return
      setData(withDisplayId(merged))
    } catch (e) {
      if (fetchSeqRef.current !== seq) return
      setError(e.message || 'Unknown error fetching inventory')
    } finally {
      if (fetchSeqRef.current === seq) {
        setLoading(false)
        setLoadingEmpty(false)
      }
    }
  }, [loadDiscrepancies])

  useEffect(() => { doFetch(facilityId) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleFacilitySwitch = (facId) => { setFacilityId(facId); doFetch(facId, true) }
  const handleRefresh        = ()      => doFetch(facilityId, false)

  const openFlagForm = useCallback((loc, e) => { e.stopPropagation(); setFlagModal(loc) }, [])

  const saveFlag = useCallback((locId, note) => {
    setDiscrepancies(prev => { const n = new Map(prev); n.set(locId, note); return n })
    setFlagModal(null)
    upsertInventoryDiscrepancy(facilityId, locId, note)
  }, [facilityId])

  const removeFlag = useCallback((locId) => {
    setDiscrepancies(prev => { const n = new Map(prev); n.delete(locId); return n })
    setFlagModal(null)
    deleteInventoryDiscrepancy(facilityId, locId)
  }, [facilityId])

  const toggleExpand = useCallback((id) => { setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n }) }, [])

  // Toggles a body class (rather than a permanent global rule) so the shared
  // TopNav/utility-bar chrome is hidden only for this print action — see the
  // guarded @media print rules in inventory-report.css. Cleaned up via the
  // 'afterprint' event so it doesn't linger and affect prints of other tabs.
  const handlePrintSheet = useCallback(() => {
    document.body.classList.add('inv-printing')
    const cleanup = () => document.body.classList.remove('inv-printing')
    window.addEventListener('afterprint', cleanup, { once: true })
    window.print()
  }, [])

  // 2026-08-27 (Cory/Dan, cycle count on aisle "AQ" at CAL showing only 1
  // location): Room F1 at Caledonia was partially renamed at some point
  // from a legacy "A<letter>###" location-code format (e.g. "AQ116B") to
  // "F1-<letter>-###-#" (e.g. "F1-Q-116-B"). For most aisles that rename
  // is incomplete in Datex -- some locations still carry the old name,
  // most carry the new one -- so a plain "starts with" search on one
  // prefix only ever finds part of the aisle. Confirmed live in
  // MotherDuck: aisle Q has exactly 1 legacy-named location left plus 751
  // under the new prefix; aisles D/E/F/G/H/I/K have a similar split
  // (varying amounts still legacy-named); this 4-segment naming is unique
  // to Room F1 at Caledonia, no other room or facility uses it, so this
  // expansion can't accidentally broaden a search elsewhere.
  // Rather than have people remember which prefix a given aisle uses,
  // recognize a bare aisle-letter query (one letter, optionally preceded
  // by the legacy "A", e.g. "Q", "AQ", "AD", "K") and search BOTH the
  // literal typed prefix AND the equivalent "F1-<letter>-" prefix, so the
  // full aisle comes back regardless of which locations in it have been
  // renamed yet.
  //
  // FIXED 2026-08-27, same day: the regex below was missing the /i flag,
  // so it only matched a LITERAL uppercase "A" as the legacy prefix --
  // typing "aq" (lowercase, exactly what most people naturally type)
  // failed to match at all, silently falling back to a plain startsWith
  // that only caught the single literal AQ116B row and none of the
  // F1-Q-* locations. Caught live: Dan searched "aq" and only got 1
  // result again. Verified the /i fix against all four case variants
  // (AQ/aq/Aq/aQ) plus the untouched-by-design cases (C8B, F7X, AQ116B
  // itself, empty string) before shipping.
  const aisleLetterMatch = /^A?([A-Za-z])$/i.exec(search.trim())
  const aisleExpandedPrefix = aisleLetterMatch ? `f1-${aisleLetterMatch[1].toLowerCase()}-` : null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return data.filter(loc => {
      const mm = mode === 'All' || (mode === 'Occupied' && loc.palletCount > 0) || (mode === 'Empty' && loc.palletCount === 0) || (mode === '1 LP' && loc.palletCount === 1) || (mode === '3 LPs' && loc.palletCount === 3)
      const idLower = loc.id.toLowerCase()
      const sm = !q || idLower.startsWith(q) || (aisleExpandedPrefix && idLower.startsWith(aisleExpandedPrefix))
      return mm && sm
    })
  }, [data, mode, search, aisleExpandedPrefix])

  // Print worksheet data — a dedicated compact 2-column cycle-count sheet,
  // not a printed copy of the interactive table (see src/styles/inventory-report.css).
  // Respects the current facility/mode/search filter so narrowing the on-screen
  // view before printing produces a shorter sheet.
  //
  // Pagination history (this is rev 3):
  // - rev 1: JS-computed "pages" with a guessed rows-per-column count, forced
  //   page-break between chunks. The guess (30/36) didn't match actual
  //   rendered row height — real capacity was ~26 — so column 1 overflowed
  //   past its intended page, landing ahead of column 2's own content and
  //   scrambling reading order.
  // - rev 2: switched to native CSS multi-column flow (columns:2 +
  //   column-fill:auto) to avoid needing a row-count guess at all. This
  //   backfired worse — nesting CSS Grid rows inside a multicol container is
  //   a known-unreliable combination in Chromium's print engine: text
  //   overlapped/ran together on page 2, and the total-height miscalculation
  //   produced two extra blank pages at the end.
  // - rev 3: back to plain <table> markup per column (proven to render
  //   cleanly with no overlap in rev 1's actual output), still JS-chunked
  //   into pages with a forced page-break between chunks, but with a
  //   deliberately conservative rows-per-column budget (20/24) — well below
  //   the ~26 rows/column that rev 1 showed actually fit — so there's a
  //   safety cushion instead of any risk of overflow.
  // - rev 4 (current): Dan's rev-3 test (112 locations, WR) printed cleanly
  //   with pages 1-2 fully packed at 20/24 rows and noticeable blank space
  //   at the bottom of each. Nudged up to 24/28 — still a couple rows under
  //   the confirmed ~26 capacity for page 1's layout, and a similarly
  //   cautious step up for later pages (never directly confirmed, only
  //   inferred) — to shrink that dead space without re-risking overflow.
  //   Note: some blank space on the LAST page of any print is normal/
  //   expected whenever the location count doesn't divide evenly into full
  //   pages — that's not fixable by this constant, it's just how many
  //   locations were left over.
  const ROWS_FIRST_PAGE_COL = 24 // page 1 has less room — the header block above eats into it
  const ROWS_OTHER_PAGE_COL = 28
  const printDateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const printOccCount = filtered.filter(l => l.palletCount > 0).length
  const printEmpCount = filtered.filter(l => l.palletCount === 0).length
  const printFilterLabel = mode === 'All' ? 'All locations' : mode
  const printSearchLabel = search.trim() ? `starting with "${search.trim()}"` : ''
  // Detailed print mode (2026-08-11, Kaylee's ask): one row per pallet/LP
  // instead of one row per location, so Item Code + Description print
  // directly on the sheet — no need to tap "expand" on screen to verify an
  // item description against what's physically on the pallet (some items
  // don't have the item code on the case, only the description). Locations
  // with no pallets still get one row (blank code/description) so the
  // sheet still lists every location to check. Description is truncated to
  // one line via CSS ellipsis (see inventory-report.css), NOT wrapped, so
  // row height — and therefore the page-chunking math below — stays the
  // same as the standard sheet.
  //
  // FIXED 2026-08-28 (Cory/inventory team, same Front feedback as the
  // printDetailed-default-true fix above): the ask was specifically for
  // the LP number itself to print, not just item code/description --
  // pointed to the on-screen "tap to expand" view (which already shows
  // "LP178459" etc per pallet) as what the printout should match. Added
  // `lp` to each detailed print row and a new LP column to the print
  // table (see inventory-report.css for the column-width rebalance this
  // required to fit a 7th column into the existing tuned 2-column-per-page
  // layout without changing row height).
  const printDetailRows = useMemo(() => {
    if (!printDetailed) return []
    return filtered.flatMap(loc => {
      const flagged = discrepancies.has(loc.id)
      if (loc.pallets.length === 0) {
        return [{ key: loc.id, locId: loc.displayId, lp: '', itemCode: '', description: '', cases: loc.onHand, flagged }]
      }
      return loc.pallets.map((p, pi) => ({
        key: `${loc.id}-${pi}`,
        locId: loc.displayId,
        lp: p.lp,
        itemCode: p.materialCode,
        description: p.materialDescription,
        cases: p.qty,
        flagged,
      }))
    })
  }, [filtered, discrepancies, printDetailed])

  // Same JS-chunked, forced-page-break pagination as the standard sheet (see
  // rev-history comment above) — reused for detailed rows since single-line
  // (ellipsis-truncated) rows should render at the same height. Not yet
  // print-tested with the extra columns — verify on a real multi-page
  // facility (e.g. WR) before relying on it, same as every prior revision
  // to this sheet.
  const chunkIntoPages = (rows) => {
    const pages = []
    let idx = 0
    let isFirst = true
    while (idx < rows.length) {
      const perCol = isFirst ? ROWS_FIRST_PAGE_COL : ROWS_OTHER_PAGE_COL
      const chunk = rows.slice(idx, idx + perCol * 2)
      pages.push([chunk.slice(0, perCol), chunk.slice(perCol)])
      idx += perCol * 2
      isFirst = false
    }
    return pages
  }

  const printPages = useMemo(
    () => chunkIntoPages(printDetailed ? printDetailRows : filtered),
    [filtered, printDetailed, printDetailRows]
  )

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
      <div style={S.page} className="inv-no-print">

        <div style={S.pageHeader}>
          <div>
            <h1 style={S.h1}>INVENTORY <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>Location Contents</span></h1>
            <p style={S.sub}>
              {currentFacility?.whName} · {lastRefresh ? `Last refreshed ${lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` : 'Loading…'}
              <span style={{ margin: '0 8px', opacity: 0.3 }}>|</span>
              Omni · ~10–15 min WMS lag
            </p>
          </div>
          <div style={S.btnRow}>
            {discrepancies.size > 0 && <button style={S.btnDanger} onClick={() => setShowLog(true)}>⚑ {discrepancies.size} Discrepanc{discrepancies.size > 1 ? 'ies' : 'y'}</button>}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }} title="Shows LP #, Item Code + Description on screen and on the printed sheet, one line per pallet/LP — for verifying counts against the description when the case/pallet isn't labeled with the item code, and matching each pallet to its LP.">
              <input type="checkbox" checked={printDetailed} onChange={e => setPrintDetailed(e.target.checked)} />
              Include LP, item code & description
            </label>
            <button style={S.btn} onClick={handlePrintSheet} title="Prints the currently filtered location list as a compact 2-column cycle-count sheet with Pallets/Cases columns plus blank Actual Ct / Notes for hand-written counts. Filter to Occupied or search a location prefix first to keep it short.">🖨 Print count sheet</button>
            <button style={S.btn} onClick={handleRefresh} disabled={loading}>{loading ? 'Loading…' : '↻ Refresh'}</button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          {FACILITY_LIST.map(f => (
            <button key={f.id} onClick={() => handleFacilitySwitch(f.id)} style={{ padding: '5px 14px', borderRadius: 'var(--r-md)', border: '1px solid', fontSize: 12, fontWeight: 600, cursor: 'pointer', borderColor: facilityId === f.id ? 'var(--gold)' : 'var(--border)', background: facilityId === f.id ? 'rgba(196,160,80,0.12)' : 'var(--bg2)', color: facilityId === f.id ? 'var(--gold)' : 'var(--text-secondary)' }}>{f.label}</button>
          ))}
        </div>

        <div style={S.filterRow}>
          <div style={S.filterGroup}>
            <span style={S.filterLabel}>SHOW</span>
            <FilterPills items={MODES} active={mode} onSelect={setMode} />
          </div>
          <div style={S.filterGroup}>
            <span style={S.filterLabel}>LOCATION (starts with)</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="P, AD, C8B, F7X…"
              style={{ padding: '5px 10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text-primary)', fontSize: 12, width: 200, outline: 'none' }}
            />
          </div>
        </div>

        {!loading && !error && <StatBar rows={filtered} discCount={discrepancies.size} loadingEmpty={loadingEmpty} />}

        {loading && (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>
            Fetching inventory from Omni…
          </div>
        )}

        {!loading && error && (
          <div style={{ padding: '1.25rem', borderRadius: 'var(--r-md)', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.07)', color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>
            <strong>Error loading inventory:</strong> {error}
            <button onClick={handleRefresh} style={{ marginLeft: 12, ...S.btn, fontSize: 11 }}>Retry</button>
          </div>
        )}

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
                    <th style={S.th}>{printDetailed ? 'Item Code · Description' : 'LP · Material · Lots'}</th>
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
                        <tr key={loc.id} onClick={() => hasInventory && toggleExpand(loc.id)} style={{ borderBottom: '1px solid var(--border)', background: isFlagged ? 'rgba(239,68,68,0.06)' : 'transparent', cursor: hasInventory ? 'pointer' : 'default' }}>
                          <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                            {hasInventory && <span style={{ color: 'var(--text-secondary)', marginRight: 4, fontSize: 10 }}>{isExpanded ? '▾' : '▸'}</span>}
                            {loc.displayId}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-primary)', fontWeight: 600 }}>{loc.palletCount || '—'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-secondary)' }}>{loc.onHand > 0 ? loc.onHand.toLocaleString() : '—'}</td>
                          <td style={{ padding: '8px 10px' }}>
                            <span style={{ ...(isEmpty ? statusStyle.empty : statusStyle.occupied), padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>
                              {isEmpty ? 'Empty' : 'Occupied'}
                            </span>
                          </td>
                          <td style={{ padding: '8px 10px', color: 'var(--text-secondary)', fontSize: 11 }}>
                            {isFlagged
                              ? <span style={{ color: 'var(--red)', fontSize: 10, fontWeight: 600 }}>⚑ {DISC_TYPES.find(t => t.value === discrepancies.get(loc.id)?.discType)?.label ?? 'Flagged'}</span>
                              : hasInventory && !isExpanded
                                ? (printDetailed && loc.pallets.length === 1
                                    ? <span><span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{loc.pallets[0].materialCode}</span>{loc.pallets[0].materialDescription && <span> — {loc.pallets[0].materialDescription}</span>}</span>
                                    : `${loc.pallets.length} pallet${loc.pallets.length > 1 ? 's' : ''} — tap to expand`)
                                : ''
                            }
                          </td>
                          <td style={{ padding: '8px 10px' }} onClick={e => e.stopPropagation()}>
                            <button onClick={e => openFlagForm(loc, e)} style={{ background: isFlagged ? 'rgba(239,68,68,0.1)' : 'transparent', border: '1px solid', borderColor: isFlagged ? 'rgba(239,68,68,0.5)' : 'var(--border)', borderRadius: 'var(--r-md)', padding: '3px 9px', fontSize: 10, fontWeight: 600, color: isFlagged ? 'var(--red)' : 'var(--text-secondary)', cursor: 'pointer' }}>
                              {isFlagged ? '⚑ edit flag' : '+ flag'}
                            </button>
                          </td>
                        </tr>
                        {hasInventory && isExpanded && loc.pallets.map((p, pi) => (
                          <tr key={`${loc.id}-${pi}`} style={{ borderBottom: pi === loc.pallets.length - 1 ? '1px solid var(--border)' : '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.015)' }}>
                            <td style={{ padding: '4px 10px 4px 22px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>↳ {p.lp}</td>
                            <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: 11 }}>1</td>
                            <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: 11 }}>{p.qty.toLocaleString()}</td>
                            <td />
                            <td style={{ padding: '4px 10px', fontSize: 11 }}>
                              <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{p.materialCode}</span>
                              {printDetailed && p.materialDescription && <span style={{ color: 'var(--text-secondary)', marginLeft: 8, fontSize: 10 }}>{p.materialDescription}</span>}
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

        {flagModal && <FlagFormModal loc={flagModal} existing={discrepancies.get(flagModal.id) ?? null} onSave={note => saveFlag(flagModal.id, note)} onRemove={() => removeFlag(flagModal.id)} onClose={() => setFlagModal(null)} />}
        {showLog   && <DiscrepancyLogModal discrepancies={discrepancies} allData={data} onClose={() => setShowLog(false)} />}

      </div>

      {/* Print-only cycle-count worksheet — hidden on screen, rendered only via
          @media print in inventory-report.css. Plain HTML tables (2 per
          page-chunk), pre-chunked into printPages above with a forced
          page-break between chunks — see the pagination-history comment
          above for why this reverted away from CSS multicol. */}
      <div className="inv-print-only">
        <div className="inv-print-header">
          <div className="title">Central Storage &amp; Warehouse — Cycle Count Sheet</div>
          <div className="meta">{currentFacility?.label} ({currentFacility?.whName}) · {printFilterLabel}{printSearchLabel ? `, ${printSearchLabel}` : ''}</div>
          <div className="meta">Printed {printDateStr} · {filtered.length} location{filtered.length !== 1 ? 's' : ''} · {printOccCount} occupied · {printEmpCount} empty{discrepancies.size > 0 ? ` · ${discrepancies.size} already flagged (⚑)` : ''}</div>
          {printDetailed ? (
            <div className="meta small">One row per pallet/LP, with LP # · Cases = packaged qty on that pallet · Description truncated to one line — use the on-screen "tap to expand" view for the full text if it's cut off</div>
          ) : (
            <div className="meta small">Pallets = LP count in system · Cases = total packaged qty (same figure shown on-screen as "Total Qty" — flag if this isn't the case-level number you need)</div>
          )}
        </div>
        {printPages.map((cols, pi) => (
          <div className="inv-print-page" key={pi}>
            <div className="inv-print-columns">
              {cols.map((col, ci) => (
                <table className={printDetailed ? 'inv-print-table inv-print-table-detailed' : 'inv-print-table'} key={ci}>
                  <thead>
                    {printDetailed ? (
                      <tr>
                        <th className="d-loc-col">Location</th>
                        <th className="d-lp-col">LP</th>
                        <th className="d-code-col">Item Code</th>
                        <th className="d-desc-col">Description</th>
                        <th className="d-num-col">Cases</th>
                        <th className="d-blank-sm">Actual Ct</th>
                        <th className="d-blank-lg">Notes</th>
                      </tr>
                    ) : (
                      <tr>
                        <th className="loc-col">Location</th>
                        <th className="num-col">Pallets</th>
                        <th className="num-col">Cases</th>
                        <th className="blank-col-sm">Actual Ct</th>
                        <th className="blank-col-lg">Notes</th>
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {printDetailed ? col.map(row => (
                      <tr key={row.key}>
                        <td className="loc">{row.locId}{row.flagged && <span className="flag"> ⚑</span>}</td>
                        <td className="lp">{row.lp || '—'}</td>
                        <td className="code">{row.itemCode || '—'}</td>
                        <td className="desc">{row.description || '—'}</td>
                        <td>{row.cases > 0 ? row.cases.toLocaleString() : '—'}</td>
                        <td></td>
                        <td></td>
                      </tr>
                    )) : col.map(loc => (
                      <tr key={loc.id}>
                        <td className="loc">{loc.displayId}{discrepancies.has(loc.id) && <span className="flag"> ⚑</span>}</td>
                        <td>{loc.palletCount || '—'}</td>
                        <td>{loc.onHand > 0 ? loc.onHand.toLocaleString() : '—'}</td>
                        <td></td>
                        <td></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
