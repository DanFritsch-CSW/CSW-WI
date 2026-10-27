// Order agent: Front webhook as a Supabase Edge Function.
// REWRITTEN 2026-10-13: this started as grassland-order-webhook, handling
// only Grassland. Expanded today to a multi-customer design (Grassland +
// Richelieu, more to follow) once Dan confirmed he wants to grow this to
// additional customers rather than build a one-off agent per account.
//
// ROUTING: the customer is determined from the ORIGINAL inbound email's
// sender domain (confirmed 2026-10-13: Grassland = grassland.com,
// Richelieu = richelieufoods.com; confirmed 2026-10-14: Pedone Pinsa =
// pedonepinsa.com, Thomas Foods International = thomasfoodsusa.com) —
// this is the primary, deterministic signal, checked
// before any AI extraction runs. Each customer's config below (CUSTOMERS)
// owns its own: which attachment(s) to read per "order" (Grassland: one
// Release Form + optional Lot Info PDF per mention; Richelieu AND Thomas
// Foods: EVERY PDF on the message, each one its own independent order —
// confirmed 2026-10-13 for Richelieu (7 PDFs in one real email) and
// 2026-10-19 for Thomas Foods (5 PDFs in one real "Kingdom Farms
// Transfers" email, see that section below); Pedone/Echo Lake: one PDF
// per email), its extraction prompt/schema, its own pre-Datex structural
// validation (the one check that needs no external data — Pedone/Thomas
// Foods have none, see their sections below), an optional shouldSkip
// check for orders that are real but not CSW's to create (Thomas Foods'
// other-facility transfers), and how to build the ack/duplicate/empty
// messages. Everything downstream of extraction (the MotherDuck
// resolution, the Datex push) lives in Netlify's order-agent-common.cjs +
// per-customer adapter, mirroring this file's CUSTOMERS map.
//
// WHAT THIS FUNCTION DOES, AND DOES NOT DO: as before — verify the
// webhook, read the triggering email, find and download the relevant
// PDF(s), have Claude read them into structured JSON, run the one
// validation check that needs no external data, write batch row(s) to
// `order_agent_batches` (renamed 2026-10-24 from grassland_order_batches —
// see order-agent-common.cjs header note), post ack comment(s), then hand
// off to Netlify for
// everything needing live Datex data. Deno Edge Functions cannot run the
// native `duckdb` module MotherDuck queries depend on, which is why this
// split exists at all (same reason scheduling-agent-webhook lives here
// too).
//
// Handoff: after writing EACH batch row, this POSTs {batchId} to
// order-agent-resolve-background on Netlify (fire-and-forget, under
// EdgeRuntime.waitUntil) — for Richelieu/Thomas Foods' multi-PDF case,
// that means one handoff call per PDF/order, not one per @mention.
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
//   FRONT_GRASSLAND_AGENT_SIGNING_SECRET, FRONT_GRASSLAND_AGENT_TOKEN_URL
//   (these four deliberately KEPT Grassland-named 2026-10-24 — they're the
//   actual live Front OAuth client credentials for this agent, and renaming
//   the env var key would mean re-pasting live secret values that aren't
//   readable back from Supabase/Netlify once set; not worth the live-agent
//   risk for a cosmetic rename. They are not Grassland-specific in
//   function, just in name.),
//   ANTHROPIC_API_KEY, ORDER_AGENT_INTERNAL_SECRET (renamed 2026-10-24 from
//   GRASSLAND_INTERNAL_SECRET, same value, swapped on both Netlify and
//   Supabase together — see order-agent-common.cjs header note).
// Auto-provided: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Kill switch: ORDER_AGENT_ENABLED=false (stops ALL customers) — renamed
// 2026-10-24 from GRASSLAND_AGENT_ENABLED.
// Deploy with verify_jwt=false (Front cannot send a Supabase JWT).
//
// SLUG NOTE (2026-10-24): this function is still deployed under the slug
// `grassland-order-webhook` because Front's own Agent webhook registration
// (set in Front's UI, outside this codebase) hardcodes that URL. An
// identical copy is also deployed under the slug `order-agent-webhook` —
// once Dan repoints Front's registration to the new URL and confirms a live
// @mention works, the old slug can be retired. Every internal reference
// (tables, Netlify handoff URL, internal secret, header name) is already
// renamed in both deployments; only the externally-registered URL itself
// is pending.

// deno-lint-ignore-file no-explicit-any
const env = (k: string) => Deno.env.get(k) || ''
const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY')
const CLAUDE_MODEL = 'claude-sonnet-4-5'
const MCP_URL = 'https://mcp.frontapp.com/mcp'
const MCP_PROTOCOL = '2025-11-25'
const MAX_SKEW_MS = 10 * 60 * 1000
// Confirmed 2026-10-24 that Netlify deployed the renamed function (the
// stall turned out to be the site's AWS Lambda 4KB env-var ceiling, hit by
// adding ORDER_AGENT_INTERNAL_SECRET as a new var — not the GitHub repo
// rename as first suspected; removing the redundant new var let the next
// deploy through). Back to the renamed name.
const NETLIFY_RESOLVE_URL = 'https://csw-wi.netlify.app/.netlify/functions/order-agent-resolve-background'

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

// ADDED 2026-10-24 for McCain: confirmed across 10 real emails that
// bizlink@mccain.com's "Shipping Information Email" never attaches a PDF
// directly to the Front message — every one attaches a single `.eml`
// (message/rfc822), and the real PDF lives as an attachment INSIDE that
// forwarded/relayed message. This is the McCain-specific counterpart to
// pdfAttachments above; findPdfInMime below does the actual unwrap once
// the .eml's own bytes are downloaded.
function emlAttachments(readMessageRaw: string): Array<{ id: string; filename: string }> {
  const parsed = tryJson(readMessageRaw)
  const attachments = Array.isArray(parsed?.attachments) ? parsed.attachments : []
  return attachments
    .filter((a: any) => /\.eml$/i.test(a.filename || '') || /message\/rfc822/i.test(a.contentType || a.content_type || ''))
    .map((a: any) => ({ id: a.id || a.attachmentId, filename: a.filename || 'forwarded.eml' }))
}

// ---------------------------------------------------------------------------
// Minimal recursive MIME parser — McCain's .eml unwrap only
// ---------------------------------------------------------------------------
//
// No npm/Deno MIME library is already a dependency here, and pulling one in
// for a single attachment-extraction need felt like more risk than a small,
// purpose-built parser. This handles exactly what's needed: a raw RFC 822
// message, walking into multipart/* parts (and, in case a mail client wraps
// the original message a second time, a nested message/rfc822 part) to find
// the first base64-encoded application/pdf part. Not a general-purpose MIME
// parser — e.g. quoted-printable PDF encoding isn't handled, since every
// real sample confirmed base64 — if a future McCain email fails extraction
// with "no PDF found inside forwarded email", check the encoding first.

function parseMimeHeaders(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {}
  const lines = headerBlock.split(/\r?\n/)
  let currentKey: string | null = null
  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentKey) {
      headers[currentKey] += ' ' + line.trim()
    } else {
      const m = line.match(/^([^:]+):\s*(.*)$/)
      if (m) { currentKey = m[1].toLowerCase(); headers[currentKey] = m[2] }
    }
  }
  return headers
}

function mimeHeaderParam(headerValue: string, param: string): string | null {
  const re = new RegExp(`${param}\\s*=\\s*"?([^";]+)"?`, 'i')
  const m = (headerValue || '').match(re)
  return m ? m[1].trim() : null
}

function splitMimeMessage(raw: string): { headers: Record<string, string>; body: string } {
  const idxCrlf = raw.indexOf('\r\n\r\n')
  const idxLf = raw.indexOf('\n\n')
  let i = idxCrlf
  let sepLen = 4
  if (i === -1 || (idxLf !== -1 && idxLf < i)) { i = idxLf; sepLen = 2 }
  if (i === -1) return { headers: parseMimeHeaders(raw), body: '' }
  return { headers: parseMimeHeaders(raw.slice(0, i)), body: raw.slice(i + sepLen) }
}

// Recursively walks a raw MIME message/part looking for the first base64
// application/pdf part. Descends into multipart/* (splitting on that part's
// own boundary) and message/rfc822 (a message nested as a part, e.g. an
// extra layer of forwarding) parts until it finds one or runs out.
function findPdfInMime(raw: string): { base64: string; filename: string } | null {
  const { headers, body } = splitMimeMessage(raw)
  const contentType = headers['content-type'] || ''

  if (/application\/pdf/i.test(contentType)) {
    const encoding = (headers['content-transfer-encoding'] || '').toLowerCase()
    if (!encoding.includes('base64')) return null // see file header note
    const filename = mimeHeaderParam(contentType, 'name')
      || mimeHeaderParam(headers['content-disposition'] || '', 'filename')
      || 'document.pdf'
    return { base64: body.replace(/[\r\n]+/g, ''), filename }
  }

  if (/multipart\//i.test(contentType)) {
    const boundary = mimeHeaderParam(contentType, 'boundary')
    if (!boundary) return null
    const parts = body.split(`--${boundary}`)
    for (const part of parts) {
      const trimmed = part.replace(/^\r?\n/, '')
      if (!trimmed.trim() || trimmed.trim() === '--') continue
      const found = findPdfInMime(trimmed)
      if (found) return found
    }
    return null
  }

  if (/message\/rfc822/i.test(contentType)) {
    return findPdfInMime(body)
  }

  return null
}

// Entry point: given the base64 of a downloaded .eml FILE (what
// downloadAttachmentBase64 returns for any attachment, regardless of type),
// decode it to the raw MIME text and find the embedded PDF. atob/text
// round-tripping assumes the .eml itself is ASCII-safe, true of standard
// email structure even when it carries base64-encoded binary parts.
function extractPdfFromEmlBase64(emlBase64: string): { base64: string; filename: string } | null {
  const raw = atob(emlBase64)
  return findPdfInMime(raw)
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
//
// REWRITTEN 2026-10-16 (real failure, TOP1060598/cnv_1cnvq9as): a real
// order had TWO item rows on one page (R1116537 and R1117692), each with
// its own lot block below — the old schema assumed exactly one item per
// PDF and silently dropped the second entirely, with no error at all.
// Schema is now `items: [...]`, one entry per item row actually printed,
// each carrying its own lots. The printed unit label varies by item too
// ("10 PALLETS" vs "34 TOTES" on the very same page) — both mean the same
// physical unit (one license plate) for this customer, so the prompt
// tells Claude to copy the number as "count" regardless of which word is
// printed; the adapter's math (count × that material's own pallet size)
// doesn't care which label was used.

const RICHELIEU_PROMPT = `You read a Richelieu Foods "Transfer Order" PDF (an outbound shipment instruction from CSW's warehouse to Richelieu's Wheeling, IL plant) and return ONLY a JSON object, no prose, no markdown fences.

Shape:
{
  "transfer_order_number": string,
  "posting_date": string,
  "ship_to": { "name": string, "line1": string, "city": string, "state": string, "zip": string },
  "items": [
    {
      "item_number": string,
      "description": string,
      "total_quantity": number,
      "lots": [ { "lot_code": string, "count": number } ],
      "printed_total_count": number
    }
  ]
}

Rules:
- "transfer_order_number" is the "Transfer Order No." value near the top.
- "ship_to" is the "WHEELING PLANT SHIPPING" address block at the top of the page (name, street line, city, state, zip) — this is who the shipment goes to.
- The main table near the top lists one row per ITEM (Item No. / Description / Quantity). Create one entry in "items" for EACH row, in the order printed — a PDF may have just one item or several; never drop a row.
- Below the main table, each item has its own block: the item number printed again as a heading, then one line per lot in the form "<LOT CODE> <N> PALLETS" or "<LOT CODE> <N> TOTES" (both words mean the same physical unit here — just copy the number as "count" either way), then a "TOTAL <N> PALLETS"/"TOTAL <N> TOTES" line for that item. Match each lot block to the correct item by the item-number heading printed directly above it, not by position on the page.
- "printed_total_count" is that item's own "TOTAL <N> ..." line.
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value not visible on the page.
- If any field is illegible or absent, use null for that field rather than guessing.`

function validateRichelieuTotals(parsed: any): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const items = parsed.items || []
  for (const item of items) {
    const lots = item.lots || []
    const sum = lots.reduce((s: number, l: any) => s + (Number(l.count) || 0), 0)
    if (item.printed_total_count != null && sum !== Number(item.printed_total_count)) {
      problems.push(`${item.item_number}: sum of extracted lot counts ${sum} != printed TOTAL ${item.printed_total_count}`)
    }
  }
  // The deeper check (sum of eaches == total_quantity, via each material's
  // real Datex pallet size, plus the lot-to-material disambiguation) needs
  // MotherDuck and happens on the Netlify side in resolveOrderLines — this
  // is only the structural self-consistency check the PDF's own printed
  // numbers can confirm alone.
  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------------------
// Pedone Pinsa: extraction schema (no structural validation possible)
// ---------------------------------------------------------------------------
//
// ONE PDF = ONE "Picking Operations" document = ONE order, one per email
// (confirmed 2026-10-14 via real thread cnv_1chmcd5g — a teammate flagged
// it to Dan as "this is how they send them now"). Unlike Grassland or
// Richelieu, this document prints NO grand total anywhere on the page —
// there is nothing analogous to "RELEASE SITE TOTALS" or "TOTAL N TOTES"
// to structurally cross-check extraction against. validatePedone below is
// a deliberate no-op for that reason; the only real check available for
// this customer is resolution itself failing on the Netlify side (an item
// number not matching a real material).
//
// The document also carries a "could not be reserved / Check Availability"
// warning tied to Pedone's own order-management system's reservation
// status — confirmed with Dan (2026-10-14) this is irrelevant and must be
// ignored during extraction, same spirit as ignoring Richelieu's email-
// body logistics data.

const PEDONE_PROMPT = `You read a Pedone Pinsa "Picking Operations" PDF (an outbound shipment pick ticket) and return ONLY a JSON object, no prose, no markdown fences.

Shape:
{
  "cust_po": string,
  "csw_csd_code": string,
  "scheduled_date": string,
  "delivery_address": { "name": string, "line1": string, "city": string, "state": string, "zip": string },
  "lines": [ { "item_number": string, "description": string, "case_quantity": number } ]
}

Rules:
- "cust_po" is the "Cust PO" value from the order details row near the top.
- "csw_csd_code" is the large bold code printed below the addresses, in the form "CSW/CSD/#####".
- "scheduled_date" is the "Scheduled Date" value from the same order details row.
- "delivery_address" is the "Delivery Address" block specifically (NOT the "Customer Address" block, even though they are often similar) — name, street line, city, state, zip.
- "lines" is every row of the item table: the bracketed code is "item_number" (e.g. "[WBF-0712-C]" becomes "WBF-0712-C"), the text after it is "description", and "case_quantity" is the number in the "Case" column. Ignore the "Pallets" column entirely — it is not needed.
- Ignore any "could not be reserved" / "Check Availability" warning on the page — it is not relevant to extraction.
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value not visible on the page.
- If any field is illegible or absent, use null for that field rather than guessing.`

function validatePedone(_parsed: any): { ok: boolean; problems: string[] } {
  // Deliberate no-op — see file section header note above.
  return { ok: true, problems: [] }
}

// ---------------------------------------------------------------------------
// Thomas Foods International: extraction schema + CSW-origin filtering
// ---------------------------------------------------------------------------
//
// ONE EMAIL CAN CARRY SEVERAL ORDERS. Originally built 2026-10-14 on a
// single real sample (one PDF, one email) and assumed one-PDF-per-email,
// same as Pedone. REWRITTEN 2026-10-19 after a real failure: a genuine
// "Kingdom Farms Transfers" email (cnv_1coe9t78) carried FIVE Transfer
// Order PDFs at once, and the old code — which always grabbed only the
// FIRST pdf found — kept re-finding and re-reporting the same one
// (TO10006631, already pushed) no matter how many times the CSR
// re-mentioned the agent or what they typed ("create order TO10006628",
// "create orders", etc.). The agent had no way to advance past the first
// attachment at all. Fixed the same way Richelieu's identical multi-PDF
// gap was fixed 2026-10-16: buildJobs now returns one job per PDF.
//
// A SECOND, MORE IMPORTANT ISSUE SURFACED BY THE SAME EMAIL: Thomas Foods
// operates more than one facility, and a single consolidated email can
// carry transfers that do NOT originate from CSW at all — in that real
// email, 3 of the 5 PDFs printed "LOAD From: CSW ... Pleasant Prairie"
// (genuinely CSW's to create) but 2 printed a different origin entirely
// (Thomas Foods' other facility, referred to in the email body as "001"/
// "Lakeside"). CSW has no inventory for those and must NOT create Datex
// orders for them. shouldSkip below reads each PDF's own "LOAD From"
// line (already visible on every one of these documents, confirmed
// 2026-10-14 on the original sample) and skips — with a clear, explicit
// comment explaining why, never silently — any order that doesn't
// originate from CSW. This runs in processOneJob BEFORE a batch row is
// even created, since a skipped order isn't CSW's to track at all.
//
// Still true from the original build: this document has no printed grand
// total anywhere to structurally cross-check against — validateThomasFoods
// below is a deliberate no-op for that reason. Unlike Pedone, there IS a
// real cross-check available on the Netlify side: the PDF states a
// material code AND a storage lot independently on each line, and the
// resolved lot's own material in Datex must agree with what's printed —
// see adapters/thomasfoods.cjs for that logic.
//
// The email itself asks CSW to reply with shipping details (carrier etc.)
// separately — deliberately NOT captured here, same precedent as ignoring
// Richelieu's email-body logistics text.

const THOMAS_FOODS_PROMPT = `You read a Thomas Foods International "Fulfillment Authorization" PDF (an outbound shipment instruction) and return ONLY a JSON object, no prose, no markdown fences.

Shape:
{
  "fulfillment_authorization_number": string,
  "transfer_order_number": string,
  "customer_po": string,
  "ship_date": string,
  "load_from": string,
  "ship_to": { "name": string, "line1": string, "city": string, "state": string, "zip": string },
  "lines": [ { "material_code": string, "description": string, "storage_lot": string, "case_count": number } ]
}

Rules:
- "fulfillment_authorization_number" is the "#IF..." number printed at the top right of the page.
- "transfer_order_number" is the number after "Transfer Order #" in the "Sales Order #" column (e.g. "Transfer Order #TO10006606" -> "TO10006606").
- "customer_po" is the "Customer PO#" column value — this is very often blank; use null when it is, do not invent a value.
- "load_from" is the value of the "LOAD From:" line exactly as printed (e.g. "CSW 7800 95th Street Pleasant Prairie, WI 53158") — this is the warehouse the shipment originates from, NOT the customer. Some of these documents originate from a different Thomas Foods facility entirely, not CSW — copy whatever is actually printed here, do not assume it always says CSW.
- "ship_to" is the "Ship To" address block (name, street line, city, state, zip) — NOT the "Ship From" block, which is always CSW's own address.
- "lines" is every row of the item table. The "Item" column is in the form "<description> : <material code>" — split it into "description" and "material_code" (the part after the colon). "storage_lot" is the "Lot" column value exactly as printed (e.g. "PO156366-1"). "case_count" is the "Cases Ordered" column value. Ignore the "Lot Ref", "Pack Date", "Ship Mark", "Box ID", and "General Notes" columns — none of them are needed.
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value not visible on the page.
- If any field is illegible or absent, use null for that field rather than guessing.`

function validateThomasFoods(_parsed: any): { ok: boolean; problems: string[] } {
  // Deliberate no-op — see file section header note above. The real
  // cross-check (item material code vs. the resolved lot's actual
  // material) needs MotherDuck and happens in the Netlify adapter.
  return { ok: true, problems: [] }
}

// ADDED 2026-10-19 (real failure, cnv_1coe9t78 — see section header note
// above): returns a skip reason when a Thomas Foods order's own printed
// "LOAD From" line doesn't start with CSW — this is a real order, just not
// CSW's to create in Datex. Returns null (don't skip) when load_from is
// missing entirely, rather than guessing either way — an empty field is a
// different, separate problem (extraction miss) that should surface via
// the normal isEmpty/resolution path, not get silently swallowed here.
function thomasFoodsSkipReason(parsed: any): string | null {
  const loadFrom = (parsed.load_from || '').trim()
  if (!loadFrom) return null
  if (/^CSW\b/i.test(loadFrom)) return null
  return `Order agent: ${parsed.transfer_order_number || '(unknown TO#)'} ships from "${loadFrom}", not CSW — skipping. This order isn't CSW's to create in Datex; it belongs to the other facility it's printed under.`
}

// ---------------------------------------------------------------------------
// Echo Lake Foods: extraction schema + real printed grand-total validation
// ---------------------------------------------------------------------------
//
// ONE PDF = ONE "Order Verification" document = ONE order, one per email
// (confirmed 2026-10-16, sender customerservice@echolakefoods.com). CSW
// ships OUT of Kenosha on Echo Lake's behalf to a THIRD PARTY end customer
// named on the PDF's own Bill To/Ship To (e.g. Holiday Stationstores LLC)
// — see adapters/echolake.cjs for the full confirmation against real
// Datex order history. Unlike Pedone/Thomas Foods, this document DOES
// print a real grand total (the bottom "Total" row: total cases, total
// pallets) — validateEchoLakeTotals below is a genuine structural check,
// not a no-op.

const ECHOLAKE_PROMPT = `You read an Echo Lake Foods "Order Verification" PDF (an outbound shipment order confirmation) and return ONLY a JSON object, no prose, no markdown fences.

Shape:
{
  "order_number": string,
  "bill_to_po": string,
  "ship_date": string,
  "ship_to": { "name": string, "line1": string, "line2": string, "city": string, "state": string, "zip": string },
  "lines": [ { "part_number": string, "description": string, "case_quantity": number, "pallets": number } ],
  "printed_total_cases": number,
  "printed_total_pallets": number
}

Rules:
- "order_number" is the "Order #" value printed at the top right of the page.
- "bill_to_po" is the "Bill To PO" column value from the order details row (e.g. "PO003710 - WH3750141") — copy it exactly as printed, including the dash and any spaces around it.
- "ship_date" is the "Ship Date" value from the same order details row.
- "ship_to" is the "Ship To" address block (NOT the "Bill To" block, even though they are often similar) — name, the street address line, a second line if there's a facility/commissary name printed below the street address, city, state, zip.
- "lines" is every row of the item table. "Part #" is "part_number". "Qty" (the first numeric column, in cases) is "case_quantity". "Pallets" is "pallets". Ignore the "Lbs", "Lbs/UOM", "UOM", "Cs/Pal", "$/Lb", "$/UOM", and "Total" (dollar) columns entirely — none of them are needed.
- "printed_total_cases" and "printed_total_pallets" come from the bottom "Total" row of the item table (the Qty and Pallets columns of that row).
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value not visible on the page.
- If any field is illegible or absent, use null for that field rather than guessing.`

function validateEchoLakeTotals(parsed: any): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const lines = parsed.lines || []
  const sumCases = lines.reduce((s: number, l: any) => s + (Number(l.case_quantity) || 0), 0)
  if (parsed.printed_total_cases != null && sumCases !== Number(parsed.printed_total_cases)) {
    problems.push(`Sum of extracted case quantities ${sumCases} != printed total ${parsed.printed_total_cases}`)
  }
  const sumPallets = lines.reduce((s: number, l: any) => s + (Number(l.pallets) || 0), 0)
  if (parsed.printed_total_pallets != null && sumPallets !== Number(parsed.printed_total_pallets)) {
    problems.push(`Sum of extracted pallet counts ${sumPallets} != printed total ${parsed.printed_total_pallets}`)
  }
  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------------------
// McCain Foods (Wisconsin Rapids): .eml unwrap + catch-weight extraction
// ---------------------------------------------------------------------------
//
// ONE EMAIL = ONE .eml ATTACHMENT = ONE PDF = ONE "Shipping information"
// document = ONE order (confirmed across 10 real emails, 2026-10-24,
// sender bizlink@mccain.com). Unlike every other customer here, the PDF is
// never a direct Front attachment — see emlAttachments/findPdfInMime above
// for the unwrap this customer's buildJobs performs before extraction.
//
// CATCH-WEIGHT: the document gives a target WEIGHT per batch/lot line, not
// a case or tote count. See adapters/mccain.cjs for how that's turned into
// a Datex tote-count line (Datex's line-create API takes neither a weight
// nor a license plate, matching the Grassland/Richelieu constraints already
// documented there).
//
// "footer_po_number" IS NOT the same as "reference_number": confirmed
// against 9 real Datex orders with zero exceptions — "Reference number"
// (near the top of the page) maps 1:1 to Datex's owner_reference, while a
// DIFFERENT 10-digit number that appears only in the free-text paragraph at
// the bottom of the page (e.g. "...MOZZ - 4500821227 - 40,249.72 LBS...")
// is what the Datex lot lookup_code is built from, together with each
// "BATCH#" value in that same paragraph — see mccain.cjs's buildLotCode for
// the exact construction. Both numbers are genuinely present and genuinely
// different; do not let the model collapse them into one field.
const MCCAIN_PROMPT = `You read a McCain Foods "Shipping information" / "Delivery Note" PDF (an outbound shipment release from CSW's Wisconsin Rapids warehouse) and return ONLY a JSON object, no prose, no markdown fences.

Shape:
{
  "delivery_note_number": string,
  "reference_number": string,
  "shipment_number": string,
  "ship_date": string,
  "ship_to": { "name": string, "line1": string, "city": string, "state": string, "zip": string },
  "net_weight": number,
  "items": [
    {
      "material_code": string,
      "description": string,
      "lines": [ { "batch_number": string, "weight": number } ]
    }
  ],
  "footer_po_number": string,
  "printed_total_weight": number
}

Rules:
- "delivery_note_number" is the number on the "Delivery note <number> / <date>" line near the top (just the number, not the date).
- "reference_number" is the "Reference number" value printed near the top — do not confuse this with the different number that appears later in the free-text paragraph at the bottom of the page (see "footer_po_number" below).
- "shipment_number" is the "Shipment No." value.
- "ship_date" is the "Scheduled Ship Date" value.
- "ship_to" is the "Ship-To:" address block at the top of the page (name, street line, city, state, zip) — NOT the "Ship-From:" block, which is always CSW's own warehouse.
- "net_weight" is the "Net weight" value from the weight/volume summary block.
- The "Shipping details" table lists one block per material: an item line with the material code and description, followed by one row per batch — each row has a batch number (an 8-digit number, e.g. "20260911") and a weight (the LB figure; the Quantity and Weight columns print the same number — use either). Create one entry in "items" per material block, with one entry in its "lines" array per batch row, in the order printed. Never drop a row.
- "footer_po_number" comes from the free-text paragraph at the very bottom of the page (it starts with something like "PLEASE SEND THE FOLLOWING LOAD...") — it is the 10-digit number that appears right after the material code and right before the first "BATCH#" mention (e.g. in "...3000001249 MOZZ - 4500821227 - 40,249.72 LBS. BATCH# 20260911...", the value is "4500821227"). This is a DIFFERENT number from "reference_number" above — copy it exactly even if it looks similar.
- "printed_total_weight" is the value on the "Total:" line near the bottom of the shipping details table (the one just above the free-text paragraph, not any value inside that paragraph).
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value not visible on the page.
- If any field is illegible or absent, use null for that field rather than guessing.`

function validateMcCainTotals(parsed: any): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const items = parsed.items || []
  const sum = items.reduce((s: number, it: any) => s + (it.lines || []).reduce((s2: number, l: any) => s2 + (Number(l.weight) || 0), 0), 0)
  if (parsed.printed_total_weight != null && Math.abs(sum - Number(parsed.printed_total_weight)) > 0.01) {
    problems.push(`Sum of extracted line weights ${sum} != printed Total ${parsed.printed_total_weight}`)
  }
  if (parsed.net_weight != null && Math.abs(sum - Number(parsed.net_weight)) > 0.01) {
    problems.push(`Sum of extracted line weights ${sum} != printed Net weight ${parsed.net_weight}`)
  }
  // The real lot-code resolution (constructing each lot from footer_po_number
  // + batch_number, confirming it exists with on-hand inventory in Datex, and
  // the tote-count allocation) needs MotherDuck and happens in the Netlify
  // adapter — this is only the structural self-consistency check the PDF's
  // own printed numbers can confirm alone.
  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------------------
// DSM Firmenich: extraction schema + real printed net-weight validation
// ---------------------------------------------------------------------------
//
// Added 2026-10-26 after a live kickoff call with the Kenosha DSM team. TWO
// Datex projects (DSMEN5 enzymes, DSMFO8 cultures) ship under this ONE
// sender domain — the subject sometimes carries "( E )" or "(C)" but Dan
// confirmed by voice this isn't reliable enough to route on. This layer
// (extraction + structural validation) is deliberately project-agnostic:
// it just reads the document into JSON. Which Datex project an order
// belongs to is resolved on the Netlify side, from the item numbers
// themselves, after live MotherDuck lookup — see adapters/dsm.cjs for that
// logic and the full confirmation behind it (zero item-number overlap
// across the full 816-material catalog spanning both projects).
//
// ONE EMAIL, UNCONFIRMED WHETHER ALWAYS ONE PDF: both real samples seen so
// far (order 859860/DSMEN5, order 860637/DSMFO8) had exactly one PDF
// attachment. Some subjects use "Orders" plural (e.g. "10/28 Orders (C)"),
// which is suggestive of a multi-PDF email but not yet confirmed either
// way — buildJobs below processes EVERY PDF found on the triggering
// message as its own independent order, the same defensive pattern already
// proven necessary for Richelieu (7 PDFs in one real email) and Thomas
// Foods (5 PDFs in one real email), so nothing silently gets dropped if a
// multi-PDF DSM email does turn up.
//
// DOCUMENT SHAPE: a "Delivery Note" (one or two pages) followed by a
// "Picking list" page. The Picking list carries the Batch/lot code per
// line, printed as ONE literal token (not constructed from two fields,
// despite how that sounded read aloud digit-by-digit on the kickoff call —
// confirmed directly against real Datex lot records before writing this
// prompt). Cultures orders also repeat the batch inline on the Delivery
// Note page itself; enzymes orders do not — the Picking list page is the
// one place both formats reliably carry it, so the prompt treats that as
// the primary source and the Delivery Note's inline mention (when present)
// as a secondary confirmation only.

const DSM_PROMPT = `You read a DSM Firmenich "Delivery Note" PDF (an outbound shipment document, usually followed by a "Picking list" page for the same order) and return ONLY a JSON object, no prose, no markdown fences.

Shape:
{
  "delivery_number": string,
  "shipment_id_number": string,
  "your_po_number": string,
  "sales_order_number": string,
  "delivery_date": string,
  "net_weight": number,
  "ship_to": { "name": string, "line1": string, "city": string, "state": string, "zip": string },
  "lines": [
    { "item_number": string, "description": string, "item_count": number, "net_weight": number, "lot_code": string }
  ]
}

Rules:
- "delivery_number" is the "Delivery" value near the top of the Delivery Note page (e.g. "81050660") — NOT "Our order number" and NOT "Shipment ID number", which are different fields printed on the same page.
- "shipment_id_number" is the "Shipment ID number" value on the Delivery Note page.
- "your_po_number" is the "Your purchase order" value.
- "sales_order_number" is the "Our order number" value — informational only.
- "delivery_date" is the "Delivery date" value — NOT the separate freeform "Ship <date>" note that sometimes appears later in the body text, which is a different, earlier date.
- "net_weight" is the "Net weight" figure from the weight block near "Shipped From" (strip "KG", just the number).
- "ship_to" is the "Shipped To" address block (NOT "Sold To", which is very often a different company) — name, street line, city, state, zip.
- "lines" is every material line item on the Delivery Note's item table, one entry per material in the order printed. "item_number" is the Material code (the number, not the product name). "item_count" is the number in the Quantity column before its unit (e.g. "5" from "5 PC" — strip the unit). "net_weight" is that line's own Net weight figure (strip "KG").
- "lot_code" is each line's Batch number. Read it from the "Picking list" page (it appears later in the document), matching each line to its item there by the item/material number — this page always carries it in both formats seen so far. If a line's batch is also printed inline on the Delivery Note page itself (common on cultures orders, as "Batch<code>" right next to the quantity), you can use that to confirm the Picking list reading, but the Picking list is the authoritative source if they ever disagree.
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value not visible on the page.
- If any field is illegible or absent, use null for that field rather than guessing.`

function validateDSMTotals(parsed: any): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const lines = parsed.lines || []
  const sumWeight = lines.reduce((s: number, l: any) => s + (Number(l.net_weight) || 0), 0)
  // Confirmed exact on both real samples (100 KG single-line; 42 KG =
  // 15 + 13.5 + 13.5 three-line) — a small tolerance covers ordinary
  // rounding on a document this agent has only seen twice so far.
  if (parsed.net_weight != null && Math.abs(sumWeight - Number(parsed.net_weight)) > 0.5) {
    problems.push(`Sum of extracted line net weights ${sumWeight} KG != printed Net weight ${parsed.net_weight} KG`)
  }
  // The real project/lot resolution (which Datex project this belongs to,
  // and whether each line's lot actually exists and matches its material)
  // needs MotherDuck and happens in the Netlify adapter — this is only the
  // structural self-consistency check the PDF's own printed numbers can
  // confirm alone.
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
  // secondary PDF). Richelieu/Thomas Foods: one job per PDF, no secondary.
  // Pedone/Echo Lake: one job for the first PDF found, no secondary. McCain
  // (added 2026-10-24): one job per .eml attachment, built from `emls`
  // instead of `pdfs` — it downloads and MIME-unwraps the PDF itself and
  // returns it pre-decoded via `primaryB64` so processOneJob can skip the
  // normal downloadPdf(primaryId) call (there is no separate attachment id
  // for the embedded PDF to download by).
  buildJobs(pdfs: Array<{ id: string; filename: string }>, emls: Array<{ id: string; filename: string }>, downloadPdf: (id: string) => Promise<string>): Promise<Array<{ primaryId: string | null; secondaryId: string | null; primaryB64?: string }>>
  extract(primaryB64: string, secondaryB64: string | null): Promise<any>
  validate(parsed: any): { ok: boolean; problems: string[] }
  dedupeKey(parsed: any): string | null
  isEmpty(parsed: any): boolean
  // ADDED 2026-10-19: optional — returns a non-null comment body when a
  // genuinely extracted, non-empty order should NOT be processed at all
  // (e.g. Thomas Foods orders that ship from a different facility, not
  // CSW). Checked in processOneJob right after isEmpty and before the
  // dedupe check or any batch row is created — a skipped order was never
  // CSW's to track in order_agent_batches in the first place.
  shouldSkip?(parsed: any): string | null
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
    isEmpty: (parsed) => !parsed.transfer_order_number || !Array.isArray(parsed.items) || parsed.items.length === 0,
    ackBody: (parsed, ok, problems) => {
      const items = parsed.items || []
      const totalLots = items.reduce((s: number, it: any) => s + (it.lots?.length || 0), 0)
      const totalQty = items.reduce((s: number, it: any) => s + (Number(it.total_quantity) || 0), 0)
      return ok
        ? `Order agent: read Transfer Order ${parsed.transfer_order_number} (${items.length} item(s), ${totalLots} lot(s), ${totalQty} total each). Checking against current Datex inventory now...`
        : `Order agent: Transfer Order ${parsed.transfer_order_number || '(unknown)'} — extracted lot counts did not match the form's printed totals — flagged for manual entry.\n\n${problems.map((p) => `- ${p}`).join('\n')}`
    },
    batchFields: (parsed, ok, problems) => {
      const items = parsed.items || []
      const totalLots = items.reduce((s: number, it: any) => s + (it.lots?.length || 0), 0)
      const totalQty = items.reduce((s: number, it: any) => s + (Number(it.total_quantity) || 0), 0)
      const totalPrintedCount = items.reduce((s: number, it: any) => s + (Number(it.printed_total_count) || 0), 0)
      return {
        customer_code: 'richelieu',
        po_number: parsed.transfer_order_number,
        ship_date: parsed.posting_date ? new Date(parsed.posting_date).toISOString().slice(0, 10) : null,
        status: ok ? 'parsed' : 'validation_failed',
        flag_reason: ok ? null : `Printed-total validation failed: ${problems.join('; ')}`,
        line_count: totalLots,
        total_quantity: totalQty || null,
        pallet_count: totalPrintedCount || null,
        raw_extracted: parsed,
      }
    },
  },
  {
    code: 'pedone',
    domains: ['pedonepinsa.com'],
    async buildJobs(pdfs) {
      if (pdfs.length === 0) return []
      if (pdfs.length > 1) console.log(`[order-agent:pedone] multiple PDF attachments found on one email — using the first: ${pdfs.map((a) => a.filename).join(', ')}`)
      return [{ primaryId: pdfs[0].id, secondaryId: null }]
    },
    async extract(primaryB64) {
      return callClaude(PEDONE_PROMPT, [primaryB64], 'Extract this picking document as the JSON object described in your instructions.')
    },
    validate: validatePedone,
    dedupeKey: (parsed) => parsed.csw_csd_code || null,
    isEmpty: (parsed) => !parsed.csw_csd_code || !Array.isArray(parsed.lines) || parsed.lines.length === 0,
    ackBody: (parsed) => `Order agent: read ${parsed.csw_csd_code} (Cust PO ${parsed.cust_po}, ${parsed.lines.length} line(s)). Checking against current Datex inventory now...`,
    batchFields: (parsed) => ({
      customer_code: 'pedone',
      po_number: parsed.csw_csd_code,
      ship_date: parsed.scheduled_date ? new Date(parsed.scheduled_date).toISOString().slice(0, 10) : null,
      status: 'parsed',
      flag_reason: null,
      line_count: parsed.lines.length,
      total_quantity: (parsed.lines || []).reduce((s: number, l: any) => s + (Number(l.case_quantity) || 0), 0),
      pallet_count: null,
      raw_extracted: parsed,
    }),
  },
  {
    code: 'thomasfoods',
    domains: ['thomasfoodsusa.com'],
    async buildJobs(pdfs) {
      // FIXED 2026-10-19 (real failure, cnv_1coe9t78) — see section header
      // note above. Used to take only pdfs[0]; now one job per PDF, same
      // pattern as Richelieu.
      if (pdfs.length > 1) console.log(`[order-agent:thomasfoods] ${pdfs.length} PDF attachments found — processing each as its own order: ${pdfs.map((a) => a.filename).join(', ')}`)
      return pdfs.map((p) => ({ primaryId: p.id, secondaryId: null }))
    },
    async extract(primaryB64) {
      return callClaude(THOMAS_FOODS_PROMPT, [primaryB64], 'Extract this Fulfillment Authorization as the JSON object described in your instructions.')
    },
    validate: validateThomasFoods,
    dedupeKey: (parsed) => parsed.transfer_order_number || null,
    isEmpty: (parsed) => !parsed.transfer_order_number || !Array.isArray(parsed.lines) || parsed.lines.length === 0,
    shouldSkip: thomasFoodsSkipReason,
    ackBody: (parsed) => `Order agent: read ${parsed.transfer_order_number} (${parsed.fulfillment_authorization_number || 'no IF#'}, ${parsed.lines.length} lot line(s)). Checking against current Datex inventory now...`,
    batchFields: (parsed) => ({
      customer_code: 'thomasfoods',
      po_number: parsed.transfer_order_number,
      ship_date: parsed.ship_date ? new Date(parsed.ship_date).toISOString().slice(0, 10) : null,
      status: 'parsed',
      flag_reason: null,
      line_count: parsed.lines.length,
      total_quantity: (parsed.lines || []).reduce((s: number, l: any) => s + (Number(l.case_count) || 0), 0),
      pallet_count: null,
      raw_extracted: parsed,
    }),
  },
  {
    code: 'echolake',
    domains: ['echolakefoods.com'],
    async buildJobs(pdfs) {
      // FIXED 2026-10-27 (real failure, Echo Lake 438995/438996 cnv_1cqpihec):
      // used to take only pdfs[0] and silently log the rest — a second,
      // DIFFERENT order (438996) in the same email was dropped entirely,
      // never even flagged. Now one job per PDF, same pattern as
      // Richelieu/Thomas Foods/DSM.
      if (pdfs.length > 1) console.log(`[order-agent:echolake] ${pdfs.length} PDF attachments found — processing each as its own order: ${pdfs.map((a) => a.filename).join(', ')}`)
      return pdfs.map((p) => ({ primaryId: p.id, secondaryId: null }))
    },
    async extract(primaryB64) {
      return callClaude(ECHOLAKE_PROMPT, [primaryB64], 'Extract this Order Verification as the JSON object described in your instructions.')
    },
    validate: validateEchoLakeTotals,
    dedupeKey: (parsed) => parsed.order_number || null,
    isEmpty: (parsed) => !parsed.order_number || !Array.isArray(parsed.lines) || parsed.lines.length === 0,
    ackBody: (parsed, ok, problems) => ok
      ? `Order agent: read Order #${parsed.order_number} (${parsed.lines.length} line(s), ${parsed.printed_total_cases ?? '?'} total cases). Checking against current Datex inventory now...`
      : `Order agent: Order #${parsed.order_number || '(unknown)'} — extracted line totals did not match the form's printed totals — flagged for manual entry.\n\n${problems.map((p) => `- ${p}`).join('\n')}`,
    batchFields: (parsed, ok, problems) => ({
      customer_code: 'echolake',
      po_number: parsed.order_number,
      ship_date: parsed.ship_date ? new Date(parsed.ship_date).toISOString().slice(0, 10) : null,
      status: ok ? 'parsed' : 'validation_failed',
      flag_reason: ok ? null : `Printed-total validation failed: ${problems.join('; ')}`,
      line_count: parsed.lines.length,
      total_quantity: parsed.printed_total_cases ?? (parsed.lines || []).reduce((s: number, l: any) => s + (Number(l.case_quantity) || 0), 0),
      // FIXED 2026-10-26 (real failure, Echo Lake order 438995, cnv_1cqehhsk):
      // Echo Lake's printed "Pallets" total is cases / cs_per_pal and often
      // doesn't divide evenly (1384 / 84 = 16.48), but pallet_count is an
      // integer column — the raw printed value threw Postgres 22P02 and
      // killed the whole batch insert before the order was ever created.
      // Per Dan: the agent doesn't need to determine a pallet count at all
      // for this customer (the order is built from case_quantity alone,
      // see echolake.cjs) — leave it null like Pedone/Thomas Foods rather
      // than storing a rounded/derived number nobody asked for.
      pallet_count: null,
      raw_extracted: parsed,
    }),
  },
  {
    code: 'mccain',
    domains: ['mccain.com'],
    // McCain's PDF is never a direct attachment (see emlAttachments /
    // findPdfInMime above) — this downloads and MIME-unwraps each .eml
    // itself and returns the decoded PDF via primaryB64, so processOneJob
    // skips its normal downloadPdf(primaryId) call for this customer.
    // Confirmed one .eml per email, one PDF per .eml, 2026-10-24 (10 real
    // samples) — if a future email bundles more than one, this only
    // processes the first and logs the rest, same precedent as
    // Pedone/Echo Lake's single-attachment assumption.
    async buildJobs(pdfs, emls, downloadPdf) {
      if (emls.length === 0) return []
      if (emls.length > 1) console.log(`[order-agent:mccain] multiple .eml attachments found on one email — using the first: ${emls.map((a) => a.filename).join(', ')}`)
      const emlBase64 = await downloadPdf(emls[0].id)
      const found = extractPdfFromEmlBase64(emlBase64)
      if (!found) {
        console.log(`[order-agent:mccain] no PDF found inside forwarded email ${emls[0].filename} — see findPdfInMime encoding caveat in file header note`)
        return []
      }
      return [{ primaryId: null, secondaryId: null, primaryB64: found.base64 }]
    },
    async extract(primaryB64) {
      return callClaude(MCCAIN_PROMPT, [primaryB64], 'Extract this Shipping information / Delivery Note document as the JSON object described in your instructions.')
    },
    validate: validateMcCainTotals,
    dedupeKey: (parsed) => parsed.delivery_note_number || null,
    isEmpty: (parsed) => !parsed.delivery_note_number || !Array.isArray(parsed.items) || parsed.items.length === 0,
    ackBody: (parsed, ok, problems) => {
      const totalLines = (parsed.items || []).reduce((s: number, it: any) => s + (it.lines?.length || 0), 0)
      return ok
        ? `Order agent: read Delivery Note ${parsed.delivery_note_number} (${(parsed.items || []).length} item(s), ${totalLines} lot line(s), ${parsed.printed_total_weight ?? '?'} LB total). Checking against current Datex inventory now...`
        : `Order agent: Delivery Note ${parsed.delivery_note_number || '(unknown)'} — extracted line weights did not match the form's printed totals — flagged for manual entry.\n\n${problems.map((p) => `- ${p}`).join('\n')}`
    },
    batchFields: (parsed, ok, problems) => {
      const items = parsed.items || []
      const totalLines = items.reduce((s: number, it: any) => s + (it.lines?.length || 0), 0)
      const totalWeight = items.reduce((s: number, it: any) => s + (it.lines || []).reduce((s2: number, l: any) => s2 + (Number(l.weight) || 0), 0), 0)
      return {
        customer_code: 'mccain',
        po_number: parsed.delivery_note_number,
        ship_date: parsed.ship_date ? new Date(parsed.ship_date).toISOString().slice(0, 10) : null,
        status: ok ? 'parsed' : 'validation_failed',
        flag_reason: ok ? null : `Printed-total validation failed: ${problems.join('; ')}`,
        line_count: totalLines,
        total_quantity: parsed.printed_total_weight ?? totalWeight ?? null,
        pallet_count: null,
        raw_extracted: parsed,
      }
    },
  },
  {
    code: 'dsm',
    domains: ['dsm-firmenich.com'],
    async buildJobs(pdfs) {
      // UNCONFIRMED whether a DSM email can ever carry more than one PDF —
      // see section header note above. Processing every PDF found as its
      // own order is the safe default regardless, same as Richelieu/Thomas
      // Foods.
      if (pdfs.length > 1) console.log(`[order-agent:dsm] ${pdfs.length} PDF attachments found — processing each as its own order: ${pdfs.map((a) => a.filename).join(', ')}`)
      return pdfs.map((p) => ({ primaryId: p.id, secondaryId: null }))
    },
    async extract(primaryB64) {
      return callClaude(DSM_PROMPT, [primaryB64], 'Extract this Delivery Note (and its Picking list page) as the JSON object described in your instructions.')
    },
    validate: validateDSMTotals,
    dedupeKey: (parsed) => parsed.delivery_number || null,
    isEmpty: (parsed) => !parsed.delivery_number || !Array.isArray(parsed.lines) || parsed.lines.length === 0,
    ackBody: (parsed, ok, problems) => ok
      ? `Order agent: read Delivery ${parsed.delivery_number} (${parsed.lines.length} line(s)). Checking against current Datex inventory now — this will resolve to DSMEN5 or DSMFO8 based on the item number(s) on the order.`
      : `Order agent: Delivery ${parsed.delivery_number || '(unknown)'} — extracted line weights did not match the document's printed Net weight — flagged for manual entry.\n\n${problems.map((p) => `- ${p}`).join('\n')}`,
    batchFields: (parsed, ok, problems) => ({
      customer_code: 'dsm',
      po_number: parsed.delivery_number,
      ship_date: parsed.delivery_date ? new Date(parsed.delivery_date).toISOString().slice(0, 10) : null,
      status: ok ? 'parsed' : 'validation_failed',
      flag_reason: ok ? null : `Printed-total validation failed: ${problems.join('; ')}`,
      line_count: parsed.lines.length,
      total_quantity: (parsed.lines || []).reduce((s: number, l: any) => s + (Number(l.item_count) || 0), 0),
      pallet_count: null,
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
    // TEMPORARY FALLBACK (2026-10-24, remove once Dan confirms
    // ORDER_AGENT_INTERNAL_SECRET is set in this project's Edge Function
    // secrets — programmatic secret writes are still paused in the Supabase
    // dashboard): falls back to the pre-rename GRASSLAND_INTERNAL_SECRET
    // (same value) so this handoff still carries a real, matching secret in
    // the meantime — order-agent-resolve-background.cjs on Netlify (now
    // confirmed live) accepts either name during this window.
    const internalSecret = env('ORDER_AGENT_INTERNAL_SECRET') || env('GRASSLAND_INTERNAL_SECRET')
    const res = await fetch(NETLIFY_RESOLVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-order-agent-internal-secret': internalSecret },
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

// ADDED 2026-10-27 per Dan: a dedupe hit used to be a flat "not processing
// again" with no detail — fine when the PO really is a re-send of the same
// document, but on a real Echo Lake case the agent silently dropped a
// SECOND, different PO in the same email (see echolake.buildJobs fix
// above) which made the dedupe skip on the first PO look like the whole
// conversation had hard-failed. This walks the newly-parsed document
// against the already-stored raw_extracted for that PO and reports what,
// if anything, actually differs — so a true re-send comes back "nothing
// changed" and a genuinely different document (corrected quantities, a
// different lot, etc.) gets its differences spelled out in the comment
// instead of being silently discarded. This never creates or updates a
// batch row itself — a flagged difference still needs a human to decide
// what to do with it; the point is visibility, not auto-reconciliation.
function diffParsedOrders(oldObj: any, newObj: any, prefix = ''): string[] {
  const diffs: string[] = []
  const a = oldObj ?? {}
  const b = newObj ?? {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k
    const av = a[k]
    const bv = b[k]
    if (Array.isArray(av) || Array.isArray(bv)) {
      const aArr = Array.isArray(av) ? av : []
      const bArr = Array.isArray(bv) ? bv : []
      const len = Math.max(aArr.length, bArr.length)
      for (let i = 0; i < len; i++) {
        if (i >= aArr.length) { diffs.push(`${path}[${i}]: new line — ${JSON.stringify(bArr[i])}`); continue }
        if (i >= bArr.length) { diffs.push(`${path}[${i}]: line removed (was ${JSON.stringify(aArr[i])})`); continue }
        const x = aArr[i], y = bArr[i]
        if (x && typeof x === 'object' && y && typeof y === 'object') {
          diffs.push(...diffParsedOrders(x, y, `${path}[${i}]`))
        } else if (JSON.stringify(x) !== JSON.stringify(y)) {
          diffs.push(`${path}[${i}]: ${JSON.stringify(x)} → ${JSON.stringify(y)}`)
        }
      }
    } else if (av && typeof av === 'object' && bv && typeof bv === 'object') {
      diffs.push(...diffParsedOrders(av, bv, path))
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      diffs.push(`${path}: ${JSON.stringify(av)} → ${JSON.stringify(bv)}`)
    }
  }
  return diffs
}

async function processOneJob(conversationId: string, customer: CustomerConfig, job: { primaryId: string | null; secondaryId: string | null; primaryB64?: string }, downloadPdf: (id: string) => Promise<string>) {
  // McCain's buildJobs already downloaded + MIME-unwrapped the PDF itself
  // (there's no separate attachment id for the embedded PDF to pass here) —
  // see CustomerConfig.buildJobs doc comment above.
  const primaryB64 = job.primaryB64 || await downloadPdf(job.primaryId as string)
  const secondaryB64 = job.secondaryId ? await downloadPdf(job.secondaryId) : null
  const parsed = await customer.extract(primaryB64, secondaryB64)

  if (customer.isEmpty(parsed)) {
    await withMcp((call) => call('add_comment', { conversationId, body: `Order agent could not read one of this conversation's documents (missing key fields) — left for manual entry.` }))
    return { ok: false, reason: 'extraction empty' }
  }

  // ADDED 2026-10-19: a real, fully-readable order that still isn't CSW's
  // to process (see CustomerConfig.shouldSkip doc comment above). Checked
  // before dedupe/batch creation — this order never gets a row in
  // order_agent_batches at all, since CSW never owned it.
  if (customer.shouldSkip) {
    const skipReason = customer.shouldSkip(parsed)
    if (skipReason) {
      await withMcp((call) => call('add_comment', { conversationId, body: skipReason }))
      return { ok: false, reason: 'skipped-not-csw' }
    }
  }

  const key = customer.dedupeKey(parsed)
  if (key) {
    const existing = await sbGet(`order_agent_batches?po_number=eq.${encodeURIComponent(key)}&select=id,status,raw_extracted&limit=1`)
    if (Array.isArray(existing) && existing[0]) {
      const prior = existing[0]
      // Soft fail: never hard-stop the conversation over a dedupe hit — see
      // diffParsedOrders doc comment above. Compare this PDF's parsed
      // content against what was actually stored for that PO and say so,
      // rather than a bare "not processing again" that reads as an error.
      const diffs = diffParsedOrders(prior.raw_extracted, parsed)
      const body = diffs.length === 0
        ? `Order agent: ${key} already has a batch (status ${prior.status}) — not processing again. This PDF matches what's already on file, no differences found.`
        : `Order agent: ${key} already has a batch (status ${prior.status}) — not processing again, but this PDF doesn't match what's on file:\n\n${diffs.map((d) => `- ${d}`).join('\n')}\n\nFlagging for manual review rather than creating a second batch.`
      await withMcp((call) => call('add_comment', { conversationId, body }))
      return { ok: false, reason: 'duplicate', diffs }
    }
  }

  const totalsCheck = customer.validate(parsed)
  const batchRows = await sbPost('order_agent_batches', {
    front_conversation_id: conversationId,
    ...customer.batchFields(parsed, totalsCheck.ok, totalsCheck.problems),
  })
  const batch = batchRows[0]

  await withMcp((call) => call('add_comment', { conversationId, body: customer.ackBody(parsed, totalsCheck.ok, totalsCheck.problems) }))
  await sbPatch(`order_agent_batches?id=eq.${batch.id}`, { ack_comment_posted: true }).catch(() => {})

  if (totalsCheck.ok) await triggerNetlifyResolve(batch.id)

  return { ok: true, batchId: batch.id }
}

async function runOrderAgentForMention(conversationId: string) {
  if (env('ORDER_AGENT_ENABLED') === 'false') return { skipped: 'kill switch' }

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
      // ADDED 2026-10-24 for McCain: that customer never attaches a PDF
      // directly (see emlAttachments/findPdfInMime above) — a candidate
      // message now also counts as "found" if it carries a .eml instead.
      let emls: Array<{ id: string; filename: string }> = []
      const MAX_PAGES = 5
      for (let page = 0; page < MAX_PAGES && !triggeringMsgRaw; page++) {
        const convRaw: string = cursor
          ? await call('read_conversation', { conversationId, limit: 50, cursor })
          : await call('read_conversation', { conversationId, limit: 50 })
        const inboundIds = allInboundMessageIds(convRaw)
        // Find the first (newest-first) inbound message that actually has
        // PDF (or, for McCain, .eml) attachments — the message that
        // triggered this, not just whichever inbound entry happens to be
        // most recent (a Richelieu thread can have later inbound replies
        // about driver ETAs etc. with no attachments at all).
        for (const messageId of inboundIds) {
          const msgRaw = await call('read_message', { messageId })
          const foundPdfs = pdfAttachments(msgRaw)
          const foundEmls = emlAttachments(msgRaw)
          if (foundPdfs.length > 0 || foundEmls.length > 0) { triggeringMsgRaw = msgRaw; pdfs = foundPdfs; emls = foundEmls; break }
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
      const jobs = await customer.buildJobs(pdfs, emls, downloadPdf)
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
