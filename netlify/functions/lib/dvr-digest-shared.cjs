'use strict'

// Shared core for the LoadProof/DVRS open-incidents daily digest — split
// out 2026-07-31 from dvr-digest-run.cjs. Same fix as
// lib/prepick-digest-shared.cjs / lib/fefo-digest-shared.cjs: Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` in
// netlify.toml, which made "Send test digest now" 403 here too. The
// scheduled function (dvr-digest-run.cjs) keeps the schedule and only
// handles the cron tick; the manual test button now calls the sibling
// dvr-digest-test.cjs, which has no schedule.
//
// Everything below is otherwise unchanged from the original
// dvr-digest-run.cjs — see that file's original header (preserved in git
// history) for the fuller feature history (the earlier x-netlify-event
// scheduled-detection fix, the daily lock via last_sent_date, the
// skip-to-next-valid-day lookahead, etc).

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN  = process.env.FRONT_API_TOKEN
const APP_URL      = 'https://csw-wi.netlify.app'
const ROW_FILTER   = 'facility=eq.all&dashboard_type=eq.dvr_incidents'

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  return r.json()
}

async function acquireDailyLock(todayISO) {
  const filter = `${ROW_FILTER}&or=(last_sent_date.is.null,last_sent_date.lt.${todayISO})`
  const r = await fetch(`${SUPABASE_URL}/rest/v1/prepick_notify_settings?${filter}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ last_sent_date: todayISO }),
  })
  const rows = await r.json()
  const acquired = Array.isArray(rows) && rows.length > 0
  console.log(`[dvr-digest] lock ${acquired ? 'acquired' : 'already sent today'} for ${todayISO}`)
  return acquired
}

function centralNowParts() {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
  return Object.fromEntries(f.formatToParts(new Date()).map(p => [p.type, p.value]))
}
function centralTodayISO() { const p = centralNowParts(); return `${p.year}-${p.month}-${p.day}` }
function isoWeekday(dateStr) { const d = new Date(dateStr + 'T12:00:00'); return d.getDay() === 0 ? 7 : d.getDay() }
function fmtDateLabel(iso) {
  try { return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }) }
  catch { return iso }
}
async function fetchFacilityIncidents(facilityId, baseUrl) {
  try { const r = await fetch(`${baseUrl}/.netlify/functions/sharepoint-dvr?facility=${facilityId}`); const d = await r.json(); return { data: d.incidents || [], error: d.error || null } }
  catch(e) { return { data: [], error: e.message } }
}
async function postFrontComment(conversationId, body) {
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  const r = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, { method: 'POST', headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ body }) })
  if (!r.ok) { const t = await r.text(); throw new Error(`Front API ${r.status}: ${t.slice(0,200)}`) }
}

// runDigest — shared entry point for both invocation paths. isManualTest
// bypasses active/time/weekday/daily-lock gating and always sends
// immediately for today.
async function runDigest(isManualTest, baseUrl) {
  const rows = await sbGet(`prepick_notify_settings?${ROW_FILTER}&select=*`)
  const s = rows[0]
  if (!s) return { ok: false, reason: 'No settings row found' }
  if (!s.front_conversation_id) return { ok: false, reason: 'No Front conversation ID configured' }
  const todayISO = centralTodayISO()
  if (!isManualTest) {
    if (!s.active) return { ok: false, reason: 'Digest not enabled' }
    const p = centralNowParts()
    const currentHour = parseInt(p.hour, 10)
    const currentMinute = Math.floor(parseInt(p.minute, 10) / 15) * 15
    if (currentHour !== s.notify_hour) return { ok: false, reason: `Hour mismatch (${currentHour} vs ${s.notify_hour})` }
    if (currentMinute !== s.notify_minute) return { ok: false, reason: `Minute mismatch (${currentMinute} vs ${s.notify_minute})` }
    const notifyDays = s.notify_days || [1,2,3,4,5]
    const todayWeekday = isoWeekday(todayISO)
    if (!notifyDays.includes(todayWeekday)) {
      if (!s.skip_to_next_valid_day) return { ok: false, reason: `Day ${todayWeekday} not in notify_days` }
      let found = null
      for (let offset = 1; offset <= 7; offset++) {
        const c = new Date(todayISO + 'T12:00:00'); c.setDate(c.getDate() + offset); const iso = c.toISOString().slice(0,10)
        if (notifyDays.includes(isoWeekday(iso))) { found = iso; break }
      }
      if (!found) return { ok: false, reason: 'No valid send day in next 7 days' }
    }
    const locked = await acquireDailyLock(todayISO)
    if (!locked) return { ok: false, reason: `Already sent for ${todayISO}` }
  }
  const [calRes, kenRes, madRes] = await Promise.all([fetchFacilityIncidents('cal', baseUrl), fetchFacilityIncidents('ken', baseUrl), fetchFacilityIncidents('mad', baseUrl)])
  const cal = calRes.data, ken = kenRes.data, mad = madRes.data, all = [...cal, ...ken, ...mad]
  const adjNeeded = all.filter(i=>i.adjOpen).length, coachPending = all.filter(i=>i.coachingOpen).length, invPending = all.filter(i=>i.invOpen).length
  const facLine = (name, data, err) => {
    if (err) return `${name}: Error reading SharePoint`
    if (!data.length) return `${name}: 0 open`
    const parts = []
    if (data.filter(i=>i.adjOpen).length) parts.push(`${data.filter(i=>i.adjOpen).length} adj`)
    if (data.filter(i=>i.coachingOpen).length) parts.push(`${data.filter(i=>i.coachingOpen).length} coaching`)
    if (data.filter(i=>i.invOpen).length) parts.push(`${data.filter(i=>i.invOpen).length} inv`)
    return `${name}: ${data.length} open${parts.length ? ` (${parts.join(', ')})` : ''}`
  }
  const body = ['LoadProof / DVRS - Open Incidents', fmtDateLabel(todayISO), '', '-------------------------------', `**Total open: ${all.length}**`, '-------------------------------', `- Adj. needed: ${adjNeeded}`, `- Coaching pending: ${coachPending}`, `- Investigation pending: ${invPending}`, '', facLine('Caledonia', cal, calRes.error), facLine('Kenosha', ken, kenRes.error), facLine('Madison', mad, madRes.error), '', `${APP_URL}/customers?tab=dvr`].join('\n')
  await postFrontComment(s.front_conversation_id, body)
  console.log(`[dvr-digest] posted total=${all.length}`)
  return { ok: true, totalOpen: all.length, message: `Digest sent - ${all.length} open incidents` }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, APP_URL, ROW_FILTER,
  sbGet,
  runDigest,
}
