'use strict'

// Pickline queries for WR Bernatello's pick planning.
// Field IDs sourced directly from Omni Advanced SQL editor (Silver Datex Slv Orders topic).
// DSD Order class filter applied to match the Excel export exactly.
// Returns: { casesRows, tieHighRows, shortageRows, date }

const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

const DATEX_MODEL_ID = 'e80fa12f-918e-40b8-bb91-60fbac98ab19'

// Field IDs from Omni Advanced SQL editor
const F = {
  status_name:      'silver__datex_slv_orderstatuses.status_name',
  delivery_date:    'silver__datex_slv_orders.requested_delivery_date',
  route_number:     'silver__datex_slv_orders.calculation',  // LEFT(owner_reference, 3)
  project_name:     'silver__datex_slv_projects.project_name',
  order_class_name: 'silver__datex_slv_orderclasses.order_class_name',
  mat_lookup_code:  'silver__datex_slv_materials.lookup_code',
  mat_name:         'silver__datex_slv_materials.material_name',
  packaged_amount:  'silver__datex_slv_orderlines.packaged_amount_sum',
  pick_sequence:    'silver__datex_slv_locationcontainers.pick_sequence',
  pallet_tie:       'silver__datex_slv_materialspackagingslookup.pallet_tie',
  pallet_high:      'silver__datex_slv_materialspackagingslookup.pallet_high',
  warehouse_name:   'silver__datex_slv_warehouses.warehouse_name',
  is_primary_pick:  'silver__datex_slv_locationcontainers.is_primary_pick',
  available_amount: 'gold__available_inventory_by_material.available_amount_sum',
  amount_sum:       'silver__datex_slv_orderlines.amount_sum',
}

// Shared filters for Cases and Shortage — matches the Omni workbook exactly
function baseOrderFilters(date) {
  return {
    [F.project_name]: {
      kind: 'EQUALS', type: 'string', values: ["Bernatello's - Wisconsin Rapids"],
    },
    [F.order_class_name]: {
      kind: 'EQUALS', type: 'string', values: ['DSD Order'],
    },
    [F.delivery_date]: {
      kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
      isFiscal: false, left_side: date, is_negative: false,
      offset_interval_string: '0 days',
    },
    [F.status_name]: {
      kind: 'EQUALS', type: 'string', values: ['Created', 'Processing'],
    },
  }
}

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
      if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
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
    table: 'silver__datex_slv_orderlines',
    fields: [
      F.delivery_date,
      F.route_number,
      F.mat_lookup_code,
      F.mat_name,
      F.packaged_amount,
    ],
    filters: baseOrderFilters(date),
    sorts: [],
    limit: 5000,
  }
}

function buildTieHighQuery() {
  return {
    version: 5,
    modelId: DATEX_MODEL_ID,
    table: 'silver__datex_slv_locationcontainers',
    fields: [
      F.pick_sequence,
      F.mat_lookup_code,
      F.mat_name,
      F.pallet_tie,
      F.pallet_high,
    ],
    filters: {
      [F.is_primary_pick]: {
        kind: 'EQUALS', type: 'boolean', values: [true],
      },
      [F.warehouse_name]: {
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
    table: 'silver__datex_slv_orderlines',
    fields: [
      F.delivery_date,
      F.mat_lookup_code,
      F.mat_name,
      F.available_amount,
      F.amount_sum,
    ],
    filters: baseOrderFilters(date),
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
    "Route Number (Bernatello's)": String(r[F.route_number] ?? ''),
    'Material Lookup Code':        String(r[F.mat_lookup_code] ?? ''),
    'Packaged Amount Sum':          Number(r[F.packaged_amount] ?? 0),
    'Requested Delivery Date Date': String(r[F.delivery_date] ?? '').slice(0, 10),
  }))

  const tieHighRows = tieHighRaw.map(r => ({
    'Location Container':   '',
    'Material Lookup Code': String(r[F.mat_lookup_code] ?? ''),
    'Material Name':        String(r[F.mat_name] ?? ''),
    'Pickline Zones':       pickSeqToZone(Number(r[F.pick_sequence] ?? 0)),
    'Full Pallet (t x h)':  Number(r[F.pallet_tie] ?? 0) * Number(r[F.pallet_high] ?? 0),
  }))

  const shortageRows = shortageRaw
    .filter(r => Number(r[F.available_amount] ?? 0) < Number(r[F.amount_sum] ?? 0))
    .map(r => ({
      'Material Lookup Code':         String(r[F.mat_lookup_code] ?? ''),
      'Item Number':                  String(r[F.mat_lookup_code] ?? ''),
      'Requested Delivery Date Date': String(r[F.delivery_date] ?? '').slice(0, 10),
      'Total Available Cases':        Number(r[F.available_amount] ?? 0),
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
    runOmniQuery(buildCasesQuery(date),    API_KEY),
    runOmniQuery(buildTieHighQuery(),      API_KEY),
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
