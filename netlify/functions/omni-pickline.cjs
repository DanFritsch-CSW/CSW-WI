'use strict'

// Pickline queries for WR Bernatello's pick planning.
// DSD Order class filter applied to match the Excel export exactly.
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
  loc_name:         'silver__datex_slv_locationcontainers.location_container_name',
  pallet_tie:       'silver__datex_slv_materialspackagingslookup.pallet_tie',
  pallet_high:      'silver__datex_slv_materialspackagingslookup.pallet_high',
  warehouse_name:   'silver__datex_slv_warehouses.warehouse_name',
  is_primary_pick:  'silver__datex_slv_locationcontainers.is_primary_pick',
  available_amount: 'gold__available_inventory_by_material.available_amount_sum',
  amount_sum:       'silver__datex_slv_orderlines.amount_sum',
}

// Zone boundaries derived from actual WR slot numbers (P029A–P122A).
// Validated against TieHigh Excel sheet — "Pickline Zones" column.
// Zone 1: P029–P036, Zone 2: P037–P042, Zone 3: P043–P050,
// Zone 4: P051–P058, Zone 5: P059–P064, Zone 6: P065–P074,
// Zone 7: P075–P081, Zone 8: P083–P090, Zone 9: P091–P098,
// Zone 10: P099–P106, Zone 11: P107–P114, Zone 12: P115+
function slotToZone(locName) {
  const m = String(locName || '').match(/P(\d+)/i)
  if (!m) return 0
  const s = parseInt(m[1], 10)
  if (s >= 29  && s <= 36)  return 1
  if (s >= 37  && s <= 42)  return 2
  if (s >= 43  && s <= 50)  return 3
  if (s >= 51  && s <= 58)  return 4
  if (s >= 59  && s <= 64)  return 5
  if (s >= 65  && s <= 74)  return 6
  if (s >= 75  && s <= 81)  return 7
  if (s >= 83  && s <= 90)  return 8
  if (s >= 91  && s <= 98)  return 9
  if (s >= 99  && s <= 106) return 10
  if (s >= 107 && s <= 114) return 11
  if (s >= 115)             return 12
  return 0
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

function buildTieHighQuery() {
  return {
    version: 5, modelId: DATEX_MODEL_ID,
    table: 'silver__datex_slv_locationcontainers',
    // Use location_container_name to derive zone via slotToZone() — pick_sequence ranges
    // don't correspond to zones directly.
    fields: [F.loc_name, F.mat_lookup_code, F.mat_name, F.pallet_tie, F.pallet_high],
    filters: {
      [F.is_primary_pick]: { kind: 'EQUALS', type: 'boolean', values: [true] },
      [F.warehouse_name]:  { kind: 'CONTAINS', type: 'string', values: ['Rapids'], is_negative: false },
    },
    sorts: [], limit: 500,
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

function transformRows(casesRaw, tieHighRaw, shortageRaw) {
  const casesRows = casesRaw.map(r => ({
    "Route Number (Bernatello's)": String(r[F.route_number] ?? ''),
    'Material Lookup Code':        String(r[F.mat_lookup_code] ?? ''),
    'Packaged Amount Sum':          Number(r[F.packaged_amount] ?? 0),
    'Requested Delivery Date Date': String(r[F.delivery_date] ?? '').slice(0, 10),
  }))

  const tieHighRows = tieHighRaw.map(r => ({
    'Location Container':   String(r[F.loc_name] ?? ''),
    'Material Lookup Code': String(r[F.mat_lookup_code] ?? ''),
    'Material Name':        String(r[F.mat_name] ?? ''),
    'Pickline Zones':       slotToZone(r[F.loc_name]),
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
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Omni query failed: ${failed.join(', ')}`, detail }) }
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
