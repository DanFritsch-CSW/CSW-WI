'use strict'

// Netlify function — CRUD for fefo_dismissals in Supabase.
//
// GET  ?projectId=xxx           → active dismissals (dismissed_until > NOW())
// GET  ?projectId=xxx&all=true  → include expired ones (audit view)
// POST { projectId, lotLookupCode, materialCode?, dismissedBy, dismissedUntil, reason? }
//   → creates a new dismissal row; dismissedUntil is an ISO string
// DELETE ?id=xxx                → hard-clear a dismissal (undo)
//
// The fefo-orders endpoint pulls active dismissals at request time and
// filters them out of REM candidates so those lots stop showing as
// violations. This function is only for the CRUD side.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

function supabaseHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  }
}

async function listDismissals(projectId, includeExpired) {
  const params = new URLSearchParams()
  params.set('select', '*')
  params.set('project_id', `eq.${projectId}`)
  if (!includeExpired) {
    params.set('dismissed_until', `gt.${new Date().toISOString()}`)
  }
  params.set('order', 'dismissed_at.desc')
  const url = `${SUPABASE_URL}/rest/v1/fefo_dismissals?${params.toString()}`
  const res = await fetch(url, { headers: supabaseHeaders() })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase list failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function createDismissal(payload) {
  const url = `${SUPABASE_URL}/rest/v1/fefo_dismissals`
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase insert failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  const rows = await res.json()
  return Array.isArray(rows) ? rows[0] : rows
}

async function deleteDismissal(id) {
  const url = `${SUPABASE_URL}/rest/v1/fefo_dismissals?id=eq.${encodeURIComponent(id)}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase delete failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  return { deleted: true }
}

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'Supabase env vars not configured' }),
    }
  }

  const method = event.httpMethod

  try {
    if (method === 'GET') {
      const q = event.queryStringParameters || {}
      const projectId = q.projectId
      if (!projectId) {
        return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'projectId required' }) }
      }
      const includeExpired = q.all === 'true' || q.all === '1'
      const dismissals = await listDismissals(projectId, includeExpired)
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ dismissals, includeExpired }),
      }
    }

    if (method === 'POST') {
      let body
      try {
        body = JSON.parse(event.body || '{}')
      } catch {
        return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
      }
      const { projectId, lotLookupCode, materialCode, dismissedBy, dismissedUntil, reason } = body
      if (!projectId || !lotLookupCode || !dismissedBy || !dismissedUntil) {
        return {
          statusCode: 400,
          headers: NO_CACHE_HEADERS,
          body: JSON.stringify({ error: 'projectId, lotLookupCode, dismissedBy, and dismissedUntil required' }),
        }
      }
      const dismissal = await createDismissal({
        project_id:       projectId,
        lot_lookup_code:  lotLookupCode,
        material_code:    materialCode || null,
        dismissed_by:     dismissedBy,
        dismissed_until:  dismissedUntil,
        reason:           reason || null,
      })
      return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ dismissal }) }
    }

    if (method === 'DELETE') {
      const id = event.queryStringParameters?.id
      if (!id) {
        return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'id required' }) }
      }
      const result = await deleteDismissal(id)
      return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify(result) }
    }

    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message || 'unknown error' }),
    }
  }
}
