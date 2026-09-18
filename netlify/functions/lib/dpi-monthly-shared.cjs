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

// ── MotherDuck query helper — shared by material resolution and the ─────────
// line-persistence verification below. Retries once on failure (the same
// cold-start extension-load issue affects any fresh connection, not just
// the first one made in a container).

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
// Datex's own material table has already proven 100% accurate in this
// investigation (every code checked there matched Datex's real catalog
// exactly), use MotherDuck as the source of truth for material_id
// resolution instead of trusting this API endpoint. Same connection
// pattern as netlify/functions/motherduck-dpi-pickline.cjs (duckdb npm
// package + MOTHERDUCK_TOKEN, already configured in this app).

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

// Returns the set of material_ids MotherDuck currently shows as persisted
// on this order — the read side of the verify-and-backfill loop below.
async function getPersistedMaterialIds(order_id) {
  const rows = await runMotherDuckQuery(`
    SELECT DISTINCT material_id
    FROM production_db.silver.datex_slv_orderlines
    WHERE order_id = ${Number(order_id)}
  `)
  return new Set(rows.map((r) => r.material_id).filter((id) => id != null))
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
// measurably reduced the drop rate (one real order went from ~40% missing
// to 0% missing; two others from ~60% to 10-20%) but did not eliminate it.
//
// Since Datex won't reliably tell us whether a given line actually took,
// the only remaining fully self-controlled fix is to VERIFY what actually
// persisted (via MotherDuck, the same source that's been 100% accurate
// throughout this investigation) and BACKFILL whatever didn't, rather than
// trusting the create call's response at all.
const LINE_CREATE_DELAY_MS = 300
const VERIFY_WAIT_MS = 5000
const MAX_BACKFILL_ROUNDS = 2

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

  // Resolve every line up front — anything not in MotherDuck's material
  // table is a genuine data gap, not a create_outbound_order_line
  // reliability issue, and is reported separately below.
  const missingMaterials = []
  const resolvedLines = [] // [{ code, material_id, quantity }]
  const materialIdToCode = new Map()
  for (const line of agency.lines) {
    const code = String(line.materialLookupCode || '').trim()
    const material_id = materialMap.get(code)
    if (material_id == null) {
      missingMaterials.push(code)
      continue
    }
    resolvedLines.push({ code, material_id, quantity: Number(line.quantity) || 0 })
    materialIdToCode.set(material_id, code)
  }

  // Initial pass — submit every resolvable line.
  const firstPass = await submitLines(order_id, shipment_id, cfg.packaging_id, resolvedLines, 0)
  if (!firstPass.ok) {
    return { success: false, order_id, error: firstPass.error }
  }

  // Verify-and-backfill: Datex's create call gives no reliable success/
  // failure signal (see investigation note above), so check what actually
  // persisted via MotherDuck and re-submit anything missing, up to
  // MAX_BACKFILL_ROUNDS times.
  let lastLineNumber = firstPass.lastLineNumber
  let verifiedComplete = false
  let lastKnownPersistedIds = null
  for (let round = 1; round <= MAX_BACKFILL_ROUNDS; round++) {
    await sleep(VERIFY_WAIT_MS)

    let persistedIds
    try {
      persistedIds = await getPersistedMaterialIds(order_id)
      lastKnownPersistedIds = persistedIds
    } catch (err) {
      console.error(`[dpi-monthly-shared] verify round ${round} for order ${order_id} failed to read MotherDuck: ${err.message}`)
      break // can't verify — fall through to the final check below
    }

    const stillMissingIds = new Set(
      resolvedLines.map((l) => l.material_id).filter((id) => !persistedIds.has(id))
    )

    if (stillMissingIds.size === 0) {
      console.error(`[dpi-monthly-shared] order ${order_id} verified complete after round ${round}: all ${resolvedLines.length} lines persisted.`)
      verifiedComplete = true
      break
    }

    console.error(`[dpi-monthly-shared] order ${order_id} verify round ${round}: ${stillMissingIds.size} of ${resolvedLines.length} lines missing, backfilling.`)
    const toBackfill = resolvedLines.filter((l) => stillMissingIds.has(l.material_id))
    const backfillResult = await submitLines(order_id, shipment_id, cfg.packaging_id, toBackfill, lastLineNumber)
    if (!backfillResult.ok) {
      return { success: false, order_id, error: `Backfill round ${round} failed: ${backfillResult.error}` }
    }
    lastLineNumber = backfillResult.lastLineNumber
  }

  // Final check — skip re-querying if the backfill loop already confirmed
  // completeness on its last round; otherwise do one more check after the
  // last backfill attempt before deciding.
  let finalPersistedIds
  if (verifiedComplete) {
    finalPersistedIds = lastKnownPersistedIds
  } else {
    try {
      await sleep(VERIFY_WAIT_MS)
      finalPersistedIds = await getPersistedMaterialIds(order_id)
    } catch (err) {
      return {
        success: false,
        order_id,
        error: `Order and lines submitted, but could not do a final MotherDuck verification (${err.message}) — check this order manually before trusting it.`,
      }
    }
  }
  const finalMissing = resolvedLines.filter((l) => !finalPersistedIds.has(l.material_id))

  if (missingMaterials.length > 0 || finalMissing.length > 0) {
    const parts = []
    if (missingMaterials.length > 0) {
      parts.push(`${missingMaterials.length} line(s) skipped — material lookup_code not found in MotherDuck for project ${cfg.project_id}: ${[...new Set(missingMaterials)].join(', ')}`)
    }
    if (finalMissing.length > 0) {
      parts.push(`${finalMissing.length} line(s) submitted but never persisted after ${MAX_BACKFILL_ROUNDS} backfill attempt(s): ${finalMissing.map((l) => l.code).join(', ')}`)
    }
    return { success: false, order_id, error: `Order ${order_id}: ${parts.join(' | ')}` }
  }

  return { success: true, order_id, line_count: resolvedLines.length }
}

module.exports = {
  FACILITIES,
  isConfigured,
  getSmartUpToken,
  getMaterialMap,
  getExistingLookupCodes,
  createAgencyOrder,
}
