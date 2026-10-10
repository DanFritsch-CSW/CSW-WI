'use strict'

/**
 * Customer Lens: Front agent path (phase 2). Added 2026-10-10.
 *
 * Front's native Agents feature: a teammate @mentions the agent in a comment,
 * Front POSTs a thin `mention` event ({event_id, type, conversation_id,
 * comment_id}), and the agent reads the thread + posts via Front's MCP server
 * (https://mcp.frontapp.com/mcp) using an OAuth client_credentials token.
 *
 * COMMENT-ONLY BY DESIGN: the only MCP write tool this file ever calls is
 * add_comment. There is no draft/send/assign/status code path. Also grant the
 * agent comment-level permissions only in Front (Agents > Permissions).
 *
 * Reuses lens-shared.cjs for context assembly, the model call, and run logging
 * (runLensFromText), then re-tags that run row as source='front'.
 *
 * Env: FRONT_AGENT_CLIENT_ID, FRONT_AGENT_CLIENT_SECRET, FRONT_AGENT_TOKEN_URL
 *      (the "Auth URL" on the agent's Credentials screen), plus the Supabase /
 *      Anthropic vars lens-shared already uses. LENS_ENABLED=false is the kill
 *      switch.
 */

const {
  loadFacilityKeys,
  runLensFromText,
  parseOverrides,
} = require('./lens-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY

const MCP_URL = 'https://mcp.frontapp.com/mcp'
const MCP_PROTOCOL = '2025-11-25'
const INTERNAL_DOMAINS = ['csw-wi.com']
const MAX_THREAD_CHARS = 30000

// ---------------------------------------------------------------------------
// Supabase (tiny REST helpers, same pattern as lens-shared)
// ---------------------------------------------------------------------------

function sbHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  }
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() })
  const text = await res.text()
  if (!res.ok) throw new Error(text)
  return text ? JSON.parse(text) : null
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  })
  if (!res.ok) throw new Error(await res.text())
}

// ---------------------------------------------------------------------------
// Agent OAuth (client_credentials). Token lives in memory only (~15 min).
// ---------------------------------------------------------------------------

let cachedToken = null // { token, expiresAt }

async function getAgentToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) return cachedToken.token
  const { FRONT_AGENT_CLIENT_ID, FRONT_AGENT_CLIENT_SECRET, FRONT_AGENT_TOKEN_URL } = process.env
  if (!FRONT_AGENT_CLIENT_ID || !FRONT_AGENT_CLIENT_SECRET || !FRONT_AGENT_TOKEN_URL) {
    throw new Error('FRONT_AGENT_CLIENT_ID / FRONT_AGENT_CLIENT_SECRET / FRONT_AGENT_TOKEN_URL not configured')
  }
  const res = await fetch(FRONT_AGENT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: FRONT_AGENT_CLIENT_ID,
      client_secret: FRONT_AGENT_CLIENT_SECRET,
    }).toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Agent token request failed ${res.status}: ${text.slice(0, 300)}`)
  const data = JSON.parse(text)
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 900) * 1000 }
  return cachedToken.token
}

// ---------------------------------------------------------------------------
// Minimal MCP client (streamable HTTP, JSON-RPC over fetch)
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

// One short-lived session per call batch.
async function withMcp(fn) {
  const token = await getAgentToken()
  const state = { sessionId: null, protocol: null }
  const init = await mcpPost(
    token,
    state,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'csw-customer-lens', version: '1.0.0' },
      },
    },
    true
  )
  state.protocol = (init && init.protocolVersion) || MCP_PROTOCOL
  await mcpPost(token, state, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)

  let nextId = 2
  const callTool = async (name, args) => {
    const result = await mcpPost(
      token,
      state,
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
      true
    )
    const text = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    if (result.isError) throw new Error(`MCP tool ${name} failed: ${text.slice(0, 400)}`)
    return text
  }
  return fn(callTool)
}

// ---------------------------------------------------------------------------
// Thread helpers. The MCP read_conversation output shape is not documented in
// detail, so everything here tolerates JSON or plain text.
// ---------------------------------------------------------------------------

function tryJson(s) {
  try { return JSON.parse(s) } catch { return null }
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function findById(node, id) {
  if (!node || typeof node !== 'object') return null
  if (node.id === id) return node
  for (const v of Object.values(node)) {
    const hit = findById(v, id)
    if (hit) return hit
  }
  return null
}

function extractRequestText(raw, commentId) {
  const parsed = tryJson(raw)
  const node = parsed ? findById(parsed, commentId) : null
  const body = node && (node.body || node.text || node.content)
  return body ? stripTags(String(body)) : ''
}

function extractExternalHandles(raw) {
  const found = new Set()
  for (const m of raw.matchAll(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g)) {
    const h = m[0].toLowerCase()
    if (INTERNAL_DOMAINS.includes(h.split('@')[1])) continue
    found.add(h)
  }
  return [...found]
}

async function resolveAccountKeyFromHandles(handles) {
  if (!handles.length) return null
  const maps = await sbGet('lens_account_map?select=match_type,match_value,account_key')
  const byEmail = new Map()
  const byDomain = new Map()
  for (const m of maps || []) {
    const v = (m.match_value || '').toLowerCase()
    if (m.match_type === 'email') byEmail.set(v, m.account_key)
    if (m.match_type === 'domain') byDomain.set(v, m.account_key)
  }
  for (const h of handles) if (byEmail.has(h)) return byEmail.get(h)
  for (const h of handles) {
    const d = h.split('@')[1]
    if (byDomain.has(d)) return byDomain.get(d)
  }
  return null
}

// ---------------------------------------------------------------------------
// Main entry: one mention event in, one internal comment out.
// ---------------------------------------------------------------------------

async function runLensForMention({ conversationId, commentId, eventId }) {
  if (process.env.LENS_ENABLED === 'false') return { skipped: 'kill switch (LENS_ENABLED=false)' }

  // At-least-once delivery: skip a comment we already answered.
  const dupes = await sbGet(
    `lens_runs?source=eq.front&front_comment_id=eq.${encodeURIComponent(commentId)}&select=id&limit=1`
  )
  if (dupes && dupes.length) return { skipped: 'duplicate comment_id', commentId }

  try {
    const raw = await withMcp((call) => call('read_conversation', { conversationId, limit: 200 }))
    const requestText = extractRequestText(raw, commentId)
    const threadText = raw.length > MAX_THREAD_CHARS
      ? '[...older content truncated...]\n' + raw.slice(raw.length - MAX_THREAD_CHARS)
      : raw

    const overrides = parseOverrides(requestText)
    const accountKey = overrides.accountKey || (await resolveAccountKeyFromHandles(extractExternalHandles(raw)))
    const allFacilities = await loadFacilityKeys()
    const hay = `${threadText}\n${requestText}`.toLowerCase()
    const facilityKeys = overrides.facilityKeys.length
      ? overrides.facilityKeys
      : allFacilities.filter((k) => hay.includes(k.toLowerCase()))

    const result = await runLensFromText({ text: threadText, requestText, accountKey, facilityKeys })

    let posted = false
    let error = result.error
    if (result.ok && result.output) {
      const header =
        `Customer Lens${accountKey ? ` (${accountKey})` : ' (account not identified)'}` +
        `${facilityKeys.length ? ` | ${facilityKeys.join(', ')}` : ''}\n\n`
      try {
        await withMcp((call) => call('add_comment', { conversationId, body: header + result.output }))
        posted = true
      } catch (e) {
        error = `Comment post failed: ${e.message}`
      }
    }

    // Re-tag the run row that runLensFromText wrote as a Front run.
    if (result.runId) {
      try {
        await sbPatch(`lens_runs?id=eq.${result.runId}`, {
          source: 'front',
          front_conversation_id: conversationId,
          front_comment_id: commentId,
          error: error || null,
        })
      } catch (_) { /* best effort */ }
    }
    return { ok: !error, posted, accountKey, facilityKeys, runId: result.runId, error }
  } catch (e) {
    // Leave a trace in the Runs tab even when the read/auth step fails.
    try {
      await sbInsert('lens_runs', {
        source: 'front',
        front_conversation_id: conversationId,
        front_comment_id: commentId,
        request_text: null,
        error: e.message.slice(0, 1000),
      })
    } catch (_) { /* best effort */ }
    // Best-effort internal note so the person who asked isn't left waiting.
    try {
      await withMcp((call) =>
        call('add_comment', {
          conversationId,
          body: 'Customer Lens could not run on this thread. Details are in the Runs tab at csw-wi.netlify.app/lens.',
        })
      )
    } catch (_) { /* ignore */ }
    return { ok: false, error: e.message }
  }
}

module.exports = { runLensForMention, parseRpcResponse, extractRequestText, extractExternalHandles }
