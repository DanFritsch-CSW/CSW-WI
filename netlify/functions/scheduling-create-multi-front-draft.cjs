'use strict'

// Ported from front_netlify_datex/functions/create-multi-front-draft.js (2026-08-03).
// Creates a single Front draft reply summarizing multiple approved
// appointments in one conversation (multi-stop bookings).
//
// POST /.netlify/functions/scheduling-create-multi-front-draft
// Body: { front_conversation_id: "<string>", record_ids?: string[], created_after?: "<iso-timestamp>", draft_template?: "<string>" }
//
// UPDATED 2026-08-20 after Kay hit "No approved records found for this
// batch" on a batch that had genuinely succeeded (confirmed via direct
// Supabase query: real datex_appointment_id, status='approved', correct
// conversation ID and timestamp). Root cause: created_after alone compares
// a CLIENT-computed timestamp against a SERVER-generated created_at
// column — client/server clock skew beyond the 5-second buffer built into
// that timestamp can silently exclude a genuinely successful, just-created
// appointment. record_ids is now the PRIMARY path (the client already has
// the exact submission IDs from its own batch loop) and sidesteps clock
// skew entirely. It's also now retried with the same lag-tolerant pattern
// created_after already had, and filters to status='approved' explicitly —
// previously this path had NO status filter at all, so a still-processing
// or failed record fetched by ID could have silently ended up in a
// customer-facing draft. created_after is kept as a secondary signal only
// (used to identify records when record_ids isn't provided, e.g. an old
// cached frontend build).

const { createFrontMultiDraft } = require('./lib/front-draft-shared.cjs')

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

const HEADERS = { 'Content-Type': 'application/json' }

function supabaseHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
}

// Retries up to 5 times (4s apart, ~20s total) fetching by exact ID and
// filtering to status='approved' — tolerates the same lag between the
// background Datex push completing and the status update being visible to
// this query that the created_after path already accounted for.
async function fetchApprovedByIds(recordIds) {
  const idsFilter = recordIds.map((id) => encodeURIComponent(id)).join(',')
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4000))
    console.log(`[scheduling-create-multi-front-draft] attempt ${attempt + 1}/5: checking record_ids for approved status`)
    const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?select=*&id=in.(${idsFilter})&status=eq.approved`, {
      headers: supabaseHeaders(),
    })
    if (res.ok) {
      const data = await res.json()
      if (data?.length) return data
    }
  }
  return []
}

async function fetchApprovedByCreatedAfter(frontConversationId, createdAfter) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4000))
    console.log(`[scheduling-create-multi-front-draft] attempt ${attempt + 1}/5: checking created_after (conv=${frontConversationId}, after=${createdAfter})`)
    const url = `${SUPABASE_URL}/rest/v1/submissions?select=*&front_conversation_id=eq.${encodeURIComponent(frontConversationId)}&status=eq.approved&created_at=gte.${encodeURIComponent(createdAfter)}&order=created_at.asc`
    const res = await fetch(url, { headers: supabaseHeaders() })
    if (res.ok) {
      const data = await res.json()
      if (data?.length) return data
    }
  }
  return []
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Supabase env vars not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { front_conversation_id, created_after, record_ids, draft_template } = body

  if (!front_conversation_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing front_conversation_id' }) }
  }
  if (!created_after && (!Array.isArray(record_ids) || record_ids.length === 0)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing created_after' }) }
  }

  if (!FRONT_API_KEY) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, draft_created: false, reason: 'No FRONT_API_TOKEN configured' }) }
  }

  // record_ids is the PRIMARY path when provided — exact, immune to clock
  // skew. Falls back to created_after only if record_ids wasn't sent
  // (older cached frontend) or the ID-based lookup somehow comes back
  // empty (defense in depth, not expected in normal operation).
  let records = []
  if (Array.isArray(record_ids) && record_ids.length > 0) {
    records = await fetchApprovedByIds(record_ids)
  }
  if (records.length === 0 && created_after) {
    records = await fetchApprovedByCreatedAfter(front_conversation_id, created_after)
  }

  if (records.length === 0) {
    console.log('[scheduling-create-multi-front-draft] all attempts exhausted — no approved records found')
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'No approved records found for this batch' }) }
  }

  try {
    await createFrontMultiDraft(records, FRONT_API_KEY, draft_template || undefined)
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, draft_created: true, count: records.length }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ ok: false, error: err.message }) }
  }
}
