'use strict'

// DPI Monthly Process — stop-to-stop travel time (A5 fix).
//
// Per Dan (2026-09-24): OSRM's public demo server, to start — no API key,
// no billing setup, consistent with the existing precedent in this app
// (dpi-geocode.cjs already chose the free US Census Geocoder over a paid
// Google/Mapbox key for the same reason). Dan may switch to
// OpenRouteService later if OSRM's public server proves unreliable; this
// function is deliberately the ONLY place that knows which provider is in
// use, so a future swap is a change to this one file, not to every place
// that needs a travel time.
//
// OSRM's public demo server (router.project-osrm.org) is NOT an
// officially production-supported service — no uptime guarantee, no
// support contract. Fine for this app's actual call volume (at most a
// couple dozen stops recalculated per route, only when a route is
// reordered/a stop is added or removed — not a live per-drag-frame call),
// but if it becomes flaky in practice, that is the signal to move to
// OpenRouteService (needs a free API key from openrouteservice.org) or a
// paid provider.
//
// Uses OSRM's Route service (not Table) because the caller always wants
// travel time for a FIXED sequence of points (facility -> stop 1 -> stop
// 2 -> ...), not a full pairwise matrix — Route's `legs[]` gives exactly
// the sequential durations needed, one per consecutive pair, in one call.
//
// Input (POST JSON): { points: [{ lat, lon }, ...] } — at least 2 points,
// in route order (first point is normally the CSW facility, though this
// function has no facility-specific knowledge; the caller decides what
// "first" means).
// Output: { legMinutes: [minutes_0_to_1, minutes_1_to_2, ...] } — one
// fewer entry than points. On failure: { error: '...', legMinutes: null }
// so the caller can distinguish "couldn't compute" from "computed as
// zero" and decide how to degrade (e.g. leave existing travel times
// alone rather than overwriting them with a guess).
//
// Tested locally with a mocked OSRM response before shipping (verified
// URL construction — lon,lat order, semicolon-separated — and duration-
// to-minutes rounding), plus every error path (too few points, bad point
// shape, wrong HTTP method, OSRM NoRoute).

const NO_CACHE_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const points = body.points
  if (!Array.isArray(points) || points.length < 2) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'points must be an array of at least 2 {lat, lon} objects' }) }
  }
  for (const p of points) {
    if (typeof p?.lat !== 'number' || typeof p?.lon !== 'number') {
      return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'every point needs numeric lat and lon' }) }
    }
  }

  // OSRM wants lon,lat (not lat,lon) pairs, semicolon-separated.
  const coordString = points.map((p) => `${p.lon},${p.lat}`).join(';')
  const url = `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=false&annotations=duration`

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 15_000)
  let res
  try {
    res = await fetch(url, { signal: abort.signal })
  } catch (err) {
    clearTimeout(timeout)
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `OSRM request failed: ${err.message}`, legMinutes: null }) }
  }
  clearTimeout(timeout)

  if (!res.ok) {
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `OSRM returned ${res.status}`, legMinutes: null }) }
  }

  const data = await res.json().catch(() => null)
  const legs = data?.routes?.[0]?.legs
  if (data?.code !== 'Ok' || !Array.isArray(legs)) {
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `OSRM: ${data?.code || 'no route found'}`, legMinutes: null }) }
  }

  const legMinutes = legs.map((leg) => Math.round((leg.duration || 0) / 60))
  return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ legMinutes }) }
}
