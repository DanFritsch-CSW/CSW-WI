'use strict'

// Ported from front_netlify_datex/functions/create-front-draft.js (2026-08-03).
// Manually triggers a Front draft reply — called from the Plugin as a
// fallback/retry after a successful Datex push if the automatic draft failed.
//
// POST /.netlify/functions/scheduling-create-front-draft
// Body: { id: "<uuid>" }  OR  { front_conversation_id: "<string>" }

const { createFrontDraft, createFrontComment } = require('./lib/front-draft-shared.cjs')

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Supabase env vars not configured' }) }
  }
  if (!FRONT_API_KEY) {
    return { statusCode: 503, headers: HEADERS, body: JSON.stringify({ error: 'FRONT_API_TOKEN not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { id, front_conversation_id, draft_template } = body
  const col = id ? 'id' : front_conversation_id ? 'front_conversation_id' : null
  const value = id || front_conversation_id
  if (!col) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing id or front_conversation_id' }) }
  }

  const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions?select=*&${col}=eq.${encodeURIComponent(value)}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!fetchRes.ok) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Supabase fetch failed: HTTP ${fetchRes.status}` }) }
  }
  const rows = await fetchRes.json()
  const record = rows?.[0]
  if (!record) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Submission not found' }) }
  }
  if (!record.front_conversation_id) {
    return { statusCode: 422, headers: HEADERS, body: JSON.stringify({ error: 'No Front conversation linked to this submission' }) }
  }

  let mode = 'draft'
  try {
    await createFrontDraft(record, FRONT_API_KEY, draft_template)
  } catch (draftErr) {
    try {
      await createFrontComment(record, FRONT_API_KEY, draft_template)
      mode = 'comment'
    } catch (commentErr) {
      return {
        statusCode: 502,
        headers: HEADERS,
        body: JSON.stringify({ ok: false, error: `Draft: ${draftErr.message} | Comment: ${commentErr.message}` }),
      }
    }
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, mode }) }
}
