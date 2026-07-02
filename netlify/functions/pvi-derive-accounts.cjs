'use strict'

// Netlify function — one-shot PVI canonical account seed suggester.
//
// POST input: {} (no body needed)
// Response: {
//   fetchedAt: ISO,
//   elapsedMs: N,
//   suggestions: [
//     {
//       canonical_name: 'Costco',
//       account_type:   'end_customer' | 'internal_transfer',
//       derived_days:   156,        // MAX of marks in [60..365] across the cluster; null if not derivable
//       raw_names:      ['COSTCO', 'Costco Chicago', ...],
//       shipment_count: 156,
//       lines:          1249,
//     },
//     ...
//   ],
//   unclustered: [{ raw_account_name, shipments, lines, mode_marks }],
// }
//
// Scans the last 90 days of PVI (PALVI9 + PALDSD9 + PALMA9, CAL only) order
// lines, extracts each ship-to's raw name + integer marks values, then applies
// a keyword-based canonicalizer to cluster raw names into canonical accounts.
//
// Design notes:
//   - Marks in 60..365 are treated as real shelf-life days. Outside that range
//     is either (a) internal transfer metadata (32 dominant across CSW-*
//     transfers), (b) misfired data (negatives, huge numbers), or (c) lot
//     seq counts. Filter aggressively.
//   - Uses MAX of valid marks per canonical → the strictest requirement the
//     customer has ever enforced on any line. Bias conservative.
//   - Canonicalizer is intentionally coarse: it groups obvious brands (COSTCO
//     Atlanta / Mira Loma / Sumner → Costco) and known internal patterns
//     (PVI - Canal, DSD Route N, CSW-*) but leaves anything ambiguous
//     unclustered for user review. Better to have a Settings tab with 25
//     obvious buckets pre-populated + 40 unclustered names for review than
//     to auto-cluster 60 names wrong.
//   - Uses the same duckdb/MotherDuck init pattern as fefo-orders.cjs (see
//     that file's top-of-file comment block for the full rationale).

process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// PVI project set — CAL only per Phase 1 scope. Kenosha DSD (PALDSD5) and
// other Palermo's project variants are out of scope for now.
const PVI_PROJECT_LOOKUPS = ['PALVI9', 'PALDSD9', 'PALMA9']

// Marks are considered valid shelf-life days only within this window. See
// data check 2 (marks distribution) — 32 dominates transfers, negatives and
// values >365 appear as data errors.
const MIN_VALID_MARKS = 60
const MAX_VALID_MARKS = 365

// Canonicalizer — keyword patterns tested top-down. First match wins. Anything
// unmatched falls into the `unclustered` bucket for user review.
//
// Rules of thumb for keeping this list maintainable:
//   - Test patterns are UPPERCASED before matching; add them in uppercase.
//   - Prefer /\bKEYWORD\b/ or explicit prefixes over unbounded partial matches.
//   - Put more-specific patterns above less-specific ones (e.g. SAMS CLUB
//     before WALMART, since Sam's Club used to be Walmart-branded).
//   - Internal transfers get account_type='internal_transfer'; end customers
//     get 'end_customer'.
const CANONICAL_RULES = [
  // Internal / transfer / Palermo's-owned
  { canonical: 'Palermo\'s (Internal Transfer)', type: 'internal_transfer', patterns: [/\bPVI\s*-/, /PALERMO/] },
  { canonical: 'CSW (Internal Transfer)',        type: 'internal_transfer', patterns: [/^CSW\b/, /\bCSW-/] },
  { canonical: 'DSD Route (Internal)',           type: 'internal_transfer', patterns: [/\bDSD\s*ROUTE\b/] },
  { canonical: 'Americold (Cold Storage)',       type: 'internal_transfer', patterns: [/\bAMERICOLD\b/] },
  { canonical: 'Northland Cold Storage',         type: 'internal_transfer', patterns: [/\bNORTHLAND\s+COLD/] },
  { canonical: 'Minnesota Cold Storage',         type: 'internal_transfer', patterns: [/\bMINNESOTA\s+COLD/] },
  { canonical: 'Valley Cold Transit',            type: 'internal_transfer', patterns: [/\bVALLEY\s+COLD/] },
  { canonical: 'Cold Storage (Other)',           type: 'internal_transfer', patterns: [/\bCOLD\s+STORAGE\b/, /\bTRANSIT\b/] },
  { canonical: 'Carol Stream Cross-Dock',        type: 'internal_transfer', patterns: [/\bCAROL\s+STREAM\b/] },

  // End customers — big-box retailers
  { canonical: 'Costco',        type: 'end_customer', patterns: [/\bCOSTCO\b/] },
  { canonical: "Sam's Club",    type: 'end_customer', patterns: [/\bSAM'?S\s*CLUB\b/, /\bSAMS\s*CLUB\b/] },
  { canonical: 'Walmart',       type: 'end_customer', patterns: [/\bWAL[- ]?MART\b/, /\bWALMART\b/] },
  { canonical: 'Target',        type: 'end_customer', patterns: [/\bTARGET\b/] },
  { canonical: 'Kroger',        type: 'end_customer', patterns: [/\bKROGER\b/] },
  { canonical: 'Publix',        type: 'end_customer', patterns: [/\bPUBLIX\b/] },
  { canonical: 'Meijer',        type: 'end_customer', patterns: [/\bMEIJER\b/] },
  { canonical: 'Aldi',          type: 'end_customer', patterns: [/\bALDI\b/] },
  { canonical: 'Wegmans',       type: 'end_customer', patterns: [/\bWEGMANS\b/] },
  { canonical: 'HEB',           type: 'end_customer', patterns: [/\bH-?E-?B\b/, /\bHEB\b/] },

  // Grocery — regional chains
  { canonical: 'Food Lion',     type: 'end_customer', patterns: [/\bFOOD\s*LION\b/, /\bFOODLION\b/] },
  { canonical: 'Giant Eagle',   type: 'end_customer', patterns: [/\bGIANT\s+EAGLE\b/] },
  { canonical: 'Hy-Vee',        type: 'end_customer', patterns: [/\bHY-?VEE\b/] },
  { canonical: 'Ahold',         type: 'end_customer', patterns: [/\bAHOLD\b/, /\bSTOP\s*[& ]\s*SHOP\b/, /\bGIANT\s+FOOD\b/] },
  { canonical: 'Weis',          type: 'end_customer', patterns: [/\bWEIS\b/] },
  { canonical: 'Winn-Dixie',    type: 'end_customer', patterns: [/\bWINN-?DIXIE\b/] },
  { canonical: 'Piggly Wiggly', type: 'end_customer', patterns: [/\bPIGGLY\b/] },
  { canonical: 'Festival Foods',type: 'end_customer', patterns: [/\bFESTIVAL\s+FOODS\b/] },
  { canonical: 'Woodmans',      type: 'end_customer', patterns: [/\bWOODMANS?\b/, /\bWOODMAN'S\b/] },

  // Foodservice / distributors
  { canonical: 'Sysco',           type: 'end_customer', patterns: [/\bSYSCO\b/] },
  { canonical: 'US Foods',        type: 'end_customer', patterns: [/\bUS\s*FOODS\b/, /\bUSFS\b/] },
  { canonical: 'Reinhart',        type: 'end_customer', patterns: [/\bREINHART\b/] },
  { canonical: 'Performance Food',type: 'end_customer', patterns: [/\bPERFORMANCE\s+FOOD\b/, /\bPFG\b/] },
  { canonical: 'Gordon Food Service', type: 'end_customer', patterns: [/\bGORDON\s+FOOD\b/, /\bGFS\b/] },
  { canonical: 'Shamrock Foods',  type: 'end_customer', patterns: [/\bSHAMROCK\b/] },
  { canonical: 'UNFI',            type: 'end_customer', patterns: [/\bUNFI\b/] },
  { canonical: 'C&S',             type: 'end_customer', patterns: [/^C\s*&\s*S\b/, /\bC&S\b/] },
  { canonical: 'Martin-Brower',   type: 'end_customer', patterns: [/\bMARTIN-?BROWER\b/, /\bMB\s/] },
  { canonical: 'Roundy\'s',       type: 'end_customer', patterns: [/\bROUNDY'?S\b/] },
  { canonical: 'Associated Wholesale', type: 'end_customer', patterns: [/\bASSOCIATED\s+WHOLESALE\b/, /\bAWG\b/] },

  // Convenience / fuel
  { canonical: 'QuikTrip (QT)',   type: 'end_customer', patterns: [/^QT\b/, /\bQUIKTRIP\b/] },
  { canonical: 'Kwik Trip',       type: 'end_customer', patterns: [/\bKWIK\s*TRIP\b/] },
  { canonical: 'Casey\'s',        type: 'end_customer', patterns: [/\bCASEY'?S\b/] },
  { canonical: '7-Eleven',        type: 'end_customer', patterns: [/\b7-?ELEVEN\b/] },
  { canonical: 'Sheetz',          type: 'end_customer', patterns: [/\bSHEETZ\b/] },
  { canonical: 'Wawa',            type: 'end_customer', patterns: [/\bWAWA\b/] },
  { canonical: 'Circle K',        type: 'end_customer', patterns: [/\bCIRCLE\s*K\b/] },

  // Restaurant / QSR
  { canonical: 'Hunt Brothers Pizza', type: 'end_customer', patterns: [/^HUNT\b/, /\bHUNT\s+BROTHERS\b/] },
  { canonical: 'RaOs',            type: 'end_customer', patterns: [/\bRAOS\b/] },
  { canonical: 'General Mills',   type: 'end_customer', patterns: [/\bGENERAL\s+MILLS\b/] },
  { canonical: 'Olympia',         type: 'end_customer', patterns: [/\bOLYMPIA\b/] },
]

function normalizeName(s) {
  return String(s || '').toUpperCase().trim()
}

function canonicalize(rawName) {
  const upper = normalizeName(rawName)
  if (!upper) return null
  for (const rule of CANONICAL_RULES) {
    if (rule.patterns.some(pat => pat.test(upper))) {
      return { canonical_name: rule.canonical, account_type: rule.type }
    }
  }
  return null
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return {
      statusCode: 500, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }),
    }
  }

  let conn, db
  try {
    process.env.HOME = '/tmp'
    process.env.motherduck_token = TOKEN
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = (sql) => new Promise((resolve, reject) => {
      conn.run(sql, (err) => err ? reject(err) : resolve())
    })
    const runQuery = (sql) => new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows))
    })

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    // Single scan: per (ship_to_name, marks) tuple, count lines + orders.
    // 90-day window bounded to CAL PVI projects. NULL/empty ship-to names
    // are excluded — they'll surface as "unclustered" but with a placeholder.
    const projList = PVI_PROJECT_LOOKUPS.map(p => `'${p}'`).join(',')
    const sql = `
      WITH pvi_orders AS (
        SELECT o.order_id
        FROM production_db.silver.datex_slv_orders o
        JOIN production_db.silver.datex_slv_projects p ON p.project_id = o.project_id
        WHERE p.lookup_code IN (${projList})
          AND o.parquet_record_sys_date_time >= CURRENT_DATE - INTERVAL 90 DAY
      ),
      shipto AS (
        SELECT order_id, "Name" AS raw_name
        FROM production_db.silver.datex_slv_orderaddresses
        WHERE type_id = 2
      )
      SELECT
        s.raw_name,
        COUNT(DISTINCT po.order_id) AS shipments,
        COUNT(*)                    AS lines,
        MAX(CASE
              WHEN TRY_CAST(ol."Marks" AS INTEGER) BETWEEN ${MIN_VALID_MARKS} AND ${MAX_VALID_MARKS}
              THEN TRY_CAST(ol."Marks" AS INTEGER)
            END)                    AS max_valid_marks,
        MODE(TRY_CAST(ol."Marks" AS INTEGER)) AS mode_marks
      FROM production_db.silver.datex_slv_orderlines ol
      JOIN pvi_orders po ON po.order_id = ol.order_id
      LEFT JOIN shipto s ON s.order_id = ol.order_id
      WHERE s.raw_name IS NOT NULL AND s.raw_name != ''
      GROUP BY s.raw_name
      ORDER BY shipments DESC
    `
    const rows = await runQuery(sql)

    // Group raw names into canonicals.
    const clusters = new Map()   // canonical_name → { account_type, derived_days, raw_names, shipments, lines }
    const unclustered = []       // rows that didn't match any rule
    for (const r of rows) {
      const rawName = r.raw_name
      const shipments = Number(r.shipments) || 0
      const lines     = Number(r.lines) || 0
      const maxMarks  = r.max_valid_marks == null ? null : Number(r.max_valid_marks)
      const modeMarks = r.mode_marks == null ? null : Number(r.mode_marks)

      const match = canonicalize(rawName)
      if (!match) {
        unclustered.push({ raw_account_name: rawName, shipments, lines, mode_marks: modeMarks })
        continue
      }

      if (!clusters.has(match.canonical_name)) {
        clusters.set(match.canonical_name, {
          canonical_name: match.canonical_name,
          account_type:   match.account_type,
          derived_days:   null,
          raw_names:      [],
          shipments:      0,
          lines:          0,
        })
      }
      const bucket = clusters.get(match.canonical_name)
      bucket.raw_names.push(rawName)
      bucket.shipments += shipments
      bucket.lines     += lines
      // Derived days = MAX of valid marks across all raw names in the cluster.
      // Internal transfers get null derived_days regardless (irrelevant).
      if (match.account_type === 'end_customer' && maxMarks != null) {
        if (bucket.derived_days == null || maxMarks > bucket.derived_days) {
          bucket.derived_days = maxMarks
        }
      }
    }

    // Suggestions list — sort by shipment count desc so the biggest customers
    // land at the top of the review UI.
    const suggestions = Array.from(clusters.values())
      .sort((a, b) => b.shipments - a.shipments)
      .map(c => ({
        canonical_name: c.canonical_name,
        account_type:   c.account_type,
        derived_days:   c.derived_days,
        raw_names:      c.raw_names.sort(),
        shipment_count: c.shipments,
        lines:          c.lines,
      }))

    unclustered.sort((a, b) => b.shipments - a.shipments)

    try { conn?.close(); db?.close() } catch (_) {}

    return {
      statusCode: 200, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        suggestions,
        unclustered,
        totalRawNames: rows.length,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: e.message,
        stack: e.stack?.slice(0, 500),
        elapsedMs: Date.now() - t0,
      }),
    }
  }
}
