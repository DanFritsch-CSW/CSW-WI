'use strict'

// Shared core for the WR "Cases To Pick" nightly digest — split out
// 2026-07-31 from wr-cases-digest-run.cjs. Same fix as
// lib/prepick-digest-shared.cjs / lib/fefo-digest-shared.cjs: Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` in
// netlify.toml, which made "Send test digest now" 403 here too. The
// scheduled function (wr-cases-digest-run.cjs) keeps the schedule and
// only handles the cron tick; the manual test button now calls the
// sibling wr-cases-digest-test.cjs, which has no schedule.
//
// Everything below is otherwise unchanged from the original
// wr-cases-digest-run.cjs — see that file's original header (preserved in
// git history) for the fuller feature history (configurable send time,
// weekday filter, skip-to-next-valid-day lookahead, the Front Markdown
// "#" heading-eating fix, etc).

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

function fmt(n) {
  if (n == null) return '—'
  return Math.round(n).toLocaleString()
}

function buildDigestBody(data, dateObj) {
  const lines = []
  lines.push(`Bernatello's - Wisconsin Rapids:`)
  lines.push(`Cases To Pick — ${formatHeaderDate(dateObj)}`)
  lines.push('')
  lines.push(`Total DSD Cases (Pickline & Outside): ${fmt(data.totalDsdCases)} Cases`)
  lines.push(`• To Pick Outside Pickline: ${fmt(data.casesOutsidePickline)}`)
  lines.push(`• Full pallet pick: ${fmt(data.fullPalletPickCount)}`)
  lines.push(`• Warehouse Case pick: ${fmt(data.casePickCases)}`)
  lines.push('')
  lines.push('━━━━━━━━━━━━━━━━━━━━')
  lines.push(`**TOTAL PICKLINE VOLUME: ${fmt(data.picklineVolume)}**`)
  lines.push('━━━━━━━━━━━━━━━━━━━━')
  lines.push('')
  lines.push(`Total NON-DSD Orders Tomorrow:`)
  lines.push(`NON-DSD Cases: ${fmt(data.nonDsdCases)}`)
  lines.push(`Full Pallets: ${fmt(data.fullPalletsSo)}`)
  lines.push(`Case Picking on SO Orders: ${fmt(data.casePickingOnSoOrders)}`)
  return lines.join('\n')
}

async function postDigest({ conversationId, dateObj, isManualTest }) {
  const date = isoDate(dateObj)

  const casesRes = await fetch(`${SITE_URL}/.netlify/functions/motherduck-wr-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  })
  const casesText = await casesRes.text()
  let casesJson
  try { casesJson = JSON.parse(casesText) } catch { casesJson = { raw: casesText } }
  if (!casesRes.ok) {
    return { ok: false, reason: 'motherduck-wr-cases failed', detail: casesJson }
  }

  const body = buildDigestBody(casesJson, dateObj)

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
    await sbPatch(`prepick_notify_settings?facility=eq.wr&dashboard_type=eq.cases_to_pick`, { last_sent_date: date })
  }

  return { ok: true, date, conversationId, commentId: frontJson.id }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  sbFetch, sbPatch,
  centralNowParts, centralTodayISO, isNotifyTimeMatch, tomorrowCentral,
  isoWeekday, isoDate, formatHeaderDate,
  buildDigestBody, postDigest,
}
