'use strict'

// MotherDuck backend for the Manager tab's OSD $ live pull. Added
// 2026-07-31. Source: bronze.acumatica_acumatica_gl_tran_detail (Acumatica
// GL export). Confirmed with Dan before building:
//   - Only GLAcctNbr 4270 ("Damages") counts toward OSD $ — GLAcctNbr 4260
//     ("Leased Equipment"), which appeared bundled in the reference
//     dashboard SQL Dan/Dean supplied, does NOT belong in this metric.
//   - Module filter excludes 'GL' (manual journal/accrual entries),
//     keeping only 'AP' and 'AR' — matches the reference dashboard's own
//     filter exactly (`NOT module = 'GL' OR module IS NULL`).
//   - Date axis is LastModifiedDate, matching the reference dashboard
//     (not TransactionDate) — same convention, not a semantic upgrade.
//
// Real finding before shipping (per standing project rule — verify live,
// don't guess): GLSubacctDescription does NOT map 1:1 to facility for
// Madison. There are 10 distinct subaccounts total (Caledonia, Corporate,
// Eau Claire, Gainsville-GA, Kenosha, Madison, Radford, Banbury, Ultra
// Cold, Wisconsin Rapids), and "Radford" is a real second building (rent
// revenue, real estate taxes, depreciation — the profile of an actual
// property, not a data artifact) that the reference dashboard SQL already
// folds into Madison's number (`GLSubacctDescription IN ('Madison',
// 'Radford')`). No mapping table anywhere in the Omni model documents this
// combination — it's evidently institutional knowledge that Radford is a
// satellite building operated as part of Madison. Historically $0 has
// ever posted to GL 4270 under Radford specifically, but the query
// includes it anyway in case that changes. CAL/KEN/WR/EC are clean 1:1 —
// no equivalent combination exists for them.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Facility → GL subaccount description(s). Madison uniquely combines two
// subaccounts (see header). Confirmed live against
// bronze.acumatica_acumatica_gl_tran_detail — do not add other facilities
// here without the same live verification (no general "combine buildings"
// convention exists in the model; this is Madison-specific).
const GL_SUBACCOUNTS = {
  cal: ['Caledonia'],
  ken: ['Kenosha'],
  mad: ['Madison', 'Radford'],
  wr:  ['Wisconsin Rapids'],
  ec:  ['Eau Claire'],
}

function num(v) { return v == null ? null : Number(v) }

function quarterBounds(quarterStr) {
  const [yStr, qStr] = quarterStr.split('-Q')
  const y = Number(yStr)
  const q = Number(qStr)
  const startMonth = (q - 1) * 3
  const start = new Date(Date.UTC(y, startMonth, 1))
  const end = new Date(Date.UTC(y, startMonth + 3, 1))
  const fmt = (d) => d.toISOString().slice(0, 10)
  return [fmt(start), fmt(end)]
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }

  let facility, quarter
  try {
    ;({ facility, quarter } = JSON.parse(event.body || '{}'))
    if (!GL_SUBACCOUNTS[facility]) throw new Error('unknown facility')
    if (!quarter || !/^\d{4}-Q[1-4]$/.test(quarter)) throw new Error('invalid quarter')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Body must be { facility, quarter: 'YYYY-Qn' } — ${e.message}` }) }
  }

  const subaccounts = GL_SUBACCOUNTS[facility]
  const [qStart, qEnd] = quarterBounds(quarter)

  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  let conn, db
  try {
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = (sql) => new Promise((resolve, reject) => conn.run(sql, (err) => err ? reject(err) : resolve()))
    const runQuery = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    const subaccountsSql = subaccounts.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')

    const sql = `
      SELECT
        COUNT(*) AS txn_count,
        SUM("NetAmount") AS net_amount_sum
      FROM production_db.bronze.acumatica_acumatica_gl_tran_detail
      WHERE "GLAcctNbr" = 4270
        AND (NOT "Module" = 'GL' OR "Module" IS NULL)
        AND "GLSubacctDescription" IN (${subaccountsSql})
        AND "LastModifiedDate" >= TIMESTAMP '${qStart}'
        AND "LastModifiedDate" <  TIMESTAMP '${qEnd}'
    `

    const rows = await runQuery(sql)
    const r = rows[0] || {}
    // No rows this quarter means $0 in damages posted — a real, good
    // value, not missing data, so default to 0 rather than null.
    const amount = num(r.net_amount_sum) ?? 0

    try { conn.close(); db.close() } catch (_) {}

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        facility, quarter, subaccounts, quarterStart: qStart, quarterEndExclusive: qEnd,
        transactionCount: num(r.txn_count) || 0,
        osdDollar: { amount: Math.round(amount * 100) / 100 },
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), facility, quarter, elapsedMs: Date.now() - t0 }),
    }
  }
}
