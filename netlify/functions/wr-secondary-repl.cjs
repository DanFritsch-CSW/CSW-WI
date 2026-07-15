'use strict'

// WR "Secondary Replenishments" tab backend (added 2026-07-15, rewritten
// 2026-07-15 same day to query MotherDuck directly instead of Omni).
// Bernatello's - Wisconsin Rapids only (same warehouse scope as
// WrPickCheck/WrCasesToPick).
//
// ── Why MotherDuck instead of Omni (rewrite rationale) ───────────────────
// The original version (recreated from the standalone csw-secondary-
// replenishment repo) proxied 6 separate Omni queries through the
// existing omni-query.cjs function via internal HTTP round trips — each
// hop carries its own connection setup, retry/timeout overhead, and
// network latency. Dan asked for faster collective results. This version
// drops Omni entirely and queries production_db directly via MotherDuck
// (same duckdb init pattern as motherduck-wr-pick-check.cjs /
// motherduck-inventory.cjs: HOME=/tmp, :memory: db, ATTACH 'md:production_db'
// without alias, 3-part SQL names) — 3 SQL queries over ONE connection in
// a single function invocation, no repeated HTTP hops. Schema verified
// against motherduck-inventory.cjs's proven joins: licenseplates has no
// direct material_id column — material always resolves via
// licenseplatecontents -> lots -> materials. This is actually simpler
// than the original Omni version, which carried a 2-step lot->material
// fallback for F-aisle only (assuming LP-direct material for G-aisle) —
// that asymmetry doesn't exist in the real MotherDuck schema, so F and G
// inventory now use the exact same join shape.
//
// WAREHOUSE_ID = 6 for Wisconsin Rapids (same constant used by
// motherduck-wr-pick-check.cjs) — used directly rather than joining
// datex_slv_warehouses by name, since the ID is already known and fixed.
//
// ── Response shape is UNCHANGED from the Omni version ───────────────────
// { lpMap, pslotLotsMap, gInv, fInv, pslots, allInv, errors, fetchedAt,
//   elapsedMs } — plus a new `summary` field (bay-level stats: bays,
// emptyPositions, critical, noSecondaryInv, splitBays) computed here via
// a server-side port of the client's buildBays algorithm, so the new
// digest function (wr-secondary-repl-digest-run.cjs) can post real
// numbers without re-implementing bay-building logic a second time.
// WrSecondaryRepl.jsx is unchanged by this rewrite — it still computes
// its own stats client-side for display; `summary` here is purely for
// the digest.
//
// P-slot -> primary-pick-material assignment (secondary-repl-picks.json)
// remains static, unchanged from the original build.

const picks = require('./secondary-repl-picks.json')

const WAREHOUSE_ID = 6 // Wisconsin Rapids

// Buffer-slot map — kept in sync manually with
// src/lib/wrSecondaryReplConstants.js (SECONDARY_REPL_BUFFER_LOCS). Same
// class of intentional duplication already accepted elsewhere in this
// codebase (e.g. fefo-digest-run.cjs mirrors fefo.js's verdict engine) —
// this is a fixed business decision, not something that changes often.
const BUFFER_LOCS = [
  { loc: 'F029B', mat: '61002' }, { loc: 'F031B', mat: '61002' },
  { loc: 'F033B', mat: '61019' }, { loc: 'F035B', mat: '61019' },
  { loc: 'F037B', mat: '61003' }, { loc: 'F039B', mat: '61003' },
  { loc: 'F055B', mat: '61015' }, { loc: 'F057B', mat: '61015' },
  { loc: 'F069B', mat: '61010' }, { loc: 'F073B', mat: '61010' },
  { loc: 'F083B', mat: '059' },   { loc: 'F085B', mat: '059' },
  { loc: 'F087B', mat: '051' },   { loc: 'F089B', mat: '051' },
  { loc: 'F091B', mat: '056' },   { loc: 'F093B', mat: '056' },
  { loc: 'F095B', mat: '050' },   { loc: 'F097B', mat: '050' },
]

function num(v) { return Number(v ?? 0) || 0 }

// Server-side port of WrSecondaryRepl.jsx's buildBays — bay-building only
// (no pull-suggestion logic needed here, this just drives the digest's
// stat counts). Kept behaviorally identical to the client version.
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

  const bayNums = [...new Set(relevantP.map(p => parseInt(p.loc.match(/P(\d+)/)[1])))].sort((a, b) => a - b)

  const bufferByNum = {}
  if (aisle === 'F') {
    BUFFER_LOCS.forEach(b => {
      const m = b.loc.match(/F(\d+)B/)
      if (!m) return
      const n = parseInt(m[1])
      if (!bufferByNum[n]) bufferByNum[n] = []
      bufferByNum[n].push(b)
    })
  }

  const regularBays = bayNums.map(bayNum => {
    const faces = relevantP.filter(p => parseInt(p.loc.match(/P(\d+)/)[1]) === bayNum).sort((a, b) => a.loc.localeCompare(b.loc))
    const isSplit = new Set(faces.map(f => f.loc)).size > 1
    const secPrefix = aisle + String(bayNum).padStart(3, '0')
    const allTiers = ['B', 'C', 'D']

    const tierData = allTiers.map(t => {
      const key = secPrefix + t
      const lps = lpMap[key] || 0
      const empty = Math.max(0, 3 - lps)
      const secRows = (invMap[key] || []).map(r => ({ tier: t, loc: key, mat: r.mat, qty: r.qty }))
      return { t, key, lps, empty, secRows }
    })

    if (isSplit) {
      const mats = [...new Set(faces.map(f => f.mat))]
      const allSecRows = tierData.flatMap(td => td.secRows)
      const emptyPositions = tierData.reduce((s, td) => s + td.empty, 0)
      const hasMatchingInv = allSecRows.some(r => mats.includes(r.mat))
      return { num: bayNum, isSplit, mats, emptyPositions, hasMatchingInv, bufferTierData: [] }
    } else {
      const mats = [faces[0].mat]
      const bufferEntries = bufferByNum[bayNum] || []
      const hasBuffer = bufferEntries.length > 0
      const regularTiers = hasBuffer ? tierData.filter(td => td.t !== 'B') : tierData

      const bufferTierData = bufferEntries.map(b => {
        const lps = lpMap[b.loc] || 0
        const empty = Math.max(0, 3 - lps)
        const secRows = (invMap[b.loc] || []).map(r => ({ tier: 'B_buf', loc: b.loc, mat: r.mat, qty: r.qty }))
        return { t: 'B_buf', key: b.loc, lps, empty, secRows, bufferMat: b.mat }
      })

      const allSecRows = [...regularTiers.flatMap(td => td.secRows), ...bufferTierData.flatMap(td => td.secRows)]
      const bufferEmpty = bufferTierData.reduce((s, td) => s + td.empty, 0)
      const emptyPositions = regularTiers.reduce((s, td) => s + td.empty, 0) + bufferEmpty
      const hasMatchingInv = allSecRows.some(r => mats.includes(r.mat))

      return { num: bayNum, isSplit: false, mats, emptyPositions, hasMatchingInv, bufferTierData }
    }
  })

  // Orphan buffer bays (buffer locs with no matching P-slot bay in this aisle)
  const regularNums = new Set(regularBays.map(b => b.num))
  const orphanBuffers = []
  if (aisle === 'F') {
    const orphanNums = new Set(Object.keys(bufferByNum).map(Number).filter(n => !regularNums.has(n)))
    orphanNums.forEach(n => {
      const entries = bufferByNum[n]
      const bufferTierData = entries.map(b => {
        const lps = lpMap[b.loc] || 0
        const empty = Math.max(0, 3 - lps)
        return { t: 'B_buf', key: b.loc, lps, empty, bufferMat: b.mat }
      })
      const emptyPositions = bufferTierData.reduce((s, td) => s + td.empty, 0)
      orphanBuffers.push({ num: n, isSplit: false, isOrphanBuffer: true, mats: [], emptyPositions, hasMatchingInv: false })
    })
  }

  return [...regularBays, ...orphanBuffers]
}

function computeSummary(pslots, gInv, fInv, lpMap) {
  const gBays = buildBays('G', pslots, gInv, lpMap)
  const fBays = buildBays('F', pslots, fInv, lpMap)
  const allBays = [...gBays, ...fBays]
  return {
    bays: allBays.length,
    emptyPositions: allBays.reduce((s, b) => s + b.emptyPositions, 0),
    critical: allBays.filter(b => b.emptyPositions >= 5).length,
    noSecondaryInv: allBays.filter(b => !b.hasMatchingInv).length,
    splitBays: allBays.filter(b => b.isSplit).length,
  }
}

exports.handler = async () => {
  const t0 = Date.now()
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }
  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  let conn, db
  try {
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = sql => new Promise((resolve, reject) => conn.run(sql, err => (err ? reject(err) : resolve())))
    const runQuery = sql => new Promise((resolve, reject) => conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))))

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    // Query 1 — F+G aisle LP (license plate) count per location. Used both
    // as tier capacity (3 - lps = empty positions) and as the pull-from
    // weight for F/G locations (aisles A-E default to 1 LP, matching the
    // original design — see allInv assembly below).
    const fgLpSql = `
      SELECT loc.location_container_name AS loc, COUNT(*) AS lp_count
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN production_db.silver.datex_slv_locationcontainers loc ON lp.location_id = loc.location_container_id
      WHERE loc.warehouse_id = ${WAREHOUSE_ID}
        AND (loc.location_container_name LIKE 'F%' OR loc.location_container_name LIKE 'G%')
        AND NOT lp.archived
        AND lp.lookup_code NOT LIKE '3%'
      GROUP BY loc.location_container_name
    `

    // Query 2 — P-slot pick locations -> distinct vendor lot codes currently there.
    const pslotLotsSql = `
      SELECT DISTINCT loc.location_container_name AS loc, lot.lookup_code AS lot_code
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN production_db.silver.datex_slv_locationcontainers loc ON lp.location_id = loc.location_container_id
      JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lp.license_plate_id = lpc.license_plate_id
      JOIN production_db.silver.datex_slv_lots lot ON lpc.lot_id = lot.lot_id
      WHERE loc.warehouse_id = ${WAREHOUSE_ID}
        AND loc.location_container_name LIKE 'P%'
    `

    // Query 3 — warehouse-wide (excluding P pick faces) location + material +
    // summed qty. Drives gInv (loc LIKE 'G%'), fInv (loc LIKE 'F%'), and the
    // pull-from candidate list (all aisles A-G, distinct loc+mat).
    const invSql = `
      SELECT loc.location_container_name AS loc, m.lookup_code AS mat,
        SUM(lpc.packaged_amount) AS qty
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN production_db.silver.datex_slv_locationcontainers loc ON lp.location_id = loc.location_container_id
      JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lp.license_plate_id = lpc.license_plate_id
      JOIN production_db.silver.datex_slv_lots lot ON lpc.lot_id = lot.lot_id
      JOIN production_db.silver.datex_slv_materials m ON lot.material_id = m.material_id
      WHERE loc.warehouse_id = ${WAREHOUSE_ID}
        AND loc.location_container_name NOT LIKE 'P%'
        AND NOT lp.archived
        AND lp.lookup_code NOT LIKE '3%'
      GROUP BY loc.location_container_name, m.lookup_code
    `

    const [fgLpRows, pslotLotRows, invRows] = await Promise.all([
      runQuery(fgLpSql),
      runQuery(pslotLotsSql),
      runQuery(invSql),
    ])

    try { conn.close(); db.close() } catch (_) {}

    const lpMap = {}
    fgLpRows.forEach(r => { if (r.loc != null) lpMap[r.loc] = num(r.lp_count) })

    const pslotLotsMap = {}
    {
      const byLoc = {}
      pslotLotRows.forEach(r => {
        if (!r.loc || !r.lot_code) return
        if (!byLoc[r.loc]) byLoc[r.loc] = new Set()
        byLoc[r.loc].add(String(r.lot_code))
      })
      Object.entries(byLoc).forEach(([loc, set]) => { pslotLotsMap[loc] = [...set].sort() })
    }

    const invAll = invRows
      .map(r => ({ loc: r.loc, mat: r.mat, qty: num(r.qty) }))
      .filter(r => r.loc != null && r.mat != null && r.mat !== '')

    const gInv = invAll.filter(r => r.loc.startsWith('G'))
    const fInv = invAll.filter(r => r.loc.startsWith('F'))

    const pslots = Object.entries(picks)
      .filter(([, mat]) => mat && mat !== '')
      .map(([loc, mat]) => ({ loc, mat, qty: 0 }))

    // Pull-from candidates: every distinct (loc, mat) across the warehouse,
    // with LP-count weight from lpMap (F/G only, else default 1) — same
    // design as the original Omni version.
    const seen = new Set()
    const allInv = []
    for (const r of invAll) {
      const key = `${r.loc}|${r.mat}`
      if (seen.has(key)) continue
      seen.add(key)
      allInv.push({ loc: r.loc, mat: r.mat, lp: lpMap[r.loc] || 1 })
    }

    const summary = computeSummary(pslots, gInv, fInv, lpMap)

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        lpMap, pslotLotsMap, gInv, fInv, pslots, allInv, summary,
        errors: null,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), elapsedMs: Date.now() - t0 }),
    }
  }
}
