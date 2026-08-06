'use strict'

// Returns the most recent shift_start_date with ANY data in
// gold.takt_productivity_v2_agg — added 2026-08-06, replacing the Takt
// digest's original "content date = fire date minus 1 day" rule.
//
// WHY THIS EXISTS: the fixed 1-day-lag assumption broke within days of
// shipping. Checked live 2026-08-06: the table's most recent date was
// 8/4 while the digest (firing 8/6, assuming a 1-day lag) asked for 8/5
// and got nothing across all 5 facilities. The lag isn't even constant —
// 8/2 only had partial Kenosha data while 7/30-8/1 and 8/3-8/4 were
// fully populated. A fixed offset can't track that.
//
// FIX: one shared query, ONE date, used for every facility in a given
// digest send (see lib/takt-digest-shared.cjs). This deliberately does
// NOT return a per-facility latest date — if Caledonia has 8/4 data but
// Eau Claire only has 8/2, using each facility's own latest date would
// bring back the exact "leadership digest shows mismatched dates across
// facilities" problem that was the whole reason the original 1-day rule
// was chosen over auto-detection in the first place. A single global max
// keeps every facility's numbers in the same message pinned to the same
// date, even if that means a facility with fresher data than the rest
// shows slightly stale numbers on some sends.
//
// Separate function rather than an added mode on motherduck-takt-daily.cjs
// — same reasoning as why that file is itself separate from
// motherduck-takt.cjs: keep single-purpose functions single-purpose
// rather than growing one file's response contract indefinitely.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }

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

    const rows = await runQuery(`
      SELECT MAX(shift_start_date) AS latest_date
      FROM production_db.gold.takt_productivity_v2_agg
      WHERE employee_name IS NOT NULL
    `)

    try { conn.close(); db.close() } catch (_) {}

    const latest = rows?.[0]?.latest_date
    if (!latest) {
      return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ date: null }) }
    }
    const iso = (latest instanceof Date ? latest : new Date(latest)).toISOString().slice(0, 10)
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ date: iso }) }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }
}
