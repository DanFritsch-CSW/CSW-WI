'use strict'

// DIAGNOSTIC v2 — tries multiple MotherDuck connection patterns to find one
// that works. Earlier diagnostic confirmed: duckdb dir, native binary,
// require, Database constructor, and db.connect() all succeed. The first
// failure is LOAD motherduck, throwing "Connection was never established."
//
// Hypothesis: `new Database('md:production_db', { motherduck_token: TOKEN })`
// passes motherduck_token as a constructor config key, but that's not a
// recognized duckdb option — the constructor accepts an integer access
// mode or a config object with specific duckdb-engine keys. Passing an
// unknown key produces a broken database handle. The correct ways to wire
// the token are env var only, OR token in URI query string.
//
// This function tries 5 patterns in isolation, each with a fresh duckdb
// instance, and reports per-pattern: which initialization step failed,
// the duckdb error message and code. Whichever pattern lets us reach
// SELECT 1 successfully tells us the fix.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

exports.handler = async (event) => {
  const t0 = Date.now()
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'no MOTHERDUCK_TOKEN' }) }
  }

  const duckdb = require('duckdb')

  // Each attempt isolates one connection pattern.
  const attempts = []

  async function tryPattern(name, setup) {
    const startedAt = Date.now()
    const log = []
    let db, conn
    try {
      const result = await setup({
        duckdb,
        token: TOKEN,
        log: (step, info) => log.push({ step, info, ms: Date.now() - startedAt }),
        setDb: (x) => { db = x },
        setConn: (x) => { conn = x },
      })
      attempts.push({
        pattern: name,
        ok: true,
        totalMs: Date.now() - startedAt,
        steps: log,
        result,
      })
    } catch (e) {
      attempts.push({
        pattern: name,
        ok: false,
        totalMs: Date.now() - startedAt,
        steps: log,
        error: e?.message || String(e),
        errorCode: e?.code,
        errorName: e?.name,
        errorStack: e?.stack?.split('\n').slice(0, 6).join('\n'),
      })
    }
    try { conn?.close(); db?.close() } catch (_) {}
  }

  const runOnConn = (conn, sql) => new Promise((resolve, reject) => {
    conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows))
  })
  const exec = (conn, sql) => new Promise((resolve, reject) => {
    conn.run(sql, (err) => err ? reject(err) : resolve())
  })

  // Pattern A: env var only, md:production_db URI, NO constructor options
  await tryPattern('A-envvar-only', async ({ duckdb, token, log, setDb, setConn }) => {
    process.env.motherduck_token = token
    const db = new duckdb.Database('md:production_db')
    setDb(db); log('database-created')
    const conn = db.connect()
    setConn(conn); log('connection-created')
    const rows = await runOnConn(conn, 'SELECT 1 AS x')
    log('select-1', `rows=${rows.length}`)
    return { rows }
  })

  // Pattern B: token in URI query string
  await tryPattern('B-token-in-uri', async ({ duckdb, token, log, setDb, setConn }) => {
    const uri = `md:production_db?motherduck_token=${encodeURIComponent(token)}`
    const db = new duckdb.Database(uri)
    setDb(db); log('database-created')
    const conn = db.connect()
    setConn(conn); log('connection-created')
    const rows = await runOnConn(conn, 'SELECT 1 AS x')
    log('select-1', `rows=${rows.length}`)
    return { rows }
  })

  // Pattern C: in-memory db, INSTALL+LOAD motherduck, ATTACH
  await tryPattern('C-memory-install-attach', async ({ duckdb, token, log, setDb, setConn }) => {
    process.env.motherduck_token = token
    const db = new duckdb.Database(':memory:')
    setDb(db); log('database-created')
    const conn = db.connect()
    setConn(conn); log('connection-created')
    await exec(conn, 'INSTALL motherduck')
    log('install-motherduck')
    await exec(conn, 'LOAD motherduck')
    log('load-motherduck')
    await exec(conn, `ATTACH 'md:production_db' AS prod (TYPE motherduck)`)
    log('attach')
    const rows = await runOnConn(conn, 'SELECT 1 AS x')
    log('select-1', `rows=${rows.length}`)
    return { rows }
  })

  // Pattern D: env var + md: URI (no db name), then USE
  await tryPattern('D-md-then-use', async ({ duckdb, token, log, setDb, setConn }) => {
    process.env.motherduck_token = token
    const db = new duckdb.Database('md:')
    setDb(db); log('database-created')
    const conn = db.connect()
    setConn(conn); log('connection-created')
    await exec(conn, 'USE production_db')
    log('use-production_db')
    const rows = await runOnConn(conn, 'SELECT 1 AS x')
    log('select-1', `rows=${rows.length}`)
    return { rows }
  })

  // Pattern E: original (broken) pattern as control
  await tryPattern('E-original-broken-control', async ({ duckdb, token, log, setDb, setConn }) => {
    process.env.motherduck_token = token
    const db = new duckdb.Database('md:production_db', { motherduck_token: token })
    setDb(db); log('database-created')
    const conn = db.connect()
    setConn(conn); log('connection-created')
    await exec(conn, 'LOAD motherduck')
    log('load-motherduck')
    const rows = await runOnConn(conn, 'SELECT 1 AS x')
    log('select-1', `rows=${rows.length}`)
    return { rows }
  })

  // For the first successful pattern, run an actual silver-schema query
  // to confirm it can read production data.
  const winner = attempts.find(a => a.ok)
  let silverProbe = null
  if (winner) {
    silverProbe = await new Promise(async (resolve) => {
      const t = Date.now()
      let db, conn
      try {
        if (winner.pattern === 'A-envvar-only') {
          process.env.motherduck_token = TOKEN
          db = new duckdb.Database('md:production_db')
        } else if (winner.pattern === 'B-token-in-uri') {
          db = new duckdb.Database(`md:production_db?motherduck_token=${encodeURIComponent(TOKEN)}`)
        } else if (winner.pattern === 'C-memory-install-attach') {
          process.env.motherduck_token = TOKEN
          db = new duckdb.Database(':memory:')
          conn = db.connect()
          await exec(conn, 'INSTALL motherduck')
          await exec(conn, 'LOAD motherduck')
          await exec(conn, `ATTACH 'md:production_db' AS prod (TYPE motherduck)`)
          await exec(conn, 'USE prod')
        } else if (winner.pattern === 'D-md-then-use') {
          process.env.motherduck_token = TOKEN
          db = new duckdb.Database('md:')
          conn = db.connect()
          await exec(conn, 'USE production_db')
        } else {
          db = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
        }
        if (!conn) conn = db.connect()
        const rows = await runOnConn(conn, 'SELECT COUNT(*) AS c FROM silver.datex_slv_projects')
        resolve({ ok: true, ms: Date.now() - t, projects: rows[0]?.c })
      } catch (e) {
        resolve({ ok: false, ms: Date.now() - t, error: e?.message, stack: e?.stack?.split('\n').slice(0, 6).join('\n') })
      } finally {
        try { conn?.close(); db?.close() } catch (_) {}
      }
    })
  }

  return {
    statusCode: 200,
    headers: NO_CACHE_HEADERS,
    body: JSON.stringify({
      diagnostic: 'v2-connection-patterns',
      duckdbVersion: duckdb.version || 'unknown',
      winner: winner?.pattern || 'none',
      silverProbe,
      attempts,
      totalMs: Date.now() - t0,
    }, null, 2),
  }
}
