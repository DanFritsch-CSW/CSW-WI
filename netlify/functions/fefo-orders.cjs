'use strict'

// DIAGNOSTIC version of fefo-orders. Reports per-step status of the duckdb
// initialization chain so we can pinpoint exactly which step is failing.
// Returns rich error info: step name, error message, error stack, error code,
// and environment details. NOT a normal-flow function — just answers the
// question "where exactly is duckdb breaking?" Reverts to normal flow once
// the bug is identified.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

exports.handler = async (event) => {
  const t0 = Date.now()
  const steps = []
  const env = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    hasToken: !!process.env.MOTHERDUCK_TOKEN,
    tokenLen: process.env.MOTHERDUCK_TOKEN?.length || 0,
  }

  function step(name, fn) {
    return new Promise(async (resolve) => {
      const stepStart = Date.now()
      try {
        const result = await fn()
        steps.push({ name, ok: true, ms: Date.now() - stepStart, result: typeof result === 'string' ? result : 'ok' })
        resolve({ ok: true, result })
      } catch (e) {
        steps.push({
          name,
          ok: false,
          ms: Date.now() - stepStart,
          error: e?.message || String(e),
          errorCode: e?.code,
          errorName: e?.name,
          stack: e?.stack?.split('\n').slice(0, 10).join('\n'),
        })
        resolve({ ok: false, error: e })
      }
    })
  }

  // STEP 1: Check if duckdb directory exists in the function bundle.
  const fs = require('fs')
  const path = require('path')
  await step('check-duckdb-dir', () => {
    const candidates = [
      '/var/task/node_modules/duckdb',
      path.join(process.cwd(), 'node_modules/duckdb'),
      './node_modules/duckdb',
    ]
    for (const p of candidates) {
      try {
        const stats = fs.statSync(p)
        if (stats.isDirectory()) {
          const contents = fs.readdirSync(p).slice(0, 20)
          return `found at ${p}: ${contents.join(', ')}`
        }
      } catch (_) {}
    }
    throw new Error(`duckdb dir not found in any of: ${candidates.join(', ')}`)
  })

  // STEP 2: Check for the native binary (.node file)
  await step('check-native-binary', () => {
    const candidates = [
      '/var/task/node_modules/duckdb/lib/binding/duckdb.node',
      '/var/task/node_modules/duckdb/build/Release/duckdb.node',
      path.join(process.cwd(), 'node_modules/duckdb/lib/binding/duckdb.node'),
      path.join(process.cwd(), 'node_modules/duckdb/build/Release/duckdb.node'),
    ]
    for (const p of candidates) {
      try {
        const stats = fs.statSync(p)
        return `found at ${p} (${stats.size} bytes)`
      } catch (_) {}
    }
    // Try to find it by walking the duckdb dir
    const roots = ['/var/task/node_modules/duckdb', path.join(process.cwd(), 'node_modules/duckdb')]
    for (const root of roots) {
      try {
        const walk = (dir, depth = 0) => {
          if (depth > 4) return null
          for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name)
            try {
              const s = fs.statSync(full)
              if (s.isDirectory()) {
                const found = walk(full, depth + 1)
                if (found) return found
              } else if (name.endsWith('.node')) {
                return full
              }
            } catch (_) {}
          }
          return null
        }
        const found = walk(root)
        if (found) return `found by walk at ${found}`
      } catch (_) {}
    }
    throw new Error(`no .node binary found in any duckdb dir`)
  })

  // STEP 3: require('duckdb')
  let duckdb
  const requireResult = await step('require-duckdb', () => {
    duckdb = require('duckdb')
    return `keys: ${Object.keys(duckdb).slice(0, 5).join(',')}`
  })
  if (!requireResult.ok) {
    return diag(t0, env, steps, 'require failed')
  }

  // STEP 4: new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
  let db
  const dbResult = await step('new-database-md', () => {
    process.env.motherduck_token = process.env.MOTHERDUCK_TOKEN
    db = new duckdb.Database('md:production_db', { motherduck_token: process.env.MOTHERDUCK_TOKEN })
    return 'database object created'
  })
  if (!dbResult.ok) {
    return diag(t0, env, steps, 'new Database failed')
  }

  // STEP 5: db.connect()
  let conn
  const connResult = await step('db-connect', () => {
    conn = db.connect()
    return 'connection object created'
  })
  if (!connResult.ok) {
    return diag(t0, env, steps, 'connect failed')
  }

  // STEP 6: conn.run('LOAD motherduck')
  await step('load-motherduck', () => {
    return new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', err => err ? reject(err) : resolve('loaded'))
    })
  })

  // STEP 7: trivial query to confirm round-trip works
  await step('trivial-query', () => {
    return new Promise((resolve, reject) => {
      conn.all('SELECT 1 AS test', (err, rows) => {
        if (err) reject(err)
        else resolve(`got ${rows?.length || 0} rows`)
      })
    })
  })

  // STEP 8: real test query against silver schema
  await step('silver-projects-count', () => {
    return new Promise((resolve, reject) => {
      conn.all('SELECT COUNT(*) AS c FROM silver.datex_slv_projects', (err, rows) => {
        if (err) reject(err)
        else resolve(`projects=${rows?.[0]?.c}`)
      })
    })
  })

  try { conn?.close(); db?.close() } catch (_) {}

  return diag(t0, env, steps, 'all-steps-complete')
}

function diag(t0, env, steps, summary) {
  return {
    statusCode: 200,
    headers: NO_CACHE_HEADERS,
    body: JSON.stringify({
      diagnostic: true,
      summary,
      env,
      steps,
      totalMs: Date.now() - t0,
    }, null, 2),
  }
}
