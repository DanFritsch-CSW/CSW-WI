'use strict'

// Nightly Pre-Pick Status digest — posts a summary comment to a Front
// conversation, added 2026-07-13 per Dan. Message formatting tightened
// 2026-07-13 (later same day) after the first real digest ran too text-
// heavy. Time display fixed 2026-07-13 (later still). Pallet estimate
// added 2026-07-13 (later still) — see notes below.
//
// ── Configurable send time — added 2026-07-14 ────────────────────────────
// Dan asked for the ability to change what time this fires from the UI,
// for both this digest and the new WR Cases To Pick digest
// (wr-cases-digest-run.cjs, same pattern). Netlify's cron schedule is
// fixed at deploy time — it can't read a per-row DB setting to decide
// when to fire — so the redesign moves the schedule check INSIDE the
// function instead of relying on netlify.toml's cron to be the single
// source of truth for the exact minute:
//   - netlify.toml now fires this function every 15 minutes
//     (`*/15 * * * *`), same cadence as revision-sync.cjs.
//   - On each tick, the function reads notify_hour/notify_minute/active
//     from prepick_notify_settings (facility='mad', dashboard_type=
//     'prepick') and compares against the CURRENT America/Chicago local
//     time (computed via Intl, not a fixed UTC offset — this is actually
//     more DST-correct than the old fixed-cron design, which drifted an
//     hour with US DST like every other scheduled function in this app).
//   - Minutes are bucketed to the nearest 15 (0/15/30/45) since the check
//     only runs every 15 min anyway.
//   - `last_sent_date` (Central-time date) guards against double-sending
//     if the tick and the target time land in the same bucket more than
//     once, or if Netlify's scheduler fires slightly early/late.
//   - The MANUAL TEST path (button in the UI) bypasses all of this and
//     always sends immediately for tomorrow's date, exactly as before —
//     it does not read or write last_sent_date, so a test send doesn't
//     interfere with the scheduled send happening later that day.
//
// ── Weekday filter — added 2026-07-14 (later) ────────────────────────────
// Dan: no weekend sends. `notify_days` (SMALLINT[], ISO weekday numbers
// 1=Mon..7=Sun, DEFAULT '{1,2,3,4,5}') is checked against the WEEKDAY OF
// THE CONTENT DATE — i.e. "tomorrow", the day being summarized — not the
// weekday the digest actually fires on. This matters because the digest
// always fires the evening before: a Sunday-night tick summarizes Monday
// (a workday, so it should send), while a Friday-night tick summarizes
// Saturday (a non-workday, so it should skip) even though Friday itself
// is a configured day. Checking the fire-date's weekday instead would get
// this backwards. Manual test bypasses this filter too, same as the
// time/active checks above.
//
// Two invocation paths (same convention as front-daily-discussion-run.cjs):
//
// 1. SCHEDULED (netlify.toml: schedule = "*/15 * * * *" as of 2026-07-14,
//    was a fixed "15 3 * * *" before the configurable-time redesign above).
//    Only actually sends when the current Central time matches the
//    configured notify_hour/notify_minute AND it hasn't already sent
//    today — otherwise it's a fast no-op. Fires the evening before,
//    summarizing TOMORROW's Madison outbound schedule.
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
// facility='mad'/dashboard_type='prepick', editable from the Pre-Pick
// Status tab (not hardcoded) per Dan's request. Posts as a COMMENT on
// that existing conversation (POST /conversations/{id}/comments) — NOT a
// new discussion, unlike front-post-discussion.cjs/
// front-daily-discussion-run.cjs which both create fresh discussions
// each time.
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
//
// ── Time display — fixed 2026-07-13 ──────────────────────────────────────
// scheduled_arrival comes out of MotherDuck as a naive string like
// "2026-07-13 07:30:00" with NO timezone marker — it's already Central
// time (Datex's own local clock; confirmed via direct query). The
// original version did `new Date(raw)` then converted to America/Chicago
// for display. On Netlify's UTC-runtime servers, `new Date("2026-07-13
// 07:30:00")` (space-separated, non-ISO format) gets misparsed as 07:30
// UTC — and then the explicit America/Chicago conversion shifted it BACK
// another 5 hours on top of that, so a real 7:30am appointment displayed
// as 2:30am. Dan caught this by comparing the digest's times against the
// live app tile, which never showed the bug — it runs in the browser
// (already Central), so the same misparse + no extra shift happened to
// cancel out by coincidence. Relying on that coincidence was fragile; this
// function proved it. Fix: skip Date/timezone conversion entirely and read
// the HH:MM straight out of the raw string — it's already correct Central
// time, there's nothing to convert.
//
// ── Estimated pallets — added 2026-07-13 ────────────────────────────────
// motherduck-prepick-status.cjs now returns estimatedPallets (from
// material tie/high, see that file's header for the full definition and
// coverage caveats). Shown per not-started line as "~N pallets" when
// available; omitted when null (no tie/high data for that order at all)
// rather than showing a misleading 0.
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

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(t) }
}

// Current America/Chicago local time, computed fresh via Intl rather than
// a fixed UTC offset — correctly tracks CDT/CST without a DST-adjustment
// bug (see file header "Configurable send time").
function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function centralTodayISO() {
  const { year, month, day } = centralNowParts()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Bucketed to 15 min since the scheduled tick only runs every 15 minutes.
function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
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

// ISO weekday: 1=Mon .. 7=Sun (JS getUTCDay() is 0=Sun..6=Sat).
function isoWeekday(dateObj) {
  const dow = dateObj.getUTCDay()
  return dow === 0 ? 7 : dow
}

function isoDate(dateObj) {
  return dateObj.toISOString().slice(0, 10)
}

function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
}

// Reads HH:MM straight out of the raw "YYYY-MM-DD HH:MM:SS" string — see
// file header "Time display — fixed 2026-07-13" for why this deliberately
// avoids Date/timezone conversion entirely.
function formatArrivalTime(raw) {
  if (!raw) return '—'
  const m = /(\d{2}):(\d{2})/.exec(raw)
  if (!m) return raw
  let hour = parseInt(m[1], 10)
  const minute = m[2]
  const period = hour >= 12 ? 'PM' : 'AM'
  hour = hour % 12
  if (hour === 0) hour = 12
  return `${hour}:${minute} ${period}`
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
      const pallets = a.estimatedPallets != null ? `, ~${a.estimatedPallets} pallets` : ''
      const diff = difficulty ? ` · ${difficulty}` : ''
      lines.push(`- ${time} ${name} — ${cases}${pallets}${diff}`)
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

async function runDigest({ isManualTest }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.mad&dashboard_type=eq.prepick&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settings = settingsRows?.[0]
  const conversationId = settings?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for Madison in prepick_notify_settings' }
  }

  const dateObj = tomorrowCentral()
  const date = isoDate(dateObj)

  // Scheduled ticks fire every 15 min (see file header "Configurable send
  // time") — only actually send when this tick matches the configured
  // time and hasn't already fired today. Manual test always sends
  // immediately and never touches last_sent_date.
  if (!isManualTest) {
    if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }
    const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
    if (!notifyDays.includes(isoWeekday(dateObj))) {
      return { ok: true, skipped: true, reason: `${date} is not a configured notify day` }
    }
    const notifyHour = settings.notify_hour ?? 22
    const notifyMinute = settings.notify_minute ?? 15
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
    }
    const todayCentral = centralTodayISO()
    if (settings.last_sent_date === todayCentral) {
      return { ok: true, skipped: true, reason: 'Already sent today' }
    }
  }

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

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.mad&dashboard_type=eq.prepick`, { last_sent_date: centralTodayISO() })
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
    const result = await runDigest({ isManualTest })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
