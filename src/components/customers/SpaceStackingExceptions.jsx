import { Fragment, useMemo, useState } from 'react'
import {
  fmtInt,
  fetchMaterialsForCustomer, addMaterialStacking, updateMaterialStacking, deleteMaterialStacking,
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
