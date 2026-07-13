'use strict'

// Nightly Pre-Pick Status digest — posts a summary comment to a Front
// conversation, added 2026-07-13 per Dan. Message formatting tightened
// 2026-07-13 (later same day) after the first real digest ran too text-
// heavy — see notes below.
//
// Two invocation paths (same convention as front-daily-discussion-run.cjs):
//
// 1. SCHEDULED (netlify.toml: schedule = "15 3 * * *", i.e. 03:15 UTC =
//    10:15pm CDT / 9:15pm CST — DST-unadjusted, same caveat as every other
//    scheduled function in this app). Fires the evening before, summarizing
//    TOMORROW's Madison outbound schedule.
//
// 2. MANUAL TEST (plain POST, no body needed — always targets tomorrow).
//    Called from the "Send test digest now" button on the Pre-Pick Status
//    tab settings panel. Left open (no shared-secret header) for the same
//    reason front-daily-discussion-run.cjs's manual path is open: the
//    client can't control WHO gets notified or WHAT conversation it posts
//    to (both resolved server-side from prepick_notify_settings) — worst
//    case is someone spamming test comments into their own configured
//    conversation.
//
// Where it posts: prepick_notify_settings.front_conversation_id for
// facility='mad', editable from the Pre-Pick Status tab (not hardcoded)
// per Dan's request. Posts as a COMMENT on that existing conversation
// (POST /conversations/{id}/comments) — NOT a new discussion, unlike
// front-post-discussion.cjs/front-daily-discussion-run.cjs which both
// create fresh discussions each time.
//
// Data source: proxies to motherduck-prepick-status.cjs via internal HTTP
// call rather than duplicating its ~400 lines of matching/task/complexity
// logic here. Facility hardcoded to 'mad' for now — this whole feature is
// Madison-only (see 2026-07-12 conversation on why CAL/KEN aren't ready).
//
// ── Message formatting — tightened 2026-07-13 ────────────────────────────
// First real digest (Monday night, for Tuesday 7/14) came back essentially
// listing all 17 appointments, since at 10:15pm the night before almost
// nothing has started picking yet — "not started" the night before is
// normal, not alarming, but the original format treated every not-started
// order as equally "needs attention" and repeated "not started" + the
// project's full name (always ending in the same "- CSW-Madison" suffix)
// on every single line. Dan explicitly said NOT to add a time-of-day
// urgency cutoff (he wants every order listed, not just early ones) — the
// fix requested was purely about noise reduction:
//   - Strip the repetitive "- CSW-Madison" suffix from every project name
//     (adds zero information — every order in this digest is Madison by
//     definition).
//   - Drop the redundant "— not started" phrase per line; it's now implied
//     by being under the "Not started:" section header instead.
//   - Split "Unresolved" into its own short section (real data problem,
//     distinct from ordinary not-yet-picked) instead of interleaving it
//     line-by-line with not-started orders.
const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

// "Tomorrow" in US Central time regardless of the function's own runtime TZ
// (Netlify functions run in UTC) — same pattern as front-daily-discussion-run.cjs.
function tomorrowCentral() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const y = Number(parts.find(p => p.type === 'year').value)
  const m = Number(parts.find(p => p.type === 'month').value)
  const d = Number(parts.find(p => p.type === 'day').value)
  const todayCentral = new Date(Date.UTC(y, m - 1, d))
  todayCentral.setUTCDate(todayCentral.getUTCDate() + 1)
  return todayCentral
}

function isoDate(dateObj) {
  return dateObj.toISOString().slice(0, 10)
}

function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
}

function formatArrivalTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago' })
  } catch {
    return iso
  }
}

const DIFFICULTY_LABEL = (pickLocations, rehandleRisk) => {
  if (pickLocations == null || rehandleRisk == null) return null
  const score = pickLocations + pickLocations * 2 + rehandleRisk * 3
  if (score >= 100) return 'Heavy digging'
  if (score >= 40) return 'Some digging'
  return 'Easy grab'
}

// Strips the repetitive "- CSW-Madison" style suffix that
// gold.truck_appointments.project_name always carries (e.g. "Rhodes -
// CSW-Madison" -> "Rhodes"). See file header for why this was added.
function cleanProjectName(name) {
  if (!name) return name
  return name.replace(/\s*-\s*CSW-Madison\s*$/i, '').trim()
}

function buildDigestBody(appointments, dateObj) {
  const real = appointments.filter(a => a.status !== 'placeholder')
  const ready = real.filter(a => a.status === 'ready')
  const notStarted = real
    .filter(a => a.status === 'not-started')
    .sort((a, b) => (a.scheduledArrival || '').localeCompare(b.scheduledArrival || ''))
  const unresolved = real
    .filter(a => a.status === 'unresolved')
    .sort((a, b) => (a.scheduledArrival || '').localeCompare(b.scheduledArrival || ''))

  const lines = []
  lines.push(`Madison Pre-Pick Status — ${formatHeaderDate(dateObj)}`)
  lines.push('')
  lines.push(`${ready.length} of ${real.length} outbound orders ready to load.`)

  if (notStarted.length > 0) {
    lines.push('')
    lines.push('Not started:')
    for (const a of notStarted) {
      const time = formatArrivalTime(a.scheduledArrival)
      const name = cleanProjectName(a.projectName) || a.carrierName || a.lookupCode || 'Unknown'
      const difficulty = DIFFICULTY_LABEL(a.pickLocations, a.rehandleRisk)
      const cases = a.expectedCases != null ? `${Math.round(a.expectedCases)} cases` : 'cases unknown'
      const diff = difficulty ? ` · ${difficulty}` : ''
      lines.push(`- ${time} ${name} — ${cases}${diff}`)
    }
  }

  if (unresolved.length > 0) {
    lines.push('')
    lines.push('No order found in Datex:')
    for (const a of unresolved) {
      const time = formatArrivalTime(a.scheduledArrival)
      const name = cleanProjectName(a.projectName) || a.carrierName || a.lookupCode || 'Unknown'
      lines.push(`- ${time} ${name}`)
    }
  }

  if (notStarted.length === 0 && unresolved.length === 0) {
    lines.push('')
    lines.push('Nothing needs attention — everything is ready or already picked.')
  }

  return lines.join('\n')
}

async function runDigest() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(`prepick_notify_settings?facility=eq.mad&select=front_conversation_id`)
  const conversationId = settingsRows?.[0]?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for Madison in prepick_notify_settings' }
  }

  const dateObj = tomorrowCentral()
  const date = isoDate(dateObj)

  const statusRes = await fetch(`${SITE_URL}/.netlify/functions/motherduck-prepick-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facilityId: 'mad', date }),
  })
  const statusText = await statusRes.text()
  let statusJson
  try { statusJson = JSON.parse(statusText) } catch { statusJson = { raw: statusText } }
  if (!statusRes.ok) {
    return { ok: false, reason: 'motherduck-prepick-status failed', detail: statusJson }
  }

  const body = buildDigestBody(statusJson.appointments || [], dateObj)

  const frontRes = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FRONT_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ body }),
  })
  const frontText = await frontRes.text()
  let frontJson
  try { frontJson = JSON.parse(frontText) } catch { frontJson = { raw: frontText } }

  if (!frontRes.ok) {
    return { ok: false, reason: 'Front API error posting comment', detail: frontJson }
  }

  return { ok: true, date, conversationId, commentId: frontJson.id, appointmentCount: (statusJson.appointments || []).length }
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  const isManualTest = event.httpMethod === 'POST' && !isScheduled

  if (!isScheduled && !isManualTest) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only (or scheduled invocation)' }) }
  }

  try {
    const result = await runDigest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
