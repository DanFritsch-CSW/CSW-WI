'use strict'

// Shared Datex SmartUp API client for DPI Monthly Process (Phase 1: import → Datex orders).
//
// IMPORTANT — this is a DIFFERENT Datex API host than netlify/functions/lib/datex-push-shared.cjs.
// That file talks to csw-footprint-api.wavelength.host (dock appointments, used by the
// Scheduling Plugin). This file talks to csw-smartup-api.wavelength.host (orders/materials,
// same host the csw-AIOrderCreator Cloudflare Worker uses for ASN inbound orders).
//
// Azure AD `scope` claims are API-specific — the FootPrint-scoped token in datex-push-shared.cjs
// is NOT assumed to work here. This file looks for its own DATEX_SMARTUP_* env vars first,
// falling back to the generic DATEX_* vars only if the SmartUp-specific ones aren't set (in case
// it turns out to be the same Azure app registration — untested, needs live verification).
//
// Confirmed against real MotherDuck data (2026-09-05), not guessed:
//   EC:      project_id 253 (lookup_code 'DPI2'), warehouse_id 3
//   Madison: project_id 122 (lookup_code 'DPI1'), warehouse_id 4
//   order_class_id 2 (both facilities, confirmed against existing "{Mon}{YY} - {AgencyNbr}" orders)
//   packaging_id 3 (CS), confirmed against real order lines on order 780998

const DATEX_SMARTUP_BASE_URL =
  process.env.DATEX_SMARTUP_BASE_URL || 'https://csw-smartup-api.wavelength.host'

const DATEX_SMARTUP_TENANT_ID     = process.env.DATEX_SMARTUP_TENANT_ID     || process.env.DATEX_TENANT_ID
const DATEX_SMARTUP_CLIENT_ID     = process.env.DATEX_SMARTUP_CLIENT_ID     || process.env.DATEX_CLIENT_ID
const DATEX_SMARTUP_CLIENT_SECRET = process.env.DATEX_SMARTUP_CLIENT_SECRET || process.env.DATEX_CLIENT_SECRET
const DATEX_SMARTUP_SCOPE         = process.env.DATEX_SMARTUP_SCOPE         || process.env.DATEX_SCOPE

const FACILITIES = {
  'Eau Claire': { project_id: 253, warehouse_id: 3, order_class_id: 2, packaging_id: 3 },
  'Madison':    { project_id: 122, warehouse_id: 4, order_class_id: 2, packaging_id: 3 },
}

// Mirrors the AIOrderCreator Cloudflare Worker's `dryRun = !env.DATEX_CLIENT_ID`
// pattern — lets the push function simulate instead of failing when
// credentials aren't set up yet (blocked on Azure app registration access
// as of 2026-09-06 — Ethan, expected ~2026-09-09).
function isConfigured() {
  return Boolean(
    DATEX_SMARTUP_TENANT_ID && DATEX_SMARTUP_CLIENT_ID &&
    DATEX_SMARTUP_CLIENT_SECRET && DATEX_SMARTUP_SCOPE
  )
}

// ── Azure AD token cache (module-level; cold starts just re-fetch) ─────────

let _tokenCache = null

async function getSmartUpToken() {
  const now = Date.now()
  const minRemaining = 10 * 60 * 1000

  if (_tokenCache && _tokenCache.expiresAt > now + minRemaining) {
    return _tokenCache.token
  }

  if (!DATEX_SMARTUP_TENANT_ID || !DATEX_SMARTUP_CLIENT_ID || !DATEX_SMARTUP_CLIENT_SECRET || !DATEX_SMARTUP_SCOPE) {
    throw new Error(
      'SmartUp API credentials not configured. Set DATEX_SMARTUP_TENANT_ID / DATEX_SMARTUP_CLIENT_ID / ' +
      'DATEX_SMARTUP_CLIENT_SECRET / DATEX_SMARTUP_SCOPE in Netlify env vars. These are NOT assumed to be ' +
      'the same as the FootPrint API credentials — verify with Dan before assuming reuse.'
    )
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: DATEX_SMARTUP_CLIENT_ID,
    client_secret: DATEX_SMARTUP_CLIENT_SECRET,
    scope: DATEX_SMARTUP_SCOPE,
  })

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 30_000)
  let res
  try {
    res = await fetch(`https://login.microsoftonline.com/${DATEX_SMARTUP_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: abort.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`SmartUp Azure token fetch failed (${res.status}): ${text.slice(0, 300)}`)
  }

  const json = await res.json()
  if (!json.access_token) throw new Error('SmartUp Azure token response missing access_token')

  const expiresIn = json.expires_in || 3600
  _tokenCache = { token: json.access_token, expiresAt: now + expiresIn * 1000 }
  return _tokenCache.token
}

async function smartUpPost(path, body) {
  const token = await getSmartUpToken()
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 30_000)
  let res
  try {
    res = await fetch(`${DATEX_SMARTUP_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = null }
  return { ok: res.ok, status: res.status, data, text }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── MotherDuck query helper ─────────────────────────────────────────────
// Used for material catalog resolution only (see below) — NOT for
// verifying recently-written order lines. 2026-09-18: confirmed there is
// a real ~30 minute sync delay between Datex and MotherDuck. A short-wait
// "verify what persisted" check against MotherDuck was built and then
// REVERTED the same day once this was confirmed — a 5-15 second wait
// cannot see true state on a 30-minute-delayed replica, and treating
// genuinely-successful-but-not-yet-synced lines as "missing" would have
// caused this code to resubmit them, creating duplicate lines in Datex
// once the real sync caught up. MotherDuck remains safe to use here only
// for the material catalog, which is slow-changing reference data where a
// 30-minute staleness window is not a correctness risk.

async function runMotherDuckQuery(sql, { retries = 2 } = {}) {
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    throw new Error('MOTHERDUCK_TOKEN not configured — cannot query MotherDuck')
  }
  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    const duckdb = require('duckdb')
    const db = new duckdb.Database(':memory:')
    const conn = db.connect()
    const exec = (s) => new Promise((resolve, reject) => conn.run(s, (err) => (err ? reject(err) : resolve())))
    const runQuery = (s) => new Promise((resolve, reject) => conn.all(s, (err, rows) => (err ? reject(err) : resolve(rows))))
    try {
      await exec("SET home_directory='/tmp'")
      await exec('INSTALL motherduck')
      await exec('LOAD motherduck')
      await exec(`ATTACH 'md:production_db'`)
      const rows = await runQuery(sql)
      return rows
    } catch (err) {
      lastErr = err
      console.error(`[dpi-monthly-shared] MotherDuck query attempt ${attempt}/${retries} failed: ${err.message}`)
      if (attempt < retries) await sleep(2000)
    } finally {
      try { conn.close(); db.close() } catch (_) { /* best effort cleanup */ }
    }
  }
  throw new Error(`MotherDuck query failed after ${retries} attempts: ${lastErr.message}`)
}

// ── Material resolution — via MotherDuck, not the SmartUp API ─────────────
// 2026-09-18: the SmartUp API's get_materials_by_project has unreliable
// pagination — repeated calls with our best-guess page/limit/offset params
// returned different, overlapping-but-incomplete subsets each time (never
// the full ~700+ SKU catalog). Dan's call: since MotherDuck's replica of
// Datex's material table has proven 100% accurate for this kind of slow-
// changing reference data, use it as the source of truth for material_id
// resolution instead of trusting this API endpoint. Same connection
// pattern as netlify/functions/motherduck-dpi-pickline.cjs (duckdb npm
// package + MOTHERDUCK_TOKEN, already configured in this app).
//
// This is safe specifically because the material catalog changes rarely —
// unlike order lines just written moments ago (see the note on
// runMotherDuckQuery above), there's no meaningful risk that a material
// added to Datex minutes ago wouldn't yet be visible here.

const _materialCache = new Map() // project_id -> Map(lookup_code -> material_id)

async function getMaterialMap(project_id) {
  if (_materialCache.has(project_id)) return _materialCache.get(project_id)

  const rows = await runMotherDuckQuery(`
    SELECT lookup_code, material_id
    FROM production_db.silver.datex_slv_materials
    WHERE project_id = ${Number(project_id)}
  `)

  const map = new Map()
  for (const row of rows) {
    if (row.lookup_code != null && row.material_id != null) {
      map.set(String(row.lookup_code).trim(), row.material_id)
    }
  }
  console.error(`[dpi-monthly-shared] getMaterialMap(${project_id}) resolved ${map.size} materials via MotherDuck.`)
  _materialCache.set(project_id, map)
  return map
}

// ── Duplicate check ──────────────────────────────────────────────────────
// Returns a Set of lookup_codes that already exist for this project, so the
// caller can skip re-creating orders on a re-run/re-upload.

async function getExistingLookupCodes(project_id) {
  const result = await smartUpPost('/api/get_orders_by_project', { project_id })
  if (!result.ok) {
    throw new Error(`get_orders_by_project failed (${result.status}): ${result.text.slice(0, 300)}`)
  }
  const rows = Array.isArray(result.data) ? result.data : (result.data?.orders || result.data?.items || [])
  const set = new Set()
  for (const row of rows) {
    const code = row.lookup_code ?? row.LookupCode
    if (code != null) set.add(String(code).trim())
  }
  return set
}

// ── Order + line creation ───────────────────────────────────────────────
//
// agency = {
//   agencyNumber, firstName (already abbreviated to <=32 chars if needed),
//   line1, city, state, postalCode,
//   lookupCode, expectedDate (ISO string),
//   lines: [{ materialLookupCode, quantity }]
// }

// 2026-09-18 investigation summary for create_outbound_order_line's
// silent-drop behavior. Order + shipment_id + material_id + quantity all
// independently confirmed correct, yet a meaningful fraction of otherwise-
// identical line-creation calls never persist — every response comes back
// byte-identical ({"line_number":null,"reason":null}) whether a line
// succeeds or not, so Datex's own response carries no distinguishing
// signal. Explicit sequential line_number + a delay between calls (below)
// measurably reduced the drop rate in real testing (one order went from
// ~40% missing to 0% missing; two others from ~60% to 10-20%) but did not
// eliminate it.
//
// A "verify what persisted via MotherDuck and backfill the gap" step was
// built the same day and then REVERTED once a real ~30-minute Datex→
// MotherDuck sync delay was confirmed — a short in-process wait cannot see
// true state on a 30-minute-delayed replica, and doing so risked
// resubmitting genuinely-successful lines as if they were missing,
// creating duplicates once the real sync caught up. Any future
// verification/backfill against MotherCk must run as a SEPARATE, later
// process (well past the sync delay), never synchronously inside this
// push.
//
// 2026-09-18 (later): raised the delay from 300ms to 1000ms per Dan's
// request, then REVERTED back down the same day once real production
// volume was factored in. Netlify's background function execution limit
// is a confirmed, documented HARD ceiling of 15 minutes (900 seconds) —
// not an estimate, it's an AWS Lambda-backed function that gets killed
// mid-run when it hits this, with no graceful wind-down. Dan's real
// volume: a full month's CSV import can total 1,000-1,500 lines across
// ALL agencies in one facility push, all processed sequentially in this
// ONE function invocation. At 1000ms delay alone, that's 1,000-1,500
// seconds (16.7-25 min) of pure sleep — already over budget before
// counting a single real API call. Even at 300ms, real per-call API
// latency (network + Datex processing, separate from this deliberate
// sleep) likely adds another 300-500ms per line on its own, meaning
// 1,500 lines could plausibly consume 7.5-12.5 minutes from unavoidable
// latency alone, leaving very little headroom for deliberate delay on
// top of it.
//
// Bottom line: no single per-line delay value is safe at true production
// scale without real risk of the whole push timing out mid-run (which
// would be worse than a partial line-drop — agencies not yet reached get
// no final status written at all). Tuning this number further is NOT a
// complete fix. The real fix is removing the "everything in one 15-minute
// invocation" constraint entirely — batching a full push across multiple
// chained function invocations — discussed with Dan 2026-09-18, not yet
// built. Reverting to 300ms here as the safest known value pending that
// architectural change: real test data showed it got one order (Fall
// River, 26 lines) to 100% correct and two others to 80-90%, without the
// same acute timeout risk 1000ms carries at real volume.
const LINE_CREATE_DELAY_MS = 300

async function createAgencyOrder(facility, agency, materialMap) {
  const cfg = FACILITIES[facility]
  if (!cfg) throw new Error(`Unknown facility "${facility}" — expected "Eau Claire" or "Madison"`)

  const orderResult = await smartUpPost('/api/create_outbound_order', {
    project_id: cfg.project_id,
    warehouse_id: cfg.warehouse_id,
    order_class_id: cfg.order_class_id,
    lookup_code: agency.lookupCode,
    owner_reference: agency.lookupCode,
    vendor_reference: agency.lookupCode,
    expected_date: agency.expectedDate,
    shipping_address: {
      first_name: agency.firstName,
      line1: agency.line1 || null,
      city: agency.city || null,
      state: agency.state || null,
      postal_code: agency.postalCode || null,
      country: 'US',
    },
  })

  if (!orderResult.ok) {
    return { success: false, error: `create_outbound_order failed (${orderResult.status}): ${orderResult.text.slice(0, 300)}` }
  }

  const order_id = orderResult.data?.order_id ?? orderResult.data?.Id ?? orderResult.data?.id
  if (!order_id) {
    return { success: false, error: `create_outbound_order returned no order_id: ${JSON.stringify(orderResult.data)}` }
  }

  const shipment_id = orderResult.data?.shipment_id ?? orderResult.data?.ShipmentId ?? orderResult.data?.shipment?.id ?? null
  if (shipment_id == null) {
    return {
      success: false,
      order_id,
      error: `Order ${order_id} created but response had no recognizable shipment_id field — cannot safely create lines without it (would repeat the "order created, 0 lines" bug). Raw response: ${JSON.stringify(orderResult.data)}`,
    }
  }

  const missingMaterials = []
  let lineNumber = 0
  for (const line of agency.lines) {
    const code = String(line.materialLookupCode || '').trim()
    const material_id = materialMap.get(code)
    if (material_id == null) {
      missingMaterials.push(code)
      continue // don't call create_outbound_order_line with a null material_id
    }
    lineNumber += 1

    const lineResult = await smartUpPost('/api/create_outbound_order_line', {
      order_id,
      shipment_id,
      line_number: lineNumber,
      material_id,
      expected_quantity: Number(line.quantity) || 0,
      actual_quantity: Number(line.quantity) || 0,
      packaging_id: cfg.packaging_id,
    })
    console.error(`[dpi-monthly-shared] create_outbound_order_line response for material ${code} (line_number ${lineNumber}): ${lineResult.text.slice(0, 500)}`)
    if (!lineResult.ok) {
      return {
        success: false,
        order_id,
        error: `create_outbound_order_line failed for material ${code} (${lineResult.status}): ${lineResult.text.slice(0, 300)}`,
      }
    }

    // Spacing out rapid-fire writes to the same order/shipment — see the
    // 2026-09-18 investigation note above this function. Only sleeps
    // between calls, not after the last one.
    if (lineNumber < agency.lines.length) {
      await sleep(LINE_CREATE_DELAY_MS)
    }
  }

  if (missingMaterials.length > 0) {
    return {
      success: false,
      order_id,
      error: `Order created but ${missingMaterials.length} line(s) skipped — material lookup_code not found in MotherDuck for project ${cfg.project_id}: ${[...new Set(missingMaterials)].join(', ')}`,
    }
  }

  // NOTE: "success" here means every create_outbound_order_line call
  // returned an HTTP-level success response — it does NOT guarantee every
  // line actually persisted in Datex (see investigation note above). A
  // reliable post-hoc check needs to run separately, well after the real
  // Datex→MotherDuck sync delay — not decided/built yet as of 2026-09-18.
  return { success: true, order_id, line_count: agency.lines.length }
}

module.exports = {
  FACILITIES,
  isConfigured,
  getSmartUpToken,
  getMaterialMap,
  getExistingLookupCodes,
  createAgencyOrder,
  runMotherDuckQuery,
}
