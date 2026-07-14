'use strict'

// Nightly WR "Cases To Pick" digest — posts a summary comment to a Front
// conversation. Added 2026-07-14, mirrors prepick-digest-run.cjs's design
// exactly per Dan's request ("just as we did in the Madison Pre-Pick
// Status"), including the same configurable-send-time mechanism — see
// that file's header comment for the full rationale (Netlify cron can't
// read a per-row DB setting, so the schedule check lives inside the
// function and the cron just ticks every 15 minutes).
//
// Two invocation paths:
//
// 1. SCHEDULED (netlify.toml: schedule = "*/15 * * * *"). Only actually
//    sends when the current America/Chicago local time matches
//    prepick_notify_settings.notify_hour/notify_minute for
//    facility='wr'/dashboard_type='cases_to_pick' AND it hasn't already
//    sent today (last_sent_date guard). Otherwise a fast no-op.
//
// 2. MANUAL TEST (plain POST, no body needed — always targets tomorrow).
//    Called from the "Send test digest now" button on the Cases To Pick
//    tab's Notify Settings panel. Bypasses the time/active/last_sent_date
//    checks entirely and never writes last_sent_date, same as
//    prepick-digest-run.cjs's manual path.
//
// Where it posts: prepick_notify_settings.front_conversation_id for
// facility='wr'/dashboard_type='cases_to_pick', editable from the Cases
// To Pick tab. Posts as a COMMENT on that existing conversation (POST
// /conversations/{id}/comments), same convention as prepick-digest-run.cjs
// — not a new discussion.
//
// Data source: proxies to motherduck-wr-cases.cjs via internal HTTP call
// (same pattern as prepick-digest-run.cjs proxying motherduck-prepick-
// status.cjs) rather than duplicating its MotherDuck query logic here.
// Always summarizes TOMORROW's numbers (fires the evening before), even
// though the live Cases To Pick tab itself is pinned to whatever date is
// selected in the app per Dan's 2026-07-14 answer — the digest's whole
// purpose is a heads-up for the next day, so it stays "tomorrow" the same
// way the original Omni email dashboard did.
//
// ── Weekday filter — added 2026-07-14 (later) ────────────────────────────
// No weekend sends, mirrors prepick-digest-run.cjs's identical addition.
// `notify_days` (ISO weekday numbers 1=Mon..7=Sun, default Mon-Fri) is
// checked against tomorrow's weekday (the content date), not the weekday
// the digest fires on — a Sunday-night tick summarizes Monday (a workday,
// sends) while a Friday-night tick summarizes Saturday (skips). Manual
// test bypasses this filter.
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

// ISO weekday: 1=Mon .. 7=Sun (JS getUTCDay() is 0=Sun..6=Sat). Checked
// against the CONTENT date (tomorrow) — see file header "Weekday filter".
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

// ── Message format — revised 2026-07-14 (later same day) per Dan ────────
// Restructured to match his exact draft, plus one fix and one enhancement:
//   - Fix: the original "  # of Full Pallets: 31" line rendered in Front
//     as "of Full Pallets: 31" — the "#" silently disappeared. Front
//     comments run through a Markdown parser (confirmed via Front's own
//     help docs: **bold**, *italic*, ~~strikethrough~~, `code` are all
//     supported), and CommonMark treats a "#" preceded by up to 3 spaces
//     as an ATX heading marker — it gets stripped even though it wasn't
//     meant as a heading. Fix: no line starts with "#" anymore.
//   - Enhancement: Dan wants Total Pickline Volume to visually stand out
//     as the headline number. Front's comment API only reliably supports
//     the four Markdown styles above — no font-size or highlight-color
//     control. **Bold** plus isolating the line on its own paragraph
//     between plain unicode divider rules is the strongest emphasis
//     available without relying on untested/undocumented rendering.
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

async function runDigest({ isManualTest }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.wr&dashboard_type=eq.cases_to_pick&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settings = settingsRows?.[0]
  const conversationId = settings?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for WR Cases To Pick in prepick_notify_settings' }
  }

  const dateObj = tomorrowCentral()
  const date = isoDate(dateObj)

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
    await sbPatch(`prepick_notify_settings?facility=eq.wr&dashboard_type=eq.cases_to_pick`, { last_sent_date: centralTodayISO() })
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
