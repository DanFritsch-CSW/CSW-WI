'use strict'

// Syncs Front channels (shared inboxes + personal channels) into Supabase
// (front_channels), so Settings can offer a "From" picker for anything that
// creates Front drafts/messages — starting with CMM Outbound Appts, which
// otherwise always drafts from the hardcoded CSW Main channel (cha_erzf8).
//
// Mirrors front-teammates-nightly-sync.cjs: upsert-only, no delete (a
// removed/archived channel's row just goes stale — harmless, same posture
// as front_teammates). GET /channels returns each channel's id, name,
// address (the actual From email), and type (custom/smtp/etc — 'email'-ish
// channels are the ones useful here, but no filtering is applied since Dan
// can see the type in the picker and just won't pick e.g. an SMS channel).
//
// Two invocation paths — same convention as every other digest/sync here:
//   1. SCHEDULED (netlify.toml, nightly, right after front-teammates-
//      nightly-sync.cjs) — no request body.
//   2. MANUAL (POST, any body or none) — same sync, for "Sync channels now"
//      in Settings so Dan doesn't have to wait for the nightly tick.
// Open, no shared secret — same reasoning as front-teammates-nightly-sync.cjs:
// this only reads Front's channel list and writes non-sensitive metadata
// (name/address/type) to Supabase; it can't be used to exfiltrate or send
// anything.

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only (or scheduled invocation)' }) }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Supabase env not configured' }) }
  }
  if (!FRONT_TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'FRONT_API_TOKEN not set' }) }
  }

  try {
    const frontRes = await fetch('https://api2.frontapp.com/channels', {
      headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
    })
    const frontText = await frontRes.text()
    if (!frontRes.ok) {
      return { statusCode: frontRes.status, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Front API error', detail: frontText }) }
    }
    const frontData = JSON.parse(frontText)
    const channels = frontData._results || []

    if (!channels.length) {
      return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, synced: 0, note: 'Front returned zero channels — no-op, not treated as a delete signal' }) }
    }

    const rows = channels.map(c => ({
      channel_id: c.id,
      name: c.name || null,
      address: c.address || null,
      channel_type: c.type || null,
      synced_at: new Date().toISOString(),
    }))

    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/front_channels?on_conflict=channel_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    })

    if (!upsertRes.ok) {
      const detail = await upsertRes.text()
      return { statusCode: upsertRes.status, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Supabase upsert error', detail }) }
    }

    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, synced: rows.length }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
