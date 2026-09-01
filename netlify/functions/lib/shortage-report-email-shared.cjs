'use strict'

// Shared core for Customer Shortage Report EMAIL draft creation — added
// 2026-09-01, MOVED same day from an earlier "Daily Discussion Email"
// version per Dan's follow-up: "I would've thought they would live within
// the Customer Shortage Report tab" + "this needs to live within the
// Customer Shortage Report [tab] for when we get more customers other
// than Pretzilla built within it."
//
// Two decisions that shape this file:
//
//   1. CONTENT = the shortage table itself (Material / Needed / Active /
//      Inactive / Allocated / Short), NOT a general appointment list.
//      Query mirrors motherduck-pretzilla-shortage.cjs EXACTLY — same
//      appointment-join demand logic, same gold.available_inventory_by_
//      material inventory pull, same Short = Active - Needed formula (see
//      that file's header for the full validation history). Kept as a
//      literal copy rather than a shared import so this function has no
//      runtime dependency on the report tab's own backend function.
//
//   2. KEYED BY reportKey, NOT facility. The report tab currently covers
//      one customer (Pretzilla, Kenosha, project_ids [230,342]) but is
//      explicitly expected to grow to more customers later. Using
//      "facility" as the settings-row key (like Daily Discussions/CMM
//      Outbound do) would collide the day a second Kenosha customer gets
//      added to this tab, and wouldn't even make sense for a customer at
//      a different warehouse. reportKey is a free-form string identifying
//      ONE customer's report scope within this tab — 'pretzilla_ken' is
//      the only value that exists today. Adding a second customer later
//      means a second reportKey + a REPORT_CONFIGS entry below, not a
//      restructuring of this file.
//
// Reuses prepick_notify_settings (dashboard_type='shortage_report_email',
// facility column repurposed to hold the reportKey value — no schema
// change needed, that table was already a generic key-value settings
// store keyed by two text columns). New dedicated table
// shortage_report_email_recipients (report_key, email, role, active) for
// TO/CC — deliberately NOT reusing daily_discussion_email_recipients
// (that table is now orphaned/unused, left in place per this app's
// no-file-delete convention) or cmm_outbound_email_recipients. Internal
// discussion followers reuse notification_recipients with
// list_name=`shortage_report_email_<reportKey>`.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN
const DEFAULT_FRONT_CHANNEL_ID = 'cha_erzf8'
const DASHBOARD_TYPE = 'shortage_report_email'

// One entry per customer report. Add a new key here (plus its own
// PROJECT_IDS/WAREHOUSE_ID/APPT_TAG/display name) when a second customer
// gets built into the Customer Shortage Report tab — nothing else in this
// file needs to change to support that.
const REPORT_CONFIGS = {
  pretzilla_ken: {
    display: 'Pretzilla — Kenosha',
    warehouseId: 5,
    projectIds: [230, 342],
    apptTag: '(PZ)',
  },
}

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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function fmt(n) { return Number(n ?? 0).toLocaleString('en-US') }

// Builds the shortage-table HTML — same six columns as the app's own
// Customer Shortage Report tab (Material / Needed / Active / Inactive /
// Allocated / Short).
function buildDraftHtml(materials, dateObj, reportDisplay) {
  const shortCount = materials.filter(m => m.short < 0).length
  const rowsHtml = materials.map(m => `
    <tr${m.short < 0 ? ' style="background:#fdecec;"' : ''}>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;">
        <div style="font-family:monospace;font-size:11px;color:#666;">${escapeHtml(m.materialCode)}</div>
        ${escapeHtml(m.description)}
      </td>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;text-align:right;">${fmt(m.needed)}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;text-align:right;">${fmt(m.active)}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;text-align:right;">${fmt(m.inactive)}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;text-align:right;">${fmt(m.allocated)}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #ddd;text-align:right;font-weight:${m.short < 0 ? 'bold' : 'normal'};color:${m.short < 0 ? '#c0392b' : '#333'};">
        ${m.short < 0 ? fmt(m.short) : '—'}
      </td>
    </tr>`).join('')

  return `
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;">
      <h3 style="margin:0 0 4px;">Shortage Report — ${escapeHtml(reportDisplay)}</h3>
      <p style="margin:0 0 12px;color:#555;">${escapeHtml(formatHeaderDate(dateObj))}</p>
      <p style="margin:0 0 12px;"><strong>Materials: ${materials.length} · Short: ${shortCount}</strong></p>
      <table style="border-collapse:collapse;width:100%;max-width:680px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:4px 10px;border-bottom:2px solid #333;">Material</th>
            <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #333;">Needed</th>
            <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #333;">Active</th>
            <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #333;">Inactive</th>
            <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #333;">Allocated</th>
            <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #333;">Short</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:8px 10px;">No orders found for this date.</td></tr>'}</tbody>
      </table>
      <p style="margin:12px 0 0;font-size:11px;color:#888;">Short = Active − Needed, shown only when negative. Inactive and Allocated (soft + hard) are informational only.</p>
    </div>`
}

// Mirrors motherduck-pretzilla-shortage.cjs's query logic exactly — see
// that file's header for the appointment-coverage and soft-allocated
// validation history. Demand STRICTLY from linked appointment→order
// relations only (unlinked/no-order appointments excluded, same as the
// tab itself).
async function queryShortageMaterials(config, date) {
  process.env.HOME = '/tmp'
  process.env.motherduck_token = MOTHERDUCK_TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database('md:production_db', { motherduck_token: MOTHERDUCK_TOKEN })
  const conn = db.connect()
  await new Promise((resolve, reject) => { conn.run('LOAD motherduck', err => err ? reject(err) : resolve()) })
  const runQuery = (sql) => new Promise((resolve, reject) => { conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)) })

  const { warehouseId, projectIds, apptTag } = config

  const linkedApptsSql = `
    SELECT dai.dock_appointment_id AS appt_id, o.order_id AS order_id
    FROM production_db.silver.datex_slv_dockappointments da
    JOIN production_db.silver.datex_slv_dockappointmentitems dai
      ON dai.dock_appointment_id = da.dock_appointment_id
    JOIN production_db.silver.datex_slv_orders o
      ON o.order_id = dai.item_entity_id AND dai.item_entity_type = 'Order'
    WHERE da.warehouse_id = ${warehouseId}
      AND da.lookup_code LIKE '%${apptTag}%'
      AND da.status_id NOT IN (4, 5)
      AND CAST(da.scheduled_arrival AS DATE) = DATE '${date}'
      AND o.project_id IN (${projectIds.join(',')})
  `
  const linkedRows = await runQuery(linkedApptsSql)
  const orderIds = [...new Set(linkedRows.map(r => r.order_id))]
  if (orderIds.length === 0) {
    conn.close(); db.close()
    return { materials: [], orderCount: 0 }
  }

  const neededSql = `
    SELECT
      m.material_id AS material_id, m.lookup_code AS material_code, m.description AS description,
      SUM(ol.packaged_amount) AS needed
    FROM production_db.silver.datex_slv_orderlines ol
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = ol.material_id
    WHERE ol.order_id IN (${orderIds.join(',')})
    GROUP BY m.material_id, m.lookup_code, m.description
    ORDER BY m.lookup_code
  `
  const neededRows = await runQuery(neededSql)
  const materialIds = neededRows.map(r => r.material_id)

  const invSql = `
    SELECT
      material_id,
      active_packaged_amount AS active,
      inactive_packaged_amount AS inactive,
      soft_allocated_packaged_amount AS soft_alloc,
      allocated_packaged_amount AS hard_alloc
    FROM production_db.gold.available_inventory_by_material
    WHERE warehouse_id = ${warehouseId}
      AND material_id IN (${materialIds.join(',') || '-1'})
  `
  const invRows = materialIds.length ? await runQuery(invSql) : []
  const invByMaterial = new Map(invRows.map(r => [r.material_id, r]))

  const materials = neededRows.map(r => {
    const inv = invByMaterial.get(r.material_id) || {}
    const needed = Number(r.needed) || 0
    const active = Number(inv.active) || 0
    const inactive = Number(inv.inactive) || 0
    const softAlloc = Number(inv.soft_alloc) || 0
    const hardAlloc = Number(inv.hard_alloc) || 0
    const rawShort = active - needed
    return {
      materialCode: r.material_code,
      description: r.description,
      needed, active, inactive,
      allocated: softAlloc + hardAlloc,
      short: rawShort < 0 ? rawShort : 0,
    }
  })

  conn.close()
  db.close()
  return { materials, orderCount: orderIds.length }
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

async function runDigest({ isManualTest, reportKey }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not set')

  const config = REPORT_CONFIGS[reportKey]
  if (!config) return { ok: false, reason: `Unknown reportKey "${reportKey}"` }

  // NOTE: prepick_notify_settings.facility column is repurposed to hold
  // reportKey here — see file header for why.
  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.${reportKey}&dashboard_type=eq.${DASHBOARD_TYPE}&select=notify_hour,notify_minute,notify_days,active,last_sent_date,discussion_comment,author_teammate_id,from_channel_id`
  )
  const settings = settingsRows?.[0]
  if (!settings) return { ok: false, reason: `No prepick_notify_settings row for ${reportKey}/${DASHBOARD_TYPE}` }

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
    return { ok: false, reason: 'No author_teammate_id configured — set a Draft Author in the Customer Shortage Report tab' }
  }

  const [emailRows, discussionRows] = await Promise.all([
    sbFetch(`shortage_report_email_recipients?report_key=eq.${reportKey}&active=eq.true&select=email,role`),
    sbFetch(`notification_recipients?list_name=eq.shortage_report_email_${reportKey}&active=eq.true&select=front_teammate_id`),
  ])
  const to = (emailRows || []).filter(r => r.role === 'to').map(r => r.email)
  const cc = (emailRows || []).filter(r => r.role === 'cc').map(r => r.email)
  const discussionTeammateIds = (discussionRows || []).map(r => r.front_teammate_id).filter(Boolean)

  if (to.length === 0) {
    return { ok: false, reason: 'No active TO recipients configured in the Customer Shortage Report tab' }
  }

  const { materials, orderCount } = await queryShortageMaterials(config, date)
  const subject = `Shortage Report Draft — ${config.display} — ${date}`
  const html = buildDraftHtml(materials, dateObj, config.display)

  const draft = await frontCreateDraft({ authorId: settings.author_teammate_id, to, cc, subject, body: html, channelId: settings.from_channel_id })
  const conversationId = conversationIdFromDraftResponse(draft)

  if (conversationId && discussionTeammateIds.length) {
    await frontAddFollowers(conversationId, discussionTeammateIds)
  }
  if (conversationId && settings.discussion_comment) {
    await frontPostComment(conversationId, settings.discussion_comment, settings.author_teammate_id)
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${reportKey}&dashboard_type=eq.${DASHBOARD_TYPE}`, { last_sent_date: date })
  }

  return {
    ok: true, date, subject, conversationId,
    materialCount: materials.length,
    shortCount: materials.filter(m => m.short < 0).length,
    orderCount, toCount: to.length, ccCount: cc.length,
    followerCount: discussionTeammateIds.length,
    channelId: settings.from_channel_id || DEFAULT_FRONT_CHANNEL_ID,
  }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  REPORT_CONFIGS, DASHBOARD_TYPE,
  sbFetch, sbPatch,
  runDigest,
}
