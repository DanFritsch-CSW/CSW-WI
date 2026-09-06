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

  const result = await smartUpPost('/api/get_materials_by_project', { project_id })
  if (!result.ok) {
    throw new Error(`get_materials_by_project failed (${result.status}): ${result.text.slice(0, 300)}`)
  }

  const rows = Array.isArray(result.data) ? result.data : (result.data?.materials || result.data?.items || [])
  const map = new Map()
  for (const row of rows) {
    const code = row.lookup_code ?? row.LookupCode ?? row.material_lookup_code
    const id = row.material_id ?? row.MaterialId ?? row.id
    if (code != null && id != null) map.set(String(code).trim(), id)
  }
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
      material_id,
      expected_quantity: Number(line.quantity) || 0,
      packaging_id: cfg.packaging_id,
    })
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
