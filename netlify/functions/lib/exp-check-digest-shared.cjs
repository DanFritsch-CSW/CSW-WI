'use strict'

// Shared core for the EXP Check nightly digest — added 2026-08-02.
// One settings row PER DATEX PROJECT (not per customer), same pattern as
// fefo-digest-shared.cjs — e.g. Bernatello's - Wisconsin Rapids and
// Pretzilla Kenosha each get their own Front conversation, send time, and
// Enabled toggle, rather than one combined digest per customer.
//
// WHY THIS FILE IS SPLIT FROM THE -run/-test ENTRYPOINTS: same reason as
// every other digest on this project (see fefo-digest-shared.cjs's header
// for the full story) — Netlify blocks direct HTTP invocation of any
// function carrying a `schedule` in netlify.toml, so the scheduled-tick
// function and the manual-test function have to be two separate files
// that both require this shared module, rather than one combined file.
//
// Content date is TODAY (same as FEFO, WR Pick Check, Secondary
// Replenishments) — this is a live "is the data clean right now" check,
// not an appointment-based forecast, so there's no tomorrow-lead-time
// reason to look ahead.
//
// Message format confirmed with Dan (his own drafted example, matched
// exactly): header line with project name, bare URL (Front auto-linkifies,
// doesn't render Markdown links — same lesson learned building the FEFO
// and Daily Ops digests), "CSW Operations Hub" label line, "As of: {date}",
// then one divider-bracketed count block per category. Categories included:
// Julian Mismatch (the check that actually catches a misread Julian code —
// see motherduck-exp-check.cjs's header), EXP Mismatch, No Shelf Life, and
// Relabeled — Verify. Every category always shows, even at 0, so "all
// clear" is exactly as visible as a real problem — same convention as
// every other digest on this project.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

// One entry per Datex project — mirrors CUSTOMERS/PROJECT_FACILITY/PROJECT_NAME
// in motherduck-exp-check.cjs. Keep these two files' project lists in sync
// if a project is ever added/removed from either check.
const EXP_CHECK_PROJECTS = [
  { id: 230, key: 'pretzilla_ken', code: 'PRETZ5', name: 'Pretzilla Kenosha', facility: 'ken' },
  { id: 342, key: 'pretzilla_ken_cooler', code: 'PRTZL5', name: 'Pretzilla COOLER Kenosha', facility: 'ken' },
  { id: 28, key: 'pretzilla_cal_frozen', code: 'PRETZ9', name: 'Pretzilla FROZEN Caledonia', facility: 'cal' },
  { id: 145, key: 'pretzilla_cal_cooler', code: 'PRTZL9', name: 'Pretzilla COOLER Caledonia', facility: 'cal' },
  { id: 297, key: 'pretzilla_mad', code: 'PRETZ1', name: 'Pretzilla - CSW-Madison', facility: 'mad' },
  { id: 336, key: 'pretzilla_mad_dry', code: 'PRETD1', name: 'Pretzilla - Dry - CSW-Madison', facility: 'mad' },
  { id: 282, key: 'bernatellos_mad', code: 'BERNA1', name: "Bernatello's - CSW-Madison", facility: 'mad' },
  { id: 320, key: 'bernatellos_wr', code: 'BERNA3', name: "Bernatello's - Wisconsin Rapids", facility: 'wr' },
]
const PROJECT_BY_DASHBOARD_TYPE = new Map(EXP_CHECK_PROJECTS.map((p) => [`exp_check_${p.key}`, p]))
const DEFAULT_NOTIFY_DAYS = [1, 2, 3, 4, 5]
const APP_URL = 'https://csw-wi.netlify.app/customers?tab=expcheck'
const DEFAULT_DAY_WINDOW = 45

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
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
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

function isoWeekday(dateObj) {
  const dow = dateObj.getUTCDay()
  return dow === 0 ? 7 : dow
}

function isoDate(dateObj) { return dateObj.toISOString().slice(0, 10) }

function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
}

function buildDigestBody(data, project, dateObj) {
  const lines = []
  lines.push(`EXP Check — ${project.name}`)
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push(`As of: ${formatHeaderDate(dateObj)}`)
  lines.push('')

  const divider = '─'.repeat(28)
  const block = (count, label) => {
    lines.push(divider)
    lines.push(`${count} ${label}`)
    lines.push(divider)
  }

  const julianMismatch = data?.julianSummary?.mismatch ?? 0
  const expMismatch = data?.summary?.mismatch ?? 0
  const noShelfLife = data?.summary?.no_shelf_life ?? 0
  const relabeled = data?.summary?.relabeled ?? 0

  block(julianMismatch, 'Julian Mismatched')
  lines.push('')
  block(expMismatch, 'Mismatched')
  lines.push('')
  block(noShelfLife, 'No Shelf Life')
  if (relabeled > 0) {
    lines.push('')
    block(relabeled, 'Relabeled — Verify Manually')
  }

  return lines.join('\n')
}

async function runForProject({ settingsRow, project, dateObj, isManualTest }) {
  const conversationId = settingsRow?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for ${project.code}`, project: project.code }
  }

  const date = isoDate(dateObj)

  const dataRes = await fetch(`${SITE_URL}/.netlify/functions/motherduck-exp-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, dayWindow: DEFAULT_DAY_WINDOW }),
  })
  const dataText = await dataRes.text()
  let data
  try { data = JSON.parse(dataText) } catch { data = { raw: dataText } }
  if (!dataRes.ok) {
    return { ok: false, reason: 'motherduck-exp-check failed', detail: data, project: project.code }
  }

  const body = buildDigestBody(data, project, dateObj)

  const frontRes = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const frontText = await frontRes.text()
  let frontJson
  try { frontJson = JSON.parse(frontText) } catch { frontJson = { raw: frontText } }
  if (!frontRes.ok) {
    return { ok: false, reason: 'Front API error posting comment', detail: frontJson, project: project.code }
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${project.facility}&dashboard_type=eq.exp_check_${project.key}`, { last_sent_date: date })
  }

  return {
    ok: true,
    date,
    project: project.code,
    conversationId,
    commentId: frontJson.id,
    julianMismatch: data?.julianSummary?.mismatch ?? 0,
    expMismatch: data?.summary?.mismatch ?? 0,
  }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  EXP_CHECK_PROJECTS, PROJECT_BY_DASHBOARD_TYPE, APP_URL, DEFAULT_NOTIFY_DAYS,
  sbFetch, sbPatch,
  centralTodayDateObj, isNotifyTimeMatch, isoWeekday, isoDate,
  runForProject,
}
