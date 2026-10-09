'use strict'

// Shared core for CMM Empty Trailer daily kickoff email (Caledonia only) --
// added 2026-10-09 per Dean/Hill's Front ask (cnv_1clwbnkk) to automate the
// long-running manual "CSW/CMM/PALERMOS Trailers" thread (see msg_2r5ewsr8
// for the exact recipient list / content style this formalizes).
//
// UNLIKE cmm-outbound-draft-shared.cjs, this sends a REAL email immediately
// via Front's /channels/{id}/messages endpoint (same call shape as
// front-send-email.cjs) -- there is no draft/review step. This was an
// explicit choice (Dan, 2026-10-09): "Auto create and Send an EMAIL not
// discussion thread." There is also no MotherDuck query here -- confirmed
// live against production_db.gold.truck_appointments that "empty trailer"
// has no structured field (no such dock_appointment_type_name value); it
// only ever shows up as free text in the Notes column. So this email is a
// content-free daily kickoff -- the 1st shift supervisor still replies
// into it with the real door/trailer status, exactly as happens today.
//
// Settings UI (Settings > CMM Empty Trailer) mirrors CMM Outbound Appts'
// layout (TO/CC recipients, From-channel picker via the shared
// front_channels table, send time/days, active toggle, Create Now test
// button) MINUS the draft-only fields -- no author_teammate_id (Front's
// /messages endpoint takes sender_name, a plain display string, not an
// author to create a draft under) and no discussion_comment (there's no
// draft to attach internal-only commentary to). It DOES keep the internal
// discussion PEOPLE picker (added 2026-10-09, same evening as the initial
// build, per Dan) -- people added as conversation followers on the sent
// thread without being a TO/CC recipient of the email itself, same
// notification_recipients + frontAddFollowers mechanism as CMM Outbound
// Appts, just applied to the conversation the live send created instead of
// a draft. list_name is `cmm_empty_trailer_<facility>`.
// Three columns were added to prepick_notify_settings instead: sender_name,
// email_subject_template, email_body_template -- all three scoped to
// dashboard_type='cmm_empty_trailer', nullable/unused by other dashboard
// types. Recipients live in their own cmm_empty_trailer_email_recipients
// table (same shape as cmm_outbound_email_recipients) rather than sharing
// that table, so the two CMM-related recipient lists can diverge freely.
//
// Content date is TODAY (Central), not tomorrow -- this is a morning
// kickoff for the day that's starting, not a lookahead.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const DEFAULT_FRONT_CHANNEL_ID = 'cha_erzf8'

const FACILITY = 'cal'
const DASHBOARD_TYPE = 'cmm_empty_trailer'

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

function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
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

// Same call as cmm-outbound-draft-shared.cjs's frontAddFollowers -- adds
// internal teammates as conversation followers without putting them in
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
    sbFetch(`cmm_empty_trailer_email_recipients?facility=eq.${FACILITY}&active=eq.true&select=email,role`),
    sbFetch(`notification_recipients?list_name=eq.cmm_empty_trailer_${FACILITY}&active=eq.true&select=front_teammate_id`),
  ])
  const to = (emailRows || []).filter(r => r.role === 'to').map(r => r.email)
  const cc = (emailRows || []).filter(r => r.role === 'cc').map(r => r.email)
  const discussionTeammateIds = (discussionRows || []).map(r => r.front_teammate_id).filter(Boolean)

  if (to.length === 0) {
    return { ok: false, reason: 'No active TO recipients configured in Settings > CMM Empty Trailer' }
  }

  const headerDate = formatHeaderDate(dateObj)
  const subject = fillTemplate(settings.email_subject_template || 'CSW/CMM/PALERMOS Trailers — {date}', { date: headerDate })
  const html = fillTemplate(
    settings.email_body_template || '<p>Starting today\u2019s trailer thread \u2014 please reply with current door / trailer status.</p>',
    { date: headerDate }
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
    await sbPatch(`prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}`, { last_sent_date: date })
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
