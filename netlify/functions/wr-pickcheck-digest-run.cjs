'use strict'

// WR Pick Location Lot Check digest. Added same day as the tab itself.
// Content date is TODAY, not tomorrow — this is a live "is the oldest
// available lot in the right spot right now" check, same reasoning as
// fefo-digest-run.cjs (no appointment lead-time to look ahead across).
// Mirrors that file's structure closely: single settings row (unlike
// FEFO's per-project rows), facility='wr', dashboard_type='pick_check' in
// prepick_notify_settings, editable from the Pick Location Lot Check
// tab's Notify Settings panel (contentDateLabel="today",
// showSkipToNextValidDay={false} — see NotifySettingsPanel.jsx).
//
// Data source: proxies to motherduck-wr-pick-check.cjs via internal HTTP
// call, same pattern as every other digest proxying its own live-data
// function rather than duplicating the MotherDuck query here.
//
// ── Message format — simplified further 2026-07-31 per Dan's feedback ──
// Prior version (2026-07-15) still listed every material under each
// call-out. Dan wanted it cut down to just the header line + count per
// section, no bullet detail at all — and a 4th call-out added for
// materials aging under 60 days (in addition to the existing <120d
// total), since <60d is the tighter/more urgent cut Dan actually watches.
// Section order: Secondary → Warehouse → Aging (<120d) → Aging (<60d).
// <60d count = agingCritical (<30d) + agingWarning (30-59d), per the
// severity bands documented in motherduck-wr-pick-check.cjs (Critical
// <30d / Warning 30-59d / Watch 60-119d). <120d total is unchanged
// (Critical+Warning+Watch). No "None right now." filler text anymore —
// just the count; 0 reads fine on its own in this stripped-down format.
//
// Two invocation paths (same convention as every other digest):
//   1. SCHEDULED (netlify.toml: "*/15 * * * *") — fires when current
//      America/Chicago time matches notify_hour/notify_minute and hasn't
//      already sent today (last_sent_date guard, keyed to today's date
//      since content date === fire date here).
//   2. MANUAL TEST (plain POST, no body) — bypasses time/active/
//      last_sent_date checks, never writes last_sent_date.

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL
const APP_URL = 'https://csw-wi.netlify.app/facility/wr?tab=pickcheck'

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

function centralTodayISO() {
  const { year, month, day } = centralNowParts()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function centralTodayDateObj() {
  const { year, month, day } = centralNowParts()
  return new Date(Date.UTC(year, month - 1, day))
}

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

function fmt(n) { return n == null ? '—' : Math.round(n).toLocaleString() }

function callOutBlock(lines, label) {
  const divider = '─'.repeat(28)
  lines.push(divider)
  lines.push(label)
  lines.push(divider)
}

function buildDigestBody(data, dateObj) {
  const s = data.summary
  const lines = []
  lines.push(`Pick Location Lot Check — Bernatello's - Wisconsin Rapids`)
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push(`As of: ${formatHeaderDate(dateObj)}`)

  const agingTotal = (s.agingCritical || 0) + (s.agingWarning || 0) + (s.agingWatch || 0)
  const agingUnder60 = (s.agingCritical || 0) + (s.agingWarning || 0)

  callOutBlock(lines, `${fmt(s.secondary)} MATERIAL${s.secondary === 1 ? '' : 'S'} IN SECONDARY`)
  callOutBlock(lines, `${fmt(s.warehouse)} MATERIAL${s.warehouse === 1 ? '' : 'S'} OUT IN WAREHOUSE`)
  callOutBlock(lines, `${fmt(agingTotal)} MATERIAL${agingTotal === 1 ? '' : 'S'} AGING (<120d)`)
  callOutBlock(lines, `${fmt(agingUnder60)} MATERIAL${agingUnder60 === 1 ? '' : 'S'} AGING (<60d)`)

  return lines.join('\n')
}

async function runDigest({ isManualTest }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.wr&dashboard_type=eq.pick_check&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settings = settingsRows?.[0]
  const conversationId = settings?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for WR Pick Location Lot Check in prepick_notify_settings' }
  }

  const dateObj = centralTodayDateObj()
  const date = centralTodayISO()

  if (!isManualTest) {
    if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }
    const notifyHour = settings.notify_hour ?? 7
    const notifyMinute = settings.notify_minute ?? 0
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
    }
    if (settings.last_sent_date === date) {
      return { ok: true, skipped: true, reason: 'Already sent for this date' }
    }
    // Weekday filter — checked against TODAY (content date === fire date here)
    const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
    const isoWeekday = dateObj.getUTCDay() === 0 ? 7 : dateObj.getUTCDay()
    if (!notifyDays.includes(isoWeekday)) {
      return { ok: true, skipped: true, reason: `${date} is not a configured notify day` }
    }
  }

  const pickCheckRes = await fetch(`${SITE_URL}/.netlify/functions/motherduck-wr-pick-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const pickCheckText = await pickCheckRes.text()
  let pickCheckJson
  try { pickCheckJson = JSON.parse(pickCheckText) } catch { pickCheckJson = { raw: pickCheckText } }
  if (!pickCheckRes.ok) {
    return { ok: false, reason: 'motherduck-wr-pick-check failed', detail: pickCheckJson }
  }

  const body = buildDigestBody(pickCheckJson, dateObj)

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
    await sbPatch(`prepick_notify_settings?facility=eq.wr&dashboard_type=eq.pick_check`, { last_sent_date: date })
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
