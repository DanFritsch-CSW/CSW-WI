import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchF8OpenPositions } from '../lib/f8OpenPositions.js'
import { fetchIgnoredLocations, ignoreLocation, restoreLocation } from '../lib/f8OpenPositionsIgnored.js'
import NotifySettingsPanel from './NotifySettingsPanel.jsx'

// ─── F8 Open Positions ───────────────────────────────────────────────────
// Added 2026-09-04, sits next to "DPI Pickline" in FacilityPanel.jsx's
// MAD_TABS row. Per Dan's request, kept deliberately simple: just how
// many open pallet positions exist per aisle in F8B-F8F, no drill-down
// table, no filters.
//
// Definition (Dan's explicit rule):
//   - B/C/D/E hold 2 pallet positions per location:
//       - a location with ZERO license plates ("Empty")     = 2 open
//       - a location with EXACTLY ONE license plate ("1 LP") = 1 open
//       - anything else (2+ LPs)                             = 0 open
//   - F holds only 1 pallet position per location (added 2026-09-04,
//     later still) -- only EMPTY F8F locations count as open (1 each);
//     a location already holding 1 LP is FULL there, not partially open.
// Computed server-side in motherduck-f8-open-positions.cjs -- see that
// file's header for the query and classification logic.
//
// Notify digest (added same day, per Dan's follow-up ask): reuses the
// same shared NotifySettingsPanel component every other digest in this
// app uses -- M-F day toggles, configurable send time, Enabled checkbox,
// Front conversation ID, "Send test digest now" -- backed by
// prepick_notify_settings (facility='mad',
// dashboard_type='f8_open_positions'). See
// lib/f8-open-positions-digest-shared.cjs for the digest itself, which
// runs its own independent copy of the same query/classification logic
// (same "self-contained port" convention as jdf-scorecard-digest-
// shared.cjs), so the digest number can never drift from what this tab
// shows.
//
// Ignore specific locations (added 2026-09-04, later still): per Dan's
// follow-up ask, a general "ignore this location" capability across all
// aisles (not just F8E's structural -00 exclusion, which stays baked
// into the backend query and isn't user-manageable). Deliberately lives
// in its own collapsed section on THIS tab, separate from the Notify
// settings dropdown -- Dan was explicit these are two different
// controls. Aisle cards recompute client-side from the raw per-location
// list (now returned by motherduck-f8-open-positions.cjs) minus whatever
// is actively ignored -- same "visibleX / filteredCounts" convention as
// WrPickCheck.jsx's material dismissals. The digest applies the same
// ignore list server-side (lib/f8-open-positions-digest-shared.cjs), so
// an ignored location disappears from the morning Front post too, not
// just this tab.

const IGNORE_DURATION_OPTIONS = [
  { label: 'Permanently', days: null },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
]

const AISLE_ORDER = ['F8B', 'F8C', 'F8D', 'F8E', 'F8F']

// F8F holds only 1 pallet position per location, vs. 2 for B/C/D/E --
// affects both the classification (done server-side, reflected in
// loc.openPositions) and how the card's sub-label reads here.
const SINGLE_POSITION_AISLES = new Set(['F8F'])

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const cardStyle = {
  background: 'var(--bg2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  padding: '16px 20px',
  minWidth: 150,
}

const smallBtnStyle = {
  fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
  background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
}

function IgnoreDurationMenu({ onPick, onClose }) {
  return (
    <div style={{
      position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 20,
      background: 'var(--bg0)', border: '1px solid var(--border)', borderRadius: 6,
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)', minWidth: 160, overflow: 'hidden',
    }}>
      {IGNORE_DURATION_OPTIONS.map(opt => (
        <button
          key={opt.label}
          onClick={() => { onPick(opt.days); onClose() }}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
            background: 'transparent', border: 'none', color: 'var(--text-primary)',
            fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg2)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export default function F8OpenPositions() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const [ignored, setIgnored] = useState([])
  const [manageOpen, setManageOpen] = useState(false)
  const [newLocationInput, setNewLocationInput] = useState('')
  const [durationMenuOpen, setDurationMenuOpen] = useState(false)
  const [ignoreBusy, setIgnoreBusy] = useState(false)
  const [ignoreMsg, setIgnoreMsg] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await fetchF8OpenPositions()
      setData(d)
      setLastRefresh(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadIgnored = useCallback(() => {
    fetchIgnoredLocations().then(setIgnored).catch(() => {}) // best-effort — never blocks the live tab
  }, [])

  useEffect(() => { load(); loadIgnored() }, [load, loadIgnored])

  // Active ignores only — a time-boxed one whose ignored_until has
  // passed stops matching here and the location reappears in the counts
  // automatically, same convention as WrPickCheck's dismissals.
  const activeIgnoredNames = useMemo(() => {
    const now = Date.now()
    const set = new Set()
    for (const i of ignored) {
      if (!i.ignored_until || new Date(i.ignored_until).getTime() > now) set.add(i.location_name)
    }
    return set
  }, [ignored])

  const rawLocations = data?.locations ?? []

  // Recomputed client-side from the raw per-location list, excluding
  // whatever's actively ignored — same "visible/filtered" convention as
  // WrPickCheck.jsx's dismissal handling, so ignoring a location actually
  // removes it from the aisle totals, not just hides it somewhere.
  // loc.openPositions is already aisle-aware (server-computed), so this
  // aggregation doesn't need to know the B-E-vs-F rule itself.
  const visibleAisles = useMemo(() => {
    const byAisle = {}
    for (const a of AISLE_ORDER) byAisle[a] = { aisle: a, empty: 0, oneLp: 0, openPositions: 0 }
    for (const loc of rawLocations) {
      if (activeIgnoredNames.has(loc.location)) continue
      const bucket = byAisle[loc.aisle]
      if (!bucket) continue
      if (loc.lpCount === 0) bucket.empty += 1
      if (loc.lpCount === 1) bucket.oneLp += 1
      bucket.openPositions += loc.openPositions
    }
    return AISLE_ORDER.map(a => byAisle[a])
  }, [rawLocations, activeIgnoredNames])

  const total = useMemo(() => visibleAisles.reduce((s, a) => s + a.openPositions, 0), [visibleAisles])

  async function handleIgnoreNew(days) {
    const name = newLocationInput.trim()
    if (!name) return
    setIgnoreBusy(true)
    setIgnoreMsg(null)
    try {
      await ignoreLocation(name, days, null, null)
      setNewLocationInput('')
      loadIgnored()
      setIgnoreMsg({ err: false, text: `${name.toUpperCase()} ignored.` })
    } catch (e) {
      setIgnoreMsg({ err: true, text: e.message || 'Failed to ignore location.' })
    } finally {
      setIgnoreBusy(false)
    }
  }

  async function handleRestore(locationName) {
    setIgnoreBusy(true)
    try {
      await restoreLocation(locationName)
      loadIgnored()
    } finally {
      setIgnoreBusy(false)
    }
  }

  const refreshLabel = lastRefresh
    ? lastRefresh.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) +
      ' ' + lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : 'loading…'

  // Datalist of currently-open locations, for autocomplete convenience —
  // the input still accepts any typed location code.
  const openLocationCodes = useMemo(
    () => rawLocations.filter(l => l.openPositions > 0 && !activeIgnoredNames.has(l.location)).map(l => l.location),
    [rawLocations, activeIgnoredNames]
  )

  return (
    <div style={{ padding: '16px 4px', fontSize: 13 }}>
      <div style={{ marginBottom: 4 }}>
        <div className="section-label" style={{ marginBottom: 4 }}>F8 Open Positions</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
          CSW-Madison · F8 aisles B–F · B–E: Empty = 2 open, 1 LP = 1 open · F: Empty = 1 open (1 LP = full)
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 16px', flexWrap: 'wrap' }}>
        <button
          onClick={load}
          disabled={loading}
          style={{ ...smallBtnStyle, background: 'transparent', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1 }}
        >
          {loading ? '⟳ Loading…' : '↻ Refresh'}
        </button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
          as of {refreshLabel}
        </span>
        {activeIgnoredNames.size > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
            · {activeIgnoredNames.size} location{activeIgnoredNames.size === 1 ? '' : 's'} ignored
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid #e05a5a', color: '#e05a5a', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          <strong>Failed to load data:</strong> {error}
          <button onClick={load} style={{ marginLeft: 12, fontSize: 11, padding: '2px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #e05a5a', background: 'transparent', color: '#e05a5a' }}>
            Retry
          </button>
        </div>
      )}

      {loading && !lastRefresh ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading live data…</p>
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
          {visibleAisles.map(a => (
            <div key={a.aisle} style={cardStyle}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {a.aisle}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 700, color: 'var(--brand, #d4a72c)', lineHeight: 1 }}>
                {a.openPositions}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
                {SINGLE_POSITION_AISLES.has(a.aisle)
                  ? <>{a.empty} empty</>
                  : <>{a.empty} empty · {a.oneLp} 1&nbsp;LP</>}
              </div>
            </div>
          ))}

          <div style={{ ...cardStyle, borderColor: 'var(--brand, #d4a72c)', borderWidth: 2, borderStyle: 'solid' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--brand, #d4a72c)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Total F8
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 700, color: 'var(--brand, #d4a72c)', lineHeight: 1 }}>
              {total}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
              open positions
            </div>
          </div>
        </div>
      )}

      <NotifySettingsPanel
        facility="mad"
        dashboardType="f8_open_positions"
        functionName="f8-open-positions-digest-test"
        contentDateLabel="today"
        showSkipToNextValidDay={false}
        digestDescription="Posts today's F8 Open Positions count per aisle (F8B–F8F) plus the total as a Front comment. Ignored locations (see below) are excluded here too."
      />

      {/* Manage Ignored Locations — deliberately a SEPARATE section from
          the Notify settings panel above, per Dan's explicit ask. Ignoring
          or restoring a location here immediately recomputes the aisle
          cards above (visibleAisles), and is also excluded server-side by
          the digest the next time it runs. */}
      <div style={{ marginTop: 12 }}>
        <button type="button" style={smallBtnStyle} onClick={() => setManageOpen(o => !o)}>
          {manageOpen ? 'Hide ignored locations' : 'Manage ignored locations'}
        </button>

        {manageOpen && (
          <div style={{
            marginTop: 8, background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '12px 16px', fontSize: 12, fontFamily: 'var(--font-mono)',
          }}>
            <div style={{ color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
              Ignore a specific location (any aisle) — it's removed from the aisle cards above and from the
              morning digest. Use exact location codes, e.g. F8E10-00.
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, position: 'relative', flexWrap: 'wrap' }}>
              <input
                type="text"
                list="f8-open-location-suggestions"
                placeholder="e.g. F8E10-00"
                value={newLocationInput}
                onChange={e => setNewLocationInput(e.target.value)}
                style={{
                  background: 'var(--bg0)', border: '1px solid var(--border)', borderRadius: 4,
                  color: 'var(--text-primary)', fontSize: 12, fontFamily: 'var(--font-mono)',
                  padding: '5px 8px', width: 180,
                }}
              />
              <datalist id="f8-open-location-suggestions">
                {openLocationCodes.map(code => <option key={code} value={code} />)}
              </datalist>
              <button
                type="button"
                style={smallBtnStyle}
                disabled={!newLocationInput.trim() || ignoreBusy}
                onClick={() => setDurationMenuOpen(o => !o)}
              >
                {ignoreBusy ? '…' : 'Ignore'}
              </button>
              {durationMenuOpen && (
                <IgnoreDurationMenu
                  onPick={handleIgnoreNew}
                  onClose={() => setDurationMenuOpen(false)}
                />
              )}
            </div>

            {ignoreMsg && (
              <div style={{ marginBottom: 10, color: ignoreMsg.err ? '#e05a5a' : 'var(--text-secondary)' }}>
                {ignoreMsg.text}
              </div>
            )}

            <div style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Currently ignored ({activeIgnoredNames.size})
            </div>
            {activeIgnoredNames.size === 0 ? (
              <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>No locations ignored.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {ignored
                  .filter(i => activeIgnoredNames.has(i.location_name))
                  .map(i => (
                    <div key={i.location_name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '4px 0', borderTop: '1px solid var(--border-subtle)' }}>
                      <div>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{i.location_name}</span>
                        <span style={{ color: 'var(--text-dim)', marginLeft: 10 }}>
                          ignored {fmtDate(i.ignored_at)}{i.ignored_until ? ` · until ${fmtDate(i.ignored_until)}` : ' · permanently'}
                        </span>
                      </div>
                      <button
                        type="button"
                        style={smallBtnStyle}
                        disabled={ignoreBusy}
                        onClick={() => handleRestore(i.location_name)}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
