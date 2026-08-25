'use strict'

// Scorecard Draft Creator — Dashboard Coverage Check. Added 2026-08-25,
// per Dan's explicit ask to pursue "Option B" from the earlier scoping
// discussion: read a customer's Omni dashboard LIVE and compare it against
// what motherduck-scorecard-metrics.cjs actually computes, rather than
// relying on someone noticing a gap only after Claude has already written
// around it (which is exactly what happened with the day-by-day breakdown
// and, earlier, Carrier % On-Time Arrival).
//
// Uses Omni's real, documented endpoint: GET /v1/documents/{documentId}/queries
// (confirmed via Omni's own docs — "Get document queries" — same Bearer
// Organization-API-Key auth pattern already used by omni-query.cjs against
// the same csw.omniapp.co/api/v1/... host, so OMNI_API_KEY is reused as-is;
// no new credential needed). Returns every saved query/tile in the
// dashboard's workbook — confirmed live via the Omni MCP connector's
// listDashboardQueries on Grassland's real dashboard (9052024d) BEFORE
// writing this function: 12 real tiles, including several this app has
// never computed (YTD/Monthly Damage Rate, Total Shipped, Damaged
// Adjustments, two rolling-13-week trend tiles, and the day-by-day
// breakdown that prompted this whole feature) — plus one, "BJB Damage
// Corrections For Walmart," that looks like a stray leftover from a
// different customer's dashboard template, exactly the kind of drift this
// feature exists to catch.
//
// Coverage matching is intentionally SIMPLE keyword matching, not an
// attempt to build a full semantic mapping between Omni tile names and
// this app's metric fields — tile naming varies per customer and isn't
// standardized (e.g. "Total OTT (Wk 1)" vs "Total OTT v2 (YTD)"). A tile
// is marked "covered" only if its name contains a strong keyword for a
// metric this app actually computes (ott, carrier, case pick, audit).
// Anything else is flagged "not covered" — including tiles that likely
// ARE related but don't match a keyword (e.g. "CSW Performance (Last Week
// by Day)"), which is the conservative, correct choice: a false "not
// covered" just means a human looks at a tile that's actually fine; a
// false "covered" could mean a real gap goes unnoticed again.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Keyword patterns for metrics this app currently computes, per
// motherduck-scorecard-metrics.cjs. Kept here (not imported) since this
// is a lightweight, independent check — not meant to be the single source
// of truth for what's computed, just a fast heuristic for "does this tile
// look like something we already cover."
const COVERED_PATTERNS = [
  { label: 'OTT (turn time)', re: /\bott\b|on.?time/i },
  { label: 'Carrier performance', re: /carrier/i },
  { label: 'Case pick / audit accuracy', re: /case pick|audit/i },
]

function classifyTile(name) {
  for (const { label, re } of COVERED_PATTERNS) {
    if (re.test(name)) return { covered: true, matchedCategory: label }
  }
  return { covered: false, matchedCategory: null }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const API_KEY = process.env.OMNI_API_KEY
  if (!API_KEY) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'OMNI_API_KEY not configured' }) }
  }

  let dashboardId
  try {
    ;({ dashboardId } = JSON.parse(event.body || '{}'))
    if (!dashboardId) throw new Error('dashboardId is required')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }

  let res
  try {
    res = await fetch(`https://csw.omniapp.co/api/v1/documents/${encodeURIComponent(dashboardId)}/queries`, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    })
  } catch (e) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Network error reaching Omni: ${e.message}` }) }
  }

  const text = await res.text()
  if (!res.ok) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `Omni documents API → ${res.status}`, detail: text.slice(0, 500) }),
    }
  }

  let data
  try { data = JSON.parse(text) } catch { data = null }
  const queries = data?.queries || data?.results || (Array.isArray(data) ? data : [])

  const tiles = queries.map((q) => {
    const name = q.name || q.title || '(unnamed query)'
    const { covered, matchedCategory } = classifyTile(name)
    return { id: q.id || q.identifier || null, name, url: q.url || null, covered, matchedCategory }
  })

  return {
    statusCode: 200,
    headers: NO_CACHE_HEADERS,
    body: JSON.stringify({
      dashboardId,
      totalTiles: tiles.length,
      coveredCount: tiles.filter((t) => t.covered).length,
      notCoveredCount: tiles.filter((t) => !t.covered).length,
      tiles,
      fetchedAt: new Date().toISOString(),
    }),
  }
}
