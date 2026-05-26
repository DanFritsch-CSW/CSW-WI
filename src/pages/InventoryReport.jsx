import { useState, useMemo, useCallback } from 'react'

// ---------------------------------------------------------------------------
// MOCK DATA — replace with Omni API call in Phase 2
// Shape mirrors Datex Legacy "Location Contents by Project Report"
// Fields: id, zone, onHand, avail, reserved, expected, pallets[]
// Pallet fields: lp, qty, lot, product, desc, client
// ---------------------------------------------------------------------------
const MOCK_DATA = [
  { zone: 'Aisle A', id: 'AA001A', onHand: 188, avail: 188, reserved: 0, expected: 0,
    pallets: [
      { lp: '904422040', qty: 70,  lot: '0002384894', product: '10003922', desc: '6/4 LB BR CH CURD BWW',                    client: 'SARFO9' },
      { lp: '904422044', qty: 70,  lot: '0002384894', product: '10003922', desc: '6/4 LB BR CH CURD BWW',                    client: 'SARFO9' },
      { lp: 'CSW235182', qty: 48,  lot: 'WJ100757',   product: '30106',    desc: 'SAFEWAY SIGNATURE RC PEPPERONI 30.5OZ',   client: 'PALVI9' },
    ]},
  { zone: 'Aisle A', id: 'AA001B', onHand: 1800, avail: 1800, reserved: 0, expected: 0,
    pallets: [
      { lp: 'MFG0579388', qty: 1008, lot: 'WC105798', product: '1001494', desc: 'CRUST 11" RISING CRUST 18.75 OZ HPB2',      client: 'PALMA9' },
      { lp: 'MFG0581036', qty: 792,  lot: 'WC105481', product: '1002530', desc: 'CRUST 11.25IN KNUCKLE DOCKED 10.8OZ',       client: 'PALMA9' },
    ]},
  { zone: 'Aisle A', id: 'AA001C', onHand: 140, avail: 0, reserved: 0, expected: 0,
    pallets: [
      { lp: '905292528', qty: 70, lot: '0002389476', product: '10003466', desc: '6/4 LB BR MZ PNK CHLI', client: 'SARFO9' },
      { lp: '905292529', qty: 70, lot: '0002389476', product: '10003466', desc: '6/4 LB BR MZ PNK CHLI', client: 'SARFO9' },
    ]},
  { zone: 'Aisle A', id: 'AA001D', onHand: 140, avail: 0, reserved: 0, expected: 0,
    pallets: [
      { lp: '905292509', qty: 70, lot: '0002389476', product: '10003466', desc: '6/4 LB BR MZ PNK CHLI', client: 'SARFO9' },
      { lp: '905292530', qty: 70, lot: '0002389476', product: '10003466', desc: '6/4 LB BR MZ PNK CHLI', client: 'SARFO9' },
    ]},
  { zone: 'Aisle A', id: 'AA002A', onHand: 130, avail: 70, reserved: 0, expected: 0,
    pallets: [
      { lp: '904422862', qty: 60, lot: '0002389477', product: '10001734', desc: '6/4 LB IQF CH, BTR & GAR CLNRY CMPT', client: 'SARFO9' },
      { lp: '905243867', qty: 70, lot: '0002383550', product: '10003285', desc: '6/5 LB IQF CH & PPR BITES',           client: 'SARFO9' },
    ]},
  { zone: 'Aisle A', id: 'AA002B', onHand: 120, avail: 120, reserved: 0, expected: 0,
    pallets: [
      { lp: '905243682', qty: 30, lot: '0002382616', product: '10001060', desc: '24/1 LB BR MZ STK TJ\'S', client: 'SARFO9' },
      { lp: '905243683', qty: 30, lot: '0002382616', product: '10001060', desc: '24/1 LB BR MZ STK TJ\'S', client: 'SARFO9' },
      { lp: '905243830', qty: 30, lot: '0002382616', product: '10001060', desc: '24/1 LB BR MZ STK TJ\'S', client: 'SARFO9' },
      { lp: '905243831', qty: 30, lot: '0002382616', product: '10001060', desc: '24/1 LB BR MZ STK TJ\'S', client: 'SARFO9' },
    ]},
  { zone: 'Aisle A', id: 'AA002C', onHand: 0, avail: 0, reserved: 0, expected: 0, pallets: [] },
  { zone: 'Aisle A', id: 'AA002D', onHand: 140, avail: 140, reserved: 0, expected: 0,
    pallets: [
      { lp: '905257948', qty: 70, lot: '0002386694', product: '10003153', desc: '6/4 LB BR MZ/AGO PNK', client: 'SARFO9' },
      { lp: '905257956', qty: 70, lot: '0002386694', product: '10003153', desc: '6/4 LB BR MZ/AGO PNK', client: 'SARFO9' },
    ]},
  { zone: 'Aisle B', id: 'AB001A', onHand: 0,   avail: 0,   reserved: 0,   expected: 0, pallets: [] },
  { zone: 'Aisle B', id: 'AB001B', onHand: 0,   avail: 0,   reserved: 0,   expected: 0, pallets: [] },
  { zone: 'Aisle B', id: 'AB001C', onHand: 96,  avail: 96,  reserved: 0,   expected: 0,
    pallets: [
      { lp: 'MFG0581100', qty: 48, lot: 'WC105500', product: '1002531', desc: 'CRUST 12IN THIN CRISPY DOCKED', client: 'PALMA9' },
      { lp: 'MFG0581101', qty: 48, lot: 'WC105500', product: '1002531', desc: 'CRUST 12IN THIN CRISPY DOCKED', client: 'PALMA9' },
    ]},
  { zone: 'Aisle B', id: 'AB002A', onHand: 210, avail: 0,   reserved: 210, expected: 0,
    pallets: [
      { lp: '905300001', qty: 70, lot: '0002390100', product: '10004200', desc: '6/4 LB BR MZ SHRD WHOLE MILK', client: 'SARFO9' },
      { lp: '905300002', qty: 70, lot: '0002390100', product: '10004200', desc: '6/4 LB BR MZ SHRD WHOLE MILK', client: 'SARFO9' },
      { lp: '905300003', qty: 70, lot: '0002390100', product: '10004200', desc: '6/4 LB BR MZ SHRD WHOLE MILK', client: 'SARFO9' },
    ]},
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ALL_ZONES   = ['ALL', ...new Set(MOCK_DATA.map(d => d.zone))]
const ALL_CLIENTS = ['ALL', ...new Set(MOCK_DATA.flatMap(d => d.pallets.map(p => p.client)))]
const MODES       = ['All', 'Occupied', 'Empty']

function statusLabel(loc) {
  if (loc.onHand === 0)     return { label: 'Empty',     cls: 'status-empty'   }
  if (loc.reserved > 0)    return { label: 'Reserved',  cls: 'status-reserved' }
  if (loc.avail < loc.onHand) return { label: 'Partial', cls: 'status-partial'  }
  return                           { label: 'Available', cls: 'status-avail'    }
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
            padding: '4px 12px',
            borderRadius: 'var(--r-md)',
            border: '1px solid',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            borderColor: active === item ? 'var(--gold)'   : 'var(--border)',
            background:  active === item ? 'rgba(196,160,80,0.12)' : 'var(--bg2)',
            color:       active === item ? 'var(--gold)'   : 'var(--text-secondary)',
          }}
        >
          {item}
        </button>
      ))}
    </div>
  )
}

function StatBar({ rows, flagCount }) {
  const occ = rows.filter(l => l.onHand > 0).length
  const emp = rows.filter(l => l.onHand === 0).length
  const res = rows.filter(l => l.reserved > 0).length
  return (
    <div style={{
      display: 'flex', gap: '1.5rem', padding: '7px 14px',
      background: 'var(--bg2)', borderRadius: 'var(--r-md)',
      fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap', marginBottom: 10,
    }}>
      <span><strong style={{ color: 'var(--text-primary)' }}>{rows.length}</strong> locations</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{occ}</strong> occupied</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{emp}</strong> empty</span>
      <span><strong style={{ color: 'var(--text-primary)' }}>{res}</strong> reserved</span>
      {flagCount > 0 && (
        <span><strong style={{ color: 'var(--red)' }}>{flagCount}</strong> flagged</span>
      )}
    </div>
  )
}

function DiscrepancyModal({ locations, allData, onClose }) {
  const flagged = allData.filter(l => locations.has(l.id))
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
          width: '90%', maxWidth: 480,
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: 'var(--red)' }}>
          ⚑ Discrepancy log
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 14px' }}>
          {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          {' — '}{flagged.length} location{flagged.length !== 1 ? 's' : ''} flagged
        </p>
        {flagged.map(loc => {
          const note = loc.onHand === 0
            ? 'Unexpected pallet found physically'
            : loc.reserved > 0
              ? `Reserved — verify against system (${loc.reserved} reserved)`
              : `${loc.onHand} on hand — verify pallet count`
          return (
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
                {note}
              </span>
            </div>
          )
        })}
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
  const [zone,      setZone]      = useState('ALL')
  const [mode,      setMode]      = useState('All')
  const [client,    setClient]    = useState('ALL')
  const [flags,     setFlags]     = useState(new Set())
  const [collapsed, setCollapsed] = useState(new Set())
  const [lastRefresh, setLastRefresh] = useState(new Date())
  const [showDisc,  setShowDisc]  = useState(false)

  const toggleFlag = useCallback((id, e) => {
    e.stopPropagation()
    setFlags(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const toggleCollapse = useCallback((id) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const filtered = useMemo(() => {
    return MOCK_DATA.filter(loc => {
      const zm = zone   === 'ALL' || loc.zone === zone
      const mm = mode   === 'All'
             || (mode === 'Occupied' && loc.onHand > 0)
             || (mode === 'Empty'    && loc.onHand === 0)
      const cm = client === 'ALL'
             || loc.pallets.some(p => p.client === client)
             || (loc.pallets.length === 0)
      return zm && mm && cm
    })
  }, [zone, mode, client])

  // Group by zone for rendering
  const byZone = useMemo(() => {
    const map = {}
    filtered.forEach(loc => {
      ;(map[loc.zone] = map[loc.zone] || []).push(loc)
    })
    return map
  }, [filtered])

  const doRefresh = () => setLastRefresh(new Date())

  // ---- styles (inline, no extra CSS file needed) ----
  const S = {
    page: {
      padding: '1.5rem',
      maxWidth: 1100,
      margin: '0 auto',
    },
    pageHeader: {
      display: 'flex', alignItems: 'flex-start',
      justifyContent: 'space-between', marginBottom: '1.25rem',
      gap: 12, flexWrap: 'wrap',
    },
    h1: {
      fontSize: 22, fontWeight: 700, margin: '0 0 2px',
      color: 'var(--text-primary)',
      letterSpacing: '-0.5px',
    },
    sub: { fontSize: 12, color: 'var(--text-secondary)', margin: 0 },
    btnRow: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
    btn: {
      padding: '7px 14px', borderRadius: 'var(--r-md)',
      border: '1px solid var(--border)', background: 'var(--bg2)',
      color: 'var(--text-primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 5,
    },
    btnDanger: {
      padding: '7px 14px', borderRadius: 'var(--r-md)',
      border: '1px solid rgba(239,68,68,0.5)',
      background: 'rgba(239,68,68,0.12)',
      color: 'var(--red)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 5,
    },
    filterRow: { display: 'flex', gap: '1.25rem', marginBottom: '1rem', flexWrap: 'wrap' },
    filterGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
    filterLabel: { fontSize: 10, color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '.06em' },
    tableWrap: {
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      overflow: 'hidden',
    },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: {
      background: 'var(--bg2)', color: 'var(--text-secondary)',
      fontWeight: 600, textAlign: 'left',
      padding: '7px 10px',
      borderBottom: '1px solid var(--border)',
      fontSize: 11,
    },
    thR: {
      background: 'var(--bg2)', color: 'var(--text-secondary)',
      fontWeight: 600, textAlign: 'right',
      padding: '7px 10px',
      borderBottom: '1px solid var(--border)',
      fontSize: 11,
    },
    zoneRow: {
      background: 'var(--bg2)',
      color: 'var(--text-secondary)',
      fontSize: 10, fontWeight: 700,
      letterSpacing: '.07em',
      padding: '5px 10px',
      borderTop: '1px solid var(--border)',
    },
  }

  const statusStyle = {
    'status-avail':    { background: 'rgba(34,197,94,0.15)',  color: '#4ade80' },
    'status-reserved': { background: 'rgba(234,179,8,0.15)',  color: '#facc15' },
    'status-partial':  { background: 'rgba(59,130,246,0.15)', color: '#60a5fa' },
    'status-empty':    { background: 'var(--bg3)',            color: 'var(--text-secondary)' },
  }

  return (
    <div className="page-content">
      <div style={S.page}>

        {/* ── Page header ── */}
        <div style={S.pageHeader}>
          <div>
            <h1 style={S.h1}>INVENTORY <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>Location Contents</span></h1>
            <p style={S.sub}>
              CSW-Franksville · Last refreshed {lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              <span style={{ margin: '0 8px', opacity: 0.3 }}>|</span>
              ~10–15 min data lag from WMS
            </p>
          </div>
          <div style={S.btnRow}>
            {flags.size > 0 && (
              <button style={S.btnDanger} onClick={() => setShowDisc(true)}>
                ⚑ {flags.size} Discrepanc{flags.size > 1 ? 'ies' : 'y'}
              </button>
            )}
            <button style={S.btn} onClick={doRefresh}>
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* ── Filters ── */}
        <div style={S.filterRow}>
          <div style={S.filterGroup}>
            <span style={S.filterLabel}>ZONE / AISLE</span>
            <FilterPills items={ALL_ZONES} active={zone} onSelect={setZone} />
          </div>
          <div style={S.filterGroup}>
            <span style={S.filterLabel}>SHOW</span>
            <FilterPills items={MODES} active={mode} onSelect={setMode} />
          </div>
          <div style={S.filterGroup}>
            <span style={S.filterLabel}>CLIENT</span>
            <FilterPills items={ALL_CLIENTS} active={client} onSelect={setClient} />
          </div>
        </div>

        {/* ── Stats bar ── */}
        <StatBar rows={filtered} flagCount={flags.size} />

        {/* ── Table ── */}
        <div style={S.tableWrap}>
          {filtered.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
              No locations match current filter
            </div>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={{ ...S.th, width: 95 }}>Location</th>
                  <th style={{ ...S.thR, width: 75 }}>On Hand</th>
                  <th style={{ ...S.thR, width: 75 }}>Available</th>
                  <th style={{ ...S.thR, width: 75 }}>Reserved</th>
                  <th style={{ ...S.th,  width: 90 }}>Status</th>
                  <th style={S.th}>Pallet / Product</th>
                  <th style={{ ...S.th, width: 68 }}>Client</th>
                  <th style={{ ...S.th, width: 64 }}></th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(byZone).map(([zoneName, locs]) => (
                  <>
                    <tr key={`zone-${zoneName}`}>
                      <td colSpan={8} style={S.zoneRow}>{zoneName.toUpperCase()}</td>
                    </tr>
                    {locs.map(loc => {
                      const { label, cls } = statusLabel(loc)
                      const isFlagged  = flags.has(loc.id)
                      const isCollapsed = collapsed.has(loc.id)
                      const hasInventory = loc.pallets.length > 0

                      return (
                        <>
                          {/* Location summary row */}
                          <tr
                            key={loc.id}
                            onClick={() => hasInventory && toggleCollapse(loc.id)}
                            style={{
                              borderBottom: '1px solid var(--border)',
                              background: isFlagged ? 'rgba(239,68,68,0.07)' : 'transparent',
                              cursor: hasInventory ? 'pointer' : 'default',
                            }}
                          >
                            <td style={{
                              padding: '8px 10px',
                              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
                              color: 'var(--text-primary)',
                            }}>
                              {hasInventory && (
                                <span style={{ color: 'var(--text-secondary)', marginRight: 4, fontSize: 10 }}>
                                  {isCollapsed ? '▸' : '▾'}
                                </span>
                              )}
                              {loc.id}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-primary)', fontWeight: 600 }}>
                              {loc.onHand || '—'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-primary)' }}>
                              {loc.avail || '—'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: loc.reserved > 0 ? '#facc15' : 'var(--text-secondary)' }}>
                              {loc.reserved || '—'}
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <span style={{
                                ...statusStyle[cls],
                                padding: '2px 8px', borderRadius: 10,
                                fontSize: 10, fontWeight: 600,
                              }}>
                                {label}
                              </span>
                            </td>
                            <td style={{ padding: '8px 10px', color: 'var(--text-secondary)', fontSize: 11 }}>
                              {hasInventory && isCollapsed
                                ? `${loc.pallets.length} pallet${loc.pallets.length > 1 ? 's' : ''}`
                                : ''}
                            </td>
                            <td></td>
                            <td style={{ padding: '8px 10px' }}>
                              <button
                                onClick={e => toggleFlag(loc.id, e)}
                                style={{
                                  background: 'transparent',
                                  border: '1px solid',
                                  borderColor: isFlagged ? 'rgba(239,68,68,0.5)' : 'var(--border)',
                                  borderRadius: 'var(--r-md)',
                                  padding: '3px 9px', fontSize: 10, fontWeight: 600,
                                  color: isFlagged ? 'var(--red)' : 'var(--text-secondary)',
                                  background: isFlagged ? 'rgba(239,68,68,0.1)' : 'transparent',
                                  cursor: 'pointer',
                                }}
                              >
                                {isFlagged ? '⚑ flagged' : '+ flag'}
                              </button>
                            </td>
                          </tr>

                          {/* Pallet detail rows — shown when expanded */}
                          {hasInventory && !isCollapsed && loc.pallets.map((p, pi) => (
                            <tr
                              key={`${loc.id}-${pi}`}
                              style={{
                                borderBottom: pi === loc.pallets.length - 1
                                  ? '1px solid var(--border)'
                                  : '1px solid rgba(255,255,255,0.04)',
                                background: 'rgba(255,255,255,0.015)',
                                opacity: (client !== 'ALL' && p.client !== client) ? 0.4 : 1,
                              }}
                            >
                              <td style={{
                                padding: '4px 10px 4px 22px',
                                fontFamily: 'var(--font-mono)', fontSize: 11,
                                color: 'var(--text-secondary)',
                              }}>
                                ↳ {p.lp}
                              </td>
                              <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: 11 }}>
                                {p.qty}
                              </td>
                              <td colSpan={2} style={{ padding: '4px 10px', color: 'var(--text-secondary)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                                {p.lot}
                              </td>
                              <td></td>
                              <td style={{ padding: '4px 10px', color: 'var(--text-primary)', fontSize: 11 }}>
                                {p.desc}
                                <span style={{ marginLeft: 8, color: 'var(--text-secondary)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                                  {p.product}
                                </span>
                              </td>
                              <td style={{
                                padding: '4px 10px',
                                fontFamily: 'var(--font-mono)', fontSize: 10,
                                color: 'var(--text-secondary)',
                              }}>
                                {p.client}
                              </td>
                              <td></td>
                            </tr>
                          ))}
                        </>
                      )
                    })}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Discrepancy modal ── */}
        {showDisc && (
          <DiscrepancyModal
            locations={flags}
            allData={MOCK_DATA}
            onClose={() => setShowDisc(false)}
          />
        )}

      </div>
    </div>
  )
}
