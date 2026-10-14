// Order agent: Front webhook as a Supabase Edge Function.
// REWRITTEN 2026-10-13: this started as grassland-order-webhook, handling
// only Grassland. Expanded today to a multi-customer design (Grassland +
// Richelieu, more to follow) once Dan confirmed he wants to grow this to
// additional customers rather than build a one-off agent per account.
//
// ROUTING: the customer is determined from the ORIGINAL inbound email's
// sender domain (confirmed 2026-10-13: Grassland = grassland.com,
// Richelieu = richelieufoods.com) — this is the primary, deterministic
// signal, checked before any AI extraction runs. Each customer's config
// below (CUSTOMERS) owns its own: which attachment(s) to read per
// "order" (Grassland: one Release Form + optional Lot Info PDF per
// mention; Richelieu: EVERY PDF on the message, each one its own
// independent order — confirmed 2026-10-13, Richelieu's daily "CSW TO WL"
// email carries several Transfer Order PDFs in one message), its
// extraction prompt/schema, its own pre-Datex structural validation (the
// one check that needs no external data), and how to build the ack/
// duplicate/empty messages. Everything downstream of extraction (the
// MotherDuck resolution, the Datex push) lives in Netlify's
// order-agent-common.cjs + per-customer adapter, mirroring this file's
// CUSTOMERS map.
//
// WHAT THIS FUNCTION DOES, AND DOES NOT DO: as before — verify the
// webhook, read the triggering email, find and download the relevant
// PDF(s), have Claude read them into structured JSON, run the one
// validation check that needs no external data, write batch row(s) to
// `grassland_order_batches` (table name kept — see order-agent-common.cjs
// header note), post ack comment(s), then hand off to Netlify for
// everything needing live Datex data. Deno Edge Functions cannot run the
// native `duckdb` module MotherDuck queries depend on, which is why this
// split exists at all (same reason scheduling-agent-webhook lives here
// too).
//
// Handoff: after writing EACH batch row, this POSTs {batchId} to
// order-agent-resolve-background on Netlify (fire-and-forget, under
// EdgeRuntime.waitUntil) — for Richelieu's multi-PDF case, that means one
// handoff call per PDF/order, not one per @mention.
//
// TODO-VERIFY (carried over, still unconfirmed): findPdfAttachment-style
// attachment discovery below is modeled on the REGULAR Front OAuth
// connector's tool shapes (read_message -> attachments[],
// get_attachment(attachmentId) -> {filename, contentType, size,
// downloadUrl}), not confirmed against Front's EXTERNAL AGENT MCP server
// specifically — though by now proven working across many real Grassland
// runs, so treat Grassland's shape as effectively confirmed; Richelieu's
// multi-attachment download path is new today and shares the same
// assumption.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   FRONT_GRASSLAND_AGENT_CLIENT_ID, FRONT_GRASSLAND_AGENT_CLIENT_SECRET,
//   FRONT_GRASSLAND_AGENT_SIGNING_SECRET, FRONT_GRASSLAND_AGENT_TOKEN_URL,
//   ANTHROPIC_API_KEY, GRASSLAND_INTERNAL_SECRET (var names kept as-is —
//   see order-agent-common.cjs header note; they are not Grassland-
//   specific in function, just in name).
// Auto-provided: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Kill switch: GRASSLAND_AGENT_ENABLED=false (stops ALL customers).
// Deploy with verify_jwt=false (Front cannot send a Supabase JWT).

// deno-lint-ignore-file no-explicit-any
const env = (k: string) => Deno.env.get(k) || ''
const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY')
const CLAUDE_MODEL = 'claude-sonnet-4-5'
const MCP_URL = 'https://mcp.frontapp.com/mcp'
const MCP_PROTOCOL = '2025-11-25'
const MAX_SKEW_MS = 10 * 60 * 1000
const NETLIFY_RESOLVE_URL = 'https://csw-wi.netlify.app/.netlify/functions/grassland-order-resolve-background'

const sbH = (extra?: any) => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) })
async function sbGet(path: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH() })
  const t = await res.text()
  if (!res.ok) throw new Error(t)
  return t ? JSON.parse(t) : null
}
async function sbPost(path: string, body: any, prefer?: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'POST', headers: sbH({ Prefer: prefer || 'return=representation' }), body: JSON.stringify(body) })
  const t = await res.text()
  if (!res.ok) throw new Error(t)
  try { return t ? JSON.parse(t) : null } catch { return null }
}
async function sbPatch(path: string, body: any): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: sbH(), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(await res.text())
}

// ---------------------------------------------------------------------------
// Agent OAuth + minimal MCP client — identical shape to scheduling-agent-webhook
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null
async function getAgentToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) return cachedToken.token
  const id = env('FRONT_GRASSLAND_AGENT_CLIENT_ID'), secret = env('FRONT_GRASSLAND_AGENT_CLIENT_SECRET'), url = env('FRONT_GRASSLAND_AGENT_TOKEN_URL')
  if (!id || !secret || !url) throw new Error('FRONT_GRASSLAND_AGENT_CLIENT_ID / _CLIENT_SECRET / _TOKEN_URL not configured')
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString() })
  const t = await res.text()
  if (!res.ok) throw new Error(`Agent token request failed ${res.status}: ${t.slice(0, 300)}`)
  const d = JSON.parse(t)
  cachedToken = { token: d.access_token, expiresAt: Date.now() + (d.expires_in || 900) * 1000 }
  return cachedToken.token
}

function parseRpc(raw: string, contentType: string | null, id: number) {
  if ((contentType || '').includes('text/event-stream')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (!p) continue
      try { const m = JSON.parse(p); if (m.id === id) return m } catch (_) { /* skip */ }
    }
    throw new Error('MCP: no matching response in event stream')
  }
  return JSON.parse(raw)
}
async function mcpPost(token: string, st: any, body: any, expect: boolean) {
  const headers: any = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }
  if (st.sessionId) headers['Mcp-Session-Id'] = st.sessionId
  if (st.protocol) headers['MCP-Protocol-Version'] = st.protocol
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) st.sessionId = sid
  const raw = await res.text()
  if (!res.ok) throw new Error(`MCP ${body.method} -> ${res.status}: ${raw.slice(0, 400)}`)
  if (!expect) return null
  const msg = parseRpc(raw, res.headers.get('content-type'), body.id)
  if (msg.error) throw new Error(`MCP ${body.method} error: ${JSON.stringify(msg.error).slice(0, 400)}`)
  return msg.result
}
async function withMcp<T>(fn: (call: (name: string, args: any) => Promise<any>) => Promise<T>) {
  const token = await getAgentToken()
  const st: any = { sessionId: null, protocol: null }
  const init = await mcpPost(token, st, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'csw-order-agent', version: '2.0.0' } } }, true)
  st.protocol = (init && init.protocolVersion) || MCP_PROTOCOL
  await mcpPost(token, st, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  let next = 2
  const call = async (name: string, args: any) => {
    const r = await mcpPost(token, st, { jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } }, true)
    const text = (r.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    if (r.isError) throw new Error(`MCP tool ${name} failed: ${text.slice(0, 400)}`)
    return text
  }
  return fn(call)
}

const tryJson = (s: string) => { try { return JSON.parse(s) } catch { return null } }

// ---------------------------------------------------------------------------
// Conversation + attachment discovery
// ---------------------------------------------------------------------------

// Every message_inbound entry, newest first (matches Front's own ordering).
// Replaces the old single-"the inbound message" assumption: a Richelieu
// thread can carry several inbound messages (driver ETAs, appointment
// changes) after the original order email, so the EDGE function now scans
// candidates for one that actually has attachments, rather than assuming
// the first one found is the right one.
function allInboundMessageIds(readConversationRaw: string): string[] {
  const parsed = tryJson(readConversationRaw)
  const results = parsed?.entries?.results
  if (!Array.isArray(results)) return []
  return results.filter((e: any) => e.kind === 'message_inbound').map((e: any) => e.messageId).filter(Boolean)
}

function senderDomain(readMessageRaw: string): string | null {
  const parsed = tryJson(readMessageRaw)
  const handle = parsed?.recipients?.from?.[0]?.handle
  if (!handle || typeof handle !== 'string' || !handle.includes('@')) return null
  return handle.split('@').pop()!.toLowerCase()
}

function pdfAttachments(readMessageRaw: string): Array<{ id: string; filename: string }> {
  const parsed = tryJson(readMessageRaw)
  const attachments = Array.isArray(parsed?.attachments) ? parsed.attachments : []
  return attachments
    .filter((a: any) => /\.pdf$/i.test(a.filename || '') || /pdf/i.test(a.contentType || a.content_type || ''))
    .map((a: any) => ({ id: a.id || a.attachmentId, filename: a.filename || 'document.pdf' }))
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

async function downloadAttachmentBase64(call: (name: string, args: any) => Promise<any>, attachmentId: string): Promise<string> {
  const metaRaw = await call('get_attachment', { attachmentId })
  const meta = tryJson(metaRaw)
  const downloadUrl = meta?.downloadUrl || meta?.download_url
  if (!downloadUrl) throw new Error(`get_attachment returned no downloadUrl: ${metaRaw.slice(0, 300)}`)
  const res = await fetch(downloadUrl)
  if (!res.ok) throw new Error(`Attachment download failed (${res.status})`)
  const buf = new Uint8Array(await res.arrayBuffer())
  return bytesToBase64(buf)
}

async function callClaude(systemPrompt: string, pdfBase64List: string[], instructionText: string): Promise<any> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
  const content: any[] = pdfBase64List.map((b64) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }))
  content.push({ type: 'text', text: instructionText })
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 8000, system: systemPrompt, messages: [{ role: 'user', content }] }),
  })
  const raw = await res.text()
  let data: any
  try { data = JSON.parse(raw) } catch { throw new Error(`Claude API returned non-JSON: ${raw.slice(0, 300)}`) }
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data).slice(0, 500)}`)
  const block = (data.content || []).find((b: any) => b.type === 'text')
  if (!block) throw new Error('Claude API returned no text block')
  // Fence-stripping: the system prompt says "no markdown fences" but the
  // model sometimes wraps output in ```json ... ``` anyway (confirmed real
  // failure, cnv_1cmqpvx0) — never skip this, even though it hasn't
  // recurred since.
  const cleaned = block.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Claude's response was cut off at the token limit before finishing the JSON. Raw (truncated) output: ${cleaned.slice(0, 500)}`)
  }
  try { return JSON.parse(cleaned) } catch { throw new Error(`Model output was not valid JSON even after stripping markdown fences: ${cleaned.slice(0, 500)}`) }
}

// ---------------------------------------------------------------------------
// Grassland: extraction schema + printed-totals validation
// ---------------------------------------------------------------------------

const GRASSLAND_PROMPT = `You read a Grassland Dairy Products "Release Form" PDF (a cold-storage outbound release instruction) — and, when a second PDF is provided, a matching "Sales Order Lot Information" summary report for the same shipment — and return ONLY a JSON object, no prose, no markdown fences.

Shape:
{
  "po_number": string,
  "sales_order_number": string,
  "release_site": string,
  "ship_date": string,
  "released_to": { "name": string, "line1": string, "city": string, "state": string, "zip": string },
  "lines": [
    { "storage_lot": string, "grassland_lot": string, "sub_lot": string, "pallet_tote_number": number, "item_number": string, "item_count": number, "weight": number }
  ],
  "storage_lot_totals": [ { "storage_lot": string, "item_count": number, "weight": number } ],
  "grand_total": { "pallet_count": number, "item_count": number, "weight": number }
}

Rules:
- "lines", "storage_lot_totals", "grand_total", "po_number", "release_site", "ship_date" and "released_to" all come from the Release Form only. One entry in "lines" per table row in the PDF, in the order printed.
- "sales_order_number" comes from the SECOND document (the "Sales Order Lot Information" report), from its "Sales Order: <number>" line near the top — NOT from the Release Form, which does not print this number. If only one document is provided, or it has no such line, use null.
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value that is not visible on the page.
- "storage_lot_totals" must include every "STORAGE LOT: X TOTALS" line in the document.
- "grand_total" comes from the "RELEASE SITE: ... TOTALS" line (pallet_count is the "PALLET COUNT:" value).
- If the document has multiple pages, include every page's lines in one combined "lines" array.
- If any field is illegible or absent, use null for that field rather than guessing.`

function findGrasslandAttachments(pdfs: Array<{ id: string; filename: string }>) {
  if (pdfs.length === 0) return null
  if (pdfs.length > 1) console.log(`[order-agent:grassland] multiple PDF attachments found: ${pdfs.map((a) => a.filename).join(', ')}`)
  const releaseForm = pdfs.find((a) => /release.?form/i.test(a.filename))
  const primary = releaseForm || pdfs[0]
  if (!releaseForm && pdfs.length > 1) console.log(`[order-agent:grassland] no filename matched "release form" — defaulting to first PDF: ${primary.filename}`)
  const lotInfo = pdfs.find((a) => /lot.?info/i.test(a.filename))
  return { primary, secondary: lotInfo || null }
}

function validateGrasslandTotals(parsed: any): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const lines = parsed.lines || []
  const bySL = new Map<string, { item_count: number; weight: number }>()
  for (const l of lines) {
    const key = l.storage_lot
    if (!bySL.has(key)) bySL.set(key, { item_count: 0, weight: 0 })
    const agg = bySL.get(key)!
    agg.item_count += Number(l.item_count) || 0
    agg.weight += Number(l.weight) || 0
  }
  for (const printed of parsed.storage_lot_totals || []) {
    const actual = bySL.get(printed.storage_lot)
    if (!actual) { problems.push(`Storage lot ${printed.storage_lot} has a printed total but no extracted lines`); continue }
    if (actual.item_count !== Number(printed.item_count)) {
      problems.push(`Storage lot ${printed.storage_lot}: extracted item count ${actual.item_count} != printed total ${printed.item_count}`)
    }
  }
  const grand = parsed.grand_total || {}
  const sumItemCount = lines.reduce((s: number, l: any) => s + (Number(l.item_count) || 0), 0)
  if (grand.item_count != null && sumItemCount !== Number(grand.item_count)) {
    problems.push(`Sum of extracted item counts ${sumItemCount} != printed grand total ${grand.item_count}`)
  }
  // A split pallet (one physical pallet, two lot fractions) legitimately
  // produces two rows for one physical pallet — count distinct
  // (storage_lot, pallet_tote_number) pairs, not raw rows.
  const distinctPallets = new Set(lines.map((l: any) => `${l.storage_lot}::${l.pallet_tote_number}`))
  if (grand.pallet_count != null && distinctPallets.size !== Number(grand.pallet_count)) {
    problems.push(`Number of distinct physical pallets ${distinctPallets.size} != printed PALLET COUNT ${grand.pallet_count}`)
  }
  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------------------
// Richelieu: extraction schema + printed-totals validation
// ---------------------------------------------------------------------------
//
// ONE PDF = ONE Transfer Order = ONE Datex order. A Richelieu "CSW TO WL"
// email carries several of these PDFs at once (confirmed 2026-10-13: 7 in
// one real email) — Dan confirmed (2026-10-13) the agent should process
// each independently into its own payload/order, triggered by a single
// early @mention on the thread (he expects the CSR to mention right when
// the email arrives, keeping the thread's later logistics chatter out of
// the way — see allInboundMessageIds above for how that's handled if it
// isn't perfectly early).

const RICHELIEU_PROMPT = `You read a Richelieu Foods "Transfer Order" PDF (an outbound shipment instruction from CSW's warehouse to Richelieu's Wheeling, IL plant) and return ONLY a JSON object, no prose, no markdown fences.

Shape:
{
  "transfer_order_number": string,
  "posting_date": string,
  "item_number": string,
  "description": string,
  "total_quantity": number,
  "ship_to": { "name": string, "line1": string, "city": string, "state": string, "zip": string },
  "lots": [ { "lot_code": string, "totes": number } ],
  "printed_total_totes": number
}

Rules:
- "transfer_order_number" is the "Transfer Order No." value near the top.
- "item_number", "description" and "total_quantity" come from the single item row in the main table (Item No. / Description / Quantity).
- "ship_to" is the "WHEELING PLANT SHIPPING" address block at the top of the page (name, street line, city, state, zip) — this is who the shipment goes to.
- "lots" is the list of lines below the main table, each in the form "<LOT CODE> <N> TOTES" (e.g. "26026P21 4 TOTES") — one entry per line, in the order printed. Copy each lot code and tote count exactly as printed.
- "printed_total_totes" is the number from the "TOTAL <N> TOTES" line at the bottom of that list.
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value not visible on the page.
- If the document has multiple pages or multiple item rows, this schema currently assumes exactly one — if you see more than one item row, still return only the first and note nothing extra; this is a known limitation to revisit if it occurs.
- If any field is illegible or absent, use null for that field rather than guessing.`

function validateRichelieuTotals(parsed: any): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const lots = parsed.lots || []
  const sumTotes = lots.reduce((s: number, l: any) => s + (Number(l.totes) || 0), 0)
  if (parsed.printed_total_totes != null && sumTotes !== Number(parsed.printed_total_totes)) {
    problems.push(`Sum of extracted tote counts ${sumTotes} != printed TOTAL ${parsed.printed_total_totes}`)
  }
  // The deeper check (sum of eaches == total_quantity, via each material's
  // real Datex pallet size) needs MotherDuck and happens on the Netlify
  // side in resolveOrderLines — this is only the structural self-
  // consistency check the PDF's own printed numbers can confirm alone.
  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------------------
// Per-customer config — the one thing to extend when adding a new customer
// ---------------------------------------------------------------------------

interface OrderJob {
  parsed: any
  dedupeKey: string
  ackBody: string
  batchFields: Record<string, any>
}

interface CustomerConfig {
  code: string
  domains: string[]
  // Reads every PDF on the triggering message and returns one "job" per
  // order to extract + push. Grassland: one job (primary + optional
  // secondary PDF). Richelieu: one job per PDF, no secondary.
  buildJobs(pdfs: Array<{ id: string; filename: string }>, downloadPdf: (id: string) => Promise<string>): Promise<Array<{ primaryId: string; secondaryId: string | null }>>
  extract(primaryB64: string, secondaryB64: string | null): Promise<any>
  validate(parsed: any): { ok: boolean; problems: string[] }
  dedupeKey(parsed: any): string | null
  isEmpty(parsed: any): boolean
  ackBody(parsed: any, totalsOk: boolean, problems: string[]): string
  batchFields(parsed: any, totalsOk: boolean, problems: string[]): Record<string, any>
}

const CUSTOMERS: CustomerConfig[] = [
  {
    code: 'grassland',
    domains: ['grassland.com'],
    async buildJobs(pdfs) {
      const found = findGrasslandAttachments(pdfs)
      if (!found) return []
      return [{ primaryId: found.primary.id, secondaryId: found.secondary?.id || null }]
    },
    async extract(primaryB64, secondaryB64) {
      const instruction = secondaryB64
        ? 'The first document is the Release Form; the second is the Sales Order Lot Information report for the same shipment. Extract the combined JSON object described in your instructions.'
        : 'Extract this release form as the JSON object described in your instructions. No Lot Information report was found for this email, so leave sales_order_number null.'
      const pdfs = secondaryB64 ? [primaryB64, secondaryB64] : [primaryB64]
      return callClaude(GRASSLAND_PROMPT, pdfs, instruction)
    },
    validate: validateGrasslandTotals,
    dedupeKey: (parsed) => parsed.po_number || null,
    isEmpty: (parsed) => !parsed.po_number || !Array.isArray(parsed.lines) || parsed.lines.length === 0,
    ackBody: (parsed, ok, problems) => ok
      ? `Order agent: read PO ${parsed.po_number} (${parsed.lines.length} line(s)). Checking against current Datex inventory now...`
      : `Order agent: extracted line totals did not match the form's printed totals — flagged for manual entry.\n\n${problems.map((p) => `- ${p}`).join('\n')}`,
    batchFields: (parsed, ok, problems) => ({
      customer_code: 'grassland',
      po_number: parsed.po_number,
      release_site: parsed.release_site || null,
      ship_date: parsed.ship_date ? new Date(parsed.ship_date).toISOString().slice(0, 10) : null,
      status: ok ? 'parsed' : 'validation_failed',
      flag_reason: ok ? null : `Printed-total validation failed: ${problems.join('; ')}`,
      line_count: parsed.lines.length,
      total_quantity: (parsed.lines || []).reduce((s: number, l: any) => s + (Number(l.item_count) || 0), 0),
      pallet_count: parsed.grand_total?.pallet_count ?? parsed.lines.length,
      raw_extracted: parsed,
    }),
  },
  {
    code: 'richelieu',
    domains: ['richelieufoods.com'],
    async buildJobs(pdfs) {
      if (pdfs.length > 1) console.log(`[order-agent:richelieu] ${pdfs.length} PDF attachments found — processing each as its own order: ${pdfs.map((a) => a.filename).join(', ')}`)
      return pdfs.map((p) => ({ primaryId: p.id, secondaryId: null }))
    },
    async extract(primaryB64) {
      return callClaude(RICHELIEU_PROMPT, [primaryB64], 'Extract this Transfer Order as the JSON object described in your instructions.')
    },
    validate: validateRichelieuTotals,
    dedupeKey: (parsed) => parsed.transfer_order_number || null,
    isEmpty: (parsed) => !parsed.transfer_order_number || !Array.isArray(parsed.lots) || parsed.lots.length === 0,
    ackBody: (parsed, ok, problems) => ok
      ? `Order agent: read Transfer Order ${parsed.transfer_order_number} (${parsed.item_number}, ${parsed.lots.length} lot(s), ${parsed.total_quantity} total each). Checking against current Datex inventory now...`
      : `Order agent: Transfer Order ${parsed.transfer_order_number || '(unknown)'} — extracted tote counts did not match the form's printed total — flagged for manual entry.\n\n${problems.map((p) => `- ${p}`).join('\n')}`,
    batchFields: (parsed, ok, problems) => ({
      customer_code: 'richelieu',
      po_number: parsed.transfer_order_number,
      ship_date: parsed.posting_date ? new Date(parsed.posting_date).toISOString().slice(0, 10) : null,
      status: ok ? 'parsed' : 'validation_failed',
      flag_reason: ok ? null : `Printed-total validation failed: ${problems.join('; ')}`,
      line_count: parsed.lots.length,
      total_quantity: parsed.total_quantity ?? null,
      pallet_count: parsed.printed_total_totes ?? null,
      raw_extracted: parsed,
    }),
  },
]

function customerForDomain(domain: string | null): CustomerConfig | null {
  if (!domain) return null
  return CUSTOMERS.find((c) => c.domains.includes(domain)) || null
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function triggerNetlifyResolve(batchId: number) {
  try {
    const res = await fetch(NETLIFY_RESOLVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-grassland-internal-secret': env('GRASSLAND_INTERNAL_SECRET') },
      body: JSON.stringify({ batchId }),
    })
    const bodyText = await res.text().catch(() => '')
    console.log(`[order-agent] Netlify resolve handoff response for batch ${batchId}: status ${res.status}, body: ${bodyText.slice(0, 300)}`)
    if (!res.ok) {
      console.error(`[order-agent] Netlify resolve handoff did NOT return 2xx for batch ${batchId} — resolution will not run unless retried.`)
    }
  } catch (e) {
    console.error('[order-agent] failed to trigger Netlify resolve (network-level):', (e as Error).message)
  }
}

async function processOneJob(conversationId: string, customer: CustomerConfig, job: { primaryId: string; secondaryId: string | null }, downloadPdf: (id: string) => Promise<string>) {
  const primaryB64 = await downloadPdf(job.primaryId)
  const secondaryB64 = job.secondaryId ? await downloadPdf(job.secondaryId) : null
  const parsed = await customer.extract(primaryB64, secondaryB64)

  if (customer.isEmpty(parsed)) {
    await withMcp((call) => call('add_comment', { conversationId, body: `Order agent could not read one of this conversation's documents (missing key fields) — left for manual entry.` }))
    return { ok: false, reason: 'extraction empty' }
  }

  const key = customer.dedupeKey(parsed)
  if (key) {
    const existing = await sbGet(`grassland_order_batches?po_number=eq.${encodeURIComponent(key)}&select=id,status&limit=1`)
    if (Array.isArray(existing) && existing[0]) {
      await withMcp((call) => call('add_comment', { conversationId, body: `Order agent: ${key} already has a batch (status ${existing[0].status}) — not processing again.` }))
      return { ok: false, reason: 'duplicate' }
    }
  }

  const totalsCheck = customer.validate(parsed)
  const batchRows = await sbPost('grassland_order_batches', {
    front_conversation_id: conversationId,
    ...customer.batchFields(parsed, totalsCheck.ok, totalsCheck.problems),
  })
  const batch = batchRows[0]

  await withMcp((call) => call('add_comment', { conversationId, body: customer.ackBody(parsed, totalsCheck.ok, totalsCheck.problems) }))
  await sbPatch(`grassland_order_batches?id=eq.${batch.id}`, { ack_comment_posted: true }).catch(() => {})

  if (totalsCheck.ok) await triggerNetlifyResolve(batch.id)

  return { ok: true, batchId: batch.id }
}

async function runOrderAgentForMention(conversationId: string) {
  if (env('GRASSLAND_AGENT_ENABLED') === 'false') return { skipped: 'kill switch' }

  try {
    const results = await withMcp(async (call) => {
      // FIXED 2026-10-13 (real failure, Richelieu cnv_1cmu7ff8): a single
      // 50-entry page isn't enough on a genuinely busy support thread — on
      // this real conversation, SLA-bot rule actions plus several
      // logistics reply emails (driver ETAs, appointment changes) plus
      // this agent's own ack/error comments from testing earlier in the
      // day pushed the original order email's entry position well past
      // 50, and the mention came back "no PDF attachment found" despite
      // the email being right there if you scrolled. Now pages backward
      // (newest-first, matching Front's own ordering) looking for an
      // inbound message with PDF attachments, capped at 5 pages (up to
      // ~250 entries) to avoid a runaway loop on a truly ancient thread —
      // same cap used elsewhere in this app for conversation pagination.
      let cursor: string | undefined
      let triggeringMsgRaw: string | null = null
      let pdfs: Array<{ id: string; filename: string }> = []
      const MAX_PAGES = 5
      for (let page = 0; page < MAX_PAGES && !triggeringMsgRaw; page++) {
        const convRaw: string = cursor
          ? await call('read_conversation', { conversationId, limit: 50, cursor })
          : await call('read_conversation', { conversationId, limit: 50 })
        const inboundIds = allInboundMessageIds(convRaw)
        // Find the first (newest-first) inbound message that actually has
        // PDF attachments — the message that triggered this, not just
        // whichever inbound entry happens to be most recent (a Richelieu
        // thread can have later inbound replies about driver ETAs etc.
        // with no attachments at all).
        for (const messageId of inboundIds) {
          const msgRaw = await call('read_message', { messageId })
          const found = pdfAttachments(msgRaw)
          if (found.length > 0) { triggeringMsgRaw = msgRaw; pdfs = found; break }
        }
        if (triggeringMsgRaw) break
        const parsedConv = tryJson(convRaw)
        cursor = parsedConv?.entries?.nextCursor
        if (!cursor) break
      }
      if (!triggeringMsgRaw) return { noAttachment: true as const }

      const domain = senderDomain(triggeringMsgRaw)
      const customer = customerForDomain(domain)
      if (!customer) return { unknownCustomer: true as const, domain }

      const downloadPdf = (id: string) => withMcp((innerCall) => downloadAttachmentBase64(innerCall, id))
      const jobs = await customer.buildJobs(pdfs, downloadPdf)
      if (jobs.length === 0) return { noAttachment: true as const }

      const jobResults = []
      for (const job of jobs) {
        try {
          jobResults.push(await processOneJob(conversationId, customer, job, (id) => downloadAttachmentBase64(call, id)))
        } catch (e) {
          const msg = (e as Error).message
          try {
            await call('add_comment', { conversationId, body: `Order agent could not process one of this conversation's documents. Error: ${msg}` })
          } catch (_) { /* best effort */ }
          jobResults.push({ ok: false, error: msg })
        }
      }
      return { customer: customer.code, jobResults }
    })

    if ((results as any).noAttachment) {
      await withMcp((call) => call('add_comment', { conversationId, body: 'Order agent: no PDF attachment found on this conversation — nothing to process.' }))
      return { ok: false, reason: 'no attachment' }
    }
    if ((results as any).unknownCustomer) {
      const domain = (results as any).domain
      await withMcp((call) => call('add_comment', { conversationId, body: `Order agent: the sender's domain (${domain || 'unknown'}) doesn't match any configured customer — this needs code support before it can be processed.` }))
      return { ok: false, reason: 'unknown customer', domain }
    }

    return { ok: true, customer: (results as any).customer, jobResults: (results as any).jobResults }
  } catch (e) {
    const msg = (e as Error).message
    try {
      await withMcp((call) => call('add_comment', { conversationId, body: `Order agent could not process this conversation. Error: ${msg}` }))
    } catch (_) { /* best effort */ }
    return { ok: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Webhook entry
// ---------------------------------------------------------------------------

async function verifySignature(raw: string, headers: Headers) {
  const ts = headers.get('x-front-request-timestamp'), sig = headers.get('x-front-signature'), secret = env('FRONT_GRASSLAND_AGENT_SIGNING_SECRET')
  if (!ts || !sig || !secret) return false
  const skew = Math.abs(Date.now() - Number(ts))
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${raw}`)))
  let bin = ''
  for (const b of mac) bin += String.fromCharCode(b)
  const expected = btoa(bin)
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req: Request) => {
  const ok = () => new Response('ok', { status: 200 })
  try {
    const raw = await req.text()
    if (!(await verifySignature(raw, req.headers))) {
      console.warn('[order-agent] signature check failed or secret not configured')
      return ok()
    }
    const p = JSON.parse(raw || '{}')
    console.log('[order-agent] event', JSON.stringify({ type: p.type, id: p.event_id }))
    if (p.type !== 'mention' || !p.conversation_id || !p.comment_id) return ok()

    const work = runOrderAgentForMention(p.conversation_id)
      .then((r) => console.log('[order-agent] result', JSON.stringify(r)))
      .catch((e) => console.error('[order-agent] error', (e as Error).message))
    // deno-lint-ignore no-explicit-any
    ;(globalThis as any).EdgeRuntime?.waitUntil(work)
    return ok()
  } catch (e) {
    console.error('[order-agent] fatal', (e as Error).message)
    return ok()
  }
})
