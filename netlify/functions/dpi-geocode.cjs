'use strict'

// DPI Monthly Process — address geocoding for the Phase 2 route map.
// Proxies to the US Census Bureau's free geocoder (no API key, no per-call
// cost — chosen over Google/Mapbox specifically to avoid adding a paid key
// just for this, per the earlier design discussion). Server-side proxy
// because direct browser calls to this API are unreliable for CORS.
//
// UNVERIFIED as of 2026-09-06: could not reach geocoding.geo.census.gov
// from the build sandbox (network egress restriction) to confirm the
// exact response shape live. Built from public API documentation —
// expects `result.addressMatches[0].coordinates.{x,y}` (x=longitude,
// y=latitude). If Census changes/differs, this will need a live-response
// adjustment; check Netlify function logs after first real use.
//
// Body: { address: "410 East Edgewater Street, Cambria, WI 53923" }
// Response: { lat, lon } or { lat: null, lon: null } if no match.

exports.handler = async function (event) {
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) }
  }

  const address = body.address
  if (!address) {
    return { statusCode: 400, body: JSON.stringify({ error: 'address is required' }) }
  }

  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 15_000)
  let res
  try {
    res = await fetch(url, { signal: abort.signal })
  } catch (err) {
    clearTimeout(timeout)
    console.error('[dpi-geocode] fetch failed:', err.message)
    return { statusCode: 200, body: JSON.stringify({ lat: null, lon: null, error: err.message }) }
  }
  clearTimeout(timeout)

  if (!res.ok) {
    console.error('[dpi-geocode] Census API non-200:', res.status)
    return { statusCode: 200, body: JSON.stringify({ lat: null, lon: null }) }
  }

  const data = await res.json().catch(() => null)
  const match = data?.result?.addressMatches?.[0]
  const coords = match?.coordinates

  if (!coords || typeof coords.y !== 'number' || typeof coords.x !== 'number') {
    return { statusCode: 200, body: JSON.stringify({ lat: null, lon: null }) }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: coords.y, lon: coords.x }),
  }
}
