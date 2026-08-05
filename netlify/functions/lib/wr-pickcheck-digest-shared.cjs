'use strict'

// Shared core for the WR Pick Location Lot Check digest — split out
// 2026-07-31 from wr-pickcheck-digest-run.cjs. Same fix as
// lib/prepick-digest-shared.cjs / lib/fefo-digest-shared.cjs: Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` in
// netlify.toml, which made "Send test digest now" 403 here too. The
// scheduled function (wr-pickcheck-digest-run.cjs) keeps the schedule and
// only handles the cron tick; the manual test button now calls the
// sibling wr-pickcheck-digest-test.cjs, which has no schedule.
//
// Message format (header+count only per section, plus <60d aging
// call-out) is unchanged from the 2026-07-31 (earlier same day)
// simplification pass — see that changelog entry / this file's
// buildDigestBody for details. Everything else is unchanged from the
// original wr-pickcheck-digest-run.cjs — see that file's original header
// (preserved in git history) for the fuller feature history.
//
// Dismissal filtering (added 2026-08-05): materials that aren't actually
// stocked in a P-slot at all (e.g. Tavern-Style Crust Pub, picked from
// bulk C/D/E/F racking, never the pickline) can be dismissed from the
// live tab. Same root cause and fix as EXP Check's dismissal filter —
// motherduck-wr-pick-check.cjs is a pure MotherDuck query with zero
// knowledge of Supabase dismissals, so without this fix a dismissed
// material would disappear from the on-screen "Warehouse" list but keep
// inflating the nightly Front digest's count. fetchActiveDismissedCodes()
// is best-effort: if Supabase hiccups, the digest falls back to an
// unfiltered count rather than blocking the whole send.

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

// Returns a Set of material_codes currently dismissed (dismissed_until
// null, or still in the future). Best-effort — an empty Set on any
// failure, so a Supabase hiccup can't block the digest entirely.
async function fetchActiveDismissedCodes() {
  try {
    const rows = await sbFetch('wr_pick_check_dismissals?select=material_code,dismissed_until')
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

// Recomputes summary counts from materials[], excluding anything in
// dismissedCodes — mirrors exp-check-digest-shared.cjs's summarize().
function summarize(materials) {
  const s = { total: 0, primary: 0, secondary: 0, warehouse: 0, agingCritical: 0, agingWarning: 0, agingWatch: 0 }
  for (const m of materials) {
    s.total++
    if (m.status === 'primary') s.primary++
    if (m.status === 'secondary') s.secondary++
    if (m.status === 'warehouse') s.warehouse++
    if (m.aging === 'critical') s.agingCritical++
    if (m.aging === 'warning') s.agingWarning++
    if (m.aging === 'watch') s.agingWatch++
  }
  return s
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

async function postDigest({ conversationId, dateObj, isManualTest }) {
  const date = centralTodayISO()

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

  const dismissedCodes = await fetchActiveDismissedCodes()
  const filteredMaterials = dismissedCodes.size > 0
    ? pickCheckJson.materials.filter(m => !dismissedCodes.has(m.materialCode))
    : pickCheckJson.materials
  const filteredData = { ...pickCheckJson, materials: filteredMaterials, summary: summarize(filteredMaterials) }

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
    await sbPatch(`prepick_notify_settings?facility=eq.wr&dashboard_type=eq.pick_check`, { last_sent_date: date })
  }

  return { ok: true, date, conversationId, commentId: frontJson.id }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  sbFetch, sbPatch,
  centralTodayISO, centralTodayDateObj, isNotifyTimeMatch, formatHeaderDate,
  buildDigestBody, postDigest,
}
