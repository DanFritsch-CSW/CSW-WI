'use strict'

// Shared logic for the Automated Appointment Creation pilot (Palermo's /
// Sam Rohde) — added 2026-08-22. Used by auto-appt-parse-run.cjs and
// auto-appt-parse-test.cjs.
//
// Scope, per Dan's explicit "tread lightly" framing:
//   - ONE sender (s.rohde@palermospizza.com), ONE format, ONE inbox
//     (CAL Appointments, channel cha_ema1g). Anything that doesn't match
//     both the sender AND the exact expected body pattern is left alone —
//     no partial guesses, no fuzzy matching.
//   - NEVER pushes to Datex. Creates a 'pending' submissions row only —
//     the existing human-approval flow in PluginView.jsx (Single APPT
//     tab) picks it up exactly like a manually-entered draft. The CSR
//     still clicks Approve & Push themselves.
//   - Every attempt is logged to auto_appt_attempts regardless of
//     outcome, reviewed via a daily digest comment (see
//     auto-appt-review-digest-run.cjs) — this is the audit trail Dan
//     wants before ever considering full automation.
//
// UPDATED 2026-08-23 after Dan clarified the parsing logic: the time in
// Sam Rohde's emails ("needed 3pm") is when the material needs to be
// READY BY, not the truck appointment time itself — the actual
// appointment should be scheduled 3 hours BEFORE that time. parseBody now
// returns both neededBy (the time as literally stated in the email) and
// scheduledArrival (neededBy minus 3 hours, via proper Date millisecond
// arithmetic so day/month/year rollover is handled correctly — e.g.
// "needed 1am" correctly rolls back to 10pm the PREVIOUS day). Both
// values are logged to auto_appt_attempts (needed_by column) and the
// needed-by time is included in the pending submission's notes, so a CSR
// reviewing it can see exactly why that appointment time was chosen.
//
// FIXED 2026-08-24 — Dan reported a real email from Sam Rohde
// (msg_2qb916ms, "TO450753 - 8/26 (needed 5pm)") that was never caught.
// Traced this against live data before writing anything: the channel ID
// was confirmed correct (cha_ema1g = cswcaledoniaappts@csw-wi.com,
// exactly matches the "to" address on her email), the regex matched the
// body exactly, and the sender matched exactly — every piece of parsing
// logic was right. The actual cause: CAL Appointments had 136
// conversation updates that same day (confirmed via Front search), and
// fetchRecentEligibleMessages only ever fetched the 50 MOST RECENT
// messages with no memory of what it had already scanned — Sam's message
// was pushed completely out of that window by unrelated traffic within
// hours, long before a 15-minute scan could realistically catch it. This
// was a known risk flagged when the function was first built, confirmed
// here as the actual cause.
//
// Fix: replaced the fixed "top 50 snapshot" with a persistent watermark
// (last-scanned message timestamp, stored in the existing `settings`
// table under key auto_appt_scan_watermark) and pagination that walks
// forward through Front's API — using message.created_at, a Unix-seconds
// timestamp per Front's documented API — until it reaches messages at or
// before the watermark, capped at MAX_PAGES as a safety bound. This
// guarantees nothing is missed regardless of channel volume, as long as
// the volume between scans stays under MAX_PAGES * 50 messages (500 —
// comfortably above the ~136/day observed here). The watermark advances
// on every run regardless of whether anything matched, so quiet periods
// of irrelevant traffic don't get needlessly re-scanned. On first run
// (no watermark yet), defaults to a 24-hour lookback so anything already
// sitting unprocessed — like Sam's stuck email — gets caught immediately
// rather than only going forward from deploy time.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN || ''

const CAL_CHANNEL_ID = 'cha_ema1g' // CAL Appointments — confirmed with Dan 2026-08-22, re-confirmed against live channel address 2026-08-24
const ELIGIBLE_SENDER = 's.rohde@palermospizza.com'
const PALERMO_OWNER_NAME = 'Palermo Villa, Inc.' // confirmed via live MotherDuck query before writing this, not guessed
const CAL_WAREHOUSE = 'CSW-Franksville' // this app's canonical CAL warehouse name (see WAREHOUSE_MAP in pluginUtils.js)
const APPT_TYPE = 'Outbound' // every observed Sam Rohde order is an Outbound Sales Order in Datex
const LEAD_TIME_HOURS = 3 // appointment is scheduled this many hours BEFORE the "needed by" time — confirmed with Dan 2026-08-23

const WATERMARK_SETTINGS_KEY = 'auto_appt_scan_watermark'
const WATERMARK_LOOKBACK_HOURS = 24 // first-ever run default — see header note
const MAX_PAGES = 10 // safety cap: 10 * 50 = 500 messages per run, comfortably above the ~136/day observed for this channel

// Matches "TO446013 - 8/20 (needed 3pm)" — the exact, consistent format
// confirmed from Sam Rohde's emails. Deliberately strict: no fuzzy
// variations attempted. A body that doesn't match this exactly falls
// through to outcome='parse_failed' rather than a best-effort guess.
const BODY_PATTERN = /\bTO(\d{5,7})\s*-\s*(\d{1,2})\/(\d{1,2})\s*\(\s*needed\s*(\d{1,2})\s*(am|pm)\s*\)/i

function sbHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) }
}

function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

async function frontFetch(path, options) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, Accept: 'application/json', ...(options?.headers || {}) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Front API ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

// Already-processed check — front_message_id is the dedup key. Kept as a
// defense-in-depth backstop (e.g. a watermark edge case, or the same
// message somehow appearing twice in a page) even though the watermark
// below is now the PRIMARY mechanism preventing re-scans.
async function alreadyProcessed(messageId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/auto_appt_attempts?front_message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`,
    { headers: sbHeaders() }
  )
  if (!res.ok) return false // fail open — a transient Supabase error shouldn't block re-checking later; worst case is a duplicate log row, not a duplicate appointment (submissions aren't created until the order+owner checks below pass)
  const rows = await res.json()
  return rows?.length > 0
}

async function logAttempt(fields) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/auto_appt_attempts`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(fields),
    })
  } catch (err) {
    console.warn('[auto-appt-parse] failed to log attempt (non-fatal):', err.message)
  }
}

// Watermark persistence — reuses the existing generic `settings`
// key/value table (already used for dock_door_rules etc.) rather than a
// new table, since this is a single scalar value. Stored as Unix seconds
// (matching Front's message.created_at format) to avoid any
// timestamp-encoding ambiguity on read-back.
async function getWatermarkSeconds() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/settings?select=value&key=eq.${WATERMARK_SETTINGS_KEY}`, {
    headers: sbHeaders(),
  })
  if (!res.ok) return null
  const rows = await res.json()
  const value = rows?.[0]?.value
  return typeof value === 'number' ? value : null
}

async function setWatermarkSeconds(seconds) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify({ key: WATERMARK_SETTINGS_KEY, value: seconds }),
    })
  } catch (err) {
    console.warn('[auto-appt-parse] failed to persist watermark (non-fatal, will retry next run):', err.message)
  }
}

// Fetches messages from the CAL Appointments channel newer than the
// stored watermark, paginating forward through Front's API as needed
// (see this file's 2026-08-24 header note for why a fixed "top 50" isn't
// enough for this channel's real volume). Advances the watermark to the
// newest message's created_at once done, REGARDLESS of whether anything
// matched the eligible-sender filter — a quiet stretch of irrelevant
// traffic still needs to count as "scanned" or every run would re-walk
// the same ground.
async function fetchRecentEligibleMessages() {
  const watermarkSeconds = await getWatermarkSeconds()
  const sinceSeconds = watermarkSeconds ?? Math.floor(Date.now() / 1000) - WATERMARK_LOOKBACK_HOURS * 3600

  let allMessages = []
  let path = `/channels/${CAL_CHANNEL_ID}/messages?limit=50`
  let pagesFetched = 0

  while (path && pagesFetched < MAX_PAGES) {
    const data = await frontFetch(path)
    const pageMessages = data._results || []
    allMessages.push(...pageMessages)
    pagesFetched++

    // Messages are newest-first (Front's documented default order for
    // this endpoint). Stop paging once this page's OLDEST message is
    // already at or before the watermark — everything newer has already
    // been collected across this and prior pages.
    const oldestOnPage = pageMessages[pageMessages.length - 1]
    if (!oldestOnPage || (oldestOnPage.created_at ?? 0) <= sinceSeconds) break

    const nextUrl = data._pagination?.next
    path = nextUrl ? nextUrl.replace('https://api2.frontapp.com', '') : null
  }

  if (allMessages.length > 0) {
    const newestSeconds = allMessages.reduce((max, m) => Math.max(max, m.created_at ?? 0), sinceSeconds)
    await setWatermarkSeconds(newestSeconds)
  }

  const newMessages = allMessages.filter((m) => (m.created_at ?? 0) > sinceSeconds)

  return newMessages.filter((m) => {
    if (!m.is_inbound) return false
    const fromHandle = (m.recipients || []).find((r) => r.role === 'from')?.handle
    return fromHandle && fromHandle.toLowerCase() === ELIGIBLE_SENDER
  })
}

function getMessageText(message) {
  if (message.text) return message.text
  if (message.body) return stripHtml(message.body)
  return ''
}

async function getConversationId(message) {
  const url = message._links?.related?.conversation
  if (!url) return null
  const path = url.replace('https://api2.frontapp.com', '')
  const conv = await frontFetch(path)
  return conv.id || null
}

function fmtLocal(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  return `${y}-${m}-${dd}T${hh}:00`
}

// Parses "TO446013 - 8/20 (needed 3pm)" into { reference, neededBy,
// scheduledArrival }. neededBy is the time as literally stated in the
// email (material must be ready by then); scheduledArrival is
// LEAD_TIME_HOURS earlier — the actual truck appointment time — computed
// via plain millisecond arithmetic on a Date object so day/month/year
// rollover is handled correctly (e.g. "needed 1am" correctly becomes
// 10pm the PREVIOUS day, not a negative hour).
//
// Assumes the current year for the stated date; if the resulting
// needed-by date is more than 60 days in the past relative to today,
// rolls to next year — handles a message arriving near a year boundary
// referencing a date just after it, without overcomplicating the common
// case.
function parseBody(text) {
  const match = BODY_PATTERN.exec(text)
  if (!match) return null
  const [, digits, monthStr, dayStr, hourStr, ampm] = match
  const reference = `TO${digits}`
  const month = parseInt(monthStr, 10)
  const day = parseInt(dayStr, 10)
  let neededHour = parseInt(hourStr, 10) % 12
  if (ampm.toLowerCase() === 'pm') neededHour += 12

  const now = new Date()
  let year = now.getFullYear()
  let neededByDate = new Date(year, month - 1, day, neededHour, 0, 0)
  const diffDays = (now - neededByDate) / (1000 * 60 * 60 * 24)
  if (diffDays > 60) {
    year += 1
    neededByDate = new Date(year, month - 1, day, neededHour, 0, 0)
  }

  const apptDate = new Date(neededByDate.getTime() - LEAD_TIME_HOURS * 60 * 60 * 1000)

  return {
    reference,
    neededBy: fmtLocal(neededByDate),
    scheduledArrival: fmtLocal(apptDate),
  }
}

// Order lookup — SAME matching logic as scheduling-order-search.cjs
// (lookup_code/owner_reference/vendor_reference, active statuses only,
// correct owner join chain project_id -> datex_projects.OwnerId ->
// datex_owners.Name). Duplicated here rather than calling that function
// over HTTP: this needs the FULL row including owner name to distinguish
// "not found" from "found but wrong owner" for logging, and a direct
// MotherDuck query is the established "self-contained port" pattern for
// scheduled functions in this app (see nightly-b2e-sync-shared.cjs).
async function lookupOrder(reference) {
  const refLit = sqlLit(reference)
  const sql = `
    WITH latest_projects AS (
      SELECT Id AS project_id, Name AS project_name, OwnerId AS owner_id
      FROM (
        SELECT Id, Name, OwnerId, ROW_NUMBER() OVER (PARTITION BY Id ORDER BY ingestion_ts DESC) AS rn
        FROM production_db.bronze.datex_projects
      )
      WHERE rn = 1
    ),
    latest_owners AS (
      SELECT Id AS owner_id, Name AS owner_name
      FROM (
        SELECT Id, Name, ROW_NUMBER() OVER (PARTITION BY Id ORDER BY ingestion_ts DESC) AS rn
        FROM production_db.bronze.datex_owners
      )
      WHERE rn = 1
    )
    SELECT o.order_id, COALESCE(ow.owner_name, '') AS owner_name, COALESCE(p.project_name, '') AS project_name
    FROM production_db.silver.datex_slv_orders o
    LEFT JOIN latest_projects p ON p.project_id = o.project_id
    LEFT JOIN latest_owners ow ON ow.owner_id = p.owner_id
    WHERE (
      LOWER(o.lookup_code) = LOWER(${refLit})
      OR LOWER(o.owner_reference) = LOWER(${refLit})
      OR LOWER(o.vendor_reference) = LOWER(${refLit})
    )
    AND o.order_status_id IN (1, 2)
    ORDER BY o.created_sys_date_time DESC
    LIMIT 1
  `
  process.env.HOME = '/tmp'
  process.env.motherduck_token = MOTHERDUCK_TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database('md:production_db', { motherduck_token: MOTHERDUCK_TOKEN })
  const conn = db.connect()
  await new Promise((resolve, reject) => conn.run('LOAD motherduck', (err) => (err ? reject(err) : resolve())))
  const rows = await new Promise((resolve, reject) => conn.all(sql, (err, result) => (err ? reject(err) : resolve(result))))
  conn.close()
  db.close()
  return rows?.[0] || null
}

// Dock door rule matching — ported from findDockDoorRule in
// src/lib/pluginUtils.js (this function runs server-side with no access
// to the browser bundle, so the logic is duplicated, not imported;
// verified line-for-line identical to the source at time of writing).
function findDockDoorRule(warehouse, project, type, rules) {
  if (!project || !type || !rules?.length) return null
  const warehouseLower = (warehouse ?? '').toLowerCase()
  const projectLower = project.toLowerCase()
  const typeLower = type.toLowerCase()
  for (const rule of rules) {
    if (!rule.project || !rule.type_contains || !rule.dock_door) continue
    if (rule.warehouse && rule.warehouse.toLowerCase() !== warehouseLower) continue
    if (rule.project.toLowerCase() === projectLower && typeLower.includes(rule.type_contains.toLowerCase())) {
      return rule.dock_door
    }
  }
  return null
}

async function getDockDoorRules() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/settings?select=value&key=eq.dock_door_rules`, { headers: sbHeaders() })
  if (!res.ok) return []
  const rows = await res.json()
  return rows?.[0]?.value || []
}

// Checks the labor picture for the parsed hour — informational only,
// never blocks pending-submission creation. Uses the SAME endpoint the
// plugin's own picker banner calls, via internal HTTP (this one's
// genuinely complex — roster assignments, carryover employees, HPA
// overrides — duplicating it here would be a real maintenance
// liability, unlike the order lookup above which is a handful of lines).
async function checkLabor(warehouse, scheduledArrival) {
  const dateOnly = scheduledArrival.split('T')[0]
  const hour = parseInt(scheduledArrival.split('T')[1].split(':')[0], 10)
  try {
    const base = process.env.URL || process.env.DEPLOY_URL || ''
    const res = await fetch(
      `${base}/.netlify/functions/scheduling-labor-planning-insights?warehouse=${encodeURIComponent(warehouse)}&date=${dateOnly}`
    )
    if (!res.ok) return null
    const data = await res.json()
    const row = (data.hours || []).find((h) => h.hour === hour)
    if (row && row.final < 0) {
      return `Short ${Math.abs(row.final).toFixed(1)} staff at the requested hour`
    }
    return null
  } catch {
    return null // informational only — never let a labor-check failure block anything
  }
}

// Appointment-code prefix — ported from findAbbreviation in
// src/lib/pluginUtils.js, using the SAME "Palermo" -> "PVI" entry already
// in DEFAULT_ABBREVIATIONS there (kept in sync manually since this file
// can't import the browser bundle; if that mapping ever changes, this
// constant needs updating too).
const PALERMO_ABBR = 'PVI'

function formatDisplayDatetime(iso) {
  const [datePart, timePart] = iso.split('T')
  const [y, m, d] = datePart.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthName = months[parseInt(m, 10) - 1] || m
  const hour24 = parseInt(timePart.split(':')[0], 10)
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  const ampm = hour24 < 12 ? 'AM' : 'PM'
  return `${monthName} ${parseInt(d, 10)}, ${y} ${hour12}:00 ${ampm}`
}

async function createPendingSubmission({ conversationId, project, dockDoor, reference, neededBy, scheduledArrival }) {
  const appointmentCode = `(${PALERMO_ABBR}) - ${reference}`
  const notes = `Auto-parsed from Sam Rohde email — needed by ${formatDisplayDatetime(neededBy)}, appointment scheduled ${LEAD_TIME_HOURS} hours prior. Please verify all fields before pushing to Datex.`
  const fields = {
    warehouse: CAL_WAREHOUSE,
    type: APPT_TYPE,
    owner: PALERMO_OWNER_NAME,
    project,
    scheduled_arrival: scheduledArrival,
    scheduled_dock_door: dockDoor || '',
    reference_number: reference,
    appointment_lookup_code: appointmentCode,
    notes,
    front_conversation_id: conversationId || null,
    status: 'pending',
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(fields),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase submissions insert -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const rows = await res.json()
  return rows?.[0] || null
}

// ── Scan orchestration ───────────────────────────────────────────────────
// Lives here (not in the run/test function files) so both
// auto-appt-parse-run.cjs (scheduled) and auto-appt-parse-test.cjs
// (manual, no schedule entry — see that file's header for why the split
// exists) call the exact same logic rather than each having their own
// copy that could drift.

async function processMessage(message) {
  const messageId = message.id
  const subject = message.subject || ''

  if (await alreadyProcessed(messageId)) {
    return { messageId, outcome: 'skipped_already_processed' }
  }

  const text = getMessageText(message)
  const parsed = parseBody(text)

  if (!parsed) {
    await logAttempt({
      front_message_id: messageId,
      sender: ELIGIBLE_SENDER,
      subject,
      outcome: 'parse_failed',
    })
    return { messageId, outcome: 'parse_failed' }
  }

  const { reference, neededBy, scheduledArrival } = parsed
  const conversationId = await getConversationId(message).catch(() => null)

  let order
  try {
    order = await lookupOrder(reference)
  } catch (err) {
    await logAttempt({
      front_message_id: messageId,
      front_conversation_id: conversationId,
      sender: ELIGIBLE_SENDER,
      subject,
      matched_reference: reference,
      needed_by: neededBy,
      parsed_arrival: scheduledArrival,
      outcome: 'error',
      error_detail: `Order lookup failed: ${err.message}`,
    })
    return { messageId, outcome: 'error', error: err.message }
  }

  if (!order) {
    await logAttempt({
      front_message_id: messageId,
      front_conversation_id: conversationId,
      sender: ELIGIBLE_SENDER,
      subject,
      matched_reference: reference,
      needed_by: neededBy,
      parsed_arrival: scheduledArrival,
      outcome: 'order_not_found',
    })
    return { messageId, outcome: 'order_not_found', reference }
  }

  if (order.owner_name !== PALERMO_OWNER_NAME) {
    await logAttempt({
      front_message_id: messageId,
      front_conversation_id: conversationId,
      sender: ELIGIBLE_SENDER,
      subject,
      matched_reference: reference,
      needed_by: neededBy,
      parsed_arrival: scheduledArrival,
      outcome: 'owner_mismatch',
      owner_name: order.owner_name,
      project_name: order.project_name,
    })
    return { messageId, outcome: 'owner_mismatch', reference, foundOwner: order.owner_name }
  }

  const dockDoorRules = await getDockDoorRules()
  const dockDoor = findDockDoorRule(CAL_WAREHOUSE, order.project_name, 'Outbound', dockDoorRules)
  const laborWarning = await checkLabor(CAL_WAREHOUSE, scheduledArrival)

  let submission
  try {
    submission = await createPendingSubmission({
      conversationId,
      project: order.project_name,
      dockDoor,
      reference,
      neededBy,
      scheduledArrival,
    })
  } catch (err) {
    await logAttempt({
      front_message_id: messageId,
      front_conversation_id: conversationId,
      sender: ELIGIBLE_SENDER,
      subject,
      matched_reference: reference,
      needed_by: neededBy,
      parsed_arrival: scheduledArrival,
      outcome: 'error',
      owner_name: order.owner_name,
      project_name: order.project_name,
      error_detail: `Submission creation failed: ${err.message}`,
    })
    return { messageId, outcome: 'error', error: err.message }
  }

  await logAttempt({
    front_message_id: messageId,
    front_conversation_id: conversationId,
    sender: ELIGIBLE_SENDER,
    subject,
    matched_reference: reference,
    needed_by: neededBy,
    parsed_arrival: scheduledArrival,
    outcome: 'pending_created',
    submission_id: submission?.id || null,
    owner_name: order.owner_name,
    project_name: order.project_name,
    labor_warning: laborWarning,
  })

  return { messageId, outcome: 'pending_created', reference, submissionId: submission?.id }
}

async function runScan() {
  const messages = await fetchRecentEligibleMessages()
  const results = []
  for (const message of messages) {
    results.push(await processMessage(message))
  }
  return results
}

module.exports = {
  CAL_CHANNEL_ID,
  ELIGIBLE_SENDER,
  PALERMO_OWNER_NAME,
  CAL_WAREHOUSE,
  LEAD_TIME_HOURS,
  fetchRecentEligibleMessages,
  alreadyProcessed,
  logAttempt,
  getMessageText,
  getConversationId,
  parseBody,
  lookupOrder,
  findDockDoorRule,
  getDockDoorRules,
  checkLabor,
  createPendingSubmission,
  runScan,
}
