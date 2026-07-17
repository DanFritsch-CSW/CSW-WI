import { useState, useMemo, useCallback, useEffect } from 'react'
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

const MODES = ['All', 'Occupied', 'Empty']

const DISC_TYPES = [
  { value: 'pallet_missing',  label: 'Pallet missing — in system, not physically there' },
  { value: 'pallet_extra',    label: 'Pallet extra — physically there, not in system' },
  { value: 'wrong_location',  label: 'Pallet in wrong location' },
  { value: 'count_mismatch',  label: 'Count mismatch — system qty vs physical qty differ' },
  { value: 'damaged',         label: 'Pallet damaged / unsaleable' },
  { value: 'other',           label: 'Other — see notes' },
]

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
          Location: <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{loc.id}</strong>
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
          <button onClick={() => canSave && onSave({ discType, lpRef, notes, initials, flaggedAt: new Date().toISOString() })} disabled={!canSave} style={{ padding: '7px 16px', borderRadius: 'var(--r-md)', fontSize 12, fontWeight: 600, border: '1px solid', borderColor: canSave ? 'rgba(239,68,68,0.5)' : 'var(--border)', background: canSave ? 'rgba(239,68,68,0.15)' : 'var(--bg3)', color: canSave ? 'var(--red)' : 'var(--text-secondary)', cursor: canSave ? 'pointer' : 'not-allowed' }}>Save flag</button>
        </div>
      </div>
    </Modal>
  )
}
