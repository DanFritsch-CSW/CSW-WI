'use strict'

// MotherDuck HTTP API proxy for the KEN v2 diagnostic mirror.
// Queries production_db.labor_planning_app.hourly_labor_required_vs_available
// directly, bypassing Omni's API layer (which only materializes staffing columns
// for past dates after nightly ETL jobs run).
//
// MotherDuck's in-memory snapshot is updated more frequently and contains live
// staffed employee data for the current operational day.
//
// Accepts POST { warehouse: string, date: string (YYYY-MM-DD) }
// Returns { rows: Array<{ h, rawStaffed, adjStaffed, breaks, whAdj, avail, availAw, req, inb, out, drops, appts }> }

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

  // Query the target date AND next day to cover the full 5am→5am operational window.
  // Client-side filtering to the window happens in fetchOmniLaborFullRow.
  const nextDate = new Date(date + 'T00:00:00Z')
  nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  const nextDateStr = nextDate.toISOString().slice(0, 10)

  const sql = `
    SELECT
      hour_of_day_timestamp,
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
    WHERE warehouse_name = '${warehouse}'
      AND activity_date::DATE IN ('${date}', '${nextDateStr}')
    ORDER BY hour_of_day_timestamp
  `

  let res
  try {
    res = await fetch('https://app.motherduck.com/api/sql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    })
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `MotherDuck network error: ${e.message}` }),
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `MotherDuck ${res.status}`, detail: text.slice(0, 300) }),
    }
  }

  const json = await res.json()

  // MotherDuck HTTP API returns { data: { columns: [...], rows: [[...], ...] } }
  const columns = json?.data?.columns ?? []
  const rawRows = json?.data?.rows ?? []

  function col(row, name) {
    const idx = columns.findIndex(c => c.name === name)
    return idx >= 0 ? row[idx] : null
  }

  function tsToHour(ts) {
    if (!ts) return 0
    const m = String(ts).match(/[T ](\d{2}):/)
    return m ? parseInt(m[1]) : 0
  }

  const rows = rawRows.map(row => ({
    h:          tsToHour(col(row, 'hour_of_day_timestamp')),
    rawStaffed: Number(col(row, 'raw_staffed_employee'))      || 0,
    adjStaffed: Number(col(row, 'adjusted_staffed_employee')) || 0,
    breaks:     Number(col(row, 'employees_on_break'))        || 0,
    whAdj:      Number(col(row, 'warehouse_labor_adjustment'))|| 0,
    avail:      Number(col(row, 'labor_available'))           || 0,
    availAw:    Number(col(row, 'labor_available_aw'))        || 0,
    req:        Number(col(row, 'labor_required'))            || 0,
    inb:        Number(col(row, 'inbound_count'))             || 0,
    out:        Number(col(row, 'outbound_count'))            || 0,
    drops:      Number(col(row, 'drops'))                     || 0,
    appts:      Number(col(row, 'total_appointments'))        || 0,
  }))

  return {
    statusCode: 200,
    headers: NO_CACHE_HEADERS,
    body: JSON.stringify({ rows }),
  }
}
