'use strict'

// Ported from front_netlify_datex/functions/get-submissions.js (2026-08-03).
// Rewritten to raw Supabase REST fetch instead of @supabase/supabase-js —
// this repo's netlify/functions folder has no Supabase SDK dependency (see
// fefo-dismissals.cjs), staying consistent rather than adding one.
//
// GET /.netlify/functions/scheduling-get-submissions?status=pending
// GET /.netlify/functions/scheduling-get-submissions?front_conversation_id=cnv_xxx

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Supabase env vars not configured' }) }
  }

  const status = event.queryStringParameters?.status
  const frontConvId = event.queryStringParameters?.front_conversation_id

  let url = `${SUPABASE_URL}/rest/v1/submissions?select=*&order=created_at.desc`
  if (frontConvId) {
    url += `&front_conversation_id=eq.${encodeURIComponent(frontConvId)}`
  } else if (status && status !== 'all') {
    url += `&status=eq.${encodeURIComponent(status)}`
  }

  try {
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Supabase HTTP ${res.status}: ${text.slice(0, 200)}` }) }
    }
    const data = await res.json()
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
