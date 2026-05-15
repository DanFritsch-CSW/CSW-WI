'use strict'

// MotherDuck query proxy for KEN v2 diagnostic mirror.
// Uses duckdb npm package with MotherDuck extension.
// Token is set via env var motherduck_token (MotherDuck's convention).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const WAREHOUSE_MAP = {
  cal: 'franksville',
  ken: 'kenosha',
  mad: 'madison',
  wr:  'wisconsin rapids',
  ec:  'eau claire',
}

function tsToHour(ts) {
  if (!ts) return 0
  const m = String(ts).match(/[T ](\d{2}):/)
  return m ? parseInt(m[1]) : 0
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

  let facilityId, date
  try {
    ;({ facilityId, date } = JSON.parse(event.body))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const warehouse = WAREHOUSE_MAP[facilityId]
  if (!warehouse || !date) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Missing facilityId or date' }) }
  }

  const nextDate = new Date(date + 'T00:00:00Z')
  nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  const nextDateStr = nextDate.toISOString().slice(0, 10)

  const sql = `
    SELECT
      hour_of_day_timestamp::VARCHAR AS ts,
      COALESCE(raw_staffed_employee, 0)       AS raw_staffed_employee,
      COALESCE(adjusted_staffed_employee, 0)  AS adjusted_staffed_employee,
      COALESCE(employees_on_break, 0)         AS employees_on_break,
      COALESCE(warehouse_labor_adjustment, 0) AS warehouse_labor_adjustment,
      COALESCE(labor_available, 0)            AS labor_available,
      COALESCE(adjusted_staffed_employee, 0) + COALESCE(warehouse_labor_adjustment, 0) AS labor_available_aw,
      COALESCE(labor_required, 0)             AS labor_required,
      COALESCE(inbound_count, 0)              AS inbound_count,
      COALESCE(outbound_count, 0)             AS outbound_count,
      COALESCE(drops, 0)                      AS drops,
      COALESCE(total_appointments, 0)         AS total_appointments
    FROM production_db.labor_planning_app.hourly_labor_required_vs_available
    WHERE warehouse_name = '${warehouse.replace(/'/g, "''")}'
      AND activity_date::DATE IN ('${date}', '${nextDateStr}')
    ORDER BY hour_of_day_timestamp
  `

  try {
    // Set the token as an env var — MotherDuck's Node extension picks it up automatically
    process.env.motherduck_token = TOKEN

    const duckdb = require('duckdb')
    // Connect directly to the production_db on MotherDuck
    const db = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
    const conn = db.connect()

    // Load MotherDuck extension explicitly
    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', (err) => err ? reject(err) : resolve())
    })

    const rows = await new Promise((resolve, reject) => {
      conn.all(sql, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })

    conn.close()
    db.close()

    const parsed = rows.map(r => ({
      h:          tsToHour(r.ts),
      rawStaffed: Number(r.raw_staffed_employee)       || 0,
      adjStaffed: Number(r.adjusted_staffed_employee)  || 0,
      breaks:     Number(r.employees_on_break)         || 0,
      whAdj:      Number(r.warehouse_labor_adjustment) || 0,
      avail:      Number(r.labor_available)            || 0,
      availAw:    Number(r.labor_available_aw)         || 0,
      req:        Number(r.labor_required)             || 0,
      inb:        Number(r.inbound_count)              || 0,
      out:        Number(r.outbound_count)             || 0,
      drops:      Number(r.drops)                      || 0,
      appts:      Number(r.total_appointments)         || 0,
    }))

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ rows: parsed }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }),
    }
  }
}
