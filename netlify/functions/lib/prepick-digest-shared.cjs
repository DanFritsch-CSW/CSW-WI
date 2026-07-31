'use strict'

// Shared core for the Madison Pre-Pick Status nightly digest — split out
// 2026-07-31 from prepick-digest-run.cjs.
//
// WHY THIS SPLIT EXISTS: Netlify does not allow direct HTTP invocation of
// any function that has a `schedule` set in netlify.toml — confirmed via
// Netlify's own docs and reproduced live on 2026-07-30 for every FEFO
// digest ("Send test digest now" started 403ing with an empty-body,
// text/plain, Server: Netlify response generated before our own code ever
// runs). That fix only touched the two FEFO functions at the time; this
// same root cause affects every other scheduled digest in the app,
// including this one, which is why "Send test digest now" here also
// 403s. Same fix pattern: the function that CARRIES the `schedule`
// (prepick-digest-run.cjs) is now scheduled-tick-only. A separate
// function with NO schedule entry in netlify.toml
// (prepick-digest-test.cjs) handles manual "Send test digest now" clicks
// instead. Both require this shared module so the actual digest logic
// (message building, Front posting) lives in exactly one place.
//
// Everything below is otherwise unchanged from the original
// prepick-digest-run.cjs — see that file's original header (preserved in
// git history) for the fuller feature history (configurable send time,
// weekday filter, skip-to-next-valid-day lookahead, pallet estimates,
// the time-display timezone fix, etc).

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

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

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

async function postDigest({ conversationId, dateObj, isManualTest }) {
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

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.mad&dashboard_type=eq.prepick`, { last_sent_date: date })
  }

  return { ok: true, date, conversationId, commentId: frontJson.id, appointmentCount: (statusJson.appointments || []).length }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  sbFetch, sbPatch,
  centralNowParts, centralTodayISO, isNotifyTimeMatch, tomorrowCentral,
  isoWeekday, isoDate, formatHeaderDate,
  buildDigestBody, postDigest,
}
