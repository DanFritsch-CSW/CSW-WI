'use strict'

// Shared core for the Takt tab's Notify digests — added 2026-08-02.
// Same split pattern as every other digest in this app (see
// lib/wr-pickcheck-digest-shared.cjs for the canonical example): the
// scheduled function (takt-digest-run.cjs) keeps the `schedule` entry and
// only handles the cron tick; "Send test digest now" calls the sibling
// takt-digest-test.cjs, which has no schedule (Netlify blocks direct HTTP
// invocation of anything carrying a schedule). Both require this file so
// the actual message-building + Front-posting logic lives in one place.
//
// ONE function backs MULTIPLE settings rows — same convention as FEFO's
// per-project digest (fefo-digest-run.cjs), except here the row key is
// `facility` itself (cal/ken/mad/wr/ec) plus a sixth row, facility='all',
// for the senior-leadership rollup across every facility. All six rows
// share dashboard_type='takt' in prepick_notify_settings.
//
// CONTENT DATE — per Dan's explicit call (2026-08-02): the digest ALWAYS
// summarizes the day BEFORE it fires, regardless of what time it's
// configured to send at (a 6am send looks at yesterday, same as a 6pm
// send). This sidesteps the data-lag issue confirmed live the same
// session (gold.takt_productivity_v2_agg often doesn't have full
// same-day rows yet — see motherduck-takt-daily.cjs's header). Simpler
// and more predictable than trying to auto-detect "the most recent date
// with data," which would risk the leadership digest showing different
// dates for different facilities in the same message.
//
// Reuses motherduck-takt-daily.cjs via an internal SITE_URL fetch rather
// than re-implementing the MotherDuck query here — same established
// pattern as wr-pickcheck-digest-shared.cjs's call to
// motherduck-wr-pick-check, and the standing project note that
// Netlify-function-to-Omni/MotherDuck calls should proxy through the
// existing function rather than duplicate query logic.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL
const APP_URL = 'https://csw-wi.netlify.app/takt'

const FACILITY_LABEL = {
  cal: 'Caledonia',
  ken: 'Kenosha',
  mad: 'Madison',
  wr: 'Wisconsin Rapids',
  ec: 'Eau Claire',
}
const FACILITY_ORDER = ['cal', 'ken', 'mad', 'wr', 'ec']

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

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

// Content date is always "yesterday" relative to Central today — see the
// file header for why. Returned both as an ISO string (for the MotherDuck
// query + last_sent_date) and a UTC Date object (for weekday checks and
// display formatting), mirroring centralTodayISO/centralTodayDateObj's
// shape in every other digest-shared file.
function contentDateISO() {
  const { year, month, day } = centralNowParts()
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function contentDateObj() {
  return new Date(contentDateISO() + 'T00:00:00Z')
}

function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
}

function fmtPct(pct) { return pct == null ? '—' : `${pct.toFixed(1)}%` }

async function fetchTaktData(date, facility) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/motherduck-takt-daily`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(facility ? { date, facility } : { date }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(json?.error || text)
  return json
}

function buildFacilityDigestBody(facility, data, dateObj) {
  const label = FACILITY_LABEL[facility]
  const rollup = data.facilities.find(f => f.facility === facility)
  const lines = []
  lines.push(`Takt Performance — ${label}`)
  lines.push(`${APP_URL}?fac=${facility}`)
  lines.push('CSW Operations Hub')
  lines.push(`For: ${formatHeaderDate(dateObj)}`)
  lines.push('')

  if (!rollup || rollup.employeeCount === 0) {
    lines.push('No Takt data available for this facility on this date yet.')
    return lines.join('\n')
  }

  lines.push(`PERFORMANCE: ${fmtPct(rollup.performance.pct)}`)
  lines.push(`Efficiency: ${fmtPct(rollup.efficiency.pct)}   Utilization: ${fmtPct(rollup.totalUtilization.pct)}`)
  lines.push(`${rollup.employeeCount} employee${rollup.employeeCount === 1 ? '' : 's'}`)

  const employees = data.employees || []
  if (employees.length > 0) {
    const top = employees[0]
    const bottom = employees[employees.length - 1]
    lines.push('')
    lines.push(`Top: ${top.employeeName} (${fmtPct(top.performance.pct)})`)
    if (employees.length > 1) {
      lines.push(`Lowest: ${bottom.employeeName} (${fmtPct(bottom.performance.pct)})`)
    }
  }

  return lines.join('\n')
}

function buildLeadershipDigestBody(data, dateObj) {
  const lines = []
  lines.push('Takt Performance — All Facilities')
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push(`For: ${formatHeaderDate(dateObj)}`)
  lines.push('')

  const ranked = FACILITY_ORDER
    .map(id => data.facilities.find(f => f.facility === id) || { facility: id, facilityName: FACILITY_LABEL[id], employeeCount: 0, performance: { pct: null }, efficiency: { pct: null }, totalUtilization: { pct: null } })
    .slice()
    .sort((a, b) => (b.performance.pct ?? -Infinity) - (a.performance.pct ?? -Infinity))

  ranked.forEach((r, i) => {
    if (r.employeeCount === 0) {
      lines.push(`${i + 1}. ${r.facilityName} — no data yet`)
      return
    }
    lines.push(`${i + 1}. ${r.facilityName} — ${fmtPct(r.performance.pct)} (Eff ${fmtPct(r.efficiency.pct)} · Util ${fmtPct(r.totalUtilization.pct)}, ${r.employeeCount} emp)`)
  })

  const withData = ranked.filter(r => r.performance.pct != null)
  if (withData.length > 0) {
    const avg = withData.reduce((s, r) => s + r.performance.pct, 0) / withData.length
    lines.push('')
    lines.push(`Network average: ${avg.toFixed(1)}%`)
  }

  return lines.join('\n')
}

async function postDigest({ facility, conversationId, isManualTest }) {
  const date = contentDateISO()
  const dateObj = contentDateObj()

  let body
  if (facility === 'all') {
    const data = await fetchTaktData(date)
    body = buildLeadershipDigestBody(data, dateObj)
  } else {
    const data = await fetchTaktData(date, facility)
    body = buildFacilityDigestBody(facility, data, dateObj)
  }

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
    await sbPatch(`prepick_notify_settings?facility=eq.${facility}&dashboard_type=eq.takt`, { last_sent_date: date })
  }

  return { ok: true, date, facility, conversationId, commentId: frontJson.id }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  sbFetch, sbPatch,
  contentDateISO, contentDateObj, isNotifyTimeMatch, formatHeaderDate,
  buildFacilityDigestBody, buildLeadershipDigestBody, postDigest,
  FACILITY_LABEL, FACILITY_ORDER,
}
