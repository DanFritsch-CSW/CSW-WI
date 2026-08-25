'use strict'

// Scorecard Draft Creator — Live Omni Tile Runner. Added 2026-08-25,
// REPLACING per-metric hand-translated MotherDuck SQL for any customer
// that opts in via customer_scorecard_config.metric_tile_names.
//
// WHY THIS EXISTS — Dan's exact pushback: "why are we using MD with I
// provide you the OMNI - this seems like extra work and not scalable for
// when i start adding more customers." He was right. The day-by-day
// breakdown built earlier this session (see motherduck-scorecard-
// metrics.cjs) required hand-translating Dan's real Omni SQL into DuckDB
// syntax, then flagging two real discrepancies (owner_name filter,
// scheduled_arrival vs completed_on windowing) that existed ONLY because
// the translation wasn't Omni's own literal query. That doesn't scale:
// every new customer, every new tile, would need another hand-translation
// pass, another discrepancy review, another live-verification round.
//
// THE FIX: Omni's own documented API lets you fetch a dashboard tile's
// REAL query object and run it directly — no translation, no
// discrepancy risk, because it IS Omni's exact query (confirmed via
// https://docs.omni.co/api/documents/get-document-queries and
// https://docs.omni.co/guides/api/run-document-queries directly, not
// guessed): GET /v1/documents/{id}/queries returns
// `{ queries: [{ id, name, url, query }] }` where `query` is already
// structured for POST /v1/query/run's `{ query: ... }` body, verbatim.
//
// This function: given a dashboardId and a list of exact tile names,
// fetches the dashboard's query list once, finds each matching tile by
// name (case-insensitive), runs its real query object via the SAME
// /api/v1/query/run endpoint omni-query.cjs already calls (reusing that
// file's Arrow-parsing pattern), and returns each tile's actual rows.
// Whatever Omni's dashboard shows is exactly what this returns — the
// owner_name/project-pattern/windowing discrepancies flagged for the
// hand-translated day-by-day breakdown cannot happen here, because there
// is no translation step to introduce them.
//
// Deliberately scoped to the Scorecard Draft Creator only (per Dan's
// explicit ask — "rebuild - probably for only the scorecard draft
// element of the APP") — does not touch motherduck-scorecard-metrics.cjs,
// which remains the path for customers without metric_tile_names set
// (Bernatello's, whose numbers were validated under that path and haven't
// been re-verified under this one).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Same Arrow-to-rows conversion as omni-query.cjs — duplicated rather
// than shared, matching this app's established convention of small
// per-function self-contained helpers over premature shared libs.
function arrowToRows(table) {
  const rows = []
  for (let i = 0; i < table.numRows; i++) {
    const row = {}
    for (const field of table.schema.fields) {
      const col = table.getChild(field.name)
      let val = col.get(i)
      if (typeof val === 'bigint') val = Number(val)
      if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1)
      }
      row[field.name] = val
    }
    rows.push(row)
  }
  return rows
}

async function fetchDocumentQueries(baseUrl, apiKey, dashboardId) {
  const res = await fetch(`${baseUrl}/api/v1/documents/${encodeURIComponent(dashboardId)}/queries`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Omni documents API → ${res.status}: ${text.slice(0, 500)}`)
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`Omni documents API returned non-JSON: ${text.slice(0, 200)}`) }
  return data.queries || []
}

// Runs one tile's real query object via Omni's own query engine — same
// endpoint, same response format (newline-delimited JSON job statuses,
// base64 Arrow on completion) as omni-query.cjs's runOmniQuery, without
// that file's retry/timeout machinery (dashboard tiles are already-
// computed, governed queries — expected to be fast and reliable; add
// retry logic here later if that assumption turns out wrong in practice).
async function runTileQuery(baseUrl, apiKey, queryObject) {
  const res = await fetch(`${baseUrl}/api/v1/query/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: queryObject }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Omni query/run → ${res.status}: ${text.slice(0, 500)}`)

  let completeJob = null
  for (const line of text.trim().split('\n')) {
    try {
      const parsed = JSON.parse(line)
      if (parsed.status === 'COMPLETE') { completeJob = parsed; break }
    } catch { /* skip malformed lines */ }
  }
  if (!completeJob) throw new Error(`Omni query/run did not complete: ${text.slice(0, 500)}`)

  const { tableFromIPC } = await import('apache-arrow')
  const buf = Buffer.from(completeJob.result, 'base64')
  const table = tableFromIPC(buf)
  return arrowToRows(table)
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const API_KEY = process.env.OMNI_API_KEY
  if (!API_KEY) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'OMNI_API_KEY not configured' }) }
  }

  let dashboardId, tileNames
  try {
    ;({ dashboardId, tileNames } = JSON.parse(event.body || '{}'))
    if (!dashboardId) throw new Error('dashboardId is required')
    if (!Array.isArray(tileNames) || !tileNames.length) throw new Error('tileNames must be a non-empty array')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }

  const BASE_URL = 'https://csw.omniapp.co'

  try {
    const allQueries = await fetchDocumentQueries(BASE_URL, API_KEY, dashboardId)

    const tiles = []
    const notFound = []

    for (const name of tileNames.map((n) => n.trim())) {
      const match = allQueries.find((q) => (q.name || '').toLowerCase() === name.toLowerCase())
      if (!match) { notFound.push(name); continue }
      try {
        const rows = await runTileQuery(BASE_URL, API_KEY, match.query)
        tiles.push({ name: match.name, rows, error: null })
      } catch (e) {
        // One tile failing to run shouldn't take down the others — surface
        // the error per-tile so the caller (and eventually Claude's
        // prompt) can see exactly which metric is missing and why.
        tiles.push({ name: match.name, rows: [], error: e.message })
      }
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        dashboardId,
        tiles,
        notFound,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, dashboardId, elapsedMs: Date.now() - t0 }),
    }
  }
}
