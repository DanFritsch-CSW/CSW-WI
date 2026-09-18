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
//
// Carrier IDs confirmed against production_db.silver.datex_slv_carriers
// 2026-09-18, per Dan's direction (Madison -> J&J, EC -> Echo Brook):
//   Madison: carrier_id 463 ("J&J") — Dan explicitly picked this one over
//     a second identically-named "J&J" record (carrier_id 1392) and
//     several other J&J-ish carriers (J&J Bros, J&J TRUCKING, J&J GRAY,
//     etc.) that also exist in the table — those are NOT interchangeable.
//   EC: carrier_id 1322 ("ECHO BROOK") — the only real match; "Echobrook"
//     as one word doesn't exist in Datex, several other Echo/Brook
//     carriers do (Echo Express, Echo Lake Transport, Cressbrook, etc.)
//     and are NOT this one.

const DATEX_SMARTUP_BASE_URL =
  process.env.DATEX_SMARTUP_BASE_URL || 'https://csw-smartup-api.wavelength.host'

const DATEX_SMARTUP_TENANT_ID     = process.env.DATEX_SMARTUP_TENANT_ID     || process.env.DATEX_TENANT_ID
const DATEX_SMARTUP_CLIENT_ID     = process.env.DATEX_SMARTUP_CLIENT_ID     || process.env.DATEX_CLIENT_ID
const DATEX_SMARTUP_CLIENT_SECRET = process.env.DATEX_SMARTUP_CLIENT_SECRET || process.env.DATEX_CLIENT_SECRET
const DATEX_SMARTUP_SCOPE         = process.env.DATEX_SMARTUP_SCOPE         || process.env.DATEX_SCOPE

const FACILITIES = {
  'Eau Claire': { project_id: 253, warehouse_id: 3, order_class_id: 2, packaging_id: 3, carrier_id: 1322 },
  'Madison':    { project_id: 122, warehouse_id: 4, order_class_id: 2, packaging_id: 3, carrier_id: 463 },
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
//
// 2026-09-18 (later): a SEPARATE, later-running reconciliation process
// (lib/dpi-reconciliation-shared.cjs) now DOES use MotherDuck to verify
// and backfill missing lines — safely, because it only ever checks 45+
// minutes after a push/backfill attempt, well past the real sync delay.
// That's a fundamentally different timing regime than the same-day
// in-process attempt described above, which is why it's safe there and
// wasn't safe here.

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

// ── Diagnostic response logging — 2026-09-18, TEMPORARY ────────────────
// Purpose: settle definitively whether create_outbound_order_line's
// response (specifically the `reason` field) ever carries real
// success/failure signal, or whether it is always byte-identical
// regardless of outcome as every prior investigation this session
// suggested. console.error alone isn't queryable after the fact, so this
// persists every raw response to a dedicated Supabase table
// (dpi_line_create_debug) that can be cross-referenced against
// MotherDuck's actual persisted lines once the ~30 min sync delay has
// passed. Fire-and-forget and fully isolated in try/catch — a failure
// here must NEVER break or slow down the real push. Safe to remove this
// whole block (and drop the table) once the investigation concludes.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

async function logLineCreateDebug(row) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/dpi_line_create_debug`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(row),
    })
  } catch (err) {
    console.error(`[dpi-monthly-shared] logLineCreateDebug failed (non-fatal): ${err.message}`)
  }
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
// 2026-09-18 (later): raised the delay from 300ms to 1000ms per Dan's
// request, then REVERTED back down the same day once real production
// volume was factored in — Netlify's background function execution limit
// is a confirmed, documented HARD ceiling of 15 minutes (900 seconds), and
// a full month's CSV import can total 1,000-1,500 lines across ALL
// agencies in one facility push.
//
// 2026-09-18 (final for the delay itself): raised again to 750ms after
// dpi-import-push-background.cjs gained self-chaining (tracks its own
// elapsed time and hands off remaining agencies to a fresh invocation
// before hitting the 15-minute ceiling), which removed the timeout
// constraint that previously capped this value.
//
// 2026-09-18 (real production run, later still): a real 67-agency Madison
// push at 750ms came back 59/67 fully correct, 8/67 short by 1-5 lines
// each (20 total lines out of 1,000+ pushed) — real, substantial
// improvement over 300ms, but not zero. Per Dan: import should be 100%
// accurate every time, and reconciliation should not require routine
// human intervention. Conclusion: no per-line delay value can be proven
// to reach exactly zero on an endpoint this unreliable, so the fix is
// making reconciliation SELF-HEALING (see lib/dpi-reconciliation-
// shared.cjs) — automatically resubmit whatever's missing 45+ min later
// (safely past the real sync delay), re-verify, and only ever surface to
// a human if a genuine gap survives multiple backfill attempts.
// submitLines is exported so reconciliation's backfill step reuses the
// exact same line_number + delay logic, not a separate reimplementation.
//
// 2026-09-18 (settling the response-signal question): before accepting
// self-healing reconciliation as the permanent answer, Dan asked to
// settle definitively whether the response actually carries no signal at
// all, or whether it does and this code just wasn't reading it right.
// Every raw response is now also persisted to dpi_line_create_debug (see
// logLineCreateDebug above) so it can be joined against MotherDuck's
// actual persisted lines once the sync delay has passed — proof either
// way, not another inference from console logs alone.
const LINE_CREATE_DELAY_MS = 750

// Submits a list of resolved lines (each { code, material_id, quantity })
// sequentially, with explicit sequential line_number continuing from
// startingLineNumber and a delay between calls. Shared by the initial
// push (createAgencyOrder below) and reconciliation's backfill step.
async function submitLines(order_id, shipment_id, packaging_id, linesToSubmit, startingLineNumber) {
  let lineNumber = startingLineNumber
  for (let i = 0; i < linesToSubmit.length; i++) {
    const { code, material_id, quantity } = linesToSubmit[i]
    lineNumber += 1

    const lineResult = await smartUpPost('/api/create_outbound_order_line', {
      order_id,
      shipment_id,
      line_number: lineNumber,
      material_id,
      expected_quantity: quantity,
      actual_quantity: quantity,
      packaging_id,
    })
    console.error(`[dpi-monthly-shared] create_outbound_order_line response for material ${code} (line_number ${lineNumber}): ${lineResult.text.slice(0, 500)}`)

    // Diagnostic capture — see header comment above. Never awaited in a
    // way that could slow down or fail the real push.
    logLineCreateDebug({
      order_id,
      shipment_id,
      material_code: code,
      line_number: lineNumber,
      quantity,
      http_status: lineResult.status,
      raw_response: lineResult.text.slice(0, 2000),
    })

    if (!lineResult.ok) {
      return { ok: false, lastLineNumber: lineNumber, error: `create_outbound_order_line failed for material ${code} (${lineResult.status}): ${lineResult.text.slice(0, 300)}` }
    }

    if (i < linesToSubmit.length - 1) {
      await sleep(LINE_CREATE_DELAY_MS)
    }
  }
  return { ok: true, lastLineNumber: lineNumber }
}

async function createAgencyOrder(facility, agency, materialMap) {
  const cfg = FACILITIES[facility]
  if (!cfg) throw new Error(`Unknown facility "${facility}" — expected "Eau Claire" or "Madison"`)

  // 2026-09-18 fix: the "Shipped to" address on real orders was coming
  // through blank. Compared our shipping_address payload against the
  // real /api/create_outbound_order schema (pulled from Datex's own API
  // docs) — we were only sending `first_name`, never `name`. Real
  // historical orders (confirmed via MotherDuck's datex_slv_orderaddresses,
  // order 780998) show BOTH Name and first_name populated with the
  // identical value on a working ship-to record. Adding `name` alongside
  // first_name to match that real pattern exactly, rather than guessing
  // at a different fix (an internal "AccountId/ContactId" address-book
  // mechanism the FootPrint UI itself uses turned out to be a different,
  // unrelated internal-only path — not what this public API call needs).
  //
  // carrier_id added same day, per Dan's explicit facility assignment
  // (see FACILITIES comment above for the exact carrier_id disambiguation
  // — several near-identical carrier names exist in Datex for both J&J
  // and Echo Brook, so these are NOT safe to re-derive by name lookup).
  const orderResult = await smartUpPost('/api/create_outbound_order', {
    project_id: cfg.project_id,
    warehouse_id: cfg.warehouse_id,
    order_class_id: cfg.order_class_id,
    lookup_code: agency.lookupCode,
    owner_reference: agency.lookupCode,
    vendor_reference: agency.lookupCode,
    expected_date: agency.expectedDate,
    carrier_id: cfg.carrier_id,
    shipping_address: {
      name: agency.firstName,
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
  const resolvedLines = [] // [{ code, material_id, quantity }]
  for (const line of agency.lines) {
    const code = String(line.materialLookupCode || '').trim()
    const material_id = materialMap.get(code)
    if (material_id == null) {
      missingMaterials.push(code)
      continue // don't call create_outbound_order_line with a null material_id
    }
    resolvedLines.push({ code, material_id, quantity: Number(line.quantity) || 0 })
  }

  const submitResult = await submitLines(order_id, shipment_id, cfg.packaging_id, resolvedLines, 0)
  if (!submitResult.ok) {
    return { success: false, order_id, shipment_id, error: submitResult.error }
  }

  if (missingMaterials.length > 0) {
    return {
      success: false,
      order_id,
      shipment_id,
      error: `Order created but ${missingMaterials.length} line(s) skipped — material lookup_code not found in MotherDuck for project ${cfg.project_id}: ${[...new Set(missingMaterials)].join(', ')}`,
    }
  }

  // NOTE: "success" here means every create_outbound_order_line call
  // returned an HTTP-level success response — it does NOT guarantee every
  // line actually persisted in Datex (see investigation note above).
  // shipment_id is returned so it can be persisted on the batch row —
  // reconciliation's backfill step needs it later and it's otherwise
  // never stored anywhere durable.
  return { success: true, order_id, shipment_id, line_count: agency.lines.length }
}

module.exports = {
  FACILITIES,
  isConfigured,
  getSmartUpToken,
  getMaterialMap,
  getExistingLookupCodes,
  createAgencyOrder,
  submitLines,
  runMotherDuckQuery,
}
