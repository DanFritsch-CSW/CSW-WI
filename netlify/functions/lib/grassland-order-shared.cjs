'use strict'

// Grassland outbound order agent — Netlify half. Rewritten 2026-10-13.
//
// Split from a single-runtime design after discovering scheduling_agent's
// real architecture: the Front/Claude-extraction side lives in a Supabase
// Edge Function (grassland-order-webhook, Deno) because that's where Front
// agent credentials and the HMAC webhook verification already live for
// every agent in this app. This file is the OTHER half — the part that
// needs real MotherDuck access, which a Deno Edge Function cannot provide
// (no native `duckdb` module there). The Edge Function writes a 'parsed'
// row to grassland_order_batches (raw_extracted = the full Claude output)
// and POSTs {batchId} here; resolveAndPushBatch reads that row, does the
// live Datex resolution, and either pushes the order or flags it.
//
// WHY THE RESOLUTION LOGIC BELOW IS NOT A SIMPLE LOOKUP — same three
// reasons as before, now proven against 4 real release forms and 7 real
// storage lots:
//   1. Grassland's "Item #" is not a stable material key — the same item #
//      exists as two different materials in two different Madison
//      projects (GRAFG1 "Cooler" vs GRALA1 "Frozen"). Project is resolved
//      per order via a majority-vote across the order's own storage lots
//      (voteOrderProject), never guessed from the item #.
//   2. The release form's "Pallet/Tote #" has no relationship to Datex's
//      real license-plate codes. The crosswalk (decodePalletNumber): take
//      the LP's LookupCode, drop its last digit, the remaining 3 digits
//      equal the release form's Pallet/Tote #.
//   3. create_outbound_order_line is a CONFIRMED UNRELIABLE Datex endpoint
//      (see dpi-monthly-shared.cjs) — silently drops lines under load.
//      Every push here writes to grassland_order_batches/_lines and MUST
//      be paired with a reconciliation job (not yet built) before being
//      trusted unattended.
//
// TODO-VERIFY: `lot_id`/`license_plate_id` on create_outbound_order_line
// are a best guess at Datex's snake_case convention, unconfirmed — no
// existing code in this repo has ever called that endpoint with lot/pallet
// data. Confirm against MotherDuck after the first real test push before
// trusting this unattended.
//
// Env: MOTHERDUCK_TOKEN, DATEX_SMARTUP_* (or generic DATEX_*) via
//      dpi-monthly-shared.cjs, SUPABASE_URL/KEY, GRASSLAND_INTERNAL_SECRET
//      (to call back into the grassland-order-reply Edge Function),
//      GRASSLAND_AGENT_ACTIVE=true to allow real Datex pushes (anything
//      else, including unset, stays dry-run).

const { getSmartUpToken, runMotherDuckQuery, isConfigured } = require('./dpi-monthly-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''
const GRASSLAND_INTERNAL_SECRET = process.env.GRASSLAND_INTERNAL_SECRET || ''
const GRASSLAND_REPLY_URL = 'https://ppsbqekabtbwsmvdiyga.supabase.co/functions/v1/grassland-order-reply'

const DATEX_SMARTUP_BASE_URL =
  process.env.DATEX_SMARTUP_BASE_URL || 'https://csw-smartup-api.wavelength.host'

// Confirmed-live constants (2026-10-13) — see Notion CSW-WI Architecture
// (no dedicated tab; tracked only here and in memory, same as the other
// Front agents) for the full derivation.
const MADISON_WAREHOUSE_ID = 4
const GRASSLAND_ORDER_CLASS_ID = 2 // "SO" Sales Order — same as DPI
const GRASSLAND_CARRIER_ID = 1618 // "GRASSLAND" — fixed on every sampled real order
const GRASSLAND_PACKAGING_ID = 3 // "CS" — confirmed for 1162/1163/1164/7105 across all 3 projects

const GRASSLAND_PROJECTS = {
  GRAFG1: { id: 181, name: 'Grassland WM - Cooler - CSW-Madison' },
  GRASM1: { id: 301, name: "Grassland Sam's - Cooler - CSW-Madison" },
  GRALA1: { id: 65, name: 'Grassland WM - Frozen - CSW-Madison' },
}
const GRASSLAND_PROJECT_IDS = Object.values(GRASSLAND_PROJECTS).map((p) => p.id)

function supabaseHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  }
}

async function sbPost(path, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: prefer || 'return=representation' }),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase insert ${path} -> ${res.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Supabase update ${path} -> ${res.status}: ${await res.text()}`)
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: supabaseHeaders() })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase get ${path} -> ${res.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

// Posts the final result back to Front via the Edge Function sibling —
// reuses the agent's own OAuth credentials (stored only in Supabase)
// without this Netlify function ever needing a copy of them.
async function postFrontComment(conversationId, body) {
  const res = await fetch(GRASSLAND_REPLY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-grassland-internal-secret': GRASSLAND_INTERNAL_SECRET },
    body: JSON.stringify({ conversationId, body }),
  })
  if (!res.ok) {
    console.error(`[grassland-order-resolve] reply post failed (${res.status}): ${await res.text().catch(() => '')}`)
  }
}

// ── SmartUp API client (thin — reuses dpi-monthly-shared.cjs's token cache) ─

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

// ── Live Datex resolution ───────────────────────────────────────────────────

// SUBSTR(code, -4, 3) cast to int. Confirmed against 7 real storage lots
// spanning 4 sample release forms with zero exceptions (2026-10-13).
function decodePalletNumber(lpLookupCode) {
  if (!lpLookupCode || lpLookupCode.length < 4) return null
  const threeDigits = lpLookupCode.slice(-4, -1)
  const n = parseInt(threeDigits, 10)
  return Number.isNaN(n) ? null : n
}

async function fetchLotCandidates(storageLots) {
  if (!storageLots.length) return new Map()
  const inList = storageLots.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')
  const rows = await runMotherDuckQuery(`
    SELECT lot.LookupCode AS storage_lot, lot.Id AS lot_id, lot.MaterialId AS material_id,
           m.LookupCode AS material_code, m.ProjectId AS project_id
    FROM bronze.datex_lots lot
    JOIN bronze.datex_materials m ON m.Id = lot.MaterialId
    WHERE lot.LookupCode IN (${inList})
      AND m.ProjectId IN (${GRASSLAND_PROJECT_IDS.join(',')})
  `)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.storage_lot)) map.set(r.storage_lot, [])
    map.get(r.storage_lot).push(r)
  }
  return map
}

function voteOrderProject(storageLots, candidatesByLot) {
  const votes = new Map()
  let votedLots = 0
  for (const sl of storageLots) {
    const candidates = candidatesByLot.get(sl) || []
    if (candidates.length === 1) {
      votedLots += 1
      const pid = candidates[0].project_id
      votes.set(pid, (votes.get(pid) || 0) + 1)
    }
  }
  if (votedLots === 0) return { projectId: null, conflict: false, noVotes: true }
  if (votes.size > 1) return { projectId: null, conflict: true, noVotes: false, votes: Object.fromEntries(votes) }
  const [projectId] = [...votes.keys()]
  const projectCode = Object.keys(GRASSLAND_PROJECTS).find((k) => GRASSLAND_PROJECTS[k].id === projectId)
  return { projectId, projectCode, conflict: false, noVotes: false }
}

async function fetchLicensePlatesForLot(lotId) {
  const rows = await runMotherDuckQuery(`
    SELECT lp.Id AS license_plate_id, lp.LookupCode AS lp_code, lpc.PackagedAmount AS amount
    FROM bronze.datex_licenseplatecontents lpc
    JOIN bronze.datex_licenseplates lp ON lp.Id = lpc.LicensePlateId
    WHERE lpc.LotId = ${Number(lotId)}
  `)
  const byPallet = new Map()
  for (const r of rows) {
    const n = decodePalletNumber(r.lp_code)
    if (n != null) byPallet.set(n, r)
  }
  return byPallet
}

async function resolveOrderLines(parsed) {
  const lines = parsed.lines || []
  const distinctStorageLots = [...new Set(lines.map((l) => l.storage_lot))]

  const candidatesByLot = await fetchLotCandidates(distinctStorageLots)
  const vote = voteOrderProject(distinctStorageLots, candidatesByLot)

  if (vote.noVotes) {
    return { ok: false, flagReason: 'No storage lot on this order resolved unambiguously to a Grassland project — needs manual lookup.' }
  }
  if (vote.conflict) {
    return { ok: false, flagReason: `Order's storage lots voted for more than one project (${JSON.stringify(vote.votes)}) — this should not occur; needs manual review.` }
  }

  const lpCacheByLotId = new Map()
  const resolvedLines = []
  const unresolvedStorageLots = []

  for (const line of lines) {
    const candidates = (candidatesByLot.get(line.storage_lot) || []).filter((c) => c.project_id === vote.projectId)
    if (candidates.length !== 1) {
      unresolvedStorageLots.push(line.storage_lot)
      resolvedLines.push({ ...line, line_status: 'ambiguous' })
      continue
    }
    const { lot_id, material_id, material_code } = candidates[0]
    if (!lpCacheByLotId.has(lot_id)) {
      lpCacheByLotId.set(lot_id, await fetchLicensePlatesForLot(lot_id))
    }
    const lp = lpCacheByLotId.get(lot_id).get(Number(line.pallet_tote_number))
    if (!lp) {
      resolvedLines.push({ ...line, line_status: 'missing_lp', resolved_lot_id: lot_id, resolved_material_id: material_id, resolved_material_code: material_code })
      continue
    }
    const amountMismatch = Number(lp.amount) !== Number(line.item_count)
    resolvedLines.push({
      ...line,
      line_status: 'resolved',
      resolved_lot_id: lot_id,
      resolved_material_id: material_id,
      resolved_material_code: material_code,
      resolved_license_plate_id: lp.license_plate_id,
      resolved_license_plate_code: lp.lp_code,
      amount_mismatch: amountMismatch,
    })
  }

  const anyUnresolved = resolvedLines.some((l) => l.line_status !== 'resolved')
  const anyAmountMismatch = resolvedLines.some((l) => l.amount_mismatch)

  if (anyUnresolved) {
    return {
      ok: false,
      projectCode: vote.projectCode,
      resolvedLines,
      flagReason: `Could not resolve every line to a specific license plate (storage lots: ${[...new Set(unresolvedStorageLots)].join(', ') || 'see line_status'}).`,
    }
  }
  if (anyAmountMismatch) {
    return {
      ok: false,
      projectCode: vote.projectCode,
      resolvedLines,
      flagReason: 'One or more lines: the PDF\u2019s item count does not match the quantity actually on the matched license plate in Datex.',
    }
  }

  return { ok: true, projectCode: vote.projectCode, projectId: vote.projectId, resolvedLines }
}

// ── Assemble + push the order ───────────────────────────────────────────────

function buildOrderHeader(parsed, projectId) {
  return {
    project_id: projectId,
    warehouse_id: MADISON_WAREHOUSE_ID,
    order_class_id: GRASSLAND_ORDER_CLASS_ID,
    lookup_code: null, // left blank: real GRAFG1 orders show pure Datex-sequential numbers
    owner_reference: null, // TODO-VERIFY: real orders show this mirroring lookup_code; confirm on first test push
    vendor_reference: (parsed.po_number || '').replace(/^0+/, ''), // best-guess transform (strip leading zero), unconfirmed
    carrier_id: GRASSLAND_CARRIER_ID,
    expected_date: parsed.ship_date || null,
    shipping_address: {
      name: parsed.released_to?.name || null,
      first_name: parsed.released_to?.name || null,
      line1: parsed.released_to?.line1 || null,
      city: parsed.released_to?.city || null,
      state: parsed.released_to?.state || null,
      postal_code: parsed.released_to?.zip || null,
      country: 'US',
    },
  }
}

async function pushGrasslandOrder(header, resolvedLines) {
  const orderResult = await smartUpPost('/api/create_outbound_order', {
    ...header,
    billing_address: header.shipping_address,
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
    return { success: false, order_id, error: `Order ${order_id} created but response had no shipment_id — cannot safely create lines.` }
  }

  const LINE_CREATE_DELAY_MS = 750
  let lineNumber = 0
  const lineResults = []
  for (const line of resolvedLines) {
    lineNumber += 1
    const lineResult = await smartUpPost('/api/create_outbound_order_line', {
      order_id,
      shipment_id,
      line_number: lineNumber,
      material_id: line.resolved_material_id,
      expected_quantity: line.item_count,
      actual_quantity: line.item_count,
      packaging_id: GRASSLAND_PACKAGING_ID,
      lot_id: line.resolved_lot_id, // TODO-VERIFY field name
      license_plate_id: line.resolved_license_plate_id, // TODO-VERIFY field name
    })
    lineResults.push({ line_number: lineNumber, ok: lineResult.ok, status: lineResult.status, raw: lineResult.text.slice(0, 500) })
    if (!lineResult.ok) {
      return { success: false, order_id, shipment_id, lineResults, error: `create_outbound_order_line failed at line ${lineNumber}: ${lineResult.text.slice(0, 300)}` }
    }
    if (lineNumber < resolvedLines.length) await new Promise((r) => setTimeout(r, LINE_CREATE_DELAY_MS))
  }

  return { success: true, order_id, shipment_id, lineResults }
}

async function insertLineRows(batchId, resolvedLines) {
  const rows = resolvedLines.map((l) => ({
    batch_id: batchId,
    storage_lot: l.storage_lot,
    sub_lot: l.sub_lot || null,
    pallet_tote_number: l.pallet_tote_number ?? null,
    grassland_lot: l.grassland_lot || null,
    item_number: l.item_number || null,
    item_count: l.item_count,
    weight: l.weight ?? null,
    resolved_material_id: l.resolved_material_id ?? null,
    resolved_material_code: l.resolved_material_code ?? null,
    resolved_lot_id: l.resolved_lot_id ?? null,
    resolved_license_plate_id: l.resolved_license_plate_id ?? null,
    resolved_license_plate_code: l.resolved_license_plate_code ?? null,
    amount_mismatch: !!l.amount_mismatch,
    line_status: l.line_status || 'pending',
  }))
  await sbPost('grassland_order_lines', rows, 'return=minimal')
}

// ── Top-level entry: called by grassland-order-resolve-background.cjs ──────
//
// Reads the 'parsed' batch row (written by the Edge Function, including
// raw_extracted), runs live resolution, pushes to Datex if `active`,
// updates the row, and posts the final comment back to Front.
async function resolveAndPushBatch(batchId) {
  const rows = await sbGet(`grassland_order_batches?id=eq.${batchId}&select=*&limit=1`)
  const batch = rows && rows[0]
  if (!batch) return { ok: false, error: `Batch ${batchId} not found` }
  if (batch.status !== 'parsed') return { ok: false, error: `Batch ${batchId} is not in 'parsed' status (currently '${batch.status}') — not re-processing` }

  const parsed = batch.raw_extracted
  const active = process.env.GRASSLAND_AGENT_ACTIVE === 'true'

  const resolution = await resolveOrderLines(parsed)
  if (resolution.resolvedLines) await insertLineRows(batch.id, resolution.resolvedLines)

  if (!resolution.ok) {
    await sbPatch(`grassland_order_batches?id=eq.${batch.id}`, {
      status: 'flagged',
      resolved_project_code: resolution.projectCode || null,
      flag_reason: resolution.flagReason,
    })
    await postFrontComment(
      batch.front_conversation_id,
      `Grassland order agent: could not safely resolve this order against current Datex inventory — flagged for manual entry.\nReason: ${resolution.flagReason}`
    )
    return { ok: false, batchId: batch.id, flagReason: resolution.flagReason }
  }

  if (!active) {
    await sbPatch(`grassland_order_batches?id=eq.${batch.id}`, {
      status: 'dry_run_resolved',
      resolved_project_code: resolution.projectCode,
    })
    await postFrontComment(
      batch.front_conversation_id,
      `Grassland order agent (dry run): resolved cleanly against current Datex inventory.\nProject: ${resolution.projectCode}, ${resolution.resolvedLines.length} line(s). No order was created — review batch ${batch.id} before enabling real pushes.`
    )
    return { ok: true, dryRun: true, batchId: batch.id }
  }

  if (!isConfigured()) {
    await sbPatch(`grassland_order_batches?id=eq.${batch.id}`, { status: 'failed', error_message: 'Datex SmartUp credentials not configured.' })
    await postFrontComment(batch.front_conversation_id, 'Grassland order agent: Datex SmartUp credentials not configured — order was not created.')
    return { ok: false, batchId: batch.id, error: 'Datex SmartUp credentials not configured.' }
  }

  const header = buildOrderHeader(parsed, resolution.projectId)
  const pushResult = await pushGrasslandOrder(header, resolution.resolvedLines)

  await sbPatch(`grassland_order_batches?id=eq.${batch.id}`, {
    status: pushResult.success ? 'pushed' : 'failed',
    resolved_project_code: resolution.projectCode,
    datex_order_id: pushResult.order_id ?? null,
    shipment_id: pushResult.shipment_id ?? null,
    error_message: pushResult.error ?? null,
  })

  await postFrontComment(
    batch.front_conversation_id,
    pushResult.success
      ? `Grassland order agent: order ${pushResult.order_id} created in Datex (batch ${batch.id}). Reconciliation will verify line-level accuracy shortly.`
      : `Grassland order agent: order creation failed. ${pushResult.error}\n(Tracked as batch ${batch.id} — check grassland_order_batches.)`
  )

  return { ok: pushResult.success, batchId: batch.id, orderId: pushResult.order_id, error: pushResult.error }
}

module.exports = {
  resolveOrderLines,
  decodePalletNumber,
  buildOrderHeader,
  pushGrasslandOrder,
  resolveAndPushBatch,
  GRASSLAND_PROJECTS,
}
