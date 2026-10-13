'use strict'

/**
 * Grassland order agent: Front agent path. Added 2026-10-13.
 *
 * Same architecture as customer-lens (lib/lens-front-agent.cjs) and
 * scheduling_agent: a teammate @mentions the agent in a Front conversation,
 * Front POSTs a thin `mention` event, and the agent reads the thread + acts
 * via Front's MCP server (https://mcp.frontapp.com/mcp) using an OAuth
 * client_credentials token (the agent's own Credentials screen).
 *
 * Unlike customer-lens (comment-only, read-only), this agent needs to:
 *   1. Read the conversation to find the Grassland release-form PDF
 *      attachment on the triggering (or most recent inbound) message.
 *   2. Download that attachment's content.
 *   3. Hand it to grassland-order-shared.cjs for the real work.
 *   4. Post an internal comment back with the result (never a customer-
 *      facing reply — same comment-only posture as customer-lens).
 *
 * TODO-VERIFY (2026-10-13): steps 1-2 use `get_attachment`/`download_attachment`-
 * shaped tool names below as a placeholder. No existing code in this repo
 * has ever downloaded a Front attachment via the MCP server (lens-front-agent
 * only ever calls read_conversation/add_comment). Confirm the actual tool
 * name and its argument/return shape against Front's live MCP tool list
 * (call tools/list once against https://mcp.frontapp.com/mcp with this
 * agent's token) before relying on this in production — do not assume the
 * guess below is correct without checking.
 *
 * Env: FRONT_GRASSLAND_AGENT_CLIENT_ID, FRONT_GRASSLAND_AGENT_CLIENT_SECRET,
 *      FRONT_GRASSLAND_AGENT_TOKEN_URL (the "Auth URL" on the agent's
 *      Credentials screen) — falls back to FRONT_AGENT_* generic names,
 *      same convention as lens-front-agent.cjs. Plus everything
 *      grassland-order-shared.cjs needs (ANTHROPIC_API_KEY, MOTHERDUCK_TOKEN,
 *      DATEX_SMARTUP_*, SUPABASE_*). GRASSLAND_AGENT_ACTIVE=true flips real
 *      Datex pushes on; anything else (including unset) stays dry-run.
 */

const { processGrasslandReleaseForm } = require('./grassland-order-shared.cjs')

const MCP_URL = 'https://mcp.frontapp.com/mcp'
const MCP_PROTOCOL = '2025-11-25'

// ---------------------------------------------------------------------------
// Agent OAuth (client_credentials) — identical pattern to lens-front-agent.cjs
// ---------------------------------------------------------------------------

let cachedToken = null

async function getAgentToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) return cachedToken.token
  const env = process.env
  const CLIENT_ID = env.FRONT_GRASSLAND_AGENT_CLIENT_ID || env.FRONT_AGENT_CLIENT_ID
  const CLIENT_SECRET = env.FRONT_GRASSLAND_AGENT_CLIENT_SECRET || env.FRONT_AGENT_CLIENT_SECRET
  const TOKEN_URL = env.FRONT_GRASSLAND_AGENT_TOKEN_URL || env.FRONT_AGENT_TOKEN_URL
  if (!CLIENT_ID || !CLIENT_SECRET || !TOKEN_URL) {
    throw new Error('FRONT_GRASSLAND_AGENT_CLIENT_ID / _CLIENT_SECRET / _TOKEN_URL not configured')
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Agent token request failed ${res.status}: ${text.slice(0, 300)}`)
  const data = JSON.parse(text)
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 900) * 1000 }
  return cachedToken.token
}

// ---------------------------------------------------------------------------
// Minimal MCP client — identical shape to lens-front-agent.cjs
// ---------------------------------------------------------------------------

function parseRpcResponse(raw, contentType, id) {
  if ((contentType || '').includes('text/event-stream')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const msg = JSON.parse(payload)
        if (msg.id === id) return msg
      } catch (_) { /* ignore non-JSON data lines */ }
    }
    throw new Error('MCP: no matching response in event stream')
  }
  return JSON.parse(raw)
}

async function mcpPost(token, state, body, expectResponse) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  }
  if (state.sessionId) headers['Mcp-Session-Id'] = state.sessionId
  if (state.protocol) headers['MCP-Protocol-Version'] = state.protocol
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) state.sessionId = sid
  const raw = await res.text()
  if (!res.ok) throw new Error(`MCP ${body.method} -> ${res.status}: ${raw.slice(0, 400)}`)
  if (!expectResponse) return null
  const msg = parseRpcResponse(raw, res.headers.get('content-type'), body.id)
  if (msg.error) throw new Error(`MCP ${body.method} error: ${JSON.stringify(msg.error).slice(0, 400)}`)
  return msg.result
}

async function withMcp(fn) {
  const token = await getAgentToken()
  const state = { sessionId: null, protocol: null }
  const init = await mcpPost(
    token,
    state,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'csw-grassland-order-agent', version: '1.0.0' } } },
    true
  )
  state.protocol = (init && init.protocolVersion) || MCP_PROTOCOL
  await mcpPost(token, state, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)

  let nextId = 2
  const callTool = async (name, args) => {
    const result = await mcpPost(token, state, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, true)
    return result // callers here need structured content (attachments), not just joined text — unlike lens, which only ever needs text
  }
  return fn(callTool)
}

function textFromResult(result) {
  return (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

// ---------------------------------------------------------------------------
// Attachment discovery + download
// ---------------------------------------------------------------------------

function tryJson(s) {
  try { return JSON.parse(s) } catch { return null }
}

// Scans a read_conversation result (format undocumented — same caveat as
// lens-front-agent.cjs) for anything that looks like a PDF attachment
// reference and returns the most recent one.
function findPdfAttachmentRef(readConversationRaw) {
  const parsed = tryJson(readConversationRaw)
  const found = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    const filename = node.filename || node.name
    const contentType = node.content_type || node.contentType || node.type
    if (filename && /\.pdf$/i.test(filename)) found.push(node)
    else if (contentType && /pdf/i.test(contentType)) found.push(node)
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(parsed)
  return found.length ? found[found.length - 1] : null
}

// TODO-VERIFY: placeholder tool name/args — see file header.
async function downloadAttachmentBase64(callTool, attachmentRef) {
  const result = await callTool('download_attachment', {
    attachment_id: attachmentRef.id || attachmentRef.attachment_id,
    message_id: attachmentRef.message_id,
  })
  const base64 = result?.content?.find((c) => c.type === 'resource' || c.type === 'document' || c.data)
  const data = base64?.data || base64?.resource?.data
  if (!data) throw new Error('download_attachment returned no recognizable base64 payload — confirm the real MCP tool shape')
  return data
}

// ---------------------------------------------------------------------------
// Main entry: one mention event in, one internal comment out.
// ---------------------------------------------------------------------------

async function runGrasslandAgentForMention({ conversationId, commentId }) {
  try {
    const raw = await withMcp(async (call) => {
      const result = await call('read_conversation', { conversationId, limit: 200 })
      return textFromResult(result)
    })

    const attachmentRef = findPdfAttachmentRef(raw)
    if (!attachmentRef) {
      await postComment(conversationId, 'Grassland order agent: no PDF attachment found on this conversation — nothing to process.')
      return { ok: false, error: 'No PDF attachment found' }
    }

    const pdfBase64 = await withMcp((call) => downloadAttachmentBase64(call, attachmentRef))

    const active = process.env.GRASSLAND_AGENT_ACTIVE === 'true'
    const result = await processGrasslandReleaseForm({ conversationId, pdfBase64, active })

    const body = formatResultComment(result, active)
    await postComment(conversationId, body)

    return result
  } catch (e) {
    try {
      await postComment(conversationId, `Grassland order agent could not process this release form. Error: ${e.message}`)
    } catch (_) { /* best effort */ }
    return { ok: false, error: e.message }
  }
}

async function postComment(conversationId, body) {
  await withMcp((call) => call('add_comment', { conversationId, body }))
}

function formatResultComment(result, active) {
  if (!result.ok) {
    if (result.stage === 'dedupe') return `Grassland order agent: ${result.error}`
    if (result.stage === 'extract') return `Grassland order agent could not read this release form: ${result.error}`
    if (result.stage === 'validate_totals') return `Grassland order agent: extracted line totals did not match the form's printed totals — flagged for manual entry.\n\n${result.problems.map((p) => `- ${p}`).join('\n')}`
    if (result.stage === 'resolve') return `Grassland order agent: could not safely resolve this order — flagged for manual entry.\nReason: ${result.flagReason}`
    if (result.stage === 'push') return `Grassland order agent: order creation failed. ${result.error}\n(Tracked as batch ${result.batchId} — check grassland_order_batches.)`
    return `Grassland order agent: ${result.error || 'unknown failure'}`
  }
  if (result.dryRun) {
    return `Grassland order agent (dry run — GRASSLAND_AGENT_ACTIVE not set): parsed and resolved cleanly.\nProject: ${result.projectCode}, ${result.lineCount} line(s). No order was created. Review batch ${result.batchId} before enabling real pushes.`
  }
  return `Grassland order agent: order ${result.orderId} created in Datex (batch ${result.batchId}). Reconciliation will verify line-level accuracy shortly.`
}

module.exports = { runGrasslandAgentForMention, findPdfAttachmentRef, decodeNote: 'see TODO-VERIFY in file header for attachment tool shape' }
