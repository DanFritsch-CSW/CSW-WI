// Grassland order agent: Front webhook as a Supabase Edge Function.
// Added 2026-10-13. Mirrors scheduling-agent-webhook's architecture exactly
// (same reason: Netlify's function env-var limits forced both off Netlify,
// and a Deno Edge Function can't run the native duckdb module MotherDuck
// needs anyway — see the split below).
//
// WHAT THIS FUNCTION DOES, AND DOES NOT DO:
// This function owns the Front/MCP side only: verify the webhook, read the
// triggering email, find and download the release-form PDF, have Claude
// read it into structured JSON, and do the one validation check that needs
// no external data (the PDF's own printed subtotals). It writes that result
// to `grassland_order_batches` and posts an initial ack comment, then hands
// off to a Netlify function for everything that needs live Datex data
// (which project a storage lot belongs to, which license plate a pallet
// number decodes to, the actual order push) — Deno Edge Functions cannot
// run the native `duckdb` module MotherDuck queries depend on, the same
// reason scheduling-agent-webhook pre-syncs its own reference tables
// (scheduling_carriers/scheduling_owners) into Supabase instead of querying
// MotherDuck directly. Grassland's resolution step can't be pre-synced the
// same way (it's live, changes with every shipment), so it has to run
// where MotherDuck access actually exists: Netlify.
//
// Handoff: after writing the batch row, this POSTs {batchId} to
// grassland-order-resolve-background on Netlify (fire-and-forget, under
// EdgeRuntime.waitUntil, same self-triggering pattern
// dpi-import-push-background.cjs already uses for its own continuation
// chaining). That Netlify function does the MotherDuck resolution + Datex
// push, then calls the sibling grassland-order-reply Edge Function to post
// the final result comment — it reuses this agent's own OAuth credentials
// without Netlify ever needing a copy of them.
//
// IMPORTANT: this file is the committed RECORD of what's deployed on
// Supabase (project ppsbqekabtbwsmvdiyga, function slug
// grassland-order-webhook) — it is NOT auto-deployed from this repo.
// Supabase Edge Functions here are deployed directly via the Supabase MCP
// tool, same as scheduling-agent-webhook/lens-webhook (neither of which
// had their source tracked in git before this file — there was no
// supabase/functions/ folder in this repo until now). After editing this
// file, the change must ALSO be deployed to Supabase directly for it to
// take effect — a git push alone does nothing here, unlike netlify/functions/.
//
// TODO-VERIFY (2026-10-13): findPdfAttachment/downloadAttachment below are
// modeled on the REGULAR Front OAuth connector's tool shapes
// (read_message -> attachments[], get_attachment(attachmentId) ->
// {filename, contentType, size, downloadUrl}) since no code in this repo
// has ever downloaded an attachment through Front's EXTERNAL AGENT MCP
// server (mcp.frontapp.com) specifically. The two servers share Front's
// general naming conventions, so this is an informed guess, not a blind
// one — but it is still unconfirmed.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   FRONT_GRASSLAND_AGENT_CLIENT_ID, FRONT_GRASSLAND_AGENT_CLIENT_SECRET,
//   FRONT_GRASSLAND_AGENT_SIGNING_SECRET, FRONT_GRASSLAND_AGENT_TOKEN_URL,
//   ANTHROPIC_API_KEY, GRASSLAND_INTERNAL_SECRET (shared with the Netlify
//   resolve function — proves the handoff call actually came from here).
// Auto-provided: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Kill switch: GRASSLAND_AGENT_ENABLED=false.
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
// FIXED 2026-10-13: the ack_comment_posted update below was calling sbPost
// (method POST) against a filtered path (?id=eq.N) — that's an INSERT
// attempt, not an update, and it was silently failing every time (caught
// by a .catch(() => {}) at the call site) because the insert violated
// NOT NULL constraints on columns it didn't supply. Found while
// diagnosing why ack_comment_posted stayed false despite the ack comment
// genuinely posting. PATCH is the correct verb for an update-by-filter.
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
  const init = await mcpPost(token, st, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'csw-grassland-order-agent', version: '1.0.0' } } }, true)
  st.protocol = (init && init.protocolVersion) || MCP_PROTOCOL
  await mcpPost(token, st, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  let next = 2
  // Returns the raw tool result (not just joined text) — this file needs
  // structured content (attachments array) from read_message, unlike
  // scheduling-agent-webhook which only ever needs text.
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
// Attachment discovery + download
// ---------------------------------------------------------------------------

function findInboundMessageId(readConversationRaw: string): string | null {
  const parsed = tryJson(readConversationRaw)
  const results = parsed?.entries?.results
  if (!Array.isArray(results)) return null
  const inbound = results.find((e: any) => e.kind === 'message_inbound')
  return inbound?.messageId || null
}

// See file header TODO-VERIFY. Expects read_message to return an
// `attachments` array with {id, filename, contentType} per the regular
// Front connector's shape.
function findPdfAttachment(readMessageRaw: string): { id: string; filename: string } | null {
  const parsed = tryJson(readMessageRaw)
  const attachments = Array.isArray(parsed?.attachments) ? parsed.attachments : []
  const pdf = attachments.find(
    (a: any) => /\.pdf$/i.test(a.filename || '') || /pdf/i.test(a.contentType || a.content_type || '')
  )
  return pdf ? { id: pdf.id || pdf.attachmentId, filename: pdf.filename || 'release-form.pdf' } : null
}

// Converts bytes to base64 in chunks (avoids call-stack blowup from
// String.fromCharCode(...hugeArray) on a multi-page PDF).
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// get_attachment returns metadata + a short-lived downloadUrl (per the
// regular connector's documented shape) — this fetches that URL directly
// rather than expecting inline base64 from the MCP call itself.
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

// ---------------------------------------------------------------------------
// Claude extraction + printed-totals validation (ported from
// grassland-order-shared.cjs — pure logic, no MotherDuck, safe to duplicate
// across runtimes)
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You read a Grassland Dairy Products "Release Form" PDF (a cold-storage outbound release instruction) and return ONLY a JSON object — no prose, no markdown fences.

Shape:
{
  "po_number": string,
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
- One entry in "lines" per table row in the PDF, in the order printed.
- Copy numbers and codes EXACTLY as printed. Never estimate, round, or infer a value that is not visible on the page.
- "storage_lot_totals" must include every "STORAGE LOT: X TOTALS" line in the document.
- "grand_total" comes from the "RELEASE SITE: ... TOTALS" line (pallet_count is the "PALLET COUNT:" value).
- If the document has multiple pages, include every page's lines in one combined "lines" array.
- If any field is illegible or absent, use null for that field rather than guessing.`

async function extractReleaseForm(pdfBase64: string): Promise<any> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: 'Extract this release form as the JSON object described in your instructions.' },
        ],
      }],
    }),
  })
  const raw = await res.text()
  let data: any
  try { data = JSON.parse(raw) } catch { throw new Error(`Claude API returned non-JSON: ${raw.slice(0, 300)}`) }
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data).slice(0, 500)}`)
  const block = (data.content || []).find((b: any) => b.type === 'text')
  if (!block) throw new Error('Claude API returned no text block')
  // FIXED 2026-10-13 (real failure, cnv_1cmqpvx0): the system prompt says
  // "no markdown fences" but the model wrapped its output in ```json ... ```
  // anyway on this real PDF, and this code called JSON.parse directly on
  // the raw text with no fence-stripping — scheduling-agent-webhook already
  // has this exact guard (its own `cleaned` step); this file never did.
  // Also bumped max_tokens 4000 -> 8000: the error comment's visible JSON
  // looked truncated, which combined with the fence issue to look worse
  // than it was, but a larger multi-page release form could plausibly need
  // more than 4000 tokens for its "lines" array alone.
  const cleaned = block.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Claude's response was cut off at the token limit before finishing the JSON — this release form may have more lines than expected. Raw (truncated) output: ${cleaned.slice(0, 500)}`)
  }
  try { return JSON.parse(cleaned) } catch { throw new Error(`Model output was not valid JSON even after stripping markdown fences: ${cleaned.slice(0, 500)}`) }
}

function validateAgainstPrintedTotals(parsed: any): { ok: boolean; problems: string[] } {
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
  if (grand.pallet_count != null && lines.length !== Number(grand.pallet_count)) {
    problems.push(`Number of extracted pallet lines ${lines.length} != printed PALLET COUNT ${grand.pallet_count}`)
  }
  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function triggerNetlifyResolve(batchId: number) {
  try {
    await fetch(NETLIFY_RESOLVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-grassland-internal-secret': env('GRASSLAND_INTERNAL_SECRET') },
      body: JSON.stringify({ batchId }),
    })
  } catch (e) {
    console.error('[grassland-order] failed to trigger Netlify resolve:', (e as Error).message)
  }
}

async function runGrasslandAgentForMention(conversationId: string) {
  if (env('GRASSLAND_AGENT_ENABLED') === 'false') return { skipped: 'kill switch' }

  try {
    const result = await withMcp(async (call) => {
      const convRaw = await call('read_conversation', { conversationId, limit: 20 })
      const messageId = findInboundMessageId(convRaw)
      if (!messageId) throw new Error('No inbound message found in conversation')

      const msgRaw = await call('read_message', { messageId })
      const attachment = findPdfAttachment(msgRaw)
      if (!attachment) return { noAttachment: true }

      const pdfBase64 = await downloadAttachmentBase64(call, attachment.id)
      const parsed = await extractReleaseForm(pdfBase64)
      return { parsed }
    })

    if ((result as any).noAttachment) {
      await withMcp((call) => call('add_comment', { conversationId, body: 'Grassland order agent: no PDF attachment found on this conversation — nothing to process.' }))
      return { ok: false, reason: 'no attachment' }
    }

    const parsed = (result as any).parsed
    if (!parsed.po_number || !Array.isArray(parsed.lines) || parsed.lines.length === 0) {
      await withMcp((call) => call('add_comment', { conversationId, body: 'Grassland order agent could not read this release form (no PO number or no lines found) — left for manual entry.' }))
      return { ok: false, reason: 'extraction empty' }
    }

    // Dedupe on PO number — same business key the Netlify side also checks.
    const existing = await sbGet(`grassland_order_batches?po_number=eq.${encodeURIComponent(parsed.po_number)}&select=id,status&limit=1`)
    if (Array.isArray(existing) && existing[0]) {
      await withMcp((call) => call('add_comment', { conversationId, body: `Grassland order agent: PO ${parsed.po_number} already has a batch (status ${existing[0].status}) — not processing again.` }))
      return { ok: false, reason: 'duplicate' }
    }

    const totalsCheck = validateAgainstPrintedTotals(parsed)
    const totalQty = (parsed.lines || []).reduce((s: number, l: any) => s + (Number(l.item_count) || 0), 0)

    const batchRows = await sbPost('grassland_order_batches', {
      front_conversation_id: conversationId,
      po_number: parsed.po_number,
      release_site: parsed.release_site || null,
      ship_date: parsed.ship_date ? new Date(parsed.ship_date).toISOString().slice(0, 10) : null,
      status: totalsCheck.ok ? 'parsed' : 'validation_failed',
      flag_reason: totalsCheck.ok ? null : `Printed-total validation failed: ${totalsCheck.problems.join('; ')}`,
      line_count: parsed.lines.length,
      total_quantity: totalQty,
      pallet_count: parsed.grand_total?.pallet_count ?? parsed.lines.length,
      raw_extracted: parsed,
    })
    const batch = batchRows[0]

    const ackBody = totalsCheck.ok
      ? `Grassland order agent: read PO ${parsed.po_number} (${parsed.lines.length} line(s)). Checking against current Datex inventory now...`
      : `Grassland order agent: extracted line totals did not match the form's printed totals — flagged for manual entry.\n\n${totalsCheck.problems.map((p) => `- ${p}`).join('\n')}`
    await withMcp((call) => call('add_comment', { conversationId, body: ackBody }))
    await sbPatch(`grassland_order_batches?id=eq.${batch.id}`, { ack_comment_posted: true }).catch(() => {})

    if (totalsCheck.ok) await triggerNetlifyResolve(batch.id)

    return { ok: true, batchId: batch.id }
  } catch (e) {
    const msg = (e as Error).message
    try {
      await withMcp((call) => call('add_comment', { conversationId, body: `Grassland order agent could not process this release form. Error: ${msg}` }))
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
      console.warn('[grassland-order] signature check failed or secret not configured')
      return ok()
    }
    const p = JSON.parse(raw || '{}')
    console.log('[grassland-order] event', JSON.stringify({ type: p.type, id: p.event_id }))
    if (p.type !== 'mention' || !p.conversation_id || !p.comment_id) return ok()

    const work = runGrasslandAgentForMention(p.conversation_id)
      .then((r) => console.log('[grassland-order] result', JSON.stringify(r)))
      .catch((e) => console.error('[grassland-order] error', (e as Error).message))
    // deno-lint-ignore no-explicit-any
    ;(globalThis as any).EdgeRuntime?.waitUntil(work)
    return ok()
  } catch (e) {
    console.error('[grassland-order] fatal', (e as Error).message)
    return ok()
  }
})
