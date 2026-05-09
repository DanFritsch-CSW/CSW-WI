'use strict'

// Pickline-specific Omni queries for WR Bernatello's pick planning.
// Uses same query format as omni.js (version:5, modelId, table, fields, filters).
// Returns: { casesRows, tieHighRows, shortageRows, date }

const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

// Correct model ID for Datex silver tables (Silver Datex Slv Orders topic)
// Found at: csw.omniapp.co/models/e80fa12f-918e-40b8-bb91-60fbac98ab19/
const DATEX_MODEL_ID = 'e80fa12f-918e-40b8-bb91-60fbac98ab19'

// Table names
const ORDERS     = 'silver__datex_slv_orders'
const ORDERLINES = 'silver__datex_slv_orderlines'
const ORDERSTAT  = 'silver__datex_slv_orderstatuses'
const MATERIALS  = 'silver__datex_slv_materials'
const LOCCONTAIN = 'silver__datex_slv_locationcontainers'
const MATPKG     = 'silver__datex_slv_materialspackagingslookup'
const WAREHOUSES = 'silver__datex_slv_warehouses'
const AVAIL_INV  = 'gold__available_inventory_by_material'

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
    if (!timedOut) return { ok: false, raw: text.slice(0, 800) }
    if (attempt === RETRY_ATTEMPTS) return { ok: false, raw: text.slice(0, 800), timedOut: true }
  }
}

function buildCasesQuery(date) {
  return {
    version: 5,
    modelId: DATEX_MODEL_ID,
    table: ORDERLINES,
    fields: [
      `${ORDERS}.requested_delivery_date`,
      `${ORDERS}.route_number`,
      `${MATERIALS}.lookup_code`,
      `${MATERIALS}.material_name`,
      `${ORDERLINES}.packaged_amount_sum`,
    ],
    filters: {
      [`${ORDERS}.project_id`]: {
        kind: 'EQUALS', type: 'number', values: [320],
      },
      [`${ORDERS}.requested_delivery_date`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: date, is_negative: false,
        offset_interval_string: '0 days',
      },
      [`${ORDERSTAT}.status_name`]: {
        kind: 'EQUALS', type: 'string', values: ['Created', 'Processing'],
      },
    },
    sorts: [],
    limit: 5000,
  }
}

function buildTieHighQuery() {
  return {
    version: 5,
    modelId: DATEX_MODEL_ID,
    table: LOCCONTAIN,
    fields: [
      `${LOCCONTAIN}.location_container`,
      `${LOCCONTAIN}.pick_sequence`,
      `${MATERIALS}.lookup_code`,
      `${MATERIALS}.material_name`,
      `${MATPKG}.pallet_tie`,
      `${MATPKG}.pallet_high`,
    ],
    filters: {
      [`${LOCCONTAIN}.is_primary_pick`]: {
        kind: 'EQUALS', type: 'boolean', values: [true],
      },
      [`${WAREHOUSES}.warehouse_name`]: {
        kind: 'CONTAINS', type: 'string', values: ['Rapids'], is_negative: false,
      },
    },
    sorts: [],
    limit: 500,
  }
}

function buildShortageQuery(date) {
  return {
    version: 5,
    modelId: DATEX_MODEL_ID,
    table: ORDERLINES,
    fields: [
      `${ORDERS}.requested_delivery_date`,
      `${MATERIALS}.lookup_code`,
      `${MATERIALS}.material_name`,
      `${AVAIL_INV}.available_amount_sum`,
      `${ORDERLINES}.amount_sum`,
    ],
    filters: {
      [`${ORDERS}.project_id`]: {
        kind: 'EQUALS', type: 'number', values: [320],
      },
      [`${ORDERS}.requested_delivery_date`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: date, is_negative: false,
        offset_interval_string: '0 days',
      },
      [`${ORDERSTAT}.status_name`]: {
        kind: 'EQUALS', type: 'string', values: ['Created', 'Processing'],
      },
      [`${ORDERLINES}.calc_1`]: {
        kind: 'LESS_THAN_OR_EQUAL_TO', type: 'number', value: 0,
      },
    },
    sorts: [],
    limit: 1000,
  }
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

function transformRows(casesRaw, tieHighRaw, shortageRaw) {
  const casesRows = casesRaw.map(r => ({
    "Route Number (Bernatello's)": String(r[`${ORDERS}.route_number`] ?? ''),
    'Material Lookup Code':        String(r[`${MATERIALS}.lookup_code`] ?? ''),
    'Packaged Amount Sum':          Number(r[`${ORDERLINES}.packaged_amount_sum`] ?? 0),
    'Requested Delivery Date Date': String(r[`${ORDERS}.requested_delivery_date`] ?? '').slice(0, 10),
  }))

  const tieHighRows = tieHighRaw.map(r => {
    const seq  = Number(r[`${LOCCONTAIN}.pick_sequence`] ?? 0)
    const tie  = Number(r[`${MATPKG}.pallet_tie`] ?? 0)
    const high = Number(r[`${MATPKG}.pallet_high`] ?? 0)
    return {
      'Location Container':   String(r[`${LOCCONTAIN}.location_container`] ?? ''),
      'Material Lookup Code': String(r[`${MATERIALS}.lookup_code`] ?? ''),
      'Material Name':        String(r[`${MATERIALS}.material_name`] ?? ''),
      'Pickline Zones':       pickSeqToZone(seq),
      'Full Pallet (t x h)':  tie * high,
    }
  })

  const shortageRows = shortageRaw.map(r => ({
    'Material Lookup Code':         String(r[`${MATERIALS}.lookup_code`] ?? ''),
    'Item Number':                  String(r[`${MATERIALS}.lookup_code`] ?? ''),
    'Requested Delivery Date Date': String(r[`${ORDERS}.requested_delivery_date`] ?? '').slice(0, 10),
    'Total Available Cases':        Number(r[`${AVAIL_INV}.available_amount_sum`] ?? 0),
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

  const [casesResult, tieHighResult, shortageResult] = await Promise.all([
    runOmniQuery(buildCasesQuery(date), API_KEY),
    runOmniQuery(buildTieHighQuery(), API_KEY),
    runOmniQuery(buildShortageQuery(date), API_KEY),
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
