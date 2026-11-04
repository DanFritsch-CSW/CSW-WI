'use strict'

// Shared core for JDF Daily Comms daily kickoff email (Madison only) --
// added 2026-11-04 per Dan's ask (cnv_1cspos44): JDF never starts a new
// email thread for outbound orders, so one "Outbounds {date}"-subject
// conversation grows all day, every day. This is a direct mirror of
// lib/cmm-empty-trailer-email-shared.cjs, MINUS the hourly keep-on-top ping
// (per Dan -- the JDF thread stays active via ordinary customer replies all
// day, unlike the CMM trailer thread, so there's no sibling
// jdf-daily-comms-ping-shared.cjs and last_conversation_id below is kept for
// reference/debugging only, never read back by anything else).
//
// Sends a REAL email immediately via Front's /channels/{id}/messages
// endpoint (same call shape as cmm-empty-trailer-email-shared.cjs /
// front-send-email.cjs) -- there is no draft/review step. Content-free: no
// MotherDuck query, no attempt to pull "today's order" data in -- Chris/
// Anne still reply into the resulting thread with the real outbound details,
// exactly as happens today. The only thing this buys is a fresh
// conversation each morning instead of one that runs forever.
//
// Settings UI (Settings > JDF Daily Comms) mirrors CMM Empty Trailer's
// layout (TO/CC recipients, From-channel picker via the shared
// front_channels table, send time/days, active toggle, Send Now test
// button, internal discussion PEOPLE picker) MINUS the hourly ping section.
// Three columns on prepick_notify_settings carry sender_name,
// email_subject_template, email_body_template, scoped to
// dashboard_type='jdf_daily_comms'. Recipients live in their own
// jdf_daily_comms_email_recipients table (same shape as
// cmm_empty_trailer_email_recipients), seeded 2026-11-04 from the live
// "Outbounds 11.03.26" thread's own TO/CC (cnv_1cspos44) -- review before
// activating.
//
// Subject convention matches JDF's own existing pattern ("Outbounds
// 11.03.26", not a full weekday/full-year string) -- see formatJdfDate
// below, MM.DD.YY with dots, distinct from CMM Empty Trailer's
// formatHeaderDate. Content date is TODAY (Central), not tomorrow -- this is
// a morning kickoff for the day that's starting.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const DEFAULT_FRONT_CHANNEL_ID = 'cha_duvx0' // madison@csw-wi.com

const FACILITY = 'mad'
const DASHBOARD_TYPE = 'jdf_daily_comms'

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

function centralTodayDateObj() {
  const { year, month, day } = centralNowParts()
  return new Date(Date.UTC(year, month - 1, day))
}

function isoDate(dateObj) { return dateObj.toISOString().slice(0, 10) }

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

// Matches JDF's own subject convention, e.g. "Outbounds 11.03.26" --
// MM.DD.YY with dots, no weekday. Distinct from CMM Empty Trailer's
// formatHeaderDate (full weekday + M/D/YYYY).
function formatJdfDate(dateObj) {
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dateObj.getUTCDate()).padStart(2, '0')
  const yy = String(dateObj.getUTCFullYear()).slice(-2)
  return `${mm}.${dd}.${yy}`
}

function fillTemplate(str, vars) {
  return String(str ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''))
}

async function frontSendMessage({ channelId, to, cc, senderName, subject, body }) {
  const payload = { to, sender_name: senderName || 'CSW Operations', subject, body, options: { archive: false } }
  if (cc && cc.length) payload.cc = cc
  const res = await fetch(`https://api2.frontapp.com/channels/${channelId || DEFAULT_FRONT_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw Object.assign(new Error('Front send-message failed'), { detail: json })
  return json
}

function conversationIdFromMessageResponse(msg) {
  const url = msg?._links?.related?.conversation
  if (!url) return null
  const m = String(url).match(/(cnv_[A-Za-z0-9]+)\s*$/)
  return m ? m[1] : null
}

// Same call as cmm-empty-trailer-email-shared.cjs's frontAddFollowers --
// adds internal teammates as conversation followers without putting them in
// TO/CC (so they see the thread, not a copy of the email itself).
async function frontAddFollowers(conversationId, teammateIds) {
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/followers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ teammate_ids: teammateIds }),
  })
  if (!res.ok) { const t = await res.text(); throw Object.assign(new Error('Front add-followers failed'), { detail: t }) }
}

async function runDigest({ isManualTest }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}&select=notify_hour,notify_minute,notify_days,active,last_sent_date,sender_name,email_subject_template,email_body_template,from_channel_id`
  )
  const settings = settingsRows?.[0]
  if (!settings) return { ok: false, reason: `No prepick_notify_settings row for ${FACILITY}/${DASHBOARD_TYPE}` }

  const dateObj = centralTodayDateObj()
  const date = isoDate(dateObj)

  if (!isManualTest) {
    if (settings.active === false) return { ok: true, skipped: true, reason: 'Disabled' }
    const notifyHour = settings.notify_hour ?? 5
    const notifyMinute = settings.notify_minute ?? 0
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
    }
    if (settings.last_sent_date === date) {
      return { ok: true, skipped: true, reason: 'Already sent for this date' }
    }
    const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5, 6, 7]
    const isoWeekday = dateObj.getUTCDay() === 0 ? 7 : dateObj.getUTCDay()
    if (!notifyDays.includes(isoWeekday)) {
      return { ok: true, skipped: true, reason: `${date} is not a configured notify day` }
    }
  }

  const [emailRows, discussionRows] = await Promise.all([
    sbFetch(`jdf_daily_comms_email_recipients?facility=eq.${FACILITY}&active=eq.true&select=email,role`),
    sbFetch(`notification_recipients?list_name=eq.jdf_daily_comms_${FACILITY}&active=eq.true&select=front_teammate_id`),
  ])
  const to = (emailRows || []).filter(r => r.role === 'to').map(r => r.email)
  const cc = (emailRows || []).filter(r => r.role === 'cc').map(r => r.email)
  const discussionTeammateIds = (discussionRows || []).map(r => r.front_teammate_id).filter(Boolean)

  if (to.length === 0) {
    return { ok: false, reason: 'No active TO recipients configured in Settings > JDF Daily Comms' }
  }

  const jdfDate = formatJdfDate(dateObj)
  const subject = fillTemplate(settings.email_subject_template || 'Outbounds {date}', { date: jdfDate })
  const html = fillTemplate(
    settings.email_body_template || "<p>Starting today's outbound thread — please reply here with today's order(s).</p>",
    { date: jdfDate }
  )

  const sent = await frontSendMessage({
    channelId: settings.from_channel_id, to, cc,
    senderName: settings.sender_name, subject, body: html,
  })
  const conversationId = conversationIdFromMessageResponse(sent)

  if (conversationId && discussionTeammateIds.length) {
    await frontAddFollowers(conversationId, discussionTeammateIds)
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}`, {
      last_sent_date: date, last_conversation_id: conversationId,
    })
  }

  return {
    ok: true, date, subject, conversationId, messageId: sent?.id,
    toCount: to.length, ccCount: cc.length, followerCount: discussionTeammateIds.length,
    channelId: settings.from_channel_id || DEFAULT_FRONT_CHANNEL_ID,
  }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN,
  FACILITY, DASHBOARD_TYPE,
  sbFetch, sbPatch,
  runDigest,
}
