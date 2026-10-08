'use strict'

// Customer Lens — shared core. Added 2026-10-08.
//
// An @mention-triggered Front agent that reads a conversation, combines it
// with CSW reference context (global rules + facility constraints + account
// profile, all edited on /lens and stored in Supabase lens_context), and
// returns a read on how a message will land plus suggested response angles.
// OUTPUT IS ADVISORY ONLY: this file can post an INTERNAL Front comment but
// has no code path that drafts or sends to a customer. Keep it that way.
//
// Used by:
//   - lens-test.cjs     (manual test + context preview from /lens; no Front writes)
//   - lens-webhook.cjs  (phase 2: Front @mention -> internal comment)
//
// Env: SUPABASE_URL/VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or anon key,
//      ANTHROPIC_API_KEY, FRONT_API_TOKEN (or FRONT_API_KEY),
//      FRONT_LENS_AUTHOR_ID (teammate id the comment is posted as; phase 2)

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const FRONT_LENS_AUTHOR_ID = process.env.FRONT_LENS_AUTHOR_ID

const CLAUDE_MODEL = 'claude-sonnet-4-5'
const MAX_THREAD_CHARS = 24000
const STALE_DAYS = 90
const INTERNAL_DOMAINS = ['csw-wi.com']

function supabaseHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  }
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: supabaseHeaders() })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

async function sbPost(path, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: prefer || 'return=minimal' }),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text)
  try { return text ? JSON.parse(text) : null } catch { return null }
}

async function frontGet(path) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Front GET ${path} -> ${res.status}: ${await res.text()}`)
  return res.json()
}

async function frontPost(path, body) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FRONT_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Front POST ${path} -> ${res.status}: ${await res.text()}`)
  const text = await res.text()
  try { return text ? JSON.parse(text) : null } catch { return null }
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

function daysSince(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Math.floor(ms / 86400000)
}

function renderBlock(row, heading) {
  const age = daysSince(row.reviewed_at)
  const stale = age != null && age > STALE_DAYS
  const flag = stale ? ` (WARNING: last reviewed ${age} days ago, may be stale)` : ''
  return `### ${heading}${flag}\n${(row.body || '').trim()}`
}

async function loadAccountKeys() {
  const rows = await sbGet(`lens_context?scope=eq.account&active=eq.true&select=key`)
  return (rows || []).map((r) => r.key)
}

async function loadFacilityKeys() {
  const rows = await sbGet(`lens_context?scope=eq.facility&active=eq.true&select=key`)
  return (rows || []).map((r) => r.key)
}

// Builds the exact reference text the model sees. Missing layers are called
// out explicitly so the model says so instead of guessing.
async function assembleContext({ accountKey, facilityKeys }) {
  const parts = []
  const found = { global: false, account: false, facilities: [] }

  const globalRows = await sbGet(`lens_context?scope=eq.global&active=eq.true&select=*&limit=1`)
  if (globalRows && globalRows[0]) {
    parts.push(renderBlock(globalRows[0], 'CSW GLOBAL RULES'))
    found.global = true
  }

  if (accountKey) {
    const rows = await sbGet(
      `lens_context?scope=eq.account&key=eq.${encodeURIComponent(accountKey)}&active=eq.true&select=*&limit=1`
    )
    if (rows && rows[0]) {
      parts.push(renderBlock(rows[0], `ACCOUNT: ${rows[0].title || accountKey}`))
      found.account = true
    }
  }
  if (!found.account) {
    parts.push(
      `### ACCOUNT CONTEXT\nNo account context on file${accountKey ? ` for "${accountKey}"` : ' (account could not be identified)'}. Do not assume contract terms, history, or relationship details.`
    )
  }

  for (const fk of facilityKeys || []) {
    const rows = await sbGet(
      `lens_context?scope=eq.facility&key=eq.${encodeURIComponent(fk)}&active=eq.true&select=*&limit=1`
    )
    if (rows && rows[0]) {
      parts.push(renderBlock(rows[0], `FACILITY: ${rows[0].title || fk}`))
      found.facilities.push(fk)
    }
  }

  return { text: parts.join('\n\n'), found }
}

// ---------------------------------------------------------------------------
// Account / facility resolution
// ---------------------------------------------------------------------------

function extractExternalHandles(messages) {
  const handles = new Set()
  for (const m of messages) {
    for (const r of m.recipients || []) {
      const h = (r.handle || '').toLowerCase()
      if (!h.includes('@')) continue
      const domain = h.split('@')[1]
      if (INTERNAL_DOMAINS.includes(domain)) continue
      handles.add(h)
    }
  }
  return [...handles]
}

// email match beats domain match. Returns account_key or null.
async function resolveAccountKey(messages) {
  const handles = extractExternalHandles(messages)
  if (handles.length === 0) return null
  const maps = await sbGet(`lens_account_map?select=match_type,match_value,account_key`)
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

// Facilities mentioned anywhere in the thread (case-insensitive key match).
function detectFacilityKeys(allFacilityKeys, threadText, requestText) {
  const hay = `${threadText}\n${requestText || ''}`.toLowerCase()
  return allFacilityKeys.filter((k) => hay.includes(k.toLowerCase()))
}

// Optional inline overrides in the @mention text: "account:lakeside" and
// "site:Eau Claire" (site ends at a comma, newline, or next key:value).
function parseOverrides(requestText) {
  const out = { accountKey: null, facilityKeys: [] }
  if (!requestText) return out
  const acct = requestText.match(/account:\s*([A-Za-z0-9_\-]+)/i)
  if (acct) out.accountKey = acct[1].toLowerCase()
  const sites = [...requestText.matchAll(/site:\s*([A-Za-z ]+?)(?=,|\n|$|\s+\w+:)/gi)]
  out.facilityKeys = sites.map((s) => s[1].trim()).filter(Boolean)
  return out
}

// ---------------------------------------------------------------------------
// Thread fetch (Front)
// ---------------------------------------------------------------------------

function stripHtml(s) {
  return (s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fetchThread(conversationId) {
  const [msgData, cmtData] = await Promise.all([
    frontGet(`/conversations/${conversationId}/messages?limit=50`),
    frontGet(`/conversations/${conversationId}/comments?limit=50`).catch(() => ({ _results: [] })),
  ])
  const messages = (msgData._results || []).map((m) => ({
    kind: 'message',
    id: m.id,
    at: m.created_at,
    inbound: m.is_inbound !== false,
    author: m.author ? `${m.author.first_name || ''} ${m.author.last_name || ''}`.trim() || m.author.email : null,
    recipients: m.recipients || [],
    subject: m.subject || '',
    text: m.text || stripHtml(m.body) || m.blurb || '',
  }))
  const comments = (cmtData._results || []).map((c) => ({
    kind: 'comment',
    id: c.id,
    at: c.posted_at,
    author: c.author ? `${c.author.first_name || ''} ${c.author.last_name || ''}`.trim() : null,
    text: stripHtml(c.body),
  }))
  const all = [...messages, ...comments].sort((a, b) => (a.at || 0) - (b.at || 0))
  return { messages, comments, all }
}

function renderThread(all) {
  const blocks = all.map((e) => {
    // Front timestamps are unix seconds (float); tolerate ms just in case.
    const ms = e.at ? (e.at > 1e12 ? e.at : e.at * 1000) : null
    const when = ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : ''
    if (e.kind === 'comment') return `[INTERNAL NOTE ${when}${e.author ? ' by ' + e.author : ''}]\n${e.text}`
    const dir = e.inbound ? 'FROM CUSTOMER/OUTSIDE' : 'FROM CSW'
    const to = (e.recipients || []).filter((r) => r.role === 'to').map((r) => r.handle).join(', ')
    return `[${dir} ${when}${e.author ? ' - ' + e.author : ''}${to ? ' - to ' + to : ''}]\n${e.text}`
  })
  // Keep the newest content if we have to truncate.
  let out = blocks.join('\n\n---\n\n')
  if (out.length > MAX_THREAD_CHARS) out = '[...older messages truncated...]\n\n' + out.slice(out.length - MAX_THREAD_CHARS)
  return out
}

// ---------------------------------------------------------------------------
// Claude call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Customer Lens, an internal advisor for Central Storage & Warehouse (CSW), a cold-storage 3PL. A CSW teammate has asked how a customer email thread (or a draft reply) will land with the customer, and how to respond.

You write an INTERNAL note. It is never sent to the customer.

Use the REFERENCE CONTEXT for CSW rules, site constraints, and account background. Rules:
- Ground every claim in the thread or the reference context. Never invent contract terms, rates, dates, or history.
- If account context is missing or marked stale, say so in CONTEXT GAPS and keep the read to what the thread supports.
- If the person included a draft reply, assess that draft. Otherwise assess the most recent message(s) in the thread.
- Be direct and specific. No flattery, no filler.
- Do not write a full reply email unless the request asks for one. Suggest angles, and short example phrasing at most.
- Plain text only. No markdown symbols (no #, *, or tables). Use the exact section labels below in capitals, followed by short lines starting with "- ".

Output format, in this order, about 250 words total:
BLUF: one or two sentences.
WHAT IT CONVEYS:
WHAT IT DOES NOT SAY:
HOW IT MAY LAND: (name who reads it how, using people from the thread)
SUGGESTED ANGLES: (2 to 3)
CONTEXT GAPS: (what reference context was missing or stale; write "None" if nothing)`

async function callClaude({ referenceContext, threadText, requestText }) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
  const user = `REFERENCE CONTEXT\n${referenceContext}\n\n=====\n\nTHREAD\n${threadText}\n\n=====\n\nREQUEST FROM TEAMMATE\n${requestText || '(no specific question; give your standard read of the latest message)'}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 900,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    }),
  })
  const raw = await res.text()
  let data
  try { data = JSON.parse(raw) } catch { data = { raw } }
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data).slice(0, 500)}`)
  const block = (data.content || []).find((b) => b.type === 'text')
  if (!block) throw new Error('Claude API returned no text block')
  return block.text.trim()
}

// ---------------------------------------------------------------------------
// Logging + Front comment
// ---------------------------------------------------------------------------

async function logRun(row) {
  try {
    const inserted = await sbPost('lens_runs', row, 'return=representation')
    return inserted && inserted[0] ? inserted[0].id : null
  } catch (_) {
    return null // best effort; never mask the real outcome
  }
}

// INTERNAL comment only. Requires FRONT_LENS_AUTHOR_ID (the agent teammate).
async function postInternalComment(conversationId, body) {
  if (!FRONT_LENS_AUTHOR_ID) throw new Error('FRONT_LENS_AUTHOR_ID not configured')
  return frontPost(`/conversations/${conversationId}/comments`, {
    author_id: FRONT_LENS_AUTHOR_ID,
    body,
  })
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

// Test path: raw pasted text, no Front access. accountKey/facilityKeys are
// chosen by the caller (the /lens Test box).
async function runLensFromText({ text, requestText, accountKey, facilityKeys }) {
  const ctx = await assembleContext({ accountKey: accountKey || null, facilityKeys: facilityKeys || [] })
  let output = null
  let error = null
  try {
    output = await callClaude({ referenceContext: ctx.text, threadText: text, requestText })
  } catch (e) {
    error = e.message
  }
  const runId = await logRun({
    source: 'test',
    account_key: accountKey || null,
    facility_key: (facilityKeys || []).join(', ') || null,
    request_text: requestText || null,
    assembled_context: ctx.text,
    output,
    model: CLAUDE_MODEL,
    error,
  })
  return { ok: !error, runId, output, error, assembledContext: ctx.text, found: ctx.found }
}

// Front path (phase 2): conversation id in, internal comment out.
async function runLensForConversation({ conversationId, requestText, commentId }) {
  const thread = await fetchThread(conversationId)
  const overrides = parseOverrides(requestText)
  const accountKey = overrides.accountKey || (await resolveAccountKey(thread.messages))
  const allFacilities = await loadFacilityKeys()
  const threadText = renderThread(thread.all)
  const facilityKeys = overrides.facilityKeys.length
    ? overrides.facilityKeys
    : detectFacilityKeys(allFacilities, threadText, requestText)

  const ctx = await assembleContext({ accountKey, facilityKeys })
  let output = null
  let error = null
  try {
    output = await callClaude({ referenceContext: ctx.text, threadText, requestText })
  } catch (e) {
    error = e.message
  }

  let posted = false
  if (output) {
    try {
      const header = `Customer Lens${accountKey ? ` (${accountKey})` : ' (account not identified)'}${facilityKeys.length ? ` | ${facilityKeys.join(', ')}` : ''}\n\n`
      await postInternalComment(conversationId, header + output)
      posted = true
    } catch (e) {
      error = `Comment post failed: ${e.message}`
    }
  }

  const runId = await logRun({
    source: 'front',
    front_conversation_id: conversationId,
    front_comment_id: commentId || null,
    account_key: accountKey || null,
    facility_key: facilityKeys.join(', ') || null,
    request_text: requestText || null,
    assembled_context: ctx.text,
    output,
    model: CLAUDE_MODEL,
    error,
  })
  return { ok: !error, posted, runId, accountKey, facilityKeys, error }
}

module.exports = {
  assembleContext,
  loadAccountKeys,
  loadFacilityKeys,
  runLensFromText,
  runLensForConversation,
  parseOverrides,
  CLAUDE_MODEL,
}
