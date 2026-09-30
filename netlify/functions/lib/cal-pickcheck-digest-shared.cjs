'use strict'

// Shared core for the CAL (Caledonia) Pick Location Lot Check digest —
// PALDSD9 only. Built 2026-09-29 as a direct mirror of
// lib/wr-pickcheck-digest-shared.cjs (see that file's header for the run/
// test split rationale: Netlify blocks direct HTTP invocation of any function
// carrying a `schedule`, so cal-pickcheck-digest-run.cjs is cron-tick-only
// and the UI's "Send test digest now" calls cal-pickcheck-digest-test.cjs).
//
// Message format is deliberately the same shape as WR's: header + count-only
// call-out blocks, no per-material listing. Differences (all from the PVI
// FEFO call, Sam/Dean/Dan):
//   - No SECONDARY block (CAL has no computable secondary rack).
//   - Aging is the 45-day window, not 120d/60d: one block for lots at
//     <= 45d (which INCLUDES already-expired lots) and one for the expired
//     subset. Both count LOTS on hand (gross, incl. held lots), from the
//     backend's `lots` dataset — a held lot at 10 days is exactly what Sam
//     wants called out even though the material-level pick check ignores it.
//   - Dismissals come from cal_pick_check_dismissals (own table, own codes).
//     A dismissed MATERIAL is removed from the material counts AND from the
//     lot counts (it is a material-level "not on the pick line" call).
//     fetchActiveDismissedCodes is best-effort, same as WR.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL
// Same deep-link style WR's digest uses (facility route + ?tab=). Not
// verified that the router reads ?tab= — mirrored for consistency.
const APP_URL = 'https://csw-wi.netlify.app/facility/cal?tab=pickcheck'

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

// Set of material_codes currently dismissed (dismissed_until null or future).
// Best-effort — empty Set on any failure so a Supabase hiccup can't block the
// digest.
async function fetchActiveDismissedCodes() {
  try {
    const rows = await sbFetch('cal_pick_check_dismissals?select=material_code,dismissed_until')
    const now = Date.now()
    const set = new Set()
    for (const r of rows) {
      if (!r.dismissed_until || new Date(r.dismissed_until).getTime() > now) set.add(r.material_code)
    }
    return set
  } catch {
    return new Set()
  }
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

function summarize(materials, lots) {
  return {
    total: materials.length,
    primary: materials.filter(m => m.status === 'primary').length,
    warehouse: materials.filter(m => m.status === 'warehouse').length,
    lotsAging: lots.filter(l => l.aging).length,
    lotsExpired: lots.filter(l => l.aging === 'expired').length,
    lotsHeldAging: lots.filter(l => l.aging && l.held).length,
  }
}

function buildDigestBody(data, dateObj) {
  const s = data.summary
  const window = data.agingWindowDays ?? 45
  const lines = []
  lines.push(`Pick Location Lot Check — Palermo's Caledonia DSD (PALDSD9)`)
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push(`As of: ${formatHeaderDate(dateObj)}`)

  callOutBlock(lines, `${fmt(s.warehouse)} MATERIAL${s.warehouse === 1 ? '' : 'S'} NOT IN PICK LINE`)
  callOutBlock(lines, `${fmt(s.lotsAging)} LOT${s.lotsAging === 1 ? '' : 'S'} AT ≤${window}d SHELF LIFE`)
  callOutBlock(lines, `${fmt(s.lotsExpired)} LOT${s.lotsExpired === 1 ? '' : 'S'} ALREADY EXPIRED (STILL ON HAND)`)

  return lines.join('\n')
}

async function postDigest({ conversationId, dateObj, isManualTest }) {
  const date = centralTodayISO()

  const pickCheckRes = await fetch(`${SITE_URL}/.netlify/functions/motherduck-cal-pick-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const pickCheckText = await pickCheckRes.text()
  let pickCheckJson
  try { pickCheckJson = JSON.parse(pickCheckText) } catch { pickCheckJson = { raw: pickCheckText } }
  if (!pickCheckRes.ok) {
    return { ok: false, reason: 'motherduck-cal-pick-check failed', detail: pickCheckJson }
  }

  const dismissedCodes = await fetchActiveDismissedCodes()
  const materials = dismissedCodes.size > 0
    ? pickCheckJson.materials.filter(m => !dismissedCodes.has(m.materialCode))
    : pickCheckJson.materials
  const lots = dismissedCodes.size > 0
    ? pickCheckJson.lots.filter(l => !dismissedCodes.has(l.materialCode))
    : pickCheckJson.lots
  const filteredData = { ...pickCheckJson, materials, lots, summary: summarize(materials, lots) }

  const body = buildDigestBody(filteredData, dateObj)

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
    await sbPatch(`prepick_notify_settings?facility=eq.cal&dashboard_type=eq.pick_check`, { last_sent_date: date })
  }

  return { ok: true, date, conversationId, commentId: frontJson.id }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  sbFetch, sbPatch,
  centralTodayISO, centralTodayDateObj, isNotifyTimeMatch, formatHeaderDate,
  buildDigestBody, postDigest,
}
