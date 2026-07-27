import { Fragment, useMemo, useState } from 'react'
import {
  fmtInt, fmtPct, utilBand, ZONES,
  fetchMaterialsForCustomer, addMaterialStacking, updateMaterialStacking, deleteMaterialStacking,
  updateRoomZone, computeRoomCapacityUsage,
} from '../../lib/spacePlanning.js'
import { smallBtnStyle, StackModeBadge, StackModeToggle } from './SpacePlanningTab.jsx'

// Companion module to SpacePlanningTab.jsx (Phase 4b, 2026-07-25) — split out
// here once SpacePlanningTab.jsx crossed ~80KB, per this project's standing
// practice of moving new logic into companion modules rather than continuing
// to grow one large file (large files are fragile to push via
// create_or_update_file). Contains:
//   - AisleOccupancyPanel — live per-aisle occupancy drill-down (which
//     customers are physically in an aisle right now, by LP count), rendered
//     by AisleRow when its label is clicked. Visibility only — does not feed
//     capacity math (aisles routinely mix multiple customers, confirmed live
//     before building this; no way to resolve to one number without bay-level
//     tracking this app doesn't have).
//   - MaterialStackingSubsection / MaterialStackingRow / MaterialStackingAddRow
//     — material-level stacking EXCEPTIONS layered on top of a customer's
//     default stack mode (space_customer_stacking). Per Dan's reminder:
//     "only select customer and potentially select materials are able to be
//     double stacked" — most materials for a customer simply inherit the
//     customer default and never need an entry here. Live material dropdown
//     (fetchMaterialsForCustomer) keeps this scalable as customers add/retire
//     materials over time — no hardcoded lists, no seeding.
//   - ZoneCell / ZoneUtilizationSummary — added 2026-07-25 per Dan's ask for
//     (a) editing a room's temperature zone through the UI (previously
//     seed-only, no edit path) and (b) a collective utilization rollup by
//     zone (Freezer/Cooler/Dry/Deep Freeze) at the top of the facility view.
//     Both reuse computeRoomCapacityUsage from spacePlanning.js — the exact
//     same cap/effectiveUsed formula RoomRow uses per-room, just grouped and
//     summed by zone here instead of displayed per-room.

export function AisleOccupancyPanel({ occupants, loading, error, hasDatexMapping }) {
  const sorted = useMemo(() => [...(occupants || [])].sort((a, b) => b.lps - a.lps), [occupants])
  return (
    <div style={{
      gridColumn: '1 / -1',
      padding: '8px 10px 8px 20px',
      background: 'var(--bg2, #f8f9fb)',
      borderRadius: 6,
      marginTop: 2, marginBottom: 2,
    }}>
      {!hasDatexMapping && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          No Datex aisle container linked — can't look up live occupancy.
        </div>
      )}
      {hasDatexMapping && loading && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Loading who's in this aisle…</div>
      )}
      {hasDatexMapping && !loading && error && (
        <div style={{ fontSize: 11, color: 'var(--red, #c0392b)' }}>Couldn't load occupancy — {error}</div>
      )}
      {hasDatexMapping && !loading && !error && sorted.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>No active inventory found in this aisle right now.</div>
      )}
      {hasDatexMapping && !loading && !error && sorted.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.6fr', rowGap: 3, columnGap: 10, fontSize: 12 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.06em' }}>CUSTOMER (LIVE)</div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.06em', textAlign: 'right' }}>LPs</div>
          {sorted.map((o, i) => (
            <Fragment key={`${o.projectName}-${i}`}>
              <div style={{ color: 'var(--text-primary)' }}>{o.projectName}</div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--text-secondary)' }}>{fmtInt(o.lps)}</div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}


export function MaterialStackingSubsection({ facility, customerName, materials, loading, onMaterialsChanged }) {
  const [adding, setAdding] = useState(false)
  const [options, setOptions] = useState({ status: 'idle', list: [] }) // idle | loading | ready | error

  // customerName here is space_customer_stacking.customer_name, which may be
  // a shortened name (e.g. "Jones Dairy Farm") rather than the full Datex
  // project_name ("Jones Dairy Farm - CSW-Madison") for rows added before
  // this feature existed. The backend matches on prefix (ILIKE), not exact
  // equality (fixed 2026-07-25 — an exact match was silently returning zero
  // rows for these older entries, which this component then wrongly reported
  // as a load failure rather than "no live materials found").
  function ensureOptionsLoaded() {
    if (options.status !== 'idle') return
    setOptions({ status: 'loading', list: [] })
    fetchMaterialsForCustomer(facility, customerName).then(list => {
      setOptions(list == null ? { status: 'error', list: [] } : { status: 'ready', list })
    })
  }

  return (
    <div style={{
      padding: '8px 14px 12px 30px',
      borderBottom: '1px solid var(--border-subtle, #eceff5)',
      background: 'var(--bg2, #f8f9fb)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{
          fontSize: 10, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          Material exceptions
        </span>
        {!adding && (
          <button
            type="button"
            onClick={() => { ensureOptionsLoaded(); setAdding(true) }}
            style={smallBtnStyle('var(--text-secondary)')}
          >
            + Add material exception
          </button>
        )}
      </div>

      {loading && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Loading…</div>
      )}

      {!loading && materials.length === 0 && !adding && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          No exceptions yet — every material for this customer follows the customer-level default above.
        </div>
      )}

      {!loading && materials.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.7fr 1.3fr 0.7fr', rowGap: 4, columnGap: 10, fontSize: 12, alignItems: 'center' }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.06em' }}>MATERIAL</div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.06em' }}>MODE</div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.06em' }}>NOTES</div>
          <div />
          {materials.map(m => (
            <MaterialStackingRow
              key={m.id}
              row={m}
              onUpdated={updated => onMaterialsChanged(materials.map(x => x.id === updated.id ? updated : x))}
              onDeleted={id => onMaterialsChanged(materials.filter(x => x.id !== id))}
            />
          ))}
        </div>
      )}

      {adding && (
        <MaterialStackingAddRow
          facility={facility}
          customerName={customerName}
          existingNames={materials.map(m => m.material_name.toLowerCase())}
          options={options}
          onAdded={row => {
            onMaterialsChanged([...materials, row])
            setAdding(false)
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )
}

function MaterialStackingRow({ row, onUpdated, onDeleted }) {
  const [editing, setEditing] = useState(false)
  const [stackMode, setStackMode] = useState(row.stack_mode)
  const [notes, setNotes] = useState(row.notes || '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [err, setErr] = useState(null)

  async function save() {
    setSaving(true)
    setErr(null)
    const result = await updateMaterialStacking(row.id, { stackMode, notes })
    setSaving(false)
    if (result.success) {
      onUpdated(result.row)
      setEditing(false)
    } else {
      setErr(result.error)
    }
  }

  function cancel() {
    setStackMode(row.stack_mode)
    setNotes(row.notes || '')
    setEditing(false)
    setErr(null)
  }

  async function handleDelete() {
    if (!window.confirm(`Remove exception for "${row.material_name}"?`)) return
    setDeleting(true)
    const result = await deleteMaterialStacking(row.id)
    setDeleting(false)
    if (result.success) {
      onDeleted(row.id)
    } else {
      setErr(result.error)
    }
  }

  if (editing) {
    return (
      <>
        <div style={{ color: 'var(--text-primary)' }}>
          {row.material_lookup_code && (
            <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11 }}>
              {row.material_lookup_code}{' '}
            </span>
          )}
          {row.material_name}
        </div>
        <StackModeToggle value={stackMode} onChange={setStackMode} disabled={saving} />
        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          disabled={saving}
          style={{ fontSize: 12, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 4, width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" onClick={save} disabled={saving} style={smallBtnStyle('var(--green, #1a8a52)')}>
            {saving ? '…' : 'Save'}
          </button>
          <button type="button" onClick={cancel} disabled={saving} style={smallBtnStyle('var(--text-dim)')}>X</button>
        </div>
        {err && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--red, #c0392b)' }}>{err}</div>}
      </>
    )
  }

  return (
    <>
      <div style={{ color: 'var(--text-primary)' }}>
        {row.material_lookup_code && (
          <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11 }}>
            {row.material_lookup_code}{' '}
          </span>
        )}
        {row.material_name}
      </div>
      <StackModeBadge mode={row.stack_mode} />
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{row.notes || '—'}</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" onClick={() => setEditing(true)} style={smallBtnStyle('var(--text-secondary)')}>Edit</button>
        <button type="button" onClick={handleDelete} disabled={deleting} style={smallBtnStyle('var(--red, #c0392b)')}>
          {deleting ? '…' : 'X'}
        </button>
      </div>
      {err && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--red, #c0392b)' }}>{err}</div>}
    </>
  )
}

const MATERIAL_OTHER_OPTION = '__other__'

function MaterialStackingAddRow({ facility, customerName, existingNames, options, onAdded, onCancel }) {
  const [selected, setSelected] = useState('')
  const [manualName, setManualName] = useState('')
  const [stackMode, setStackMode] = useState('single')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const useManual = options.status !== 'ready' || options.list.length === 0 || selected === MATERIAL_OTHER_OPTION
  const materialName = useManual ? manualName.trim() : selected
  const selectedOption = options.list.find(o => o.materialName === selected)

  async function handleAdd() {
    if (!materialName) return
    if (existingNames.includes(materialName.toLowerCase())) {
      setErr('That material already has an exception for this customer')
      return
    }
    setSaving(true)
    setErr(null)
    const result = await addMaterialStacking(facility, {
      customerName,
      materialName,
      lookupCode: useManual ? null : (selectedOption?.lookupCode || null),
      stackMode,
      notes,
    })
    setSaving(false)
    if (result.success) {
      onAdded(result.row)
    } else {
      setErr(result.error)
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 }}>
      {options.status === 'ready' && options.list.length > 0 ? (
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          disabled={saving}
          style={{ flex: '1 1 220px', fontSize: 13, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, background: '#fff' }}
        >
          <option value="">Select material…</option>
          {options.list.map(o => (
            <option key={o.materialName} value={o.materialName}>
              {o.lookupCode ? `${o.lookupCode} — ` : ''}{o.materialName} ({fmtInt(o.lps)} LPs)
            </option>
          ))}
          <option value={MATERIAL_OTHER_OPTION}>Other / not listed…</option>
        </select>
      ) : (
        <span style={{ flex: '1 1 220px', fontSize: 11, color: 'var(--amber, #a07818)' }}>
          {options.status === 'loading'
            ? 'Loading live material list…'
            : options.status === 'error'
              ? "Couldn't load live material list — enter manually"
              : `No live materials with on-hand inventory found for "${customerName}" — enter manually`}
        </span>
      )}
      {useManual && (
        <input
          value={manualName}
          onChange={e => setManualName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
          placeholder="Material name"
          disabled={saving}
          style={{ flex: '1 1 180px', fontSize: 13, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }}
        />
      )}
      <StackModeToggle value={stackMode} onChange={setStackMode} disabled={saving} />
      <input
        value={notes}
        onChange={e => setNotes(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
        placeholder="Notes (optional)"
        disabled={saving}
        style={{ flex: '1 1 200px', fontSize: 12, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }}
      />
      <button type="button" onClick={handleAdd} disabled={saving || !materialName} style={smallBtnStyle('var(--brand, #a07818)', true)}>
        {saving ? 'Adding…' : '+ Add'}
      </button>
      <button type="button" onClick={onCancel} disabled={saving} style={smallBtnStyle('var(--text-dim)')}>Cancel</button>
      {err && <span style={{ fontSize: 11, color: 'var(--red, #c0392b)', flexBasis: '100%' }}>{err}</span>}
    </div>
  )
}

// Click-to-edit temperature zone cell, replacing what was a static display-
// only zone label in RoomRow. Same immediate-save pattern as CapacityCell's
// click-to-edit, but simpler — a single <select> with no separate Save/Cancel,
// since there's only one value to change. Room's `zone` field previously had
// no edit path in the app at all — it was seed-only.
export function ZoneCell({ room, onRoomUpdated }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const zoneInfo = ZONES[room.zone] || { label: room.zone || '—', color: 'var(--text-dim)' }

  async function handleChange(e) {
    const nextZone = e.target.value
    if (nextZone === room.zone) { setEditing(false); return }
    setSaving(true)
    setErr(null)
    const result = await updateRoomZone(room.id, nextZone)
    setSaving(false)
    if (result.success) {
      onRoomUpdated?.(room.id, { zone: nextZone })
      setEditing(false)
    } else {
      setErr(result.error || 'Save failed')
    }
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <select
          autoFocus
          defaultValue={room.zone}
          disabled={saving}
          onChange={handleChange}
          onBlur={() => !saving && setEditing(false)}
          style={{ fontSize: 11, padding: '2px 4px', border: '1px solid var(--border)', borderRadius: 4, background: '#fff' }}
        >
          {Object.values(ZONES).map(z => (
            <option key={z.id} value={z.id}>{z.label}</option>
          ))}
        </select>
        {err && <span style={{ fontSize: 9, color: 'var(--red, #c0392b)' }}>{err}</span>}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to change temperature zone"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 11, color: 'var(--text-secondary)',
        background: 'none', border: '1px dashed transparent', borderRadius: 4,
        padding: '2px 4px', cursor: 'pointer', font: 'inherit',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent' }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: zoneInfo.color, display: 'inline-block' }} />
      {zoneInfo.label}
    </button>
  )
}

// Collective utilization by temperature zone, shown at the top of the
// facility view (before the per-room table) — Dan's ask, 2026-07-25:
// "Freezer 83%, Cooler 75%, Dry 95%" at a glance, without scanning every
// room row. Sums each room's cap/effectiveUsed (via computeRoomCapacityUsage
// — the identical formula RoomRow already uses per-room) grouped by
// row.zone, then divides. Rooms with cap<=0 (no capacity data at all yet)
// are excluded from the sum rather than counted as 0/0. Gated behind the
// same liveLoading/aislesLoading flags the per-room table uses, so this
// doesn't show a misleadingly low number while data is still arriving.
export function ZoneUtilizationSummary({ rows, aislesByRoomId, aisleOccupancy, aisleOccupancyLoading, customerStackingRows, customerStackingLoading, aislesLoading, liveLoading }) {
  const loading = liveLoading || aislesLoading

  const zoneTotals = useMemo(() => {
    if (loading) return null
    const totals = new Map()
    for (const row of rows) {
      const aisles = aislesByRoomId.get(row.id)
      const occupancyReady = !aisleOccupancyLoading && !customerStackingLoading && !aisleOccupancy?.error
      const { cap, effectiveUsed } = computeRoomCapacityUsage(row, aisles, aisleOccupancy?.byAisleLocationId, customerStackingRows, occupancyReady)
      if (cap <= 0) continue
      const t = totals.get(row.zone) || { cap: 0, used: 0 }
      t.cap += cap
      t.used += (effectiveUsed ?? 0)
      totals.set(row.zone, t)
    }
    return totals
  }, [rows, aislesByRoomId, aisleOccupancy, aisleOccupancyLoading, customerStackingRows, customerStackingLoading, loading])

  const label = (
    <div style={{
      fontSize: 10, color: 'var(--text-dim)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      letterSpacing: '0.1em', textTransform: 'uppercase',
    }}>
      Zone utilization
    </div>
  )

  if (loading) {
    return (
      <div>
        {label}
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>Loading…</div>
      </div>
    )
  }

  const zoneKeys = Object.keys(ZONES).filter(z => zoneTotals.has(z))
  if (zoneKeys.length === 0) return null

  return (
    <div>
      {label}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
        {zoneKeys.map(z => {
          const { cap, used } = zoneTotals.get(z)
          const util = cap > 0 ? (used / cap) * 100 : null
          const band = utilBand(util)
          const zoneInfo = ZONES[z]
          return (
            <div key={z} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 14px', minWidth: 140,
              background: 'var(--bg2, #f8f9fb)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md, 8px)',
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: zoneInfo.color, display: 'inline-block' }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>{zoneInfo.label}</span>
              <span style={{
                marginLeft: 'auto', fontSize: 16, fontWeight: 600,
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                color: band.color,
              }}>
                {fmtPct(util)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
