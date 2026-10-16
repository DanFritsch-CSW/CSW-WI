'use strict'

// CMM Empty Trailer hourly "ping" -- added 2026-10-16 per the team's ask: the
// daily kickoff thread (lib/cmm-empty-trailer-email-shared.cjs) tends to sink
// in the inbox over the course of a day, so this posts a no-content internal
// Front comment every hour from 4am-10pm Central -- "(4am Update)", "(5am
// Update)", etc. -- just to bump the conversation back to the top. It is
// NOT a status update and carries no door/trailer data; it's purely an
// inbox-sort nudge, same spirit as a "bump" message.
//
// Gated on the SAME active flag as the kickoff email itself
// (prepick_notify_settings, facility='cal', dashboard_type=
// 'cmm_empty_trailer') -- there's no separate on/off switch for this, per
// Dan: ping whenever "Auto-send daily" is checked. Targets whatever
// conversation the kickoff email most recently created
// (last_conversation_id, written by the email-send function) -- this
// function never creates a conversation itself and never resends the email.
//
// The comment posts with NO author_id. Front's Add Comment endpoint
// (confirmed via Front's own API docs, 2026-10-16) accepts an omitted
// author_id and will post the comment as "the API Token... of the
// requester" -- a bot-teammate identity distinct from any real person, so
// these hourly bumps don't appear to come from Dan (or anyone) personally.
//
// Dedup: last_ping_at (a timestamp, not an hour number) records the last
// successful ping. Comparing its Central date+hour against the current
// Central date+hour is what prevents a double-post when the */15 cron tick
// fires 4 times inside the same hour -- a plain "last_ping_hour" integer
// would go stale across midnight and silently stop pinging the next
// morning's thread until manually cleared, so a timestamp was used instead.
// last_ping_at is reset to null by the email-send function every time a new
// kickoff goes out, so this logic never needs to reason about "which day's
// thread is this ping for" itself -- last_conversation_id and last_ping_at
// are always in sync for the CURRENT day's thread by construction.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN

const FACILITY = 'cal'
const DASHBOARD_TYPE = 'cmm_empty_trailer'

// Fixed window, not configurable from Settings -- per Dan, 4am-10pm CT
// every day the kickoff email itself is active, independent of that
// email's own (configurable) send time.
const PING_START_HOUR = 4
const PING_END_HOUR = 22

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
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
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(t) }
}

function centralParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function centralTodayIso() {
  const { year, month, day } = centralParts(new Date())
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

function sameCentralDateHour(aDate, bDate) {
  const a = centralParts(aDate)
  const b = centralParts(bDate)
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour
}

function formatHourLabel(hour) {
  const period = hour < 12 ? 'am' : 'pm'
  let h12 = hour % 12
  if (h12 === 0) h12 = 12
  return `${h12}${period}`
}

async function frontPostComment(conversationId, body) {
  // No author_id -- see header note. Posts as the API token's own bot
  // identity in Front, not as any teammate.
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw Object.assign(new Error('Front comment failed'), { detail: json })
  return json
}

async function runPing({ isManualTest }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}&select=active,last_sent_date,last_conversation_id,last_ping_at`
  )
  const settings = settingsRows?.[0]
  if (!settings) return { ok: false, reason: `No prepick_notify_settings row for ${FACILITY}/${DASHBOARD_TYPE}` }

  const now = new Date()
  const { hour, minute } = centralParts(now)
  const today = centralTodayIso()

  if (!isManualTest) {
    if (settings.active === false) return { ok: true, skipped: true, reason: 'Disabled (Auto-send daily is unchecked)' }
    if (hour < PING_START_HOUR || hour > PING_END_HOUR) return { ok: true, skipped: true, reason: `Outside the ${PING_START_HOUR}am-${PING_END_HOUR - 12}pm CT ping window` }
    if (minute !== 0) return { ok: true, skipped: true, reason: 'Not the top of the hour yet' }
  }

  if (!settings.last_conversation_id) {
    return { ok: false, reason: "No conversation to ping yet -- today's kickoff email hasn't sent" }
  }
  if (settings.last_sent_date !== today) {
    return { ok: true, skipped: true, reason: `last_conversation_id is from ${settings.last_sent_date}, not today (${today}) -- no ping` }
  }
  if (!isManualTest && settings.last_ping_at && sameCentralDateHour(new Date(settings.last_ping_at), now)) {
    return { ok: true, skipped: true, reason: 'Already pinged this hour' }
  }

  const label = formatHourLabel(hour)
  const body = `(${label} Update)`

  const comment = await frontPostComment(settings.last_conversation_id, body)

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}`, {
      last_ping_at: now.toISOString(),
    })
  }

  return { ok: true, conversationId: settings.last_conversation_id, body, commentId: comment?.id }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN,
  FACILITY, DASHBOARD_TYPE,
  sbFetch, sbPatch,
  runPing,
}
