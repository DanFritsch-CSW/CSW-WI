'use strict'

// Pickline queries for WR Bernatello's pick planning.
// DSD Order class filter applied to match the Excel export exactly.
// TieHigh zone+fullPallet data is hardcoded from the Excel (Omni join is unreliable).
// Returns: { casesRows, tieHighRows, shortageRows, date }

const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

const DATEX_MODEL_ID = 'e80fa12f-918e-40b8-bb91-60fbac98ab19'

const F = {
  status_name:      'silver__datex_slv_orderstatuses.status_name',
  delivery_date:    'silver__datex_slv_orders.requested_delivery_date',
  route_number:     'silver__datex_slv_orders.calculation',
  project_name:     'silver__datex_slv_projects.project_name',
  order_class_name: 'silver__datex_slv_orderclasses.order_class_name',
  mat_lookup_code:  'silver__datex_slv_materials.lookup_code',
  mat_name:         'silver__datex_slv_materials.material_name',
  packaged_amount:  'silver__datex_slv_orderlines.packaged_amount_sum',
  available_amount: 'gold__available_inventory_by_material.available_amount_sum',
  amount_sum:       'silver__datex_slv_orderlines.amount_sum',
}

// Static SKU->zone+fullPallet map derived from WR TieHigh Excel (112 SKUs, Z1-Z12).
// Update if pickline layout changes.
const SKU_ZONE_MAP = {
  '45': { zone: 12, fullPallet: 100 },
  '46': { zone: 10, fullPallet: 100 },
  '47': { zone: 11, fullPallet: 100 },
  '48': { zone: 11, fullPallet: 100 },
  '50': { zone: 7, fullPallet: 48 },
  '51': { zone: 7, fullPallet: 48 },
  '52': { zone: 6, fullPallet: 48 },
  '53': { zone: 6, fullPallet: 54 },
  '54': { zone: 6, fullPallet: 48 },
  '56': { zone: 7, fullPallet: 48 },
  '58': { zone: 6, fullPallet: 48 },
  '59': { zone: 7, fullPallet: 48 },
  '60': { zone: 6, fullPallet: 48 },
  '61': { zone: 6, fullPallet: 48 },
  '66': { zone: 6, fullPallet: 48 },
  '67': { zone: 6, fullPallet: 48 },
  '120': { zone: 12, fullPallet: 40 },
  '128': { zone: 6, fullPallet: 42 },
  '129': { zone: 6, fullPallet: 42 },
  '130': { zone: 5, fullPallet: 42 },
  '133': { zone: 5, fullPallet: 42 },
  '137': { zone: 5, fullPallet: 42 },
  '411': { zone: 12, fullPallet: 42 },
  '412': { zone: 12, fullPallet: 42 },
  '415': { zone: 11, fullPallet: 42 },
  '416': { zone: 10, fullPallet: 42 },
  '417': { zone: 11, fullPallet: 42 },
  '418': { zone: 10, fullPallet: 42 },
  '555': { zone: 11, fullPallet: 100 },
  '556': { zone: 11, fullPallet: 100 },
  '557': { zone: 11, fullPallet: 100 },
  '558': { zone: 11, fullPallet: 100 },
  '791': { zone: 9, fullPallet: 48 },
  '792': { zone: 9, fullPallet: 48 },
  '10791': { zone: 9, fullPallet: 48 },
  '10792': { zone: 8, fullPallet: 48 },
  '11008': { zone: 9, fullPallet: 48 },
  '11009': { zone: 8, fullPallet: 48 },
  '47000': { zone: 12, fullPallet: 60 },
  '47001': { zone: 12, fullPallet: 60 },
  '47002': { zone: 11, fullPallet: 60 },
  '47004': { zone: 11, fullPallet: 60 },
  '47005': { zone: 12, fullPallet: 60 },
  '60301': { zone: 7, fullPallet: 54 },
  '60303': { zone: 8, fullPallet: 54 },
  '60310': { zone: 8, fullPallet: 54 },
  '60314': { zone: 8, fullPallet: 54 },
  '60315': { zone: 8, fullPallet: 54 },
  '61001': { zone: 5, fullPallet: 48 },
  '61002': { zone: 2, fullPallet: 48 },
  '61003': { zone: 3, fullPallet: 48 },
  '61010': { zone: 5, fullPallet: 42 },
  '61011': { zone: 3, fullPallet: 42 },
  '61015': { zone: 4, fullPallet: 42 },
  '61019': { zone: 3, fullPallet: 42 },
  '61023': { zone: 4, fullPallet: 48 },
  '61024': { zone: 3, fullPallet: 48 },
  '61026': { zone: 4, fullPallet: 42 },
  '61027': { zone: 4, fullPallet: 42 },
  '61028': { zone: 3, fullPallet: 42 },
  '61030': { zone: 3, fullPallet: 48 },
  '61031': { zone: 3, fullPallet: 48 },
  '61033': { zone: 4, fullPallet: 42 },
  '61060': { zone: 1, fullPallet: 48 },
  '61061': { zone: 1, fullPallet: 48 },
  '61062': { zone: 2, fullPallet: 48 },
  '61063': { zone: 2, fullPallet: 42 },
  '61070': { zone: 3, fullPallet: 48 },
  '61071': { zone: 4, fullPallet: 48 },
  '61072': { zone: 4, fullPallet: 48 },
  '61073': { zone: 4, fullPallet: 42 },
  '61150': { zone: 12, fullPallet: 90 },
  '61151': { zone: 11, fullPallet: 90 },
  '61152': { zone: 12, fullPallet: 90 },
  '61153': { zone: 12, fullPallet: 90 },
  '61154': { zone: 11, fullPallet: 90 },
  '61155': { zone: 12, fullPallet: 90 },
  '62101': { zone: 7, fullPallet: 30 },
  '62102': { zone: 7, fullPallet: 30 },
  '62103': { zone: 7, fullPallet: 30 },
  '62104': { zone: 7, fullPallet: 30 },
  '62105': { zone: 8, fullPallet: 30 },
  '71600': { zone: 1, fullPallet: 48 },
  '71602': { zone: 2, fullPallet: 48 },
  '71604': { zone: 2, fullPallet: 48 },
  '71605': { zone: 1, fullPallet: 48 },
  '71606': { zone: 1, fullPallet: 48 },
  '71608': { zone: 1, fullPallet: 48 },
  '71609': { zone: 2, fullPallet: 48 },
  '72100': { zone: 8, fullPallet: 48 },
  '72101': { zone: 8, fullPallet: 48 },
  '72102': { zone: 9, fullPallet: 48 },
  '72103': { zone: 9, fullPallet: 48 },
  '72104': { zone: 8, fullPallet: 48 },
  '72105': { zone: 8, fullPallet: 48 },
  '73008': { zone: 10, fullPallet: 64 },
  '73009': { zone: 9, fullPallet: 54 },
  '73010': { zone: 9, fullPallet: 36 },
  '73011': { zone: 10, fullPallet: 36 },
  '73012': { zone: 9, fullPallet: 54 },
  '73013': { zone: 10, fullPallet: 36 },
  '73014': { zone: 10, fullPallet: 64 },
  '73030': { zone: 9, fullPallet: 36 },
  '73031': { zone: 10, fullPallet: 36 },
  '73032': { zone: 10, fullPallet: 36 },
  '73033': { zone: 8, fullPallet: 36 },
  '78010': { zone: 9, fullPallet: 48 },
  '78011': { zone: 10, fullPallet: 48 },
  '78012': { zone: 9, fullPallet: 48 },
  '78013': { zone: 10, fullPallet: 48 },
  '78014': { zone: 10, fullPallet: 48 },
  '78015': { zone: 9, fullPallet: 48 },
}

// Build tieHighRows directly from the static map — no Omni query needed
function buildStaticTieHighRows() {
  return Object.entries(SKU_ZONE_MAP).map(([sku, { zone, fullPallet }]) => ({
    'Location Container':   '',
    'Material Lookup Code': sku,
    'Material Name':        '',
    'Pickline Zones':       zone,
    'Full Pallet (t x h)':  fullPallet,
  }))
}

function baseOrderFilters(date) {
  return {
    [F.project_name]: { kind: 'EQUALS', type: 'string', values: ["Bernatello's - Wisconsin Rapids"] },
    [F.order_class_name]: { kind: 'EQUALS', type: 'string', values: ['DSD Order'] },
    [F.delivery_date]: {
      kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
      isFiscal: false, left_side: date, is_negative: false, offset_interval_string: '0 days',
    },
    [F.status_name]: { kind: 'EQUALS', type: 'string', values: ['Created', 'Processing'] },
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

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
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    const text = await omniRes.text()
    let completeJob = null, timedOut = false
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
    version: 5, modelId: DATEX_MODEL_ID,
    table: 'silver__datex_slv_orderlines',
    fields: [F.delivery_date, F.route_number, F.mat_lookup_code, F.mat_name, F.packaged_amount],
    filters: baseOrderFilters(date),
    sorts: [], limit: 5000,
  }
}

function buildShortageQuery(date) {
  return {
    version: 5, modelId: DATEX_MODEL_ID,
    table: 'silver__datex_slv_orderlines',
    fields: [F.delivery_date, F.mat_lookup_code, F.mat_name, F.available_amount, F.amount_sum],
    filters: baseOrderFilters(date),
    sorts: [], limit: 1000,
  }
}

function transformRows(casesRaw, shortageRaw) {
  const casesRows = casesRaw.map(r => ({
    "Route Number (Bernatello's)": String(r[F.route_number] ?? ''),
    'Material Lookup Code':        String(r[F.mat_lookup_code] ?? ''),
    'Packaged Amount Sum':          Number(r[F.packaged_amount] ?? 0),
    'Requested Delivery Date Date': String(r[F.delivery_date] ?? '').slice(0, 10),
  }))

  const shortageRows = shortageRaw
    .filter(r => Number(r[F.available_amount] ?? 0) < Number(r[F.amount_sum] ?? 0))
    .map(r => ({
      'Material Lookup Code':         String(r[F.mat_lookup_code] ?? ''),
      'Item Number':                  String(r[F.mat_lookup_code] ?? ''),
      'Requested Delivery Date Date': String(r[F.delivery_date] ?? '').slice(0, 10),
      'Total Available Cases':        Number(r[F.available_amount] ?? 0),
    }))

  return { casesRows, shortageRows }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' }

  const API_KEY = process.env.OMNI_API_KEY
  if (!API_KEY) return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'OMNI_API_KEY not configured' }),
  }

  let date
  try {
    ;({ date } = JSON.parse(event.body))
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid date')
  } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Body must be { date: "YYYY-MM-DD" }' }) }
  }

  // Only 2 Omni queries now — TieHigh is static
  const [casesResult, shortageResult] = await Promise.all([
    runOmniQuery(buildCasesQuery(date),    API_KEY),
    runOmniQuery(buildShortageQuery(date), API_KEY),
  ])

  const failed = [
    !casesResult?.ok    && 'Cases',
    !shortageResult?.ok && 'Shortage',
  ].filter(Boolean)

  if (failed.length) {
    const detail = [
      !casesResult?.ok    && `Cases: ${casesResult?.raw ?? 'no response'}`,
      !shortageResult?.ok && `Shortage: ${shortageResult?.raw ?? 'no response'}`,
    ].filter(Boolean).join(' | ')
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Omni query failed: ${failed.join(', ')}`, detail }) }
  }

  const { tableFromIPC } = await import('apache-arrow')
  const casesRaw    = arrowToRows(tableFromIPC(Buffer.from(casesResult.job.result,    'base64')))
  const shortageRaw = arrowToRows(tableFromIPC(Buffer.from(shortageResult.job.result, 'base64')))

  const { casesRows, shortageRows } = transformRows(casesRaw, shortageRaw)
  const tieHighRows = buildStaticTieHighRows()

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ casesRows, tieHighRows, shortageRows, date }),
  }
}
