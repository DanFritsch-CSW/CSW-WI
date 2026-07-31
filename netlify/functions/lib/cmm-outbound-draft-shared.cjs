'use strict'

// Shared core for CMM Outbound Appts draft creation — split out
// 2026-07-31 from cmm-outbound-draft-create.cjs. Same fix as
// lib/prepick-digest-shared.cjs / lib/fefo-digest-shared.cjs: Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` in
// netlify.toml, which made "Create Draft Now (test)" 403 here too. The
// scheduled function (cmm-outbound-draft-create.cjs) keeps the schedule
// and only handles the cron tick; the manual test button now calls the
// sibling cmm-outbound-draft-create-test.cjs, which has no schedule.
//
// Everything below is otherwise unchanged from the original
// cmm-outbound-draft-create.cjs — see that file's original header
// (preserved in git history) for the fuller feature history (TO/CC email
// recipients vs internal-discussion followers, the CMM/Palermo's
// MotherDuck filter, the From-channel picker, etc).

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN
const DEFAULT_FRONT_CHANNEL_ID = 'cha_erzf8'

const WAREHOUSE_ID = { cal: 1, ec: 3, mad: 4, ken: 5, wr: 6 }
const FACILITY_DISPLAY = { cal: 'Caledonia', ec: 'Eau Claire', mad: 'Madison', ken: 'Kenosha', wr: 'Wisconsin Rapids' }

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

function centralTomorrowDateObj() {
  const { year, month, day } = centralNowParts()
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() + 1)
  return d
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

function formatTime(ts) {
  const m = String(ts).match(/(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return String(ts)
  let h = Number(m[1])
  const min = m[2]
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12; if (h === 0) h = 12
  return `${h}:${min} ${ampm}`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function buildDraftHtml(rows, dateObj, facilityDisplay) {
  const count = rows.length
  const rowsHtml = rows.map(r => `
    <tr>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;">${escapeHtml(formatTime(r.scheduled_arrival))}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;">${escapeHtml(r.reference_number || '—')}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;">${escapeHtml(r.dock_appointment_type_name)}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;">${escapeHtml(r.project_name)}</td>
    </tr>`).join('')

  return `
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;">
      <h3 style="margin:0 0 4px;">CMM Outbound Appts — ${escapeHtml(facilityDisplay)}</h3>
      <p style="margin:0 0 12px;color:#555;">${escapeHtml(formatHeaderDate(dateObj))}</p>
      <p style="margin:0 0 12px;"><strong>Total Open Outbound Appts: ${count}</strong></p>
      <table style="border-collapse:collapse;width:100%;max-width:560px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:4px 10px;border-bottom:2px solid #333;">Time</th>
            <th style="text-align:left;padding:4px 10px;border-bottom:2px solid #333;">Ref #</th>
            <th style="text-align:left;padding:4px 10px;border-bottom:2px solid #333;">Type</th>
            <th style="text-align:left;padding:4px 10px;border-bottom:2px solid #333;">Project</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="4" style="padding:8px 10px;">No open outbound appointments.</td></tr>'}</tbody>
      </table>
    </div>`
}

async function queryAppointments(warehouseId, date) {
  process.env.HOME = '/tmp'
  process.env.motherduck_token = MOTHERDUCK_TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database('md:production_db', { motherduck_token: MOTHERDUCK_TOKEN })
  const conn = db.connect()
  await new Promise((resolve, reject) => { conn.run('LOAD motherduck', err => err ? reject(err) : resolve()) })

  const sql = `
    SELECT reference_number, dock_appointment_type_name, dock_status_name,
           scheduled_arrival, project_name, carrier_name
    FROM production_db.gold.truck_appointments
    WHERE warehouse_id = ${warehouseId}
      AND carrier_name ILIKE '%CMM%'
      AND project_name ILIKE '%palermo%'
      AND dock_appointment_type_name ILIKE 'outbound%'
      AND dock_status_name != 'Cancelled'
      AND CAST(scheduled_arrival AS DATE) = DATE '${date}'
    ORDER BY scheduled_arrival
  `
  const rows = await new Promise((resolve, reject) => { conn.all(sql, (err, result) => err ? reject(err) : resolve(result)) })
  conn.close()
  db.close()
  return rows || []
}

async function frontCreateDraft({ authorId, to, cc, subject, body, channelId }) {
  const payload = { author_id: authorId, subject, body }
  if (to && to.length) payload.to = to
  if (cc && cc.length) payload.cc = cc
  const res = await fetch(`https://api2.frontapp.com/channels/${channelId || DEFAULT_FRONT_CHANNEL_ID}/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw Object.assign(new Error('Front create-draft failed'), { detail: json })
  return json
}

function conversationIdFromDraftResponse(draft) {
  const url = draft?._links?.related?.conversation
  if (!url) return null
  const m = String(url).match(/(cnv_[A-Za-z0-9]+)\s*$/)
  return m ? m[1] : null
}

async function frontAddFollowers(conversationId, teammateIds) {
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/followers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ teammate_ids: teammateIds }),
  })
  if (!res.ok) { const t = await res.text(); throw Object.assign(new Error('Front add-followers failed'), { detail: t }) }
}

async function frontPostComment(conversationId, body, authorId) {
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body, author_id: authorId || undefined }),
  })
  if (!res.ok) { const t = await res.text(); throw Object.assign(new Error('Front comment failed'), { detail: t }) }
}

async function runDigest({ isManualTest, facility }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not set')

  const warehouseId = WAREHOUSE_ID[facility]
  if (!warehouseId) return { ok: false, reason: `Unknown facility "${facility}"` }

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.${facility}&dashboard_type=eq.cmm_outbound_appts&select=notify_hour,notify_minute,notify_days,active,last_sent_date,discussion_comment,author_teammate_id,from_channel_id`
  )
  const settings = settingsRows?.[0]
  if (!settings) return { ok: false, reason: `No prepick_notify_settings row for ${facility}/cmm_outbound_appts` }

  const dateObj = centralTomorrowDateObj()
  const date = isoDate(dateObj)

  if (!isManualTest) {
    if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }
    const notifyHour = settings.notify_hour ?? 18
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

  if (!settings.author_teammate_id) {
    return { ok: false, reason: 'No author_teammate_id configured — set a Draft Author in Settings > CMM Outbound Appts' }
  }

  const [emailRows, discussionRows] = await Promise.all([
    sbFetch(`cmm_outbound_email_recipients?facility=eq.${facility}&active=eq.true&select=email,role`),
    sbFetch(`notification_recipients?list_name=eq.cmm_outbound_${facility}&active=eq.true&select=front_teammate_id`),
  ])
  const to = (emailRows || []).filter(r => r.role === 'to').map(r => r.email)
  const cc = (emailRows || []).filter(r => r.role === 'cc').map(r => r.email)
  const discussionTeammateIds = (discussionRows || []).map(r => r.front_teammate_id).filter(Boolean)

  if (to.length === 0) {
    return { ok: false, reason: 'No active TO recipients configured in Settings > CMM Outbound Appts' }
  }

  const appts = await queryAppointments(warehouseId, date)
  const facilityDisplay = FACILITY_DISPLAY[facility] || facility.toUpperCase()
  const subject = `CMM Outbound Appts — ${facilityDisplay} — ${date}`
  const html = buildDraftHtml(appts, dateObj, facilityDisplay)

  const draft = await frontCreateDraft({ authorId: settings.author_teammate_id, to, cc, subject, body: html, channelId: settings.from_channel_id })
  const conversationId = conversationIdFromDraftResponse(draft)

  if (conversationId && discussionTeammateIds.length) {
    await frontAddFollowers(conversationId, discussionTeammateIds)
  }
  if (conversationId && settings.discussion_comment) {
    await frontPostComment(conversationId, settings.discussion_comment, settings.author_teammate_id)
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${facility}&dashboard_type=eq.cmm_outbound_appts`, { last_sent_date: date })
  }

  return {
    ok: true, date, subject, conversationId,
    apptCount: appts.length, toCount: to.length, ccCount: cc.length,
    followerCount: discussionTeammateIds.length,
    channelId: settings.from_channel_id || DEFAULT_FRONT_CHANNEL_ID,
  }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  WAREHOUSE_ID,
  sbFetch, sbPatch,
  runDigest,
}
