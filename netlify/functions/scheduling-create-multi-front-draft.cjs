'use strict'

// Ported from front_netlify_datex/functions/create-multi-front-draft.js (2026-08-03).
// Creates a single Front draft reply summarizing multiple approved
// appointments in one conversation (multi-stop bookings).
//
// POST /.netlify/functions/scheduling-create-multi-front-draft
// Body: { front_conversation_id: "<string>", created_after: "<iso-timestamp>", draft_template?: "<string>" }
//
// Fetches all approved submissions for the conversation created on or after
// created_after, with retries — covers appointments whose HTTP response
// timed out but whose Datex push still succeeded in the background.

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

  let records
  if (created_after) {
    // Retry up to 5 times with a 4s delay to tolerate lag between the
    // background Datex push completing and the status update being visible
    // to this query. 5 attempts x 4s = up to 20s total wait.
    let data = null
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 4000))
      console.log(`[scheduling-create-multi-front-draft] attempt ${attempt + 1}/5: checking for approved records (conv=${front_conversation_id}, after=${created_after})`)
      const url = `${SUPABASE_URL}/rest/v1/submissions?select=*&front_conversation_id=eq.${encodeURIComponent(front_conversation_id)}&status=eq.approved&created_at=gte.${encodeURIComponent(created_after)}&order=created_at.asc`
      const res = await fetch(url, { headers: supabaseHeaders() })
      if (res.ok) {
        data = await res.json()
        if (data?.length) break
      }
    }
    if (!data?.length) {
      console.log('[scheduling-create-multi-front-draft] all attempts exhausted — no approved records found')
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'No approved records found for this batch' }) }
    }
    records = data
  } else {
    // Fallback for older cached frontend that still sends record_ids.
    const idsFilter = record_ids.map((id) => encodeURIComponent(id)).join(',')
    const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?select=*&id=in.(${idsFilter})`, { headers: supabaseHeaders() })
    if (!res.ok) {
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Records not found' }) }
    }
    const data = await res.json()
    records = record_ids.map((id) => data.find((r) => r.id === id)).filter(Boolean)
  }

  if (!records?.length) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'No records to include in draft' }) }
  }

  try {
    await createFrontMultiDraft(records, FRONT_API_KEY, draft_template || undefined)
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, draft_created: true, count: records.length }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ ok: false, error: err.message }) }
  }
}
