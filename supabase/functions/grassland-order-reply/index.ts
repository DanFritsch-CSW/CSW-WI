// Grassland order agent: reply endpoint. Added 2026-10-13.
// Mirrors scheduling-agent-reply's role exactly: a tiny Edge Function whose
// only job is posting back to Front using this agent's own OAuth
// credentials, called by a process that doesn't (and shouldn't) hold a copy
// of those credentials itself — here, grassland-order-resolve-background.cjs
// on Netlify, after it finishes the real MotherDuck resolution + Datex push.
//
// Auth: NOT Front's HMAC signature (this isn't a Front webhook) — a shared
// secret header (x-grassland-internal-secret) proving the call came from
// our own Netlify function, same secret grassland-order-webhook uses to
// call INTO Netlify, just checked in the other direction here.
//
// IMPORTANT: committed record only — deployed directly via the Supabase
// MCP tool, not auto-deployed from this repo. See the header note in
// supabase/functions/grassland-order-webhook/index.ts for the full
// explanation (this repo had no supabase/functions/ folder before either
// of these two files).
//
// Secrets: FRONT_GRASSLAND_AGENT_CLIENT_ID/_CLIENT_SECRET/_TOKEN_URL (same
// three as grassland-order-webhook), GRASSLAND_INTERNAL_SECRET.
// Deploy with verify_jwt=false.

// deno-lint-ignore-file no-explicit-any
const env = (k: string) => Deno.env.get(k) || ''
const MCP_URL = 'https://mcp.frontapp.com/mcp'
const MCP_PROTOCOL = '2025-11-25'

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

async function postComment(conversationId: string, body: string) {
  const token = await getAgentToken()
  const st: any = { sessionId: null, protocol: null }
  const init = await mcpPost(token, st, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'csw-grassland-order-agent', version: '1.0.0' } } }, true)
  st.protocol = (init && init.protocolVersion) || MCP_PROTOCOL
  await mcpPost(token, st, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  await mcpPost(token, st, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_comment', arguments: { conversationId, body } } }, true)
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const secret = req.headers.get('x-grassland-internal-secret')
  if (!secret || secret !== env('GRASSLAND_INTERNAL_SECRET')) {
    return new Response('Unauthorized', { status: 401 })
  }
  try {
    const { conversationId, body } = await req.json()
    if (!conversationId || !body) return new Response('Missing conversationId or body', { status: 400 })
    await postComment(conversationId, body)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error('[grassland-order-reply] error', (e as Error).message)
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
