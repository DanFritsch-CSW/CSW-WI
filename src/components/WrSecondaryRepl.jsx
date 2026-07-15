import { useState, useMemo, useEffect, useCallback } from 'react'
import { fetchWrSecondaryRepl } from '../lib/wrSecondaryRepl.js'
import { SECONDARY_REPL_BUFFER_LOCS as BUFFER_LOCS } from '../lib/wrSecondaryReplConstants.js'

// WR "Secondary Replenishments" sub-tab (added 2026-07-15) — recreated from
// the standalone csw-secondary-replenishment repo/site
// (csw-secondary-replenishment.netlify.app) as a WR sub-tab next to
// Pick Location Lot Check. Bernatello's - Wisconsin Rapids only.
//
// For every F-aisle (odd bay #) / G-aisle (even bay #) pallet-rack bay,
// shows how many secondary-storage LPs are in the B/C/D tiers above the
// primary P-slot pick face, whether the tiers match what's actually being
// picked, and — when a tier is short — which warehouse locations have that
// material available to pull down, furthest-aisle-first (A first, G last).
// See netlify/functions/wr-secondary-repl.cjs for the full live-query design
// (6 Omni reads proxied through omni-query, combined server-side).
//
// Bay-building and pull-suggestion algorithms below are ported verbatim
// from the original repo's src/App.jsx — same aisle-rank/furthest-first
// logic, same split-bay / buffer-slot handling.

const AISLE_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 }
function aisleRank(loc) {
  const ch = loc.charAt(0).toUpperCase()
  return AISLE_ORDER[ch] !== undefined ? AISLE_ORDER[ch] : 99
}

function buildPullMap(allInv) {
  const map = {}
  allInv.forEach(r => {
    if (!map[r.mat]) map[r.mat] = []
    map[r.mat].push(r)
  })
  Object.keys(map).forEach(mat => {
    map[mat].sort((a, b) => {
      const ra = aisleRank(a.loc), rb = aisleRank(b.loc)
      if (ra !== rb) return ra - rb
      return a.loc.localeCompare(b.loc)
    })
  })
  return map
}

function getPullLocations(mats, pullMap, bayCapacity, buffer = 3, claimedLocs = null) {
  const target = bayCapacity + buffer
  const results = []
  for (const mat of mats) {
    const locs = (pullMap[mat] || []).filter(r =>
      !r.loc.startsWith('P') &&
      (!claimedLocs || !claimedLocs.has(r.loc))
    )
    let cumulative = 0
    const needed = []
    for (const r of locs) {
      if (cumulative >= target) break
      needed.push(r)
      cumulative += r.lp
    }
    if (needed.length > 0) {
      if (claimedLocs) needed.forEach(r => claimedLocs.add(r.loc))
      results.push({ mat, locs: needed, total: cumulative })
    }
  }
  return results
}

function buildBays(aisle, pslots, inv, lpMap) {
  const invMap = {}
  inv.forEach(r => {
    if (!invMap[r.loc]) invMap[r.loc] = []
    invMap[r.loc].push(r)
  })

  const isEven = n => n % 2 === 0
  const aisleFilter = aisle === 'G' ? isEven : n => !isEven(n)

  const relevantP = pslots.filter(p => {
    const m = p.loc.match(/P(\d+)/)
    if (!m) return false
    return aisleFilter(parseInt(m[1]))
  })

  const bayNums = [
    ...new Set(relevantP.map(p => parseInt(p.loc.match(/P(\d+)/)[1]))),
  ].sort((a, b) => a - b)

  const bufferByNum = {}
  if (aisle === 'F') {
    BUFFER_LOCS.forEach(b => {
      const m = b.loc.match(/F(\d+)B/)
      if (!m) return
      const num = parseInt(m[1])
      if (!bufferByNum[num]) bufferByNum[num] = []
      bufferByNum[num].push(b)
    })
  }

  const regularBays = bayNums.map(num => {
    const faces = relevantP
      .filter(p => parseInt(p.loc.match(/P(\d+)/)[1]) === num)
      .sort((a, b) => a.loc.localeCompare(b.loc))
    const isSplit = new Set(faces.map(f => f.loc)).size > 1
    const secPrefix = aisle + String(num).padStart(3, '0')
    const allTiers = ['B', 'C', 'D']

    const tierData = allTiers.map(t => {
      const key = secPrefix + t
      const lps = lpMap[key] || 0
      const empty = Math.max(0, 3 - lps)
      const secRows = (invMap[key] || []).map(r => ({
        tier: t, loc: key, mat: r.mat, qty: r.qty,
      }))
      return { t, key, lps, empty, secRows }
    })

    if (isSplit) {
      const faceA = faces.find(f => f.loc.endsWith('A'))
      const faceB = faces.find(f => f.loc.endsWith('B'))
      const splitFaces = [
        { face: faceA, mats: faceA ? [faceA.mat] : [], tiers: tierData.filter(td => td.t === 'B') },
        { face: faceB, mats: faceB ? [faceB.mat] : [], tiers: tierData.filter(td => td.t === 'C' || td.t === 'D') },
      ]
      const mats = [...new Set(faces.map(f => f.mat))]
      const allSecRows = tierData.flatMap(td => td.secRows)
      const emptyPositions = tierData.reduce((s, td) => s + td.empty, 0)
      const hasMatchingInv = allSecRows.some(r => mats.includes(r.mat))
      return {
        num, faces, isSplit, mats, secPrefix, emptyPositions,
        hasMatchingInv, allSecRows, tierLetters: allTiers, tierData, splitFaces,
      }
    } else {
      const mats = [faces[0].mat]
      const bufferEntries = bufferByNum[num] || []
      const hasBuffer = bufferEntries.length > 0
      const regularTiers = hasBuffer ? tierData.filter(td => td.t !== 'B') : tierData

      const bufferTierData = bufferEntries.map(b => {
        const lps = lpMap[b.loc] || 0
        const empty = Math.max(0, 3 - lps)
        const secRows = (invMap[b.loc] || []).map(r => ({
          tier: 'B_buf', loc: b.loc, mat: r.mat, qty: r.qty,
        }))
        return { t: 'B_buf', key: b.loc, lps, empty, secRows, bufferMat: b.mat }
      })

      const allSecRows = [
        ...regularTiers.flatMap(td => td.secRows),
        ...bufferTierData.flatMap(td => td.secRows),
      ]
      const bufferEmpty = bufferTierData.reduce((s, td) => s + td.empty, 0)
      const emptyPositions = regularTiers.reduce((s, td) => s + td.empty, 0) + bufferEmpty
      const hasMatchingInv = allSecRows.some(r => mats.includes(r.mat))

      return {
        num, faces, isSplit, mats, secPrefix, emptyPositions,
        hasMatchingInv, allSecRows,
        tierLetters: hasBuffer ? ['C', 'D'] : allTiers,
        tierData: regularTiers,
        bufferTierData,
      }
    }
  })

  const regularNums = new Set(regularBays.map(b => b.num))
  const orphanBuffers = []
  if (aisle === 'F') {
    const orphanNums = new Set(
      Object.keys(bufferByNum).map(Number).filter(n => !regularNums.has(n))
    )
    orphanNums.forEach(n => {
      const entries = bufferByNum[n]
      const mats = [...new Set(entries.map(e => e.mat))]
      const secPrefix = 'F' + String(n).padStart(3, '0')
      const bufferTierData = entries.map(b => {
        const lps = lpMap[b.loc] || 0
        const empty = Math.max(0, 3 - lps)
        const secRows = (invMap[b.loc] || []).map(r => ({
          tier: 'B_buf', loc: b.loc, mat: r.mat, qty: r.qty,
        }))
        return { t: 'B_buf', key: b.loc, lps, empty, secRows, bufferMat: b.mat }
      })
      const emptyPositions = bufferTierData.reduce((s, td) => s + td.empty, 0)
      orphanBuffers.push({
        num: n, faces: [], isSplit: false, isOrphanBuffer: true,
        mats, secPrefix, emptyPositions,
        hasMatchingInv: false, allSecRows: [],
        tierLetters: [], tierData: [], bufferTierData,
      })
    })
  }

  return [...regularBays, ...orphanBuffers].sort((a, b) => a.num - b.num)
}

function urgencyColor(emp) {
  if (emp >= 5) return '#e05a5a'
  if (emp >= 3) return '#d4a72c'
  return '#3fb950'
}

function LotBadge({ lots }) {
  if (!lots || lots.length === 0) return null
  return (
    <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'rgba(88,101,242,0.12)', color: '#8891f5', border: '1px solid rgba(88,101,242,0.3)', fontFamily: 'var(--font-mono)' }}>
      Lot {lots.join(', ')}
    </span>
  )
}

function PullSuggestions({ pullSuggestions }) {
  if (pullSuggestions.length === 0) return null
  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 2 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>Pull from</div>
      {pullSuggestions.map(({ mat, locs }) => (
        <div key={mat} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 3, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, minWidth: 48, color: 'var(--text-primary)' }}>{mat}</span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {locs.map((r, i) => (
              <span key={i} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: 'rgba(212,167,44,0.12)', color: '#d4a72c', border: '1px solid rgba(212,167,44,0.35)', fontFamily: 'var(--font-mono)' }}>
                {r.loc} <span style={{ opacity: 0.7 }}>{r.lp} LP{r.lp !== 1 ? 's' : ''}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TierRow({ td, allSecRows, mats }) {
  const tierMats = [...new Set((td.secRows || allSecRows.filter(r => r.tier === td.t)).map(r => r.mat))]
  const isMatch = tierMats.some(m => mats.includes(m))
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
      <span style={{ fontSize: 10, width: 14, color: 'var(--text-dim)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{td.t.replace('_buf', '')}</span>
      {td.lps > 0 && (
        <span style={{
          fontSize: 10, padding: '1px 5px', borderRadius: 3,
          background: isMatch ? 'rgba(63,185,80,0.14)' : 'var(--bg2)',
          color: isMatch ? '#3fb950' : 'var(--text-secondary)',
          border: `1px solid ${isMatch ? 'rgba(63,185,80,0.35)' : 'var(--border-subtle)'}`,
        }}>
          {tierMats.filter(Boolean).join(', ') || '(no mat.)'} — {td.lps} LP{td.lps !== 1 ? 's' : ''}
        </span>
      )}
      {td.empty > 0 && (
        <span style={{ fontSize: 10, color: '#e05a5a', fontStyle: 'italic' }}>
          {td.lps === 0 ? 'empty — 3 positions' : `${td.empty} empty position${td.empty > 1 ? 's' : ''}`}
        </span>
      )}
    </div>
  )
}

function FaceSection({ face, mats, tiers, pullMap, claimedLocs, lots }) {
  const faceEmpty = tiers.reduce((s, td) => s + td.empty, 0)
  const faceCapacity = tiers.length * 3
  const pullSuggestions = getPullLocations(mats, pullMap, faceCapacity, 3, claimedLocs)
  const urg = urgencyColor(faceEmpty)
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{face ? face.loc : '—'}</span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{mats.join(', ')}</span>
          <LotBadge lots={lots} />
        </div>
        {faceEmpty > 0 && <span style={{ fontSize: 11, color: urg, fontWeight: 600 }}>{faceEmpty} empty</span>}
      </div>
      <div style={{ marginBottom: faceEmpty > 0 ? 6 : 0 }}>
        {tiers.map(td => <TierRow key={td.t} td={td} allSecRows={[]} mats={mats} />)}
      </div>
      {faceEmpty > 0 && pullSuggestions.length > 0 && <PullSuggestions pullSuggestions={pullSuggestions} />}
      {faceEmpty > 0 && pullSuggestions.length === 0 && (
        <div style={{ paddingTop: 4, fontSize: 11, color: '#e05a5a', fontStyle: 'italic' }}>No pull locations found for this material</div>
      )}
    </div>
  )
}

function BufferSlotBlock({ bufferTierData, pullMap, claimedLocs, title }) {
  return (
    <div style={{ borderTop: '1px dashed var(--border-subtle)', paddingTop: 6, marginTop: 6 }}>
      {title && <div style={{ fontSize: 10, fontWeight: 600, color: '#3fb950', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>{title}</div>}
      {[...new Set(bufferTierData.map(td => td.bufferMat))].map(mat => {
        const entries = bufferTierData.filter(td => td.bufferMat === mat)
        const bufMatEmpty = entries.reduce((s, td) => s + td.empty, 0)
        const bufPull = getPullLocations([mat], pullMap, entries.length * 3, 3, claimedLocs)
        return (
          <div key={mat} style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 3 }}>Material: {mat}</div>
            {entries.map((td, i) => (
              <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
                <span style={{ fontSize: 10, width: 14, color: '#3fb950', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>B</span>
                {td.lps > 0 && (
                  <span style={{
                    fontSize: 10, padding: '1px 5px', borderRadius: 3,
                    background: 'rgba(63,185,80,0.14)', color: '#3fb950', border: '1px solid rgba(63,185,80,0.35)',
                  }}>
                    {[...new Set((td.secRows || []).map(r => r.mat))].join(', ') || '(no mat.)'} — {td.lps} LP{td.lps !== 1 ? 's' : ''}
                  </span>
                )}
                {td.empty > 0 && (
                  <span style={{ fontSize: 10, color: '#e05a5a', fontStyle: 'italic' }}>
                    {td.lps === 0 ? 'empty — 3 positions' : `${td.empty} empty position${td.empty > 1 ? 's' : ''}`}
                  </span>
                )}
              </div>
            ))}
            {bufMatEmpty > 0 && (
              bufPull.length > 0
                ? <PullSuggestions pullSuggestions={bufPull} />
                : <div style={{ paddingTop: 4, fontSize: 11, color: '#e05a5a', fontStyle: 'italic' }}>No pull locations found for this material</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function BayCard({ bay, pullMap, claimedLocs, pslotLotsMap }) {
  const urg = urgencyColor(bay.emptyPositions)
  const cardStyle = { border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', background: 'var(--bg1)', marginBottom: 8 }

  if (bay.isSplit) {
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{bay.secPrefix}</span>
            <span style={{ fontSize: 10, background: 'rgba(88,101,242,0.15)', color: '#8891f5', padding: '1px 6px', borderRadius: 4 }}>split</span>
          </div>
          <span style={{ fontSize: 12, color: urg, fontWeight: 600 }}>{bay.emptyPositions > 0 ? `${bay.emptyPositions} empty` : 'full'}</span>
        </div>
        {bay.splitFaces.map((sf, i) => (
          <div key={i}>
            {i > 0 && <div style={{ borderTop: '1px dashed var(--border-subtle)', margin: '8px 0' }} />}
            <FaceSection face={sf.face} mats={sf.mats} tiers={sf.tiers} pullMap={pullMap} claimedLocs={claimedLocs} lots={sf.face ? (pslotLotsMap || {})[sf.face.loc] : undefined} />
          </div>
        ))}
      </div>
    )
  }

  if (bay.isOrphanBuffer) {
    const bufferEmpty = bay.bufferTierData.reduce((s, td) => s + td.empty, 0)
    const urg2 = urgencyColor(bufferEmpty)
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{bay.secPrefix}</span>
            <span style={{ fontSize: 10, background: 'rgba(63,185,80,0.15)', color: '#3fb950', padding: '1px 6px', borderRadius: 4 }}>buffer</span>
          </div>
          <span style={{ fontSize: 12, color: urg2, fontWeight: 600 }}>{bufferEmpty > 0 ? `${bufferEmpty} empty` : 'full'}</span>
        </div>
        <BufferSlotBlock bufferTierData={bay.bufferTierData} pullMap={pullMap} claimedLocs={claimedLocs} />
      </div>
    )
  }

  const bayCapacity = bay.tierLetters.length * 3
  const regEmpty = bay.tierData.reduce((s, td) => s + td.empty, 0)
  const regPull = getPullLocations(bay.mats, pullMap, bay.tierData.length * 3, 3, claimedLocs)

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{bay.secPrefix}</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{bay.faces.map(f => f.loc).join(' / ')}</span>
        </div>
        <span style={{ fontSize: 12, color: urg, fontWeight: 600 }}>{bay.emptyPositions > 0 ? `${bay.emptyPositions} empty` : 'full'}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>Materials: {bay.mats.join(', ')}</span>
        <LotBadge lots={bay.faces.length > 0 ? (pslotLotsMap || {})[bay.faces[0].loc] : undefined} />
      </div>
      <div style={{ marginBottom: bay.emptyPositions > 0 ? 8 : 0 }}>
        {bay.tierData.map(td => <TierRow key={td.t} td={td} allSecRows={bay.allSecRows} mats={bay.mats} />)}
      </div>

      {regEmpty > 0 && (
        regPull.length > 0
          ? <PullSuggestions pullSuggestions={regPull} />
          : <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 7, marginTop: 4, fontSize: 11, color: '#e05a5a', fontStyle: 'italic' }}>No pull locations found for this material</div>
      )}

      {bay.bufferTierData && bay.bufferTierData.length > 0 && (
        <BufferSlotBlock bufferTierData={bay.bufferTierData} pullMap={pullMap} claimedLocs={claimedLocs} title="— Buffer slot —" />
      )}
    </div>
  )
}

export default function WrSecondaryRepl() {
  const [aisle, setAisle] = useState('F')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('bay')

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await fetchWrSecondaryRepl()
      setData(d)
      if (d.errors) setError(Object.entries(d.errors).map(([k, v]) => `${k}: ${v}`).join(' | '))
      setLastRefresh(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const pslots = data?.pslots ?? []
  const lpMap = data?.lpMap ?? {}
  const pslotLotsMap = data?.pslotLotsMap ?? {}
  const gInv = data?.gInv ?? []
  const fInv = data?.fInv ?? []
  const allInv = data?.allInv ?? []

  const inv = aisle === 'G' ? gInv : fInv
  const bays = useMemo(() => buildBays(aisle, pslots, inv, lpMap), [aisle, pslots, inv, lpMap])
  const pullMap = useMemo(() => buildPullMap(allInv), [allInv])

  const filtered = bays.filter(b => {
    if (filter === 'empty') return b.emptyPositions > 0
    if (filter === 'critical') return b.emptyPositions >= 5
    if (filter === 'noinv') return !b.hasMatchingInv
    return true
  })
  const sorted = [...filtered].sort((a, b) => sort === 'empty' ? b.emptyPositions - a.emptyPositions : a.num - b.num)

  const totalBays = bays.length
  const totalEmpty = bays.reduce((s, b) => s + b.emptyPositions, 0)
  const critical = bays.filter(b => b.emptyPositions >= 5).length
  const noInv = bays.filter(b => !b.hasMatchingInv).length
  const splits = bays.filter(b => b.isSplit).length

  const refreshLabel = lastRefresh
    ? lastRefresh.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) + ' ' + lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : 'loading…'

  return (
    <div style={{ padding: '16px 4px', fontSize: 13 }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
        Bernatello's - Wisconsin Rapids · data {refreshLabel}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, maxWidth: 680 }}>
        Secondary-storage tiers (B/C/D) above each F/G-aisle primary pick face — empty positions and, when short,
        which warehouse locations have that material to pull down, furthest aisle first.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <button
          onClick={load}
          disabled={loading}
          title="Re-fetch live data from Omni"
          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: loading ? 'default' : 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', opacity: loading ? 0.5 : 1 }}
        >
          {loading ? '⟳ Loading…' : '↻ Refresh data'}
        </button>
        <button
          onClick={() => window.print()}
          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          Print / Save PDF
        </button>
        <div style={{ display: 'flex', gap: 4 }}>
          {['G', 'F'].map(a => (
            <button key={a} onClick={() => setAisle(a)} style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-mono)',
              background: aisle === a ? 'var(--accent)' : 'transparent',
              color: aisle === a ? '#0a0a0a' : 'var(--text-primary)',
              border: '1px solid var(--border)',
            }}>
              {a === 'G' ? 'G Aisle · even' : 'F Aisle · odd'}
            </button>
          ))}
        </div>
        <select value={filter} onChange={e => setFilter(e.target.value)} className="settings-field-input" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6 }}>
          <option value="all">All bays</option>
          <option value="empty">Has empty positions</option>
          <option value="critical">Critical (5+)</option>
          <option value="noinv">No matching inv.</option>
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)} className="settings-field-input" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6 }}>
          <option value="bay">Sort: bay number</option>
          <option value="empty">Sort: most empty</option>
        </select>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        {[
          { label: 'Bays', val: totalBays, color: 'var(--text-primary)' },
          { label: 'Empty positions', val: totalEmpty, color: 'var(--text-primary)' },
          { label: 'Critical (5+)', val: critical, color: '#e05a5a' },
          { label: 'No secondary inv.', val: noInv, color: '#d4a72c' },
          { label: 'Split bays', val: splits, color: 'var(--text-primary)' },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', minWidth: 130 }}>
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, color: s.color }}>{loading ? '—' : s.val}</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: 'var(--font-mono)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {error && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid #e05a5a', color: '#e05a5a', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          <strong>Failed to load data:</strong> {error}
          <button onClick={load} style={{ marginLeft: 12, fontSize: 11, padding: '2px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #e05a5a', background: 'transparent', color: '#e05a5a' }}>
            Retry
          </button>
        </div>
      )}

      <div>
        {loading && !lastRefresh ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading live data from Omni…</p>
        ) : sorted.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>No bays match the current filter.</p>
        ) : (
          (() => {
            const claimedLocs = new Set()
            return sorted.map(b => (
              <BayCard key={b.num} bay={b} pullMap={pullMap} claimedLocs={claimedLocs} pslotLotsMap={pslotLotsMap} />
            ))
          })()
        )}
      </div>

      {lastRefresh && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 10, fontFamily: 'var(--font-mono)' }}>
          fetched {lastRefresh.toLocaleTimeString()} {data?.elapsedMs != null ? `· ${data.elapsedMs}ms` : ''}
        </div>
      )}
    </div>
  )
}
