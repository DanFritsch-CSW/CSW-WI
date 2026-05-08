'use strict'

// Pickline-specific Omni queries for WR Bernatello's pick planning
// Returns: { casesRows, tieHighRows, shortageRows, date }
// Cases and TieHigh queried from production_db via Omni proxy
// Pick Schedule is now managed in-app (wr_pick_schedule table)

const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function arrowToRows(table) {
  const rows = []
  for (let i = 0; i < table.numRows; i++) {
    const row = {}
    for (const field of table.schema.fields) {
      const col = table.getChild(field.name)
      let val = col.get(i)
      if (typeof val === 'bigint') val = Number(val)
      if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1)
      }
      row[field.name] = val
    }
    rows.push(row)
  }
  return rows
}

async function runOmniQuery(query, apiKey) {
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)
    const omniRes = await fetch('https://csw.omniapp.co/api/v1/query/run', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
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
    if (!timedOut) return { ok: false, raw: text.slice(0, 500) }
    if (attempt === RETRY_ATTEMPTS) return { ok: false, raw: text.slice(0, 500), timedOut: true }
  }
}

// Validated against production_db via MotherDuck:
// project_id 320 = Bernatello's - Wisconsin Rapids
// Tables: silver.datex_slv_orderlines, datex_slv_orders, datex_slv_materials, datex_slv_orderstatuses
function buildCasesQuery(date) {
  return {
    model_id: '33204248-b6db-4630-ae34-11aa94347add',
    query: {
      table: 'silver__datex_slv_orderlines',
      dimensions: [
        'silver__datex_slv_orders.requested_delivery_date',
        'silver__datex_slv_orders.route_number',
        'silver__datex_slv_materials.lookup_code',
        'silver__datex_slv_materials.material_name',
      ],
      measures: ['silver__datex_slv_orderlines.packaged_amount_sum'],
      filters: [
        {
          field: 'silver__datex_slv_orders.project_id',
          operator: 'EQUALS',
          values: ['320'],
        },
        {
          field: 'silver__datex_slv_orders.requested_delivery_date',
          operator: 'EQUALS',
          value: date,
        },
        {
          field: 'silver__datex_slv_orderstatuses.status_name',
          operator: 'IS_IN',
          values: ['Created', 'Processing'],
        },
      ],
      limit: 5000,
    },
  }
}

// Validated against production_db: 112 rows, pallet_tie * pallet_high = full_pallet
// Tables: silver.datex_slv_locationcontainers + locationcontainerassignedmaterials + materials + materialspackagingslookup
function buildTieHighQuery() {
  return {
    model_id: '33204248-b6db-4630-ae34-11aa94347add',
    query: {
      table: 'silver__datex_slv_locationcontainers',
      dimensions: [
        'silver__datex_slv_locationcontainers.location_container',
        'silver__datex_slv_locationcontainers.pick_sequence',
        'silver__datex_slv_materials.lookup_code',
        'silver__datex_slv_materials.material_name',
        'silver__datex_slv_materialspackagingslookup.pallet_tie',
        'silver__datex_slv_materialspackagingslookup.pallet_high',
      ],
      filters: [
        {
          field: 'silver__datex_slv_locationcontainers.is_primary_pick',
          operator: 'EQUALS',
          values: ['true'],
        },
        {
          field: 'silver__datex_slv_warehouses.warehouse_name',
          operator: 'CONTAINS',
          value: 'Rapids',
        },
      ],
      limit: 500,
    },
  }
}

// Same SQL as confirmed in Omni workbook
function buildShortageQuery(date) {
  return {
    model_id: '33204248-b6db-4630-ae34-11aa94347add',
    query: {
      table: 'silver__datex_slv_orderlines',
      dimensions: [
        'silver__datex_slv_orders.requested_delivery_date',
        'silver__datex_slv_materials.lookup_code',
        'silver__datex_slv_materials.material_name',
        'gold__available_inventory_by_material.available_amount_sum',
        'silver__datex_slv_orderlines.amount_sum',
      ],
      measures: [],
      filters: [
        {
          field: 'silver__datex_slv_orders.project_id',
          operator: 'EQUALS',
          values: ['320'],
        },
        {
          field: 'silver__datex_slv_orders.requested_delivery_date',
          operator: 'EQUALS',
          value: date,
        },
        {
          field: 'silver__datex_slv_orderstatuses.status_name',
          operator: 'IS_IN',
          values: ['Created', 'Processing'],
        },
        {
          field: 'silver__datex_slv_orderlines.calc_1',
          operator: 'LESS_THAN_OR_EQUAL_TO',
          value: '0',
        },
      ],
      limit: 1000,
    },
  }
}

// Pick sequence → zone mapping derived from Excel TieHigh data
// pick_sequence ranges: 101-110=Z1, 111-120=Z2, 121-140=Z3, 141-160=Z4,
//                       161-170=Z5, 171-180=Z6, 181-190=Z7, 191-200=Z8,
//                       201-205=Z9, 206-209=Z10, 210-211=Z11, 212=Z12
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
  if (seq >= 212) return 12
  return 0
}

// Transform raw Omni rows into the shape parsePicklineXlsx expects
function transformRows(casesRaw, tieHighRaw, shortageRaw) {
  // casesRows: [{ route_number, lookup_code, packaged_amount_sum, requested_delivery_date }]
  const casesRows = casesRaw.map(r => ({
    "Route Number (Bernatello's)": String(r['silver__datex_slv_orders.route_number'] ?? ''),
    'Material Lookup Code':        String(r['silver__datex_slv_materials.lookup_code'] ?? ''),
    'Packaged Amount Sum':          Number(r['silver__datex_slv_orderlines.packaged_amount_sum'] ?? 0),
    'Requested Delivery Date Date': String(r['silver__datex_slv_orders.requested_delivery_date'] ?? '').slice(0, 10),
  }))

  // tieHighRows: [{ location_container, pick_sequence, lookup_code, pallet_tie, pallet_high }]
  // Compute Pickline Zones from pick_sequence and Full Pallet from tie*high
  const tieHighRows = tieHighRaw.map(r => {
    const seq = Number(r['silver__datex_slv_locationcontainers.pick_sequence'] ?? 0)
    const tie = Number(r['silver__datex_slv_materialspackagingslookup.pallet_tie'] ?? 0)
    const high = Number(r['silver__datex_slv_materialspackagingslookup.pallet_high'] ?? 0)
    return {
      'Location Container':   String(r['silver__datex_slv_locationcontainers.location_container'] ?? ''),
      'Material Lookup Code': String(r['silver__datex_slv_materials.lookup_code'] ?? ''),
      'Material Name':        String(r['silver__datex_slv_materials.material_name'] ?? ''),
      'Pickline Zones':       pickSeqToZone(seq),
      'Full Pallet (t x h)':  tie * high,
    }
  })

  // shortageRows: [{ lookup_code, available_amount, ordered_amount, requested_delivery_date }]
  const shortageRows = shortageRaw.map(r => ({
    'Material Lookup Code':          String(r['silver__datex_slv_materials.lookup_code'] ?? ''),
    'Requested Delivery Date Date':  String(r['silver__datex_slv_orders.requested_delivery_date'] ?? '').slice(0, 10),
    'Total Available Cases':         Number(r['gold__available_inventory_by_material.available_amount_sum'] ?? 0),
    'Item Number':                   String(r['silver__datex_slv_materials.lookup_code'] ?? ''),
  }))

  return { casesRows, tieHighRows, shortageRows }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  const API_KEY = process.env.OMNI_API_KEY
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

  // Run all 3 queries in parallel
  const [casesResult, tieHighResult, shortageResult] = await Promise.all([
    runOmniQuery(buildCasesQuery(date), API_KEY),
    runOmniQuery(buildTieHighQuery(), API_KEY),
    runOmniQuery(buildShortageQuery(date), API_KEY),
  ])

  const failed = [
    !casesResult?.ok && 'Cases',
    !tieHighResult?.ok && 'TieHigh',
    !shortageResult?.ok && 'Shortage',
  ].filter(Boolean)

  if (failed.length) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Omni query failed: ${failed.join(', ')}` }),
    }
  }

  const { tableFromIPC } = await import('apache-arrow')

  const casesRaw    = arrowToRows(tableFromIPC(Buffer.from(casesResult.job.result, 'base64')))
  const tieHighRaw  = arrowToRows(tableFromIPC(Buffer.from(tieHighResult.job.result, 'base64')))
  const shortageRaw = arrowToRows(tableFromIPC(Buffer.from(shortageResult.job.result, 'base64')))

  const { casesRows, tieHighRows, shortageRows } = transformRows(casesRaw, tieHighRaw, shortageRaw)

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ casesRows, tieHighRows, shortageRows, date }),
  }
}
