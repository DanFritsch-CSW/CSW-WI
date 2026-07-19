'use strict'

// LoadProof / DVRS open-incidents daily digest.
// Same every-15-min tick + configurable notify_hour/notify_minute/notify_days
// pattern as the other digests (facility='all', dashboard_type='dvr_incidents'
// in prepick_notify_settings). Content date is TODAY — this is a live snapshot
// of currently-open DVRS incidents, not a day-ahead forecast.
// Fetches open incidents from SharePoint (via sharepoint-dvr.cjs) for all 3
// facilities and posts a summary Front comment. See NotifySettingsPanel in
// DvrTracker.jsx for the UI.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const APP_URL = 'https://csw-wi.netlify.app'

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  return r.json()
}
async function sbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  })
  if (!r.ok) console.error(`[dvr-digest] sbPatch failed ${r.status}: ${await r.text()}`)
  return r
}

function centralNowParts() {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
  return Object.fromEntries(f.formatToParts(new Date()).map(p => [p.type, p.value]))
}
function centralTodayISO() {
  const p = centralNowParts()
  return `${p.year}-${p.month}-${p.day}`
}
function isoWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.getDay() === 0 ? 7 : d.getDay()
}
function fmtDateLabel(iso) {
  try { return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }) } catch { return iso }
}

async function fetchFacilityIncidents(facilityId, baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/.netlify/functions/sharepoint-dvr?facility=${facilityId}`)
    const d = await r.json()
    return { data: d.incidents || [], error: d.error || null }
  } catch(e) {
    return { data: [], error: e.message }
  }
}

async function postFrontComment(conversationId, body) {
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  const r = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body })
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Front API ${r.status}: ${t.slice(0, 200)}`)
  }
  return true
}

async function runDigest(isManual, baseUrl) {
  const rows = await sbGet(`prepick_notify_settings?facility=eq.all&dashboard_type=eq.dvr_incidents&select=*`)
  const settings = rows[0]
  if (!settings) return { ok: false, reason: 'No settings row — facility=all, dashboard_type=dvr_incidents not found' }
  if (!settings.front_conversation_id) return { ok: false, reason: 'No Front conversation ID configured' }

  const todayISO = centralTodayISO()

  if (!isManual) {
    if (!settings.active) return { ok: false, reason: 'Digest not enabled' }
    const p = centralNowParts()
    const currentHour = parseInt(p.hour)
    const currentMinute = Math.floor(parseInt(p.minute) / 15) * 15
    if (currentHour !== settings.notify_hour) return { ok: false, reason: `Hour mismatch (${currentHour} vs ${settings.notify_hour})` }
    if (currentMinute !== settings.notify_minute) return { ok: false, reason: `Minute mismatch (${currentMinute} vs ${settings.notify_minute})` }

    const notifyDays = settings.notify_days || [1,2,3,4,5]
    const todayWeekday = isoWeekday(todayISO)
    if (!notifyDays.includes(todayWeekday)) {
      if (!settings.skip_to_next_valid_day) return { ok: false, reason: `Day ${todayWeekday} not in notify_days` }
      let found = null
      for (let offset = 1; offset <= 7; offset++) {
        const candidate = new Date(todayISO + 'T12:00:00')
        candidate.setDate(candidate.getDate() + offset)
        const iso = candidate.toISOString().slice(0, 10)
        if (notifyDays.includes(isoWeekday(iso))) { found = iso; break }
      }
      if (!found) return { ok: false, reason: 'No valid day found in next 7 days' }
    }

    if (settings.last_sent_date === todayISO) return { ok: false, reason: `Already sent for ${todayISO}` }

    // Lock last_sent_date BEFORE slow SharePoint reads — prevents re-sends if
    // the function times out mid-fetch (KEN has 2400+ rows, reads can take 20s+).
    // Even if the function is killed after this point, the gate is already set.
    await sbPatch(`prepick_notify_settings?facility=eq.all&dashboard_type=eq.dvr_incidents`, { last_sent_date: todayISO })
  }

  const [calRes, kenRes, madRes] = await Promise.all([
    fetchFacilityIncidents('cal', baseUrl),
    fetchFacilityIncidents('ken', baseUrl),
    fetchFacilityIncidents('mad', baseUrl),
  ])

  const cal = calRes.data, ken = kenRes.data, mad = madRes.data
  const all = [...cal, ...ken, ...mad]

  const adjNeeded = all.filter(i => i.adjOpen).length
  const coachPending = all.filter(i => i.coachingOpen).length
  const invPending = all.filter(i => i.invOpen).length

  const facLine = (name, data, err) => {
    if (err) return `${name}: ⚠ Error reading SharePoint`
    if (!data.length) return `${name}: 0 open`
    const adj = data.filter(i => i.adjOpen).length
    const coach = data.filter(i => i.coachingOpen).length
    const inv = data.filter(i => i.invOpen).length
    const parts = []
    if (adj) parts.push(`${adj} adj`)
    if (coach) parts.push(`${coach} coaching`)
    if (inv) parts.push(`${inv} inv`)
    return `${name}: ${data.length} open${parts.length ? ` (${parts.join(', ')})` : ''}`
  }

  const lines = [
    `LoadProof / DVRS — Open Incidents`,
    fmtDateLabel(todayISO),
    ``,
    `-------------------------------`,
    `**Total open: ${all.length}**`,
    `-------------------------------`,
    `• Adj. needed: ${adjNeeded}`,
    `• Coaching pending: ${coachPending}`,
    `• Investigation pending: ${invPending}`,
    ``,
    facLine('Caledonia', cal, calRes.error),
    facLine('Kenosha', ken, kenRes.error),
    facLine('Madison', mad, madRes.error),
    ``,
    `${APP_URL}/customers?tab=dvr`,
  ]

  await postFrontComment(settings.front_conversation_id, lines.join('\n'))
  console.log(`[dvr-digest] Posted to ${settings.front_conversation_id}, all=${all.length}`)

  return { ok: true, totalOpen: all.length, message: `Digest sent — ${all.length} open incidents` }
}

exports.handler = async function(event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || APP_URL
  try {
    const isManual = event.httpMethod === 'POST'
    const result = await runDigest(isManual, baseUrl)
    console.log('[dvr-digest]', result)
    return { statusCode: 200, headers: cors, body: JSON.stringify(result) }
  } catch(err) {
    console.error('[dvr-digest] error:', err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: err.message }) }
  }
}
