'use strict'

// MotherDuck-direct B2E roster + schedule fetch.
//
// Bypasses Omni for B2E reads. See top-of-file changelog for context.
//
// Request shape (POST JSON):
//   { kind: 'active_roster',              facilityId: 'ken' }
//   { kind: 'active_roster_named',        facilityId: 'ken' }
//   { kind: 'active_roster_all_jobcodes', facilityId: 'ken' }
//   { kind: 'schedule_date',              facilityId: 'ken', fromDate: '2026-07-10' }
//   { kind: 'schedule_range',             facilityId: 'ken', fromDate: '2026-07-10', daysForward: 14 }
//
// Response shape:
//   { rows: [ { 'silver__b2e_slv_futurescheduleentries.employee_id': '535', ... } ] }
//
// The Omni-qualified column-name shape is deliberate — the client's
// downstream filter/map logic in fetchB2eRosterForEntryDate and
// fetchB2eRosterForRange accesses fields via
// r[`${SCHEDULE}.employee_id`] etc. Preserving that shape lets us swap
// the underlying data source without touching any of the ~200 lines of
// post-processing (stale-snapshot filter, job_code filter, shift/lane
// derivation).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const B2E_LOCATION = {
  cal:  '019 - Caledonia',
  mad:  '011 - Madison',
  ec:   '012 - Eau Claire',
  ken:  '015 - Kenosha',
  wr:   '023 - Wisconsin Rapids',
}

const ROSTER   = 'silver__b2e_slv_employeeroster'
const SCHEDULE = 'silver__b2e_slv_futurescheduleentries'

const ROSTER_TABLE_PATH   = 'production_db.silver.b2e_slv_employeeroster'
const SCHEDULE_TABLE_PATH = 'production_db.silver.b2e_slv_futurescheduleentries'

// Shared by 'active_roster' and 'active_roster_named' below. Kept in
// lockstep with getAllowedJobCodes in src/lib/omni.js and
// netlify/functions/lib/nightly-b2e-sync-shared.cjs: MAD + EC include
// Shift Supervisors (209) — Dan, 2026-07-10 / 2026-07-14. WR includes
// both Case Pickers (206, 2026-10-30) and Shift Supervisors (209,
// 2026-11-11, same treatment as MAD/EC). CAL and KEN are untouched —
// 205 only. Getting this filter wrong silently purges the extra job
// codes as "terminated" on the next nightly sync even though they're
// correctly seeded elsewhere, since this is the query that defines the
// "active roster" set purgeTerminatedAcrossFuture compares future rows
// against.
function jobCodeFilterFor(facilityId) {
  if (facilityId === 'mad' || facilityId === 'ec') return "default_job_code IN ('205', '209')"
  if (facilityId === 'wr') return "default_job_code IN ('205', '206', '209')"
  return "default_job_code = '205'"
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }),
    }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const { kind, facilityId, fromDate, daysForward } = body
  const location = B2E_LOCATION[facilityId]
  if (!location) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Unknown facilityId: ${facilityId}` }) }
  }

  // Input validation to protect against SQL injection through fromDate/daysForward.
  // location comes from a static allowlist, so a single-quote escape is defensive.
  if (kind === 'schedule_range' || kind === 'schedule_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate || ''))) {
      return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid or missing fromDate (YYYY-MM-DD)' }) }
    }
    if (kind === 'schedule_range') {
      const d = Number(daysForward)
      if (!Number.isFinite(d) || d < 1 || d > 60) {
        return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'daysForward must be an integer 1..60' }) }
      }
    }
  }

  const safeLoc = location.replace(/'/g, "''")

  let sql, scopeTable
  if (kind === 'active_roster') {
    // Mirrors fetchActiveB2eEmployees in omni.js. Used by purge paths to
    // identify the current live roster — see jobCodeFilterFor above for
    // which job codes count as "active" per facility.
    scopeTable = ROSTER
    const jobCodeFilter = jobCodeFilterFor(facilityId)
    sql = `
      SELECT DISTINCT employee_id
      FROM ${ROSTER_TABLE_PATH}
      WHERE default_location_full_path = '${safeLoc}'
        AND employee_status = 'Active'
        AND ${jobCodeFilter}
    `
  } else if (kind === 'active_roster_named') {
    // Added 2026-07-18 — weekend Special Project auto-populate
    // (RosterBoard.jsx). Same Active + job-code scope as 'active_roster',
    // but also returns employee_name so the client can seed full roster
    // rows without a B2E schedule to derive names from (B2E has no
    // Saturday/Sunday rows in futurescheduleentries at all — weekends
    // aren't a "stale snapshot", there's simply nothing published).
    // b2e_slv_employeeroster carries employee_name as a single combined
    // field (confirmed via schema — no separate first/last columns here,
    // unlike futurescheduleentries).
    scopeTable = ROSTER
    const jobCodeFilter = jobCodeFilterFor(facilityId)
    sql = `
      SELECT DISTINCT employee_id, employee_name, default_job_code
      FROM ${ROSTER_TABLE_PATH}
      WHERE default_location_full_path = '${safeLoc}'
        AND employee_status = 'Active'
        AND ${jobCodeFilter}
    `
  } else if (kind === 'active_roster_all_jobcodes') {
    // Mirrors the ROSTER omniQuery inside fetchB2eRosterForEntryDate and
    // fetchB2eRosterForRange: Active only, no job_code filter (the client
    // applies ALLOWED_JOB_CODES in JS after the stale-snapshot filter).
    scopeTable = ROSTER
    sql = `
      SELECT DISTINCT employee_id, employee_status
      FROM ${ROSTER_TABLE_PATH}
      WHERE default_location_full_path = '${safeLoc}'
        AND employee_status = 'Active'
    `
  } else if (kind === 'schedule_range' || kind === 'schedule_date') {
    // schedule_date is a specialisation of schedule_range with
    // daysForward=14 (matches the widened window in
    // fetchB2eRosterForEntryDate — the 14d span is needed so the
    // per-employee max_ingestion_ts filter can detect ghost rows from
    // stale snapshot batches; client narrows back to entryDate after).
    scopeTable = SCHEDULE
    const days = kind === 'schedule_range' ? Number(daysForward) : 14
    sql = `
      SELECT
        employee_id, first_name, last_name, default_job_code,
        start_time, end_time, modified_start_time, modified_end_time,
        work_schedule, ingestion_ts, entry_date
      FROM ${SCHEDULE_TABLE_PATH}
      WHERE default_location_full_path = '${safeLoc}'
        AND entry_date BETWEEN DATE '${fromDate}' AND DATE '${fromDate}' + INTERVAL '${days} days'
      ORDER BY ingestion_ts DESC
      LIMIT 5000
    `
  } else {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Unknown kind: ${kind}` }) }
  }

  let db, conn
  try {
    // HOME=/tmp so MotherDuck C++ init has a writable path for extension files.
    process.env.HOME             = '/tmp'
    // motherduck_token env var is read automatically by the extension after LOAD.
    process.env.motherduck_token = TOKEN

    const duckdb = require('duckdb')

    db   = new duckdb.Database(':memory:')
    conn = db.connect()

    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', err => err ? reject(err) : resolve())
    })
    await new Promise((resolve, reject) => {
      conn.run("ATTACH 'md:production_db' AS production_db (READ_ONLY)", err => err ? reject(err) : resolve())
    })

    const rawRows = await new Promise((resolve, reject) => {
      conn.all(sql, (err, result) => err ? reject(err) : resolve(result))
    })

    conn.close()
    db.close()

    // Reshape to Omni-qualified column name shape. The client accesses
    // fields via r[`${SCHEDULE}.employee_id`] template literals; matching
    // that shape means fetchB2eRosterForEntryDate / fetchB2eRosterForRange
    // stay unchanged apart from the top-level fetch call swap.
    //
    // Timestamps coerced to ISO strings so the client's string-based
    // stale-filter comparison (`ts > maxIngestByEmp.get(id)`) still works.
    // BigInt coerced to string to survive JSON.stringify.
    const rows = rawRows.map(r => {
      const out = {}
      for (const [k, v] of Object.entries(r)) {
        let val = v
        if (val instanceof Date) {
          val = val.toISOString()
        } else if (typeof val === 'bigint') {
          val = String(val)
        }
        out[`${scopeTable}.${k}`] = val
      }
      return out
    })

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ rows }),
    }
  } catch (e) {
    try { if (conn) conn.close() } catch {}
    try { if (db)   db.close()   } catch {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 800) }),
    }
  }
}
