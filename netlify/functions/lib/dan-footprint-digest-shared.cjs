'use strict'

// Dan's Footprint Variance digest — shared core.
//
// Unlike every other digest in this app (prepick-digest-run.cjs,
// fefo-digest-run.cjs, etc.), which post a COMMENT into one fixed,
// pre-existing Front conversation (prepick_notify_settings.front_conversation_id),
// this one mirrors front-daily-discussion-run.cjs instead: it creates a
// BRAND-NEW Front discussion every time it fires, addressed only to Dan
// (resolved from notification_recipients, list_name='dan_footprint_variance',
// which carries his front_teammate_id — tea_a3e8k, confirmed live against
// front_teammates before seeding). Per Dan's explicit ask: "I want this to
// be a 'NEW' discussion thread — that is only sent to me."
//
// Multi-facility as of 2026-09-30 (Dan, 2026-09-30) — Wisconsin Rapids added
// alongside Madison, each with its OWN schedule and its OWN Front thread
// (Dan's explicit call: don't combine). Settings rows: reuses
// prepick_notify_settings (facility='dan', dashboard_type=
// 'footprint_variance_<facilityId>' — one row per tracked facility, same
// "one dashboard_type per variant under a shared owner row" convention
// FEFO's per-project rows use, see fefo-digest-shared.cjs). No schema
// change, front_conversation_id stays unused/null for these rows, same as
// other inert-column cases elsewhere in that table. last_sent_date dedupes
// against the CONTENT date (today, Central) same as every other digest, so
// the */15 tick can't create two threads in the same day's matching bucket
// — tracked per-row, so MAD and WR firing at different times/days doesn't
// interfere with each other.
//
// Active LPs: self-contained port of fetchActiveInventory (src/lib/omni.js),
// generalized 2026-09-30 to take a warehouse name (was Madison-only) —
// proxies through this site's own omni-query function
// (${process.env.URL}/.netlify/functions/omni-query) rather than
// duplicating the GraphQL-over-HTTP plumbing, per this project's documented
// "Netlify function → Omni direct API calls can return empty rows" lesson
// (omni-query.cjs already has the Arrow parsing / retry / timeout-injection
// logic; a second function should ride on top of it, not reimplement it).
//
// Projected Footprint + tracked-project list: dan_footprint_targets
// (Supabase), same table the /dan frontend reads/writes, scoped per facility.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const VIEW_LP = 'silver__datex_slv_licenseplates'
const VIEW_LP_WH = 'silver__datex_slv_warehouses'
const VIEW_LP_PROJ = 'silver__datex_slv_projects'

// Which facilities this digest supports, and what each needs: the Omni
// warehouse-name filter (matches CSW_WAREHOUSE in src/lib/omni.js), the
// human label used in the Front subject/body, and the dashboard_type this
// facility's settings row lives under. Add a row here (matching a row in
// Dan.jsx's FACILITIES array) to extend to another facility — no other
// changes needed in this file.
const FACILITY_CONFIG = {
  mad: { warehouse: 'CSW-Madison', label: 'Madison', dashboardType: 'footprint_variance_mad' },
  wr: { warehouse: 'CSW-Wisconsin Rapids', label: 'Wisconsin Rapids', dashboardType: 'footprint_variance_wr' },
}

// Reverse lookup used by the scheduled tick, which iterates settings rows
// by dashboard_type (see dan-footprint-digest-run.cjs) rather than knowing
// facility ids up front — same shape as FEFO's PROJECT_BY_DASHBOARD_TYPE.
const FACILITY_BY_DASHBOARD_TYPE = new Map(
  Object.entries(FACILITY_CONFIG).map(([id, cfg]) => [cfg.dashboardType, { id, ...cfg }])
)

const CSW_NAME_SUFFIXES = [
  ' - CSW-Madison', ' - CSW-Franksville', ' - CSW-Kenosha',
  ' - CSW-Wisconsin Rapids', ' - CSW-Eau Claire', '-CSW-Madison', ' - Madison',
]
function stripWarehouseSuffix(name) {
  if (!name) return name
  for (const suffix of CSW_NAME_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length)
  }
  return name
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

async function omniQueryViaProxy(query) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/omni-query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { version: 5, ...query } }),
  })
  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new Error(body.error || `omni-query ${res.status}`)
  }
  const { rows } = await res.json()
  return rows
}

// Self-contained port of fetchActiveInventory (src/lib/omni.js), scoped to
// one warehouse. Same paginated 5x500-row query, same archived=false +
// warehouse-name-contains filter. Generalized 2026-09-30 from a
// Madison-only fetchMadActiveInventory — warehouseName is the Omni
// CSW_WAREHOUSE value for the target facility (e.g. 'CSW-Madison',
// 'CSW-Wisconsin Rapids').
async function fetchFacilityActiveInventory(warehouseName) {
  const PAGE_SIZE = 500
  const MAX_PAGES = 5
  const allRows = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await omniQueryViaProxy({
      modelId: GOLD_MODEL_ID,
      table: VIEW_LP,
      fields: [
        `${VIEW_LP_PROJ}.project_name`,
        `${VIEW_LP}.lookup_code_count_distinct`,
      ],
      filters: {
        [`${VIEW_LP}.archived`]: { type: 'boolean', is_negative: true, treat_nulls_as_false: false },
        [`${VIEW_LP_WH}.warehouse_name`]: { kind: 'CONTAINS', type: 'string', values: [warehouseName], is_negative: false, case_insensitive: true },
      },
      sorts: [{ column_name: `${VIEW_LP}.lookup_code_count_distinct`, sort_descending: true }],
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    allRows.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  const map = new Map()
  for (const r of allRows) {
    const name = stripWarehouseSuffix(r[`${VIEW_LP_PROJ}.project_name`] || '')
    const lps = Number(r[`${VIEW_LP}.lookup_code_count_distinct`]) || 0
    if (name && name.trim()) map.set(name, lps)
  }
  return map
}

function fmt(n) { return Math.round(n).toLocaleString('en-US') }

// Per Dan's explicit format request (2026-09-07): project name as its own
// line, then Active/Projected/Variance as separate "Key = value" lines, a
// blank line between projects, and NO trailing total line — replaces the
// earlier compressed one-line-per-project + totals version.
function buildDiscussionBody(rows) {
  const lines = []
  for (const r of rows) {
    const variance = r.activeLps - r.projected
    const sign = variance >= 0 ? '+' : ''
    lines.push(r.projectName)
    lines.push(`Active = ${fmt(r.activeLps)}`)
    lines.push(`Projected = ${fmt(r.projected)}`)
    lines.push(`Variance = ${sign}${fmt(variance)}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function subjectFor(dateObj, facilityLabel) {
  const m = dateObj.getUTCMonth() + 1
  const d = dateObj.getUTCDate()
  const y = dateObj.getUTCFullYear()
  return `${facilityLabel} Footprint / Projected ${m}/${d}/${y}`
}

// Creates the new Front discussion + (on the scheduled path) stamps
// last_sent_date. Shared by both the scheduled tick and the manual test —
// isManualTest skips the last_sent_date write so repeated test clicks in
// the same day always fire (same convention as postDigest in every other
// *-digest-shared.cjs in this app). facility (default 'mad' for back-compat
// with any caller not yet passing it explicitly) selects which
// FACILITY_CONFIG entry — and therefore which warehouse, which
// dan_footprint_targets rows, and which settings row — this run applies to.
async function createFootprintThread({ isManualTest, facility = 'mad' }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const cfg = FACILITY_CONFIG[facility]
  if (!cfg) throw new Error(`Unknown facility '${facility}' — expected one of: ${Object.keys(FACILITY_CONFIG).join(', ')}`)

  const recipients = await sbFetch(
    `notification_recipients?list_name=eq.dan_footprint_variance&active=eq.true&front_teammate_id=not.is.null&select=front_teammate_id`
  )
  if (!recipients || !recipients.length) {
    return { ok: false, reason: 'no active recipient with a resolved Front teammate_id' }
  }

  const [targets, liveLps] = await Promise.all([
    sbFetch(`dan_footprint_targets?facility=eq.${facility}&select=project_name,projected_footprint&order=project_name.asc`),
    fetchFacilityActiveInventory(cfg.warehouse),
  ])

  if (!targets || !targets.length) {
    return { ok: false, reason: `no tracked projects in dan_footprint_targets for facility='${facility}'` }
  }

  const rows = targets.map(t => ({
    projectName: t.project_name,
    projected: Number(t.projected_footprint) || 0,
    activeLps: liveLps.get(t.project_name) ?? 0,
  }))

  const dateObj = centralTodayDateObj()
  const date = centralTodayISO()
  const subject = subjectFor(dateObj, cfg.label)
  const body = buildDiscussionBody(rows)

  const res = await fetch('https://api2.frontapp.com/conversations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      type: 'discussion',
      teammate_ids: recipients.map(r => r.front_teammate_id),
      subject,
      comment: { body },
    }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) {
    return { ok: false, reason: 'Front API error', detail: json }
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.dan&dashboard_type=eq.${cfg.dashboardType}`, { last_sent_date: date })
  }

  return { ok: true, facility, date, subject, conversationId: json.id, rowCount: rows.length }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  FACILITY_CONFIG, FACILITY_BY_DASHBOARD_TYPE,
  sbFetch, sbPatch,
  centralTodayISO, centralTodayDateObj, isNotifyTimeMatch,
  createFootprintThread,
}
