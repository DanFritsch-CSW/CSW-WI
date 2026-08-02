'use strict'

// Shared core for the EXP Check nightly digest — added 2026-08-02, ONE
// SETTINGS ROW PER CUSTOMER (Pretzilla / Bernatello's), not per Datex
// project. First built per-project (mirroring FEFO's pattern exactly),
// then Dan corrected: he wants this at the owner/customer level instead
// — one Front conversation per customer, aggregating all of that
// customer's projects into a single digest, same granularity as the tab
// itself defaults to. facility='all' on the settings row (same convention
// already used by dvr-digest-run.cjs for its own cross-facility digest),
// since a customer here genuinely spans multiple facilities (Pretzilla:
// ken/cal/mad; Bernatello's: mad/wr) and doesn't map to one.
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
// Message format confirmed with Dan (his own drafted example, matched as
// closely as the owner-level scope allows — his example named a specific
// project, "Bernatello's - Wisconsin Rapids", from back when this was
// still per-project; now the header names the customer instead): header
// line, bare URL (Front auto-linkifies, doesn't render Markdown links —
// same lesson learned building the FEFO and Daily Ops digests), "CSW
// Operations Hub" label line, "As of: {date}", then one divider-bracketed
// count block per category, aggregated across every project owned by
// that customer. Julian Mismatch leads (the check that actually catches
// a misread Julian code — see motherduck-exp-check.cjs's header), then
// EXP Mismatch, No Shelf Life, and Relabeled (only shown when > 0 —
// Bernatello's doesn't use that convention at all). Every shown category
// always displays its count even at 0, so "all clear" is exactly as
// visible as a real problem — same convention as every other digest on
// this project.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

// One entry per customer — mirrors CUSTOMERS in motherduck-exp-check.cjs
// (label only needed here; project_ids/julian format live server-side in
// that function and are resolved automatically from the `customer` key).
const EXP_CHECK_CUSTOMERS = [
  { key: 'pretzilla', label: 'Pretzilla' },
  { key: 'bernatellos', label: "Bernatello's" },
]
const CUSTOMER_BY_DASHBOARD_TYPE = new Map(EXP_CHECK_CUSTOMERS.map((c) => [`exp_check_${c.key}`, c]))
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

function buildDigestBody(data, customer, dateObj) {
  const lines = []
  lines.push(`EXP Check — ${data?.customerLabel || customer.label}`)
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

async function runForCustomer({ settingsRow, customer, dateObj, isManualTest }) {
  const conversationId = settingsRow?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for ${customer.label}`, customer: customer.label }
  }

  const date = isoDate(dateObj)

  const dataRes = await fetch(`${SITE_URL}/.netlify/functions/motherduck-exp-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer: customer.key, dayWindow: DEFAULT_DAY_WINDOW }),
  })
  const dataText = await dataRes.text()
  let data
  try { data = JSON.parse(dataText) } catch { data = { raw: dataText } }
  if (!dataRes.ok) {
    return { ok: false, reason: 'motherduck-exp-check failed', detail: data, customer: customer.label }
  }

  const body = buildDigestBody(data, customer, dateObj)

  const frontRes = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const frontText = await frontRes.text()
  let frontJson
  try { frontJson = JSON.parse(frontText) } catch { frontJson = { raw: frontText } }
  if (!frontRes.ok) {
    return { ok: false, reason: 'Front API error posting comment', detail: frontJson, customer: customer.label }
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.all&dashboard_type=eq.exp_check_${customer.key}`, { last_sent_date: date })
  }

  return {
    ok: true,
    date,
    customer: customer.label,
    conversationId,
    commentId: frontJson.id,
    julianMismatch: data?.julianSummary?.mismatch ?? 0,
    expMismatch: data?.summary?.mismatch ?? 0,
  }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  EXP_CHECK_CUSTOMERS, CUSTOMER_BY_DASHBOARD_TYPE, APP_URL, DEFAULT_NOTIFY_DAYS,
  sbFetch, sbPatch,
  centralTodayDateObj, isNotifyTimeMatch, isoWeekday, isoDate,
  runForCustomer,
}
