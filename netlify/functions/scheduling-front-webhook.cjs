'use strict'

/**
 * Netlify Function: scheduling-front-webhook
 * Ported from front_netlify_datex/functions/front-webhook.js (2026-08-03).
 *
 * Three-tag flow (the Playbook pipeline this is slated to be replaced by —
 * see the parallel Claude-extraction shadow project — but ported as-is for
 * now so the standalone app's live intake keeps working while that's built
 * and validated):
 *   0. Rule "CAL - Notify/Comment for Certain People" tags "Front Notes" →
 *      webhook creates a stub with notes + front_conversation_id, or updates
 *      notes on an existing stub.
 *   1. Front Playbook Step 1 tags "Front Warehouse" → webhook creates a stub
 *      record with warehouse + front_conversation_id, status: 'pending'.
 *   2. Front Playbook Step 3 tags "Front Playbook" → webhook finds that stub
 *      by conversation ID and updates it with full fields (date, type, PO
 *      number). If no stub exists, inserts a fresh record instead.
 *
 * NOT yet wired to a live Front webhook subscription in Front's settings —
 * that's a manual step (Settings → Developers → Webhooks) still to be done
 * before this actually receives traffic. Until then this function exists but
 * is inert.
 *
 * Env vars required: SUPABASE_URL/VITE_SUPABASE_URL, SUPABASE_ANON_KEY or
 * SUPABASE_SERVICE_ROLE_KEY, FRONT_API_TOKEN (or legacy FRONT_API_KEY),
 * FRONT_WEBHOOK_SECRET (optional, for HMAC verification).
 */

const crypto = require('crypto')

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

function supabaseHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) }
}

async function findStub(conversationId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?select=id,status,warehouse&front_conversation_id=eq.${encodeURIComponent(conversationId)}`, {
    headers: supabaseHeaders(),
  })
  if (!res.ok) return null
  const rows = await res.json()
  return rows?.[0] || null
}

async function updateStub(id, fields) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: supabaseHeaders(), body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(`Supabase update HTTP ${res.status}`)
}

async function insertStub(fields) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
    method: 'POST', headers: supabaseHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(`Supabase insert HTTP ${res.status}`)
  const rows = await res.json()
  return rows?.[0]
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------
function verifySignature(rawBody, signature, secret) {
  if (!secret) {
    console.warn('[scheduling-front-webhook] FRONT_WEBHOOK_SECRET not set — skipping HMAC check')
    return true
  }
  if (!signature) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Front API helpers
// ---------------------------------------------------------------------------
async function frontGet(path, apiKey) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Front API ${path} → ${res.status}`)
  return res.json()
}

async function findComment(conversationId, apiKey, detector) {
  const [commentsData, messagesData] = await Promise.all([
    frontGet(`/conversations/${conversationId}/comments`, apiKey).catch(() => ({ _results: [] })),
    frontGet(`/conversations/${conversationId}/messages`, apiKey).catch(() => ({ _results: [] })),
  ])
  const all = [...(commentsData._results || []), ...(messagesData._results || [])]
  const match = all.find((item) => {
    const text = item.body || item.text || ''
    return detector(text)
  })
  return match ? (match.body || match.text || '') : null
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
function parseWarehouse(text) {
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim()
  const m = plain.match(/Warehouse\s*[:\-]\s*(.+?)(?:\n|$)/i)
  const raw = m ? m[1].trim() : null
  return raw ? raw.replace(/\s*appointments?\s*$/i, '').trim() : null
}

function parsePlaybook(text) {
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim()

  const field = (pattern) => {
    const m = plain.match(new RegExp(pattern + '\\s*[:\\-]\\s*(.+?)(?:\\n|$)', 'i'))
    return m ? m[1].trim() : null
  }

  const dateRaw = field('Date')
  let scheduledArrival = null
  if (dateRaw) {
    const parsed = new Date(dateRaw)
    scheduledArrival = !isNaN(parsed) ? parsed.toISOString().slice(0, 10) : dateRaw
  }

  const typeRaw = field('Inbound or Outbound')
  const type = typeRaw ? (/outbound/i.test(typeRaw) ? 'Outbound' : 'Inbound') : null

  return {
    scheduled_arrival: scheduledArrival,
    type,
    reference_number: field('PO Number'),
  }
}

// ---------------------------------------------------------------------------
// Extract conversation ID from Front webhook payload
// ---------------------------------------------------------------------------
function extractConversationId(body) {
  if (body.conversation_id) return body.conversation_id
  const payload = body.payload || {}
  if (payload.id && String(payload.id).startsWith('cnv_')) return payload.id
  if (payload.conversation?.id) return payload.conversation.id
  if (payload.conversation_id) return payload.conversation_id
  if (body.conversation?.id) return body.conversation.id
  if (body.target?.data?.id) return body.target.data.id
  return null
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'OK', headers: { 'Content-Type': 'text/plain' } }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, body: 'Supabase env vars not configured' }
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '')

  if (!rawBody || rawBody.trim() === '') {
    return { statusCode: 200, body: 'OK' }
  }

  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { statusCode: 400, body: 'Bad Request — invalid JSON' }
  }

  // Front sends type:"sync" to verify the endpoint is reachable.
  if (body.type === 'sync') {
    const headerChallenge = event.headers['x-front-challenge']
    const bodyChallenge = body.challenge
    const challenge = headerChallenge || bodyChallenge
    console.log('[scheduling-front-webhook] Sync ping — challenge:', challenge)
    const responseBody = challenge ? { challenge } : { ok: true }
    return { statusCode: 200, body: JSON.stringify(responseBody), headers: { 'Content-Type': 'application/json' } }
  }

  const signature = event.headers['x-front-signature'] || ''
  if (!verifySignature(rawBody, signature, process.env.FRONT_WEBHOOK_SECRET)) {
    console.error('[scheduling-front-webhook] Signature mismatch')
    return { statusCode: 401, body: 'Unauthorized' }
  }

  if (!FRONT_API_KEY) return { statusCode: 500, body: 'FRONT_API_TOKEN not configured' }

  console.log('[scheduling-front-webhook] Body:', rawBody.slice(0, 2000))

  const payload = body.payload || {}
  const tagName = payload.target?.data?.name || payload.tag?.name || payload.tags?.[0]?.name || null
  console.log('[scheduling-front-webhook] Tag:', tagName, '| event type:', body.type)

  const isFrontNotes = tagName === 'Front Notes'
  const isFrontWarehouse = tagName === 'Front Warehouse'
  const isFrontPlaybook = tagName === 'Front Playbook'

  if (!isFrontNotes && !isFrontWarehouse && !isFrontPlaybook) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: true, reason: `Tag "${tagName}" ignored` }) }
  }

  const rawConvId = extractConversationId(body)
  const conversationId = rawConvId && !rawConvId.includes('{{') ? rawConvId : null

  if (!conversationId) {
    console.warn('[scheduling-front-webhook] No conversation ID found.')
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: true, reason: 'No conversation ID' }) }
  }

  // ── "Front Notes" tag ──────────────────────────────────────────────────
  if (isFrontNotes) {
    const notes = payload.conversation?.custom_fields?.Notes || null
    console.log('[scheduling-front-webhook] Front Notes for', conversationId, '—', notes)

    const existing = await findStub(conversationId)

    if (existing) {
      if (existing.status === 'approved') {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: true, reason: 'Already approved' }) }
      }
      try {
        await updateStub(existing.id, { notes })
      } catch (err) {
        return { statusCode: 500, body: `Database error: ${err.message}` }
      }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, updated: existing.id }) }
    }

    let created
    try {
      created = await insertStub({ notes, front_conversation_id: conversationId, status: 'pending' })
    } catch (err) {
      return { statusCode: 500, body: `Database error: ${err.message}` }
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, created: created?.id }) }
  }

  // ── "Front Warehouse" tag ──────────────────────────────────────────────
  if (isFrontWarehouse) {
    const rawWarehouse = payload.conversation?.custom_fields?.Warehouse || null
    const warehouse = rawWarehouse ? rawWarehouse.replace(/\s*appointments?\s*$/i, '').trim() : null
    console.log('[scheduling-front-webhook] Front Warehouse for', conversationId, '—', warehouse)

    const existing = await findStub(conversationId)

    if (existing) {
      if (existing.status === 'approved') {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: true, reason: 'Already approved' }) }
      }
      if (existing.warehouse) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: true, reason: 'Warehouse already set' }) }
      }
      try {
        await updateStub(existing.id, { warehouse })
      } catch (err) {
        return { statusCode: 500, body: `Database error: ${err.message}` }
      }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, updated: existing.id }) }
    }

    let created
    try {
      created = await insertStub({ warehouse, front_conversation_id: conversationId, status: 'pending' })
    } catch (err) {
      return { statusCode: 500, body: `Database error: ${err.message}` }
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, created: created?.id }) }
  }

  // ── "Front Playbook" tag ───────────────────────────────────────────────
  let playbookText
  try {
    playbookText = await findComment(conversationId, FRONT_API_KEY, (t) => /PO Number\s*:/i.test(t))
  } catch (err) {
    console.error('[scheduling-front-webhook] Front API error for', conversationId, ':', err.message)
    return { statusCode: 502, body: `Front API error: ${err.message}` }
  }

  if (!playbookText) {
    console.warn('[scheduling-front-webhook] No playbook comment found for', conversationId)
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: true, reason: 'No playbook data found in conversation' }) }
  }

  const fields = parsePlaybook(playbookText)
  console.log('[scheduling-front-webhook] Parsed fields for', conversationId, '—', JSON.stringify(fields))

  const existing = await findStub(conversationId)

  if (existing) {
    if (existing.status === 'approved') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: true, reason: 'Already approved' }) }
    }
    try {
      await updateStub(existing.id, fields)
    } catch (err) {
      return { statusCode: 500, body: `Database error: ${err.message}` }
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, updated: existing.id }) }
  }

  let created
  try {
    created = await insertStub({ ...fields, status: 'pending', front_conversation_id: conversationId })
  } catch (err) {
    return { statusCode: 500, body: `Database error: ${err.message}` }
  }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, created: created?.id }) }
}
