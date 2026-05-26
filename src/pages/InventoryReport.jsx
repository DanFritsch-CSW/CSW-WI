import { useState, useMemo, useCallback, useEffect } from 'react'
import { fetchInventoryLocations } from '../lib/omniInventory.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FACILITY_LIST = [
  { id: 'cal', label: 'Caledonia',        whName: 'CSW-Franksville' },
  { id: 'mad', label: 'Madison',           whName: 'CSW-Madison' },
  { id: 'ken', label: 'Kenosha',           whName: 'CSW-Kenosha' },
  { id: 'wr',  label: 'Wisconsin Rapids',  whName: 'CSW-Wisconsin Rapids' },
  { id: 'ec',  label: 'Eau Claire',        whName: 'CSW-Eau Claire' },
]

const MODES = ['All', 'Occupied', 'Empty']

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
            padding: '4px 12px',
            borderRadius: 'var(--r-md)',
            border: '1px solid',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
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

function StatBar({ rows, flagCount }) {
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
      {flagCount > 0 && (
        <span><strong style={{ color: 'var(--red)' }}>{flagCount}</strong> flagged</span>
      )}
    </div>
  )
}

function DiscrepancyModal({ flags, allData, onClose }) {
  const flagged = allData.filter(l => flags.has(l.id))
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg1)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)', padding: '1.25rem',
          width: '90%', maxWidth: 480, maxHeight: '80vh', overflowY: 'auto',
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: 'var(--red)' }}>
          ⚑ Discrepancy log
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 14px' }}>
          {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          {' — '}{flagged.length} location{flagged.length !== 1 ? 's' : ''} flagged
        </p>
        {flagged.map(loc => (
          <div key={loc.id} style={{
            padding: '8px 12px', marginBottom: 6,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: 'var(--r-md)', fontSize: 12,
          }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
              {loc.id}
            </span>
            <span style={{ marginLeft: 10, color: 'var(--text-secondary)', fontSize: 11 }}>
              {loc.palletCount === 0
                ? 'Unexpected pallet found physically — not in system'
                : `${loc.palletCount} pallet${loc.palletCount !== 1 ? 's' : ''} — verify against physical count`
              }
            </span>
            {loc.pallets.slice(0, 3).map(p => (
              <div key={p.lp} style={{ marginTop: 4, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', paddingLeft: 8 }}>
                ↳ {p.lp} · {p.materialCode} · {p.qty} units
              </div>
            ))}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={() => window.print()}
            style={{
              padding: '7px 14px', borderRadius: 'var(--r-md)',
              border: '1px solid var(--border)', background: 'var(--bg2)',
              color: 'var(--text-primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}
          >
            Print / Save PDF
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '7px 14px', borderRadius: 'var(--r-md)',
              border: '1px solid var(--border)', background: 'var(--bg3)',
              color: 'var(--text-secondary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
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

  const [flags,    setFlags]    = useState(new Set())
  // "expanded" tracks which location rows have been tapped open.
  // Default is collapsed — set starts empty, tap adds to it.
  const [expanded, setExpanded] = useState(new Set())
  const [showDisc, setShowDisc] = useState(false)

  // ---------------------------------------------------------------------------
  // Fetch — reset expanded state on each load
  // ---------------------------------------------------------------------------
  const doFetch = useCallback(async (facId) => {
    setLoading(true)
    setError(null)
    setFlags(new Set())
    setExpanded(new Set())
    setSearch('')
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

  useEffect(() => { doFetch(facilityId) }, [facilityId, doFetch])

  const handleRefresh = () => doFetch(facilityId)

  // ---------------------------------------------------------------------------
  // Flat filtered list
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
  // Handlers
  // ---------------------------------------------------------------------------
  const toggleFlag = useCallback((id, e) => {
    e.stopPropagation()
    setFlags(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  // Tap a location row to expand; tap again to collapse
  const toggleExpand = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

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
    occupied: { background: 'rgba(34,197,94,0.15)',  color: '#4ade80' },
    empty:    { background: 'var(--bg3)',             color: 'var(--text-secondary)' },
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
            {flags.size > 0 && (
              <button style={S.btnDanger} onClick={() => setShowDisc(true)}>
                ⚑ {flags.size} Discrepanc{flags.size > 1 ? 'ies' : 'y'}
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
              onClick={() => setFacilityId(f.id)}
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
                color: 'var(--text-primary)', fontSize: 12, width: 240,
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* ── Stats ── */}
        {!loading && !error && <StatBar rows={filtered} flagCount={flags.size} />}

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

        {/* ── Flat table ── */}
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
                    <th style={{ ...S.th,  width: 100 }}>Location</th>
                    <th style={{ ...S.thR, width: 70  }}>Pallets</th>
                    <th style={{ ...S.thR, width: 80  }}>Total Qty</th>
                    <th style={{ ...S.th,  width: 90  }}>Status</th>
                    <th style={S.th}>LP · Material · Lots</th>
                    <th style={{ ...S.th,  width: 60  }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(loc => {
                    const isEmpty      = loc.palletCount === 0
                    const isFlagged    = flags.has(loc.id)
                    const isExpanded   = expanded.has(loc.id)   // default: NOT expanded
                    const hasInventory = loc.pallets.length > 0

                    return (
                      <>
                        {/* ── Location summary row — always visible ── */}
                        <tr
                          key={loc.id}
                          onClick={() => hasInventory && toggleExpand(loc.id)}
                          style={{
                            borderBottom: '1px solid var(--border)',
                            background: isFlagged ? 'rgba(239,68,68,0.07)' : 'transparent',
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
                            {/* Show hint when collapsed and has pallets */}
                            {hasInventory && !isExpanded
                              ? `${loc.pallets.length} pallet${loc.pallets.length > 1 ? 's' : ''} — tap to expand`
                              : ''}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <button
                              onClick={e => toggleFlag(loc.id, e)}
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
                              {isFlagged ? '⚑ flagged' : '+ flag'}
                            </button>
                          </td>
                        </tr>

                        {/* ── Pallet detail rows — only shown when expanded ── */}
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
                              {p.vendorLot && (
                                <span style={{ color: 'var(--text-secondary)', marginLeft: 10, fontSize: 10 }}>VL: {p.vendorLot}</span>
                              )}
                              {p.sysLot && (
                                <span style={{ color: 'var(--text-secondary)', marginLeft: 8, fontSize: 10 }}>SL: {p.sysLot}</span>
                              )}
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

        {/* ── Discrepancy modal ── */}
        {showDisc && (
          <DiscrepancyModal
            flags={flags}
            allData={data}
            onClose={() => setShowDisc(false)}
          />
        )}

      </div>
    </div>
  )
}
