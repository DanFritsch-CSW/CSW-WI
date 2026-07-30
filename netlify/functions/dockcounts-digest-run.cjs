'use strict'

// Madison Dock Counts digest. Added 2026-07-30, same day as the on-demand
// tab itself. Built per Dan's explicit ask: "on demand pull for now, but
// give me the ability within the UI to toggle it back on" — so this
// function exists and is fully wired (Front conversation ID, send time,
// Mon-Fri toggle, all via the shared NotifySettingsPanel), but the
// prepick_notify_settings row is seeded/left with active=false. Nothing
// fires on a schedule until Dan flips Enabled in the Dock Counts tab.
//
// Content date is TOMORROW (mirrors Pre-Pick/Cases/Daily Ops, not FEFO's
// "today" pattern) — the ops manager's message is explicitly framed as
// "looking ahead to tomorrow", i.e. an evening-before-shift forecast, same
// reasoning as every other MAD evening digest.
//
// Message format: a Front code block (triple backtick) so the IN/OUT
// columns stay monospace-aligned — Front's comment Markdown doesn't
// support real tables (confirmed via Front's own help docs during the
// FEFO digest build), but code blocks render fixed-width and hold
// alignment fine. Mirrors the exact layout confirmed with Dan in-chat
// before this was wired up.
//
// Data source: proxies to motherduck-dock-counts.cjs via internal HTTP
// call (same pattern as every other digest), passing the resolved
// tomorrow date.
//
// Two invocation paths (same convention as every other digest):
//   1. SCHEDULED (netlify.toml: "*/15 * * * *") — fires when current
//      America/Chicago time matches notify_hour/notify_minute, the
//      resolved content date's weekday is in notify_days, and it hasn't
//      already sent for that content date (last_sent_date guard).
//   2. MANUAL TEST (plain POST, no body) — bypasses time/active/
//      notify_days/last_sent_date checks entirely, always sends for
//      tomorrow, never writes last_sent_date.

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL
const APP_URL = 'https://csw-wi.netlify.app/facility/mad?tab=dockcounts'

const DOCK_ROWS = [
  { key: 'dock8', label: 'Dock 8' },
  { key: 'east', label: 'East' },
  { key: 'west', label: 'West' },
]

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

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function centralTomorrowDateObj() {
  const { year, month, day } = centralNowParts()
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() + 1)
  return d
}

function isoDate(dateObj) { return dateObj.toISOString().slice(0, 10) }

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
}

function pad(str, len) { return String(str).padEnd(len, ' ') }

function buildDigestBody(dockCountsJson, dateObj) {
  const docks = dockCountsJson.docks || {}
  const lines = []
  lines.push(`Looking ahead to ${formatHeaderDate(dateObj)}:`)
  lines.push('')
  lines.push('```')
  lines.push(`${pad('', 10)}IN    OUT`)
  for (const row of DOCK_ROWS) {
    const d = docks[row.key] || { in: 0, out: 0 }
    lines.push(`${pad(row.label, 10)}${pad(d.in, 6)}${d.out}`)
  }
  lines.push('```')
  if (docks.other && (docks.other.in > 0 || docks.other.out > 0)) {
    lines.push('')
    lines.push(`Note: ${docks.other.in + docks.other.out} load(s) at an unrecognized dock/location — check the Dock Counts tab.`)
  }
  lines.push('')
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  return lines.join('\n')
}

async function runDigest({ isManualTest }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.mad&dashboard_type=eq.dock_counts&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settings = settingsRows?.[0]
  const conversationId = settings?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for Madison Dock Counts in prepick_notify_settings' }
  }

  const dateObj = centralTomorrowDateObj()
  const date = isoDate(dateObj)

  if (!isManualTest) {
    if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }
    const notifyHour = settings.notify_hour ?? 22
    const notifyMinute = settings.notify_minute ?? 15
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
    }
    if (settings.last_sent_date === date) {
      return { ok: true, skipped: true, reason: 'Already sent for this date' }
    }
    const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
    const isoWeekday = dateObj.getUTCDay() === 0 ? 7 : dateObj.getUTCDay()
    if (!notifyDays.includes(isoWeekday)) {
      return { ok: true, skipped: true, reason: `${date} is not a configured notify day` }
    }
  }

  const dockRes = await fetch(`${SITE_URL}/.netlify/functions/motherduck-dock-counts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  })
  const dockText = await dockRes.text()
  let dockJson
  try { dockJson = JSON.parse(dockText) } catch { dockJson = { raw: dockText } }
  if (!dockRes.ok) {
    return { ok: false, reason: 'motherduck-dock-counts failed', detail: dockJson }
  }

  const body = buildDigestBody(dockJson, dateObj)

  const frontRes = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const frontText = await frontRes.text()
  let frontJson
  try { frontJson = JSON.parse(frontText) } catch { frontJson = { raw: frontText } }
  if (!frontRes.ok) {
    return { ok: false, reason: 'Front API error posting comment', detail: frontJson }
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.mad&dashboard_type=eq.dock_counts`, { last_sent_date: date })
  }

  return { ok: true, date, conversationId, commentId: frontJson.id }
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
