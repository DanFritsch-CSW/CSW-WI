'use strict'

// Pickline queries for WR Bernatello's pick planning.
// Uses Supabase REST API (PostgREST) to query production_db directly.
// Raw SQL validated against production_db via MotherDuck.
// Returns: { casesRows, tieHighRows, shortageRows, date }

const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Run a raw SQL query via Supabase's /rest/v1/rpc/exec_sql endpoint.
// Falls back to direct postgres query via the Omni connection if needed.
async function runSupabaseSQL(sql, supabaseUrl, serviceKey) {
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ query: sql }),
      })
      if (res.ok) {
        const data = await res.json()
        return { ok: true, rows: Array.isArray(data) ? data : (data.result ?? []) }
      }
      const text = await res.text()
      if (attempt === RETRY_ATTEMPTS) return { ok: false, raw: text.slice(0, 500) }
    } catch (e) {
      if (attempt === RETRY_ATTEMPTS) return { ok: false, raw: String(e) }
    }
  }
}

// Alternatively, use the Omni proxy with a raw SQL query.
// Omni supports { sql: "...", connection_id: "..." } queries via the same endpoint.
async function runOmniSQL(sql, apiKey, connectionId) {
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)
    const omniRes = await fetch('https://csw.omniapp.co/api/v1/query/run', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: {
          version: 5,
          sql_query: sql,
          connection_id: connectionId,
        },
      }),
    })
    const text = await omniRes.text()
    let completeJob = null
    let timedOut = false
    for (const line of text.trim().split('\n')) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.status === 'COMPLETE') { completeJob = parsed; break }
        if (parsed.timed_out === true) timedOut = true
      } catch { /* skip */ }
    }
    if (completeJob) return { ok: true, job: completeJob }
    if (!timedOut) return { ok: false, raw: text.slice(0, 800) }
    if (attempt === RETRY_ATTEMPTS) return { ok: false, raw: text.slice(0, 800), timedOut: true }
  }
}

function arrowToRows(table) {
  const rows = []
  for (let i = 0; i < table.numRows; i++) {
    const row = {}
    for (const field of table.schema.fields) {
      const col = table.getChild(field.name)
      let val = col.get(i)
      if (typeof val === 'bigint') val = Number(val)
      if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
      row[field.name] = val
    }
    rows.push(row)
  }
  return rows
}

// Raw SQL queries — validated against production_db via MotherDuck
// Route number = text before first '-' in owner_reference (e.g. '650-238363' -> '650')
function buildCasesSQL(date) {
  return `
    SELECT
      o.requested_delivery_date::DATE AS delivery_date,
      SPLIT_PART(o.owner_reference, '-', 1) AS route_number,
      m.lookup_code,
      m.material_name,
      SUM(ol.packaged_amount) AS packaged_amount_sum
    FROM production_db.silver.datex_slv_orderlines ol
    JOIN production_db.silver.datex_slv_orders o ON ol.order_id = o.order_id
    JOIN production_db.silver.datex_slv_materials m ON ol.material_id = m.material_id
    JOIN production_db.silver.datex_slv_orderstatuses os ON o.order_status_id = os.order_status_id
    WHERE o.project_id = 320
      AND os.status_name IN ('Created', 'Processing')
      AND o.requested_delivery_date::DATE = '${date}'::DATE
    GROUP BY 1, 2, 3, 4
    LIMIT 5000
  `.trim()
}

function buildTieHighSQL() {
  return `
    SELECT
      lc.location_container_id::VARCHAR AS location_container,
      lc.pick_sequence,
      m.lookup_code,
      m.material_name,
      pkg.pallet_tie,
      pkg.pallet_high,
      (pkg.pallet_tie * pkg.pallet_high) AS full_pallet
    FROM production_db.silver.datex_slv_locationcontainers lc
    JOIN production_db.silver.datex_slv_locationcontainerassignedmaterials lcam
      ON lc.location_container_id = lcam.location_container_id
    JOIN production_db.silver.datex_slv_materials m ON lcam.material_id = m.material_id
    JOIN production_db.silver.datex_slv_materialspackagingslookup pkg
      ON m.material_id = pkg.material_id AND pkg.is_base_packaging = true
    JOIN production_db.silver.datex_slv_warehouses w ON lc.warehouse_id = w.warehouse_id
    WHERE lc.is_primary_pick = true
      AND w.warehouse_name ILIKE '%Rapids%'
    LIMIT 500
  `.trim()
}

function buildShortageSQL(date) {
  return `
    SELECT
      o.requested_delivery_date::DATE AS delivery_date,
      m.lookup_code,
      m.material_name,
      COALESCE(inv.available_amount, 0) AS available_amount,
      SUM(ol.packaged_amount) AS ordered_amount
    FROM production_db.silver.datex_slv_orderlines ol
    JOIN production_db.silver.datex_slv_orders o ON ol.order_id = o.order_id
    JOIN production_db.silver.datex_slv_materials m ON ol.material_id = m.material_id
    JOIN production_db.silver.datex_slv_orderstatuses os ON o.order_status_id = os.order_status_id
    LEFT JOIN production_db.gold.available_inventory_by_material inv ON m.material_id = inv.material_id
    WHERE o.project_id = 320
      AND os.status_name IN ('Created', 'Processing')
      AND o.requested_delivery_date::DATE = '${date}'::DATE
    GROUP BY 1, 2, 3, 4
    HAVING COALESCE(inv.available_amount, 0) < SUM(ol.packaged_amount)
    LIMIT 1000
  `.trim()
}

function pickSeqToZone(seq) {
  if (seq >= 101 && seq <= 110) return 1
  if (seq >= 111 && seq <= 120) return 2
  if (seq >= 121 && seq <= 140) return 3
  if (seq >= 141 && seq <= 160) return 4
  if (seq >= 161 && seq <= 170) return 5
  if (seq >= 171 && seq <= 180) return 6
  if (seq >= 181 && seq <= 190) return 7
  if (seq >= 191 && seq <= 200) return 8
  if (seq >= 201 && seq <= 205) return 9
  if (seq >= 206 && seq <= 209) return 10
  if (seq >= 210 && seq <= 211) return 11
  if (seq >= 212)               return 12
  return 0
}

// Transform DB rows into the column names buildSnapshotFromOmni expects
function transformRows(casesRaw, tieHighRaw, shortageRaw) {
  const casesRows = casesRaw.map(r => ({
    "Route Number (Bernatello's)": String(r.route_number ?? ''),
    'Material Lookup Code':        String(r.lookup_code ?? ''),
    'Packaged Amount Sum':          Number(r.packaged_amount_sum ?? 0),
    'Requested Delivery Date Date': String(r.delivery_date ?? '').slice(0, 10),
  }))

  const tieHighRows = tieHighRaw.map(r => ({
    'Location Container':   String(r.location_container ?? ''),
    'Material Lookup Code': String(r.lookup_code ?? ''),
    'Material Name':        String(r.material_name ?? ''),
    'Pickline Zones':       pickSeqToZone(Number(r.pick_sequence ?? 0)),
    'Full Pallet (t x h)':  Number(r.full_pallet ?? 0),
  }))

  const shortageRows = shortageRaw.map(r => ({
    'Material Lookup Code':         String(r.lookup_code ?? ''),
    'Item Number':                  String(r.lookup_code ?? ''),
    'Requested Delivery Date Date': String(r.delivery_date ?? '').slice(0, 10),
    'Total Available Cases':        Number(r.available_amount ?? 0),
  }))

  return { casesRows, tieHighRows, shortageRows }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  const API_KEY      = process.env.OMNI_API_KEY
  const OMNI_CONN_ID = process.env.OMNI_CONNECTION_ID  // optional, for SQL mode

  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'OMNI_API_KEY not configured' }),
    }
  }

  let date
  try {
    ;({ date } = JSON.parse(event.body))
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid date')
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Body must be { date: "YYYY-MM-DD" }' }),
    }
  }

  // Run all 3 SQL queries via Omni's SQL endpoint in parallel
  const [casesResult, tieHighResult, shortageResult] = await Promise.all([
    runOmniSQL(buildCasesSQL(date),   API_KEY, OMNI_CONN_ID),
    runOmniSQL(buildTieHighSQL(),     API_KEY, OMNI_CONN_ID),
    runOmniSQL(buildShortageSQL(date), API_KEY, OMNI_CONN_ID),
  ])

  const failed = [
    !casesResult?.ok    && 'Cases',
    !tieHighResult?.ok  && 'TieHigh',
    !shortageResult?.ok && 'Shortage',
  ].filter(Boolean)

  if (failed.length) {
    const detail = [
      !casesResult?.ok    && `Cases: ${casesResult?.raw ?? 'no response'}`,
      !tieHighResult?.ok  && `TieHigh: ${tieHighResult?.raw ?? 'no response'}`,
      !shortageResult?.ok && `Shortage: ${shortageResult?.raw ?? 'no response'}`,
    ].filter(Boolean).join(' | ')
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Omni query failed: ${failed.join(', ')}`, detail }),
    }
  }

  const { tableFromIPC } = await import('apache-arrow')

  const casesRaw    = arrowToRows(tableFromIPC(Buffer.from(casesResult.job.result,    'base64')))
  const tieHighRaw  = arrowToRows(tableFromIPC(Buffer.from(tieHighResult.job.result,  'base64')))
  const shortageRaw = arrowToRows(tableFromIPC(Buffer.from(shortageResult.job.result, 'base64')))

  const { casesRows, tieHighRows, shortageRows } = transformRows(casesRaw, tieHighRaw, shortageRaw)

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ casesRows, tieHighRows, shortageRows, date }),
  }
}
