import { useState, useEffect, useMemo } from 'react'
import {
  fetchPviCanonicalAccounts,
  upsertPviCanonicalAccount,
  deletePviCanonicalAccount,
  fetchPviAccountNameMap,
  upsertPviAccountNameMap,
  deletePviAccountNameMap,
  applyPviAccountSeed,
} from '../../lib/supabase.js'

// PVI Accounts Settings tab.
//
// Two-panel editor:
//   Left panel:  canonical accounts (Costco, Walmart, Target, ...).
//                account_type = 'end_customer' | 'internal_transfer'.
//                override_days is nullable; blank = use derived from history.
//   Right panel: raw Datex ship-to name → canonical mapping.
//
// "Suggest from history" button pings the pvi-derive-accounts Netlify function
// which scans 90 days of PVI orderline marks, clusters raw names by keyword,
// and returns proposed canonicals + mappings + derived shelf-life days. User
// reviews the suggestions in a modal, unchecks anything they don't want,
// edits days/type inline, then Apply → bulk-inserts into the two tables.
//
// Runs entirely inside the existing Settings page — no new nav.

const ACCOUNT_TYPE_OPTIONS = [
  { value: 'end_customer',      label: 'End customer' },
  { value: 'internal_transfer', label: 'Internal transfer' },
]

const STATUS_LABELS = {
  end_customer:      'End customer',
  internal_transfer: 'Internal transfer',
}

export default function PviAccountsTab() {
  const [canonicals, setCanonicals]   = useState([])
  const [nameMap, setNameMap]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [seedOpen, setSeedOpen]       = useState(false)
  const [error, setError]             = useState(null)

  useEffect(() => { reload() }, [])

  async function reload() {
    setLoading(true)
    try {
      const [canon, map] = await Promise.all([
        fetchPviCanonicalAccounts(),
        fetchPviAccountNameMap(),
      ])
      setCanonicals(canon)
      setNameMap(map)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  // Count raw-name mappings per canonical for the left-panel display.
  const rawCountByCanonical = useMemo(() => {
    const m = new Map()
    for (const row of nameMap) {
      m.set(row.canonical_id, (m.get(row.canonical_id) || 0) + 1)
    }
    return m
  }, [nameMap])

  if (loading) {
    return (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '24px 0' }}>
        Loading PVI accounts…
      </div>
    )
  }

  return (
    <div>
      {/* Header + Suggest button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 16 }}>
        <div style={{ flex: 1 }}>
          <p className="settings-page-sub" style={{ marginBottom: 8 }}>
            Palermo's ships one customer under many raw Datex names (e.g. <code>COSTCO Atlanta</code> and{' '}
            <code>COSTCO Mira Loma</code> are both Costco with a 156-day requirement). This tab lets you fold
            those raw names into canonical accounts + set each customer's minimum shelf-life days.
          </p>
          <p className="settings-page-sub" style={{ marginBottom: 0 }}>
            Blank <strong>Override days</strong> = use derived days from historical shipments. Otherwise the
            override wins. Internal transfers don't drive shelf-life cutoffs.
          </p>
        </div>
        <button
          className="settings-save-btn"
          style={{ whiteSpace: 'nowrap' }}
          onClick={() => setSeedOpen(true)}
        >
          Suggest from history
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: '#e05a5a', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <CanonicalPanel
          canonicals={canonicals}
          rawCountByCanonical={rawCountByCanonical}
          onChanged={reload}
        />
        <NameMapPanel
          canonicals={canonicals}
          nameMap={nameMap}
          onChanged={reload}
        />
      </div>

      {seedOpen && (
        <SeedModal
          onClose={() => setSeedOpen(false)}
          onApplied={reload}
        />
      )}
    </div>
  )
}

// ── Canonical Accounts Panel ─────────────────────────────────────────────

function CanonicalPanel({ canonicals, rawCountByCanonical, onChanged }) {
  const [newName, setNewName]     = useState('')
  const [newType, setNewType]     = useState('end_customer')
  const [newDays, setNewDays]     = useState('')
  const [saving, setSaving]       = useState(false)
  const [err, setErr]             = useState(null)

  async function handleAdd() {
    setErr(null)
    if (!newName.trim()) { setErr('Canonical name required.'); return }
    setSaving(true)
    try {
      await upsertPviCanonicalAccount({
        canonical_name: newName,
        account_type:   newType,
        override_days:  newDays === '' ? null : Number(newDays),
      })
      setNewName(''); setNewDays(''); setNewType('end_customer')
      onChanged()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="section-label" style={{ marginBottom: 8 }}>Canonical Accounts ({canonicals.length})</div>

      <table className="hourly-table" style={{ marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Canonical name</th>
            <th style={{ textAlign: 'left' }}>Type</th>
            <th style={{ textAlign: 'right' }}>Override days</th>
            <th style={{ textAlign: 'right' }}>Raw names</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {canonicals.length === 0 && (
            <tr><td colSpan="5" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>
              No canonical accounts yet. Click "Suggest from history" or add manually below.
            </td></tr>
          )}
          {canonicals.map(c => (
            <CanonicalRow
              key={c.id}
              row={c}
              rawCount={rawCountByCanonical.get(c.id) || 0}
              onChanged={onChanged}
            />
          ))}
        </tbody>
      </table>

      {/* Add new canonical */}
      <div className="settings-page-sub" style={{ marginBottom: 4, fontWeight: 600 }}>Add manually</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <input
          className="settings-field-input"
          placeholder="Costco"
          style={{ width: 140 }}
          value={newName}
          onChange={e => setNewName(e.target.value)}
        />
        <select className="est-drops-select" value={newType} onChange={e => setNewType(e.target.value)}>
          {ACCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input
          className="settings-field-input"
          type="number" min="0" max="999" step="1"
          placeholder="days"
          style={{ width: 72 }}
          value={newDays}
          onChange={e => setNewDays(e.target.value)}
          disabled={newType === 'internal_transfer'}
        />
        <button className="settings-save-btn" onClick={handleAdd} disabled={saving}>
          {saving ? 'Adding…' : '+ Add'}
        </button>
      </div>
      {err && <div style={{ fontSize: 11, color: '#e05a5a', fontFamily: 'var(--font-mono)', marginTop: 6 }}>{err}</div>}
    </div>
  )
}

function CanonicalRow({ row, rawCount, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [name, setName]       = useState(row.canonical_name)
  const [type, setType]       = useState(row.account_type)
  const [days, setDays]       = useState(row.override_days ?? '')
  const [busy, setBusy]       = useState(false)

  async function save() {
    setBusy(true)
    try {
      await upsertPviCanonicalAccount({
        id:             row.id,
        canonical_name: name,
        account_type:   type,
        override_days:  days === '' ? null : Number(days),
      })
      setEditing(false)
      onChanged()
    } catch (e) {
      alert(`Failed to save: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function del() {
    if (!confirm(`Delete "${row.canonical_name}" and all ${rawCount} raw-name mapping(s) to it?`)) return
    setBusy(true)
    try {
      await deletePviCanonicalAccount(row.id)
      onChanged()
    } catch (e) {
      alert(`Failed to delete: ${e.message}`)
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--brand-bg, #fef9ec)' }}>
        <td><input className="settings-field-input" value={name} onChange={e => setName(e.target.value)} style={{ width: '100%' }} /></td>
        <td>
          <select className="est-drops-select" value={type} onChange={e => setType(e.target.value)}>
            {ACCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        <td style={{ textAlign: 'right' }}>
          <input
            className="settings-field-input"
            type="number" min="0" max="999" step="1"
            style={{ width: 64, textAlign: 'right' }}
            value={days}
            onChange={e => setDays(e.target.value)}
            disabled={type === 'internal_transfer'}
          />
        </td>
        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>{rawCount}</td>
        <td>
          <button className="settings-save-btn" disabled={busy} onClick={save}>{busy ? '…' : 'Save'}</button>
          <button className="settings-save-btn" style={{ marginLeft: 4 }} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{row.canonical_name}</td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: row.account_type === 'internal_transfer' ? 'var(--text-dim)' : 'var(--text-secondary)' }}>
        {STATUS_LABELS[row.account_type]}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {row.account_type === 'internal_transfer' ? '—' : (row.override_days ?? <span style={{ color: 'var(--text-dim)' }}>(derived)</span>)}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>{rawCount}</td>
      <td>
        <button className="settings-save-btn" onClick={() => setEditing(true)}>Edit</button>
        <button className="settings-save-btn" style={{ marginLeft: 4, color: '#e05a5a', borderColor: '#e05a5a' }} onClick={del} disabled={busy}>
          Delete
        </button>
      </td>
    </tr>
  )
}

// ── Raw Name Map Panel ───────────────────────────────────────────────────

function NameMapPanel({ canonicals, nameMap, onChanged }) {
  const [newRaw, setNewRaw]   = useState('')
  const [newCanId, setNewCanId] = useState('')
  const [filter, setFilter]   = useState('')
  const [err, setErr]         = useState(null)

  const canonicalNameById = useMemo(() => {
    const m = new Map()
    for (const c of canonicals) m.set(c.id, c.canonical_name)
    return m
  }, [canonicals])

  const filtered = useMemo(() => {
    if (!filter.trim()) return nameMap
    const q = filter.toUpperCase()
    return nameMap.filter(r => {
      const raw = (r.raw_account_name || '').toUpperCase()
      const canonName = (canonicalNameById.get(r.canonical_id) || '').toUpperCase()
      return raw.includes(q) || canonName.includes(q)
    })
  }, [nameMap, filter, canonicalNameById])

  async function handleAdd() {
    setErr(null)
    if (!newRaw.trim()) { setErr('Raw name required.'); return }
    if (!newCanId) { setErr('Choose a canonical account.'); return }
    try {
      await upsertPviAccountNameMap({
        raw_account_name: newRaw,
        canonical_id:     Number(newCanId),
      })
      setNewRaw(''); setNewCanId('')
      onChanged()
    } catch (e) {
      setErr(e.message || String(e))
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div className="section-label">Raw Name → Canonical ({nameMap.length})</div>
        <input
          className="settings-field-input"
          placeholder="Filter…"
          style={{ width: 140, fontSize: 11 }}
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--border)', marginBottom: 16 }}>
        <table className="hourly-table" style={{ marginBottom: 0 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Raw ship-to name</th>
              <th style={{ textAlign: 'left' }}>Canonical</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan="3" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '12px 0' }}>
                {nameMap.length === 0 ? 'No mappings yet.' : 'No matches.'}
              </td></tr>
            )}
            {filtered.map(r => (
              <NameMapRow key={r.id} row={r} canonicals={canonicals} canonicalNameById={canonicalNameById} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Add new mapping */}
      <div className="settings-page-sub" style={{ marginBottom: 4, fontWeight: 600 }}>Add mapping</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <input
          className="settings-field-input"
          placeholder="COSTCO Atlanta"
          style={{ width: 200 }}
          value={newRaw}
          onChange={e => setNewRaw(e.target.value)}
        />
        <select className="est-drops-select" value={newCanId} onChange={e => setNewCanId(e.target.value)}>
          <option value="">Choose canonical…</option>
          {canonicals.map(c => <option key={c.id} value={c.id}>{c.canonical_name}</option>)}
        </select>
        <button className="settings-save-btn" onClick={handleAdd}>+ Add</button>
      </div>
      {err && <div style={{ fontSize: 11, color: '#e05a5a', fontFamily: 'var(--font-mono)', marginTop: 6 }}>{err}</div>}
    </div>
  )
}

function NameMapRow({ row, canonicals, canonicalNameById, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [canId, setCanId]     = useState(row.canonical_id)
  const [busy, setBusy]       = useState(false)

  async function save() {
    setBusy(true)
    try {
      await upsertPviAccountNameMap({
        id:               row.id,
        raw_account_name: row.raw_account_name,
        canonical_id:     Number(canId),
      })
      setEditing(false)
      onChanged()
    } catch (e) {
      alert(`Failed to save: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function del() {
    if (!confirm(`Remove mapping for "${row.raw_account_name}"?`)) return
    setBusy(true)
    try {
      await deletePviAccountNameMap(row.id)
      onChanged()
    } catch (e) {
      alert(`Failed to delete: ${e.message}`)
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <tr style={{ background: 'var(--brand-bg, #fef9ec)' }}>
        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{row.raw_account_name}</td>
        <td>
          <select className="est-drops-select" value={canId} onChange={e => setCanId(e.target.value)}>
            {canonicals.map(c => <option key={c.id} value={c.id}>{c.canonical_name}</option>)}
          </select>
        </td>
        <td>
          <button className="settings-save-btn" disabled={busy} onClick={save}>{busy ? '…' : 'Save'}</button>
          <button className="settings-save-btn" style={{ marginLeft: 4 }} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{row.raw_account_name}</td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
        {canonicalNameById.get(row.canonical_id) || <span style={{ color: '#e05a5a' }}>(orphaned)</span>}
      </td>
      <td>
        <button className="settings-save-btn" onClick={() => setEditing(true)}>Edit</button>
        <button className="settings-save-btn" style={{ marginLeft: 4, color: '#e05a5a', borderColor: '#e05a5a' }} onClick={del} disabled={busy}>Delete</button>
      </td>
    </tr>
  )
}

// ── Seed From History Modal ──────────────────────────────────────────────

function SeedModal({ onClose, onApplied }) {
  const [loading, setLoading]     = useState(true)
  const [suggestions, setSuggest] = useState([])
  const [unclustered, setUnclust] = useState([])
  const [error, setError]         = useState(null)
  const [applying, setApplying]   = useState(false)
  const [result, setResult]       = useState(null)
  const [elapsed, setElapsed]     = useState(null)

  // Per-row editable state, keyed by canonical_name (stable across renders).
  const [rowState, setRowState] = useState({}) // { [canonical]: { include, account_type, override_days } }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch('/.netlify/functions/pvi-derive-accounts', { method: 'POST' })
        if (!resp.ok) {
          const body = await resp.text()
          throw new Error(`Derive failed (${resp.status}): ${body.slice(0, 200)}`)
        }
        const data = await resp.json()
        if (cancelled) return
        const initState = {}
        for (const s of data.suggestions) {
          initState[s.canonical_name] = {
            include:       true,
            account_type:  s.account_type,
            override_days: s.derived_days ?? '',  // pre-fill override with derived
          }
        }
        setRowState(initState)
        setSuggest(data.suggestions)
        setUnclust(data.unclustered || [])
        setElapsed(data.elapsedMs)
      } catch (e) {
        if (!cancelled) setError(e.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  function updateRow(canonical, patch) {
    setRowState(prev => ({ ...prev, [canonical]: { ...prev[canonical], ...patch } }))
  }

  async function handleApply() {
    setApplying(true)
    setError(null)
    try {
      const toApply = suggestions
        .filter(s => rowState[s.canonical_name]?.include)
        .map(s => {
          const state = rowState[s.canonical_name]
          return {
            canonical_name: s.canonical_name,
            account_type:   state.account_type,
            override_days:  state.override_days === '' ? null : Number(state.override_days),
            raw_names:      s.raw_names,
          }
        })
      const res = await applyPviAccountSeed(toApply)
      setResult(res)
      onApplied()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: 'var(--bg0)', border: '1px solid var(--border)',
        maxWidth: '90vw', width: 900, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15 }}>Suggested Canonicals from 90-day PVI history</h3>
            {elapsed && <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
              Scanned in {(elapsed/1000).toFixed(1)}s · {suggestions.length} clusters, {unclustered.length} unclustered
            </div>}
          </div>
          <button className="settings-save-btn" onClick={onClose}>Close</button>
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>
          {loading && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Scanning history… (may take 10-20s)</div>}
          {error && <div style={{ color: '#e05a5a', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{error}</div>}

          {!loading && !error && (
            <>
              {result && (
                <div style={{ background: '#e8f5e9', border: '1px solid #4caf50', padding: 8, marginBottom: 12, fontSize: 12 }}>
                  ✓ Applied {result.canonicals} canonical account(s), {result.mappings} raw-name mapping(s).
                  You can close this dialog.
                </div>
              )}

              <table className="hourly-table" style={{ marginBottom: 16 }}>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th style={{ textAlign: 'left' }}>Canonical</th>
                    <th style={{ textAlign: 'left' }}>Type</th>
                    <th style={{ textAlign: 'right' }}>Days</th>
                    <th style={{ textAlign: 'right' }}>Shipments</th>
                    <th style={{ textAlign: 'left' }}>Raw names ({suggestions.reduce((a, s) => a + s.raw_names.length, 0)} total)</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map(s => {
                    const state = rowState[s.canonical_name] || {}
                    return (
                      <tr key={s.canonical_name} style={!state.include ? { opacity: 0.5 } : null}>
                        <td>
                          <input
                            type="checkbox"
                            checked={!!state.include}
                            onChange={e => updateRow(s.canonical_name, { include: e.target.checked })}
                          />
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.canonical_name}</td>
                        <td>
                          <select
                            className="est-drops-select"
                            value={state.account_type || s.account_type}
                            onChange={e => updateRow(s.canonical_name, { account_type: e.target.value })}
                            style={{ fontSize: 11 }}
                          >
                            {ACCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <input
                            className="settings-field-input"
                            type="number" min="0" max="999" step="1"
                            style={{ width: 56, textAlign: 'right', fontSize: 11 }}
                            value={state.override_days ?? ''}
                            onChange={e => updateRow(s.canonical_name, { override_days: e.target.value })}
                            disabled={(state.account_type || s.account_type) === 'internal_transfer'}
                            placeholder={s.derived_days ?? '—'}
                          />
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.shipment_count}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', maxWidth: 240, wordBreak: 'break-word' }}>
                          {s.raw_names.join(' · ')}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {unclustered.length > 0 && (
                <details style={{ marginTop: 16 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                    {unclustered.length} unclustered raw name(s) — review + map manually below after applying
                  </summary>
                  <table className="hourly-table" style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>Raw name</th>
                        <th style={{ textAlign: 'right' }}>Shipments</th>
                        <th style={{ textAlign: 'right' }}>Mode marks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unclustered.map(u => (
                        <tr key={u.raw_account_name}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{u.raw_account_name}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{u.shipments}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                            {u.mode_marks ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Applying is idempotent — running Suggest again won't duplicate. Existing raw-name mappings
            keep their current canonical unless you check them here.
          </div>
          <button
            className="settings-save-btn"
            style={{ background: 'var(--brand, #a07818)', color: 'white', borderColor: 'var(--brand, #a07818)' }}
            onClick={handleApply}
            disabled={loading || applying || !!error}
          >
            {applying ? 'Applying…' : `Apply ${Object.values(rowState).filter(s => s.include).length} selection(s)`}
          </button>
        </div>
      </div>
    </div>
  )
}
