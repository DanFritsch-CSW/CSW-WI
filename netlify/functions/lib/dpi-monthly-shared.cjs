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

// ── Material resolution — fetched live per project, not hardcoded ──────────
// Unlike JDF/Pretzilla/McCain (35-200 SKUs, hardcoded maps), DPI runs the
// full state catalog (~700+ codes) — a hardcoded map isn't practical.
// Cached per-invocation (module-level Map), refreshed every cold start.

const _materialCache = new Map() // project_id -> Map(lookup_code -> material_id)

async function getMaterialMap(project_id) {
  if (_materialCache.has(project_id)) return _materialCache.get(project_id)

  // 2026-09-18 finding: a real test order only got 8 of 25 expected lines
  // created. Checked MotherDuck directly — all 25 material codes exist
  // under project_id 122 in Datex's own catalog, so this isn't a data gap.
  // The prior version of this function called get_materials_by_project with
  // no size/page parameter at all and just used whatever came back in one
  // response — almost certainly hitting a server-side default page size and
  // silently truncating DPI's ~700+ SKU catalog. Paginating here using the
  // most likely parameter name conventions; capped at 20 pages (2,000
  // materials at page_size 100) as a safety net in case the real parameter
  // names differ and every "page" just returns the same first page.
  const map = new Map()
  const PAGE_SIZE = 100
  const MAX_PAGES = 20
  let previousPageCodes = null

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await smartUpPost('/api/get_materials_by_project', {
      project_id,
      page,
      page_size: PAGE_SIZE,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
    if (!result.ok) {
      throw new Error(`get_materials_by_project failed (${result.status}): ${result.text.slice(0, 300)}`)
    }

    const rows = Array.isArray(result.data) ? result.data : (result.data?.materials || result.data?.items || [])
    if (rows.length === 0) break // no more data

    const pageCodes = []
    for (const row of rows) {
      const code = row.lookup_code ?? row.LookupCode ?? row.material_lookup_code
      const id = row.material_id ?? row.MaterialId ?? row.id
      if (code != null && id != null) {
        map.set(String(code).trim(), id)
        pageCodes.push(String(code).trim())
      }
    }

    // Safety valve: if our guessed pagination params aren't respected at
    // all, every "page" will return the identical row set — detect that
    // and stop rather than looping MAX_PAGES times for nothing.
    const pageCodesKey = pageCodes.join(',')
    if (previousPageCodes === pageCodesKey) {
      console.error(`[dpi-monthly-shared] get_materials_by_project page ${page} identical to previous page — pagination params likely not respected by this API, stopping.`)
      break
    }
    previousPageCodes = pageCodesKey

    if (rows.length < PAGE_SIZE) break // last page (short page = end of data)
  }

  console.error(`[dpi-monthly-shared] getMaterialMap(${project_id}) resolved ${map.size} materials total.`)
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

  // Real historical orders (confirmed via MotherDuck 2026-09-05) show every
  // line sharing one shipment_id under the order — create_outbound_order_line's
  // own schema has a shipment_id field we were never populating.
  //
  // This field name is trying the likely candidates. If none match, this
  // fails loudly with the raw response body rather than silently proceeding
  // — the whole point of the Phase 1 push_failed banner (see
  // DpiMonthlyProcess.jsx, 2026-09-18) is that a failure here must be
  // visible, not swallowed.
  const shipment_id = orderResult.data?.shipment_id ?? orderResult.data?.ShipmentId ?? orderResult.data?.shipment?.id ?? null
  if (shipment_id == null) {
    return {
      success: false,
      order_id,
      error: `Order ${order_id} created but response had no recognizable shipment_id field — cannot safely create lines without it (would repeat the "order created, 0 lines" bug). Raw response: ${JSON.stringify(orderResult.data)}`,
    }
  }

  // 2026-09-18 investigation: order + shipment_id both confirmed correct
  // (order creates cleanly, shipment_id resolves and matches the same field
  // name a proven working ASN integration uses), yet every
  // create_outbound_order_line call returned HTTP success while ZERO rows
  // persisted in Datex (confirmed via direct MotherDuck query AND the live
  // FootPrint UI showing "0 items"). Compared against a browser network
  // capture of Datex's own UI creating a line manually: that internal call
  // (a different, session-authenticated endpoint we can't reach from a
  // service integration) sends `packagedAmount`, not `expectedAmount`.
  // Cross-referencing real historical order lines pulled from MotherDuck
  // weeks earlier: `expected_package_amount` was NULL on every real line,
  // while `packaged_amount` held the actual quantity. Both signals point
  // the same direction — Datex's outbound fulfillment model tracks the
  // "actual/packaged" quantity as the real value, not "expected". Adding
  // `actual_quantity` alongside `expected_quantity` on this theory.
  const missingMaterials = []
  for (const line of agency.lines) {
    const code = String(line.materialLookupCode || '').trim()
    const material_id = materialMap.get(code)
    if (material_id == null) {
      missingMaterials.push(code)
      continue // don't call create_outbound_order_line with a null material_id
    }
    const lineResult = await smartUpPost('/api/create_outbound_order_line', {
      order_id,
      shipment_id,
      material_id,
      expected_quantity: Number(line.quantity) || 0,
      actual_quantity: Number(line.quantity) || 0,
      packaging_id: cfg.packaging_id,
    })
    // Log the raw response even on HTTP success — the API can return 200
    // without actually persisting a line (confirmed 2026-09-18: order and
    // every line-create call succeeded, but zero rows existed in Datex).
    // If this attempt still doesn't work, Netlify function logs will show
    // exactly what Datex sent back instead of another blind guess.
    console.error(`[dpi-monthly-shared] create_outbound_order_line response for material ${code}: ${lineResult.text.slice(0, 500)}`)
    if (!lineResult.ok) {
      return {
        success: false,
        order_id,
        error: `create_outbound_order_line failed for material ${code} (${lineResult.status}): ${lineResult.text.slice(0, 300)}`,
      }
    }
  }

  if (missingMaterials.length > 0) {
    return {
      success: false,
      order_id,
      error: `Order created but ${missingMaterials.length} line(s) skipped — material lookup_code not found in project ${cfg.project_id}: ${[...new Set(missingMaterials)].join(', ')}`,
    }
  }

  return { success: true, order_id, line_count: agency.lines.length }
}

module.exports = {
  FACILITIES,
  isConfigured,
  getSmartUpToken,
  getMaterialMap,
  getExistingLookupCodes,
  createAgencyOrder,
}
