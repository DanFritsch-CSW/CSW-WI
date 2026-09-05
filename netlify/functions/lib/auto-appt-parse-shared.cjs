'use strict'

// Shared logic for the Automated Appointment Creation pilot (Palermo's /
// Sam Rohde) — added 2026-08-22. Used by auto-appt-parse-run.cjs and
// auto-appt-parse-test.cjs.
//
// Scope, per Dan's explicit "tread lightly" framing:
//   - ONE inbox (CAL Appointments, channel cha_ema1g). Anything that
//     doesn't match both a known sender AND that sender's exact expected
//     body pattern is left alone — no partial guesses, no fuzzy matching.
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
// arithmetic so day/month/year rollover is handled correctly.
//
// FIXED 2026-08-24 — replaced a fixed "top 50 snapshot" scan with a
// persistent watermark + pagination, after confirming Sam Rohde's real
// email was pushed out of the old fixed window by unrelated channel
// volume. See prior versions of this file's header for the full story.
//
// EXTENDED 2026-08-24 (later) — added Daren Peet as a second eligible
// sender with his own distinct format and the same 3-hour lead-time rule.
//
// DIAGNOSTIC LOGGING added 2026-09-05 — despite the watermark fix and
// Daren Peet addition both being deployed and confirmed intact (verified
// via direct GitHub read — netlify.toml registration and this file's
// content are both exactly as last pushed), the scheduled function has
// never once written a watermark row, even though: RLS is confirmed OFF
// on `settings`, the anon role has full INSERT/UPDATE grants (confirmed
// via information_schema.role_table_grants), the settings.key/value
// schema matches what this code expects (confirmed via
// information_schema.columns), a direct SQL upsert into settings
// succeeded instantly, and the Front API token has explicit "Read and
// Write Channels" scope (confirmed via Front's own token detail page) —
// ruling out every database- and permissions-side explanation that could
// be checked without seeing the function's own execution. Netlify's
// function log shows clean, fast (300-900ms) executions with no visible
// errors, which is consistent with the code failing very early and the
// top-level handler's try/catch converting that into a clean 502 rather
// than a visible crash.
//
// Added explicit console.log/console.error at every meaningful step
// (watermark read, each Front API page fetch, pagination decisions,
// watermark write, and eligibility results) specifically so the NEXT
// invocation's Netlify log shows exactly where execution stops, instead
// of continuing to infer from execution duration and the absence of
// side effects. getWatermarkSeconds/setWatermarkSeconds also now check
// res.ok explicitly and log the response body on failure — previously
// setWatermarkSeconds only caught network-level exceptions and silently
// ignored a non-2xx HTTP response, which could have been masking a
// Supabase-side rejection this whole time.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN || ''

const CAL_CHANNEL_ID = 'cha_ema1g' // CAL Appointments — confirmed with Dan 2026-08-22, re-confirmed against live channel address 2026-08-24
const PALERMO_OWNER_NAME = 'Palermo Villa, Inc.' // confirmed via live MotherDuck query before writing this, not guessed
const CAL_WAREHOUSE = 'CSW-Franksville' // this app's canonical CAL warehouse name (see WAREHOUSE_MAP in pluginUtils.js)
const APPT_TYPE = 'Outbound' // every observed order from either sender is an Outbound Sales Order in Datex
const LEAD_TIME_HOURS = 3 // appointment is scheduled this many hours BEFORE the "needed by"/stated time — confirmed with Dan 2026-08-23, and confirmed to apply identically to Daren Peet's format 2026-08-24

const WATERMARK_SETTINGS_KEY = 'auto_appt_scan_watermark'
const WATERMARK_LOOKBACK_HOURS = 24 // first-ever run default — see header note
const MAX_PAGES = 10 // safety cap: 10 * 50 = 500 messages per run, comfortably above the ~136/day observed for this channel

// Sam Rohde: "TO446013 - 8/20 (needed 3pm)". Deliberately strict — no
// fuzzy variations attempted.
const SAM_ROHDE_PATTERN = /\bTO(\d{5,7})\s*-\s*(\d{1,2})\/(\d{1,2})\s*\(\s*needed\s*(\d{1,2})\s*(am|pm)\s*\)/i

// Daren Peet: "TO_447991 Print Transfer Status 8/24 1700". Requires the
// literal "Print Transfer Status" phrase to stay strict.
const DAREN_PEET_PATTERN = /\bTO_(\d{5,7})\s+Print\s+Transfer\s+Status\s+(\d{1,2})\/(\d{1,2})\s+(\d{3,4})\b/i

const ELIGIBLE_SENDER_PATTERNS = [
  { sender: 's.rohde@palermospizza.com', pattern: SAM_ROHDE_PATTERN, style: 'needed_ampm' },
  { sender: 'da.peet@palermospizza.com', pattern: DAREN_PEET_PATTERN, style: 'raw_24h' },
]

function log(...args) {
  console.log('[auto-appt-parse]', ...args)
}

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
  log('frontFetch ->', path)
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, Accept: 'application/json', ...(options?.headers || {}) },
  })
  log('frontFetch <-', path, 'status', res.status)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[auto-appt-parse] frontFetch FAILED', path, res.status, text.slice(0, 500))
    throw new Error(`Front API ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

async function alreadyProcessed(messageId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/auto_appt_attempts?front_message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`,
    { headers: sbHeaders() }
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[auto-appt-parse] alreadyProcessed check FAILED', res.status, text.slice(0, 300))
    return false
  }
  const rows = await res.json()
  return rows?.length > 0
}

async function logAttempt(fields) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/auto_appt_attempts`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(fields),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('[auto-appt-parse] logAttempt FAILED', res.status, text.slice(0, 500))
    } else {
      log('logAttempt OK', fields.outcome, fields.front_message_id)
    }
  } catch (err) {
    console.error('[auto-appt-parse] logAttempt threw:', err.message)
  }
}

// Watermark persistence. NOW checks res.ok explicitly and logs the
// response body on failure — previously this only caught network-level
// exceptions and silently ignored a non-2xx HTTP response, which could
// have been masking a Supabase-side rejection this whole time.
async function getWatermarkSeconds() {
  log('getWatermarkSeconds: SUPABASE_URL set?', Boolean(SUPABASE_URL), 'SUPABASE_KEY set?', Boolean(SUPABASE_KEY))
  const url = `${SUPABASE_URL}/rest/v1/settings?select=value&key=eq.${WATERMARK_SETTINGS_KEY}`
  const res = await fetch(url, { headers: sbHeaders() })
  log('getWatermarkSeconds <- status', res.status)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[auto-appt-parse] getWatermarkSeconds FAILED', res.status, text.slice(0, 500))
    return null
  }
  const rows = await res.json()
  const value = rows?.[0]?.value
  log('getWatermarkSeconds result:', JSON.stringify(rows))
  return typeof value === 'number' ? value : null
}

async function setWatermarkSeconds(seconds) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify({ key: WATERMARK_SETTINGS_KEY, value: seconds }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('[auto-appt-parse] setWatermarkSeconds FAILED', res.status, text.slice(0, 500))
      return
    }
    log('setWatermarkSeconds OK, new value:', seconds)
  } catch (err) {
    console.error('[auto-appt-parse] setWatermarkSeconds threw (non-fatal, will retry next run):', err.message)
  }
}

async function fetchRecentEligibleMessages() {
  log('fetchRecentEligibleMessages: starting')
  const watermarkSeconds = await getWatermarkSeconds()
  const sinceSeconds = watermarkSeconds ?? Math.floor(Date.now() / 1000) - WATERMARK_LOOKBACK_HOURS * 3600
  log('fetchRecentEligibleMessages: sinceSeconds =', sinceSeconds, '(watermark was', watermarkSeconds, ')')

  let allMessages = []
  let path = `/channels/${CAL_CHANNEL_ID}/messages?limit=50`
  let pagesFetched = 0

  while (path && pagesFetched < MAX_PAGES) {
    const data = await frontFetch(path)
    const pageMessages = data._results || []
    log(`page ${pagesFetched + 1}: fetched ${pageMessages.length} messages`)
    allMessages.push(...pageMessages)
    pagesFetched++

    const oldestOnPage = pageMessages[pageMessages.length - 1]
    if (!oldestOnPage || (oldestOnPage.created_at ?? 0) <= sinceSeconds) {
      log('stopping pagination: reached watermark or empty page')
      break
    }

    const nextUrl = data._pagination?.next
    path = nextUrl ? nextUrl.replace('https://api2.frontapp.com', '') : null
    if (!path) log('stopping pagination: no next page URL')
  }

  log('fetchRecentEligibleMessages: total messages collected =', allMessages.length)

  if (allMessages.length > 0) {
    const newestSeconds = allMessages.reduce((max, m) => Math.max(max, m.created_at ?? 0), sinceSeconds)
    await setWatermarkSeconds(newestSeconds)
  } else {
    log('fetchRecentEligibleMessages: allMessages is empty, skipping watermark write')
  }

  const newMessages = allMessages.filter((m) => (m.created_at ?? 0) > sinceSeconds)
  log('fetchRecentEligibleMessages: newMessages (after watermark filter) =', newMessages.length)

  const eligible = []
  for (const m of newMessages) {
    if (!m.is_inbound) continue
    const fromHandle = (m.recipients || []).find((r) => r.role === 'from')?.handle?.toLowerCase()
    if (!fromHandle) continue
    const match = ELIGIBLE_SENDER_PATTERNS.find((p) => p.sender === fromHandle)
    if (match) eligible.push({ message: m, senderConfig: match })
  }
  log('fetchRecentEligibleMessages: eligible (matched sender) =', eligible.length)
  return eligible
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

function resolveDatesFromParts(digits, month, day, hour24) {
  const reference = `TO${digits}`
  const now = new Date()
  let year = now.getFullYear()
  let neededByDate = new Date(year, month - 1, day, hour24, 0, 0)
  const diffDays = (now - neededByDate) / (1000 * 60 * 60 * 24)
  if (diffDays > 60) {
    year += 1
    neededByDate = new Date(year, month - 1, day, hour24, 0, 0)
  }
  const apptDate = new Date(neededByDate.getTime() - LEAD_TIME_HOURS * 60 * 60 * 1000)
  return {
    reference,
    neededBy: fmtLocal(neededByDate),
    scheduledArrival: fmtLocal(apptDate),
  }
}

function parseBody(text, senderConfig) {
  if (senderConfig.style === 'needed_ampm') {
    const match = SAM_ROHDE_PATTERN.exec(text)
    if (!match) return null
    const [, digits, monthStr, dayStr, hourStr, ampm] = match
    let hour24 = parseInt(hourStr, 10) % 12
    if (ampm.toLowerCase() === 'pm') hour24 += 12
    return resolveDatesFromParts(digits, parseInt(monthStr, 10), parseInt(dayStr, 10), hour24)
  }

  if (senderConfig.style === 'raw_24h') {
    const match = DAREN_PEET_PATTERN.exec(text)
    if (!match) return null
    const [, digits, monthStr, dayStr, rawTime] = match
    const mm = rawTime.slice(-2)
    const hh = rawTime.length === 3 ? rawTime.slice(0, 1) : rawTime.slice(0, 2)
    const hour24 = parseInt(hh, 10)
    if (parseInt(mm, 10) !== 0) return null
    return resolveDatesFromParts(digits, parseInt(monthStr, 10), parseInt(dayStr, 10), hour24)
  }

  return null
}

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
    return null
  }
}

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

async function createPendingSubmission({ conversationId, project, dockDoor, reference, neededBy, scheduledArrival, senderLabel }) {
  const appointmentCode = `(${PALERMO_ABBR}) - ${reference}`
  const notes = `Auto-parsed from ${senderLabel} email — needed by ${formatDisplayDatetime(neededBy)}, appointment scheduled ${LEAD_TIME_HOURS} hours prior. Please verify all fields before pushing to Datex.`
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

async function processMessage(message, senderConfig) {
  const messageId = message.id
  const subject = message.subject || ''
  const senderHandle = senderConfig.sender
  log('processMessage: start', messageId, senderHandle)

  if (await alreadyProcessed(messageId)) {
    log('processMessage: already processed, skipping', messageId)
    return { messageId, outcome: 'skipped_already_processed' }
  }

  const text = getMessageText(message)
  const parsed = parseBody(text, senderConfig)

  if (!parsed) {
    log('processMessage: parse_failed', messageId)
    await logAttempt({ front_message_id: messageId, sender: senderHandle, subject, outcome: 'parse_failed' })
    return { messageId, outcome: 'parse_failed' }
  }

  const { reference, neededBy, scheduledArrival } = parsed
  log('processMessage: parsed', reference, neededBy, '->', scheduledArrival)
  const conversationId = await getConversationId(message).catch(() => null)

  let order
  try {
    order = await lookupOrder(reference)
  } catch (err) {
    console.error('[auto-appt-parse] lookupOrder threw:', err.message)
    await logAttempt({
      front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
      matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival,
      outcome: 'error', error_detail: `Order lookup failed: ${err.message}`,
    })
    return { messageId, outcome: 'error', error: err.message }
  }

  if (!order) {
    log('processMessage: order_not_found', reference)
    await logAttempt({
      front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
      matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival, outcome: 'order_not_found',
    })
    return { messageId, outcome: 'order_not_found', reference }
  }

  if (order.owner_name !== PALERMO_OWNER_NAME) {
    log('processMessage: owner_mismatch', reference, order.owner_name)
    await logAttempt({
      front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
      matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival, outcome: 'owner_mismatch',
      owner_name: order.owner_name, project_name: order.project_name,
    })
    return { messageId, outcome: 'owner_mismatch', reference, foundOwner: order.owner_name }
  }

  const dockDoorRules = await getDockDoorRules()
  const dockDoor = findDockDoorRule(CAL_WAREHOUSE, order.project_name, 'Outbound', dockDoorRules)
  const laborWarning = await checkLabor(CAL_WAREHOUSE, scheduledArrival)

  let submission
  try {
    submission = await createPendingSubmission({
      conversationId, project: order.project_name, dockDoor, reference, neededBy, scheduledArrival, senderLabel: senderHandle,
    })
  } catch (err) {
    console.error('[auto-appt-parse] createPendingSubmission threw:', err.message)
    await logAttempt({
      front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
      matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival, outcome: 'error',
      owner_name: order.owner_name, project_name: order.project_name,
      error_detail: `Submission creation failed: ${err.message}`,
    })
    return { messageId, outcome: 'error', error: err.message }
  }

  log('processMessage: pending_created', reference, submission?.id)
  await logAttempt({
    front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
    matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival, outcome: 'pending_created',
    submission_id: submission?.id || null, owner_name: order.owner_name, project_name: order.project_name,
    labor_warning: laborWarning,
  })

  return { messageId, outcome: 'pending_created', reference, submissionId: submission?.id }
}

async function runScan() {
  log('runScan: starting')
  try {
    const eligible = await fetchRecentEligibleMessages()
    const results = []
    for (const { message, senderConfig } of eligible) {
      results.push(await processMessage(message, senderConfig))
    }
    log('runScan: complete, results =', JSON.stringify(results))
    return results
  } catch (err) {
    console.error('[auto-appt-parse] runScan THREW:', err.message, err.stack?.slice(0, 1000))
    throw err
  }
}

module.exports = {
  CAL_CHANNEL_ID,
  ELIGIBLE_SENDER_PATTERNS,
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
