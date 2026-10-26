'use strict'

// Order agent — common helpers shared across every customer adapter.
// Added 2026-10-13 when the agent expanded from Grassland-only to a
// multi-customer design (Grassland + Richelieu, more to follow). This file
// holds everything that is the SAME regardless of which customer an order
// belongs to: Supabase CRUD against order_agent_batches/_lines (renamed
// 2026-10-24 from order_agent_batches/_lines as part of clearing the
// "Known naming debt" flagged in the Notion Architecture doc — the tables
// have been fully generic, customer_code and all, since 2026-10-13; only
// the name still said Grassland), the Front reply call, the
// SmartUp API client, and pushOrderGeneric — the actual
// create_outbound_order + create_outbound_order_line loop, which is
// IDENTICAL in mechanics across customers (same two endpoints, same
// 750ms-between-lines pacing around the confirmed-unreliable line-create
// call) even though each customer's header fields and line fields differ.
// Each adapter supplies its own resolveOrderLines, buildOrderHeader, and
// buildLinePayload; this file supplies the plumbing that calls them.

const { getSmartUpToken, runMotherDuckQuery, isConfigured } = require('./dpi-monthly-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''
// ORDER_AGENT_INTERNAL_SECRET: renamed 2026-10-24 from GRASSLAND_INTERNAL_SECRET
// (same value, swapped on both Netlify and Supabase in the same change — see
// Known naming debt cleanup, Notion Architecture doc).
//
// FIXED 2026-10-26 (real failure, Echo Lake order 438995 — the order
// actually pushed to Datex successfully, but no confirmation ever reached
// Front): this constant used to read ONLY process.env.ORDER_AGENT_INTERNAL_SECRET,
// with no fallback — unlike the inbound check in
// order-agent-resolve-background.cjs, which already falls back to
// GRASSLAND_INTERNAL_SECRET. ORDER_AGENT_INTERNAL_SECRET was never actually
// set as a Netlify env var (only the old GRASSLAND_INTERNAL_SECRET is), so
// this was always ''. Every call postFrontComment made to order-agent-reply
// sent an empty secret header, which that function's own auth check
// rejects outright (`if (!got || ...)`) — so EVERY reply since the
// 2026-10-24 rename (success or failure) has been silently 401'ing,
// visible only in Netlify's own function logs, never in Front. Added the
// same fallback used everywhere else in this pipeline so this stops being
// a silent single point of failure.
const ORDER_AGENT_INTERNAL_SECRET = process.env.ORDER_AGENT_INTERNAL_SECRET || process.env.GRASSLAND_INTERNAL_SECRET || ''
// order-agent-reply: renamed 2026-10-24 from grassland-order-reply (fresh
// Supabase slug deployed with identical logic, only this constant needed to
// change since nothing outside this codebase calls that URL directly).
const ORDER_AGENT_REPLY_URL = 'https://ppsbqekabtbwsmvdiyga.supabase.co/functions/v1/order-agent-reply'

const DATEX_SMARTUP_BASE_URL =
  process.env.DATEX_SMARTUP_BASE_URL || 'https://csw-smartup-api.wavelength.host'

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
  const res = await fetch(ORDER_AGENT_REPLY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-order-agent-internal-secret': ORDER_AGENT_INTERNAL_SECRET },
    body: JSON.stringify({ conversationId, body }),
  })
  if (!res.ok) {
    console.error(`[order-agent-resolve] reply post failed (${res.status}): ${await res.text().catch(() => '')}`)
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

// ── Generic order + lines push — same for every customer ───────────────────
//
// buildLinePayload(line, ctx) is supplied by the adapter: ctx carries
// {order_id, shipment_id, line_number}; the adapter returns the exact body
// for that one create_outbound_order_line call (field names/shape differ
// per customer — e.g. Grassland has no vendor_lot_id concept it populates,
// Richelieu always does).
async function pushOrderGeneric(header, resolvedLines, buildLinePayload) {
  const orderResult = await smartUpPost('/api/create_outbound_order', {
    ...header,
    billing_address: header.billing_address || header.shipping_address,
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
    const payload = buildLinePayload(line, { order_id, shipment_id, line_number: lineNumber })
    const lineResult = await smartUpPost('/api/create_outbound_order_line', payload)
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
    storage_lot: l.storage_lot || l.lot_code || null,
    sub_lot: l.sub_lot || null,
    pallet_tote_number: l.pallet_tote_number ?? null,
    grassland_lot: l.grassland_lot || null,
    item_number: l.item_number || null,
    item_count: l.item_count ?? l.quantity ?? null,
    weight: l.weight ?? null,
    resolved_material_id: l.resolved_material_id ?? null,
    resolved_material_code: l.resolved_material_code ?? null,
    resolved_lot_id: l.resolved_lot_id ?? null,
    resolved_vendor_lot_id: l.resolved_vendor_lot_id ?? null,
    resolved_packaging_id: l.resolved_packaging_id ?? null,
    resolved_license_plate_id: l.resolved_license_plate_id ?? null,
    resolved_license_plate_code: l.resolved_license_plate_code ?? null,
    amount_mismatch: !!l.amount_mismatch,
    line_status: l.line_status || 'pending',
  }))
  await sbPost('order_agent_lines', rows, 'return=minimal')
}

// ── Top-level entry: called by order-agent-resolve-background.cjs ──────────
//
// Reads the 'parsed' batch row (written by the Edge Function, including
// raw_extracted and customer_code), looks up that customer's adapter,
// runs live resolution, pushes to Datex if active, updates the row, and
// posts the final comment back to Front.
async function resolveAndPushBatch(batchId) {
  const rows = await sbGet(`order_agent_batches?id=eq.${batchId}&select=*&limit=1`)
  const batch = rows && rows[0]
  if (!batch) return { ok: false, error: `Batch ${batchId} not found` }
  if (batch.status !== 'parsed') return { ok: false, error: `Batch ${batchId} is not in 'parsed' status (currently '${batch.status}') — not re-processing` }

  const adapter = ADAPTERS[batch.customer_code]
  if (!adapter) {
    await sbPatch(`order_agent_batches?id=eq.${batch.id}`, { status: 'failed', error_message: `No adapter registered for customer_code '${batch.customer_code}'.` })
    await postFrontComment(batch.front_conversation_id, `Order agent: no adapter is registered for customer '${batch.customer_code}' — this needs code support before it can be processed.`)
    return { ok: false, batchId: batch.id, error: 'unknown customer_code' }
  }

  const parsed = batch.raw_extracted
  // Defaults to active (real Datex pushes) unless explicitly disabled —
  // see adapters/grassland.cjs header note for why this isn't `=== 'true'`.
  const active = process.env.ORDER_AGENT_ACTIVE !== 'false'

  const resolution = await adapter.resolveOrderLines(parsed)
  if (resolution.resolvedLines && resolution.resolvedLines.length) await insertLineRows(batch.id, resolution.resolvedLines)

  if (!resolution.ok) {
    await sbPatch(`order_agent_batches?id=eq.${batch.id}`, {
      status: 'flagged',
      resolved_project_code: resolution.projectCode || null,
      flag_reason: resolution.flagReason,
    })
    await postFrontComment(
      batch.front_conversation_id,
      `Order agent: could not safely resolve this order against current Datex inventory — flagged for manual entry.\nReason: ${resolution.flagReason}`
    )
    return { ok: false, batchId: batch.id, flagReason: resolution.flagReason }
  }

  if (!active) {
    await sbPatch(`order_agent_batches?id=eq.${batch.id}`, {
      status: 'dry_run_resolved',
      resolved_project_code: resolution.projectCode,
    })
    await postFrontComment(
      batch.front_conversation_id,
      `Order agent (dry run): resolved cleanly against current Datex inventory.\n${resolution.projectCode ? `Project: ${resolution.projectCode}, ` : ''}${resolution.headerOnly ? 'header only (no lines)' : `${resolution.resolvedLines.length} line(s)`}. No order was created — review batch ${batch.id} before enabling real pushes.`
    )
    return { ok: true, dryRun: true, batchId: batch.id }
  }

  if (!isConfigured()) {
    await sbPatch(`order_agent_batches?id=eq.${batch.id}`, { status: 'failed', error_message: 'Datex SmartUp credentials not configured.' })
    await postFrontComment(batch.front_conversation_id, 'Order agent: Datex SmartUp credentials not configured — order was not created.')
    return { ok: false, batchId: batch.id, error: 'Datex SmartUp credentials not configured.' }
  }

  const header = adapter.buildOrderHeader(parsed, resolution)
  const pushResult = await pushOrderGeneric(header, resolution.resolvedLines, adapter.buildLinePayload)

  await sbPatch(`order_agent_batches?id=eq.${batch.id}`, {
    status: pushResult.success ? 'pushed' : 'failed',
    resolved_project_code: resolution.projectCode,
    datex_order_id: pushResult.order_id ?? null,
    shipment_id: pushResult.shipment_id ?? null,
    error_message: pushResult.error ?? null,
  })

  // ADDED 2026-10-16: an adapter can return `resolution.warnings` — a list
  // of non-blocking issues worth a human's attention (e.g. Richelieu's
  // inventory-availability shortfall) that should NOT have stopped the
  // push. Appended to the success comment only; a failed push's own error
  // message is detailed enough on its own.
  const warningsBlock = pushResult.success && resolution.warnings?.length
    ? `\n\n⚠️ ${resolution.warnings.join('\n⚠️ ')}`
    : ''

  await postFrontComment(
    batch.front_conversation_id,
    pushResult.success
      ? `Order agent: order ${pushResult.order_id} created in Datex (batch ${batch.id}). ${resolution.successNote || 'Reconciliation will verify line-level accuracy shortly.'}${warningsBlock}`
      : `Order agent: order creation failed. ${pushResult.error}\n(Tracked as batch ${batch.id} — check order_agent_batches.)`
  )

  return { ok: pushResult.success, batchId: batch.id, orderId: pushResult.order_id, error: pushResult.error }
}

// Last-resort safety net (added 2026-10-13, real stall: a batch sat at
// 'parsed' with zero Front-visible signal). Looks the batch back up purely
// to get its conversation id, marks it 'failed', and posts the given
// message — used only from the outer catch in
// order-agent-resolve-background.cjs when something throws before any of
// resolveAndPushBatch's own (normal) comment paths get a chance to run.
async function postFailureComment(batchId, message) {
  const rows = await sbGet(`order_agent_batches?id=eq.${batchId}&select=front_conversation_id&limit=1`)
  const batch = rows && rows[0]
  if (!batch) return
  await sbPatch(`order_agent_batches?id=eq.${batchId}`, { status: 'failed', error_message: message.slice(0, 1000) }).catch(() => {})
  await postFrontComment(batch.front_conversation_id, message)
}

// FIXED 2026-10-13 (real failure, first Richelieu test: "runMotherDuckQuery
// is not a function" on every batch): this used to require the adapters
// BEFORE assigning module.exports, with a comment claiming that was safe
// "as long as the adapters only use the common exports inside their
// functions" — that reasoning was wrong. This is a circular require
// (adapters require this file back for sbGet/runMotherDuckQuery/etc), and
// Node resolves a circular require to whatever module.exports IS at that
// exact moment, not whatever it will eventually become. Requiring the
// adapters first meant their own `const { runMotherDuckQuery } =
// require(...)` destructured properties off Node's default empty exports
// object, long before this file's real module.exports existed — breaking
// every call to runMotherDuckQuery in every adapter, Grassland included
// (Grassland's own batches would have hit this exact same error the next
// time one ran; Richelieu's test just happened to be first). Assigning
// module.exports FIRST, then requiring the adapters afterward, means the
// object they receive via their circular require already has every real
// function attached.
let ADAPTERS = {}

module.exports = {
  sbGet,
  sbPost,
  sbPatch,
  postFrontComment,
  smartUpPost,
  runMotherDuckQuery,
  isConfigured,
  pushOrderGeneric,
  insertLineRows,
  resolveAndPushBatch,
  postFailureComment,
  get ADAPTERS() { return ADAPTERS },
}

ADAPTERS = {
  grassland: require('./adapters/grassland.cjs'),
  richelieu: require('./adapters/richelieu.cjs'),
  pedone: require('./adapters/pedone.cjs'),
  thomasfoods: require('./adapters/thomasfoods.cjs'),
  echolake: require('./adapters/echolake.cjs'),
  mccain: require('./adapters/mccain.cjs'),
}
