'use strict'

// Grassland outbound order agent — shared core. Added 2026-10-13.
//
// Turns a Grassland Dairy "Release Form" PDF attachment (emailed to the
// Madison Appointments/Customer inbox) into a real Datex SmartUp outbound
// order, line by line, with every quantity and pallet assignment validated
// against live Datex data before anything is pushed.
//
// WHY THIS IS NOT A SIMPLE PDF->JSON->PUSH PIPELINE:
//   1. Grassland's "Item #" is not a stable material key — the exact same
//      item # exists as TWO different materials in two different Madison
//      projects (GRAFG1 "Cooler" vs GRALA1 "Frozen"; confirmed collision on
//      storage lot 162802A, which exists as two separate real lot rows).
//      Project is resolved per order via a majority-vote across the
//      order's own storage lots (see resolveOrderProject below), not
//      guessed from the item #.
//   2. The release form's "Pallet/Tote #" (e.g. 21-36) is Grassland's own
//      paperwork numbering — it has NO relationship to Datex's real
//      license-plate codes (20-digit SSCC-style strings). The only
//      reliable crosswalk found (validated against 7 real storage lots,
//      zero exceptions): take the LP's LookupCode, drop its last digit
//      (checksum/random), and the remaining 3 digits equal the release
//      form's Pallet/Tote #. See decodePalletNumber().
//   3. create_outbound_order_line is a CONFIRMED UNRELIABLE Datex endpoint
//      (see dpi-monthly-shared.cjs) — it silently drops a meaningful
//      fraction of lines under load with zero distinguishing signal in the
//      response. This is why every push here writes to
//      grassland_order_batches/grassland_order_lines and MUST be paired
//      with the reconciliation job (grassland-reconciliation-shared.cjs,
//      not yet built) before being trusted unattended.
//
// TODO-VERIFY (flagged, not guessed-and-shipped): `create_outbound_order_line`
// has only ever been called by this codebase with plain material+quantity
// (DPI has no lot/pallet concept). The field names below for pinning a line
// to a specific lot and license plate (`lot_id`, `license_plate_id`) follow
// Datex's own snake_case convention seen on every other call in this file,
// but are UNCONFIRMED against the real API. Do not flip ACTIVE to true for
// any real batch until one test order has been pushed and checked against
// MotherDuck (does the line's LotId/LicensePlateId match what was sent?).
//
// Env: ANTHROPIC_API_KEY (PDF read), MOTHERDUCK_TOKEN, DATEX_SMARTUP_* (or
//      generic DATEX_*) via dpi-monthly-shared.cjs, SUPABASE_URL/KEY.

const { getSmartUpToken, runMotherDuckQuery, isConfigured } = require('./dpi-monthly-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const CLAUDE_MODEL = 'claude-sonnet-4-5' // same model lens-shared.cjs uses

const DATEX_SMARTUP_BASE_URL =
  process.env.DATEX_SMARTUP_BASE_URL || 'https://csw-smartup-api.wavelength.host'

// ── Confirmed-live constants (2026-10-13) ───────────────────────────────────
// Project IDs per MotherDuck bronze.datex_projects; carrier + packaging per
// 10 real historical GRAFG1 sales orders and the materialspackagingslookup
// join (packaging_id=3 confirmed for every Grassland material checked —
// same constant DPI uses for "CS"). Owner/warehouse not required in the
// create_outbound_order payload (same shape as dpi-monthly-shared.cjs's
// createAgencyOrder — Datex derives owner from project_id server-side).
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

// ── Step 1: read the PDF ────────────────────────────────────────────────────
// Deterministic table parsing was the first choice (to avoid repeating the
// Polaris LP-fabrication failure), but this repo has no installed PDF-table
// library (pdf-lib is generation-only) and the established pattern for this
// exact class of problem elsewhere in this codebase (Bernatello's DSD/
// scorecard automation) is Claude vision. The difference from Polaris: here
// NOTHING the model reads is trusted directly — every storage lot, pallet
// number, and quantity gets cross-checked against the PDF's own printed
// subtotals (this function) AND against live Datex data (resolveOrderLines
// below) before a single order line is built. A misread fails closed
// (flagged for a human), it never silently produces a wrong order.

const EXTRACTION_SYSTEM_PROMPT = `You read a Grassland Dairy Products "Release Form" PDF (a cold-storage outbound release instruction) and return ONLY a JSON object — no prose, no markdown fences.

Shape:
{
  "po_number": string,            // "PO #:" value, digits only (keep leading zeros as printed)
  "release_site": string,         // e.g. "MAD"
  "ship_date": string,            // "Ship Date:" as printed, e.g. "10/16/2026"
  "released_to": {
    "name": string,               // first line under "RELEASED TO:"
    "line1": string,
    "city": string,
    "state": string,
    "zip": string
  },
  "lines": [
    {
      "storage_lot": string,      // "STORAGE LOT:" value for this block
      "grassland_lot": string,    // "GRASSLAND LOT:" value for this block
      "sub_lot": string,
      "pallet_tote_number": number,
      "item_number": string,
      "item_count": number,
      "weight": number
    }
  ],
  "storage_lot_totals": [ { "storage_lot": string, "item_count": number, "weight": number } ],
  "grand_total": { "pallet_count": number, "item_count": number, "weight": number }
}

Rules:
- One entry in "lines" per table row in the PDF, in the order printed.
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value that is not visible on the page.
- "storage_lot_totals" must include every "STORAGE LOT: X TOTALS" line in the document.
- "grand_total" comes from the "RELEASE SITE: ... TOTALS" line (pallet_count is the "PALLET COUNT:" value).
- If the document has multiple pages, include every page's lines in one combined "lines" array.
- If any field is illegible or absent, use null for that field rather than guessing.`

async function extractReleaseForm(pdfBase64) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: 'Extract this release form as the JSON object described in your instructions.' },
          ],
        },
      ],
    }),
  })
  const raw = await res.text()
  let data
  try { data = JSON.parse(raw) } catch { throw new Error(`Claude API returned non-JSON: ${raw.slice(0, 300)}`) }
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data).slice(0, 500)}`)
  const block = (data.content || []).find((b) => b.type === 'text')
  if (!block) throw new Error('Claude API returned no text block')
  let parsed
  try {
    parsed = JSON.parse(block.text.trim())
  } catch {
    throw new Error(`Model output was not valid JSON: ${block.text.slice(0, 300)}`)
  }
  return parsed
}

// ── Step 2: validate extracted lines against the document's own totals ─────
// Deterministic arithmetic check — catches a misread line before it ever
// reaches Datex resolution. This is the guardrail Polaris never had.

function validateAgainstPrintedTotals(parsed) {
  const problems = []
  const lines = parsed.lines || []

  const bySL = new Map()
  for (const l of lines) {
    const key = l.storage_lot
    if (!bySL.has(key)) bySL.set(key, { item_count: 0, weight: 0 })
    const agg = bySL.get(key)
    agg.item_count += Number(l.item_count) || 0
    agg.weight += Number(l.weight) || 0
  }

  for (const printed of parsed.storage_lot_totals || []) {
    const actual = bySL.get(printed.storage_lot)
    if (!actual) {
      problems.push(`Storage lot ${printed.storage_lot} has a printed total but no extracted lines`)
      continue
    }
    if (actual.item_count !== Number(printed.item_count)) {
      problems.push(
        `Storage lot ${printed.storage_lot}: extracted item count ${actual.item_count} != printed total ${printed.item_count}`
      )
    }
  }

  const grand = parsed.grand_total || {}
  const sumItemCount = lines.reduce((s, l) => s + (Number(l.item_count) || 0), 0)
  const sumPallets = lines.length
  if (grand.item_count != null && sumItemCount !== Number(grand.item_count)) {
    problems.push(`Sum of extracted item counts ${sumItemCount} != printed grand total ${grand.item_count}`)
  }
  if (grand.pallet_count != null && sumPallets !== Number(grand.pallet_count)) {
    problems.push(`Number of extracted pallet lines ${sumPallets} != printed PALLET COUNT ${grand.pallet_count}`)
  }

  return { ok: problems.length === 0, problems }
}

// ── Step 3: resolve each line against live Datex data ───────────────────────

// SUBSTR(code, -4, 3) cast to int. Confirmed against 7 real storage lots
// spanning 4 sample release forms with zero exceptions (2026-10-13).
function decodePalletNumber(lpLookupCode) {
  if (!lpLookupCode || lpLookupCode.length < 4) return null
  const threeDigits = lpLookupCode.slice(-4, -1)
  const n = parseInt(threeDigits, 10)
  return Number.isNaN(n) ? null : n
}

// For a set of distinct storage lot codes, returns every (project, material,
// lot_id) candidate row in any of the 3 Grassland Madison projects. A
// storage lot code is NOT guaranteed unique across projects (confirmed
// collision: 162802A exists in both GRAFG1 and GRALA1).
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

// Votes a single project for the whole order from storage lots that
// resolve unambiguously (exactly one candidate project). Returns
// { projectId, projectCode, conflict, noVotes } — caller must flag the
// order for human review on conflict or noVotes rather than guess.
function voteOrderProject(storageLots, candidatesByLot) {
  const votes = new Map() // project_id -> count
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

// For one resolved lot_id, fetches every on-hand LP in that lot and
// decodes each one's pallet number, so individual lines can be matched by
// (storage_lot, pallet_tote_number) -> license_plate_id.
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

// Resolves every line in a parsed release form against Datex. Returns
// { ok, projectCode, resolvedLines, flagReason } — resolvedLines entries
// carry material_id/lot_id/license_plate_id plus an amount_mismatch flag
// when the PDF's item_count doesn't match what's actually on that LP.
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

  // For each distinct storage lot that genuinely resolves under the voted
  // project, fetch its LPs once (cache by lot_id since a lot can be
  // referenced by multiple PDF lines).
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

// ── Step 4: assemble + push the order ───────────────────────────────────────

function buildOrderHeader(parsed, projectId) {
  return {
    project_id: projectId,
    warehouse_id: MADISON_WAREHOUSE_ID,
    order_class_id: GRASSLAND_ORDER_CLASS_ID,
    lookup_code: null, // left blank: real GRAFG1 orders show pure Datex-sequential numbers, not a caller-supplied code (unlike DPI, which assigns its own)
    owner_reference: null, // TODO-VERIFY: real orders show this mirroring lookup_code exactly; unclear whether that's a Datex server-side default when both are omitted, or something this code needs to set after the fact. Confirm on first test push.
    vendor_reference: (parsed.po_number || '').replace(/^0+/, ''), // best-guess transform (strip leading zero); confirm against a real pushed order before trusting for reconciliation matching
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
    billing_address: header.shipping_address, // mirrors DPI's confirmed pattern for this field pairing
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

  // Same defensive pattern as dpi-monthly-shared.cjs's submitLines: explicit
  // sequential line_number, a delay between calls (the drop-prone endpoint
  // this hits is the exact same one DPI fights), never Promise.all.
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

// ── Supabase tracking ────────────────────────────────────────────────────────

async function createBatchRow({ conversationId, parsed, projectCode, flagReason, active }) {
  const totalQty = (parsed.lines || []).reduce((s, l) => s + (Number(l.item_count) || 0), 0)
  const rows = await sbPost('grassland_order_batches', {
    front_conversation_id: conversationId,
    po_number: parsed.po_number,
    release_site: parsed.release_site || null,
    ship_date: parsed.ship_date ? new Date(parsed.ship_date).toISOString().slice(0, 10) : null,
    resolved_project_code: projectCode || null,
    status: flagReason ? 'flagged' : 'parsed',
    flag_reason: flagReason || null,
    line_count: (parsed.lines || []).length,
    total_quantity: totalQty,
    pallet_count: parsed.grand_total?.pallet_count ?? (parsed.lines || []).length,
    active: !!active,
  })
  return rows[0]
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

async function findExistingBatch(poNumber) {
  const rows = await sbGet(`grassland_order_batches?po_number=eq.${encodeURIComponent(poNumber)}&select=id,status,po_number&limit=1`)
  return rows && rows[0]
}

// ── Top-level orchestration ──────────────────────────────────────────────────
//
// `active` is the phased-rollout gate (same convention as every other
// settings-gated feature in this app): when false, this still does the
// full parse + validate + resolve pipeline and writes the batch/line rows
// (status 'parsed', never 'pushed') so the result can be reviewed, but
// makes NO real Datex write. Flip a batch's `active` (or the global
// setting this wires to) once the schema TODOs above are confirmed.
async function processGrasslandReleaseForm({ conversationId, pdfBase64, active }) {
  // Real dedupe happens below, once the PO number is actually known from
  // extraction — there's no cheaper way to get it first, since the PO
  // number only exists inside the PDF itself.
  let parsed
  try {
    parsed = await extractReleaseForm(pdfBase64)
  } catch (e) {
    return { ok: false, stage: 'extract', error: e.message }
  }

  if (!parsed.po_number || !Array.isArray(parsed.lines) || parsed.lines.length === 0) {
    return { ok: false, stage: 'extract', error: 'Extraction returned no PO number or no lines — likely not a release form, or an unreadable page.' }
  }

  const dup = await findExistingBatch(parsed.po_number).catch(() => null)
  if (dup) {
    return { ok: false, stage: 'dedupe', error: `PO ${parsed.po_number} already has a batch (id ${dup.id}, status ${dup.status}) — not processing again.` }
  }

  const totalsCheck = validateAgainstPrintedTotals(parsed)
  if (!totalsCheck.ok) {
    const batch = await createBatchRow({ conversationId, parsed, flagReason: `Printed-total validation failed: ${totalsCheck.problems.join('; ')}`, active: false })
    return { ok: false, stage: 'validate_totals', batchId: batch.id, problems: totalsCheck.problems }
  }

  const resolution = await resolveOrderLines(parsed)
  const batch = await createBatchRow({
    conversationId,
    parsed,
    projectCode: resolution.projectCode,
    flagReason: resolution.ok ? null : resolution.flagReason,
    active: resolution.ok && active,
  })
  if (resolution.resolvedLines) await insertLineRows(batch.id, resolution.resolvedLines)

  if (!resolution.ok) {
    return { ok: false, stage: 'resolve', batchId: batch.id, flagReason: resolution.flagReason }
  }

  if (!active) {
    return { ok: true, dryRun: true, batchId: batch.id, projectCode: resolution.projectCode, lineCount: resolution.resolvedLines.length }
  }

  if (!isConfigured()) {
    await sbPatch(`grassland_order_batches?id=eq.${batch.id}`, { status: 'failed', error_message: 'Datex SmartUp credentials not configured.' })
    return { ok: false, stage: 'push', batchId: batch.id, error: 'Datex SmartUp credentials not configured.' }
  }

  const header = buildOrderHeader(parsed, resolution.projectId)
  const pushResult = await pushGrasslandOrder(header, resolution.resolvedLines)

  await sbPatch(`grassland_order_batches?id=eq.${batch.id}`, {
    status: pushResult.success ? 'pushed' : 'failed',
    datex_order_id: pushResult.order_id ?? null,
    shipment_id: pushResult.shipment_id ?? null,
    error_message: pushResult.error ?? null,
  })

  return { ok: pushResult.success, stage: 'push', batchId: batch.id, orderId: pushResult.order_id, error: pushResult.error }
}

module.exports = {
  extractReleaseForm,
  validateAgainstPrintedTotals,
  decodePalletNumber,
  resolveOrderLines,
  buildOrderHeader,
  pushGrasslandOrder,
  processGrasslandReleaseForm,
  GRASSLAND_PROJECTS,
}
