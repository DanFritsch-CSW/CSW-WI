'use strict'

// Shared logic for the Automated Appointment Creation pilot (Palermo's /
// Sam Rohde + Daren Peet) — added 2026-08-22, MAJOR REDESIGN 2026-09-05.
//
// Scope, per Dan's explicit "tread lightly" framing:
//   - CAL Appointments inbox (inb_aut78) only. Anything that doesn't
//     match both a known sender AND that sender's exact expected body
//     pattern is left alone — no partial guesses, no fuzzy matching.
//   - NEVER pushes to Datex. Creates a 'pending' submissions row only —
//     the existing human-approval flow in PluginView.jsx (Single APPT
//     tab) picks it up exactly like a manually-entered draft. The CSR
//     still clicks Approve & Push themselves.
//   - Every attempt is logged to auto_appt_attempts regardless of
//     outcome, reviewed via a daily digest comment (see
//     auto-appt-review-digest-run.cjs) — this is the audit trail Dan
//     wants before ever considering full automation.
//
// ROOT-CAUSE FOUND 2026-09-05, after this function ran on schedule for
// roughly two weeks and never once wrote its own watermark or logged a
// single attempt, despite confirmed real emails sitting in the inbox the
// whole time. Diagnostic logging added earlier that day showed the exact
// failure on the very first network call, every single run:
//   GET /channels/cha_ema1g/messages -> 404 "No such route."
// That endpoint never existed in Front's API. This function was built on
// a call that was invalid from the day it was written — not a timing
// issue, not a permissions issue, not a deploy issue (all three were
// separately ruled out first: RLS confirmed off on `settings`, anon role
// confirmed to have full INSERT/UPDATE grants, a direct SQL upsert into
// settings succeeded instantly, and the Front API token was confirmed to
// have explicit "Read and Write Channels" scope). The lesson: an
// integration call this central to the whole feature should have been
// verified against a live response before anything was built on top of
// it, the same way SQL against MotherDuck is verified elsewhere in this
// app — that didn't happen here, and it cost real time to find.
//
// SECOND DISCOVERY the same day, while confirming the real fix: pulling
// an actual Daren Peet conversation (cnv_1cbj9u8k) directly showed his
// messages arrive via a `custom_channel` origin, NOT the office365
// channel (cha_ema1g) Sam Rohde's mail comes through. Even a working fix
// to the old channel-scoped design would NEVER have caught Daren's
// messages — they don't arrive on that channel at all. This is why the
// whole fetch layer is now scoped to the INBOX (inb_aut78, "CAL
// Appointments") rather than any single channel — an inbox can receive
// messages through multiple channel types, which is exactly what's
// happening here.
//
// THIRD DISCOVERY, reading that same conversation's full history: the
// original request ("3am urgent, same day") was renegotiated hours later
// through ordinary back-and-forth replies into a completely different
// time ("ready at 0500 Tuesday") — with no second parseable email, just
// human conversation. Flagged to Dan directly; his answer: only ever act
// on a conversation's FIRST message, and accept that a conversation which
// gets renegotiated afterward may produce a stale pending draft. This is
// an acceptable tradeoff specifically BECAUSE human review is already
// mandatory before anything reaches Datex — a stale draft is a starting
// point for the CSR to correct or discard, not a live appointment.
//
// REDESIGNED FETCH LAYER: scans conversations in the CAL Appointments
// inbox (not any single channel), watermarked and paginated by
// conversation created_at (Unix seconds, matching Front's convention) —
// so a NEW conversation's arrival is what advances the watermark, not
// message-level chatter within existing conversations. For each new
// conversation, fetches its messages and identifies the EARLIEST one by
// created_at (sort-order-agnostic, since a brand-new conversation won't
// have more than a handful of messages) and evaluates ONLY that message
// against the sender/pattern rules — never anything later in the thread.
//
// OPEN RISK, not yet resolved: Daren Peet's messages arrive via
// custom_channel, and the exact shape of the "from" sender identifier on
// that channel type hasn't been independently confirmed (the visible
// content looks like a forwarded/relayed structure with embedded "From:"
// lines inside the body text, which raises a real question of whether
// Front's own recipients/handle field for these messages will cleanly
// read as da.peet@palermospizza.com, or something else — a phone number,
// a relay identity, etc.). Sam Rohde's pattern is unaffected (confirmed
// office365/email channel, clean sender handles). Left in place as-is
// rather than guessing further; if Daren's messages don't match, the
// diagnostic logging below will show exactly what handle was actually
// seen, which is the fastest way to confirm or correct this.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN || ''

const CAL_INBOX_ID = 'inb_aut78' // CAL Appointments inbox -- confirmed 2026-09-05 (cha_ema1g's own inbox_id, and where both Sam Rohde's and Daren Peet's conversations live per direct Front search)
const PALERMO_OWNER_NAME = 'Palermo Villa, Inc.' // confirmed via live MotherDuck query before writing this, not guessed
const CAL_WAREHOUSE = 'CSW-Franksville' // this app's canonical CAL warehouse name (see WAREHOUSE_MAP in pluginUtils.js)
const APPT_TYPE = 'Outbound' // every observed order from either sender is an Outbound Sales Order in Datex
const LEAD_TIME_HOURS = 3 // appointment is scheduled this many hours BEFORE the "needed by"/stated time -- confirmed with Dan for BOTH senders' formats

const WATERMARK_SETTINGS_KEY = 'auto_appt_scan_watermark'
const WATERMARK_LOOKBACK_HOURS = 24 // first-ever run default -- see header note
const MAX_PAGES = 10 // safety cap on the conversation-list pagination: 10 * 50 = 500 new conversations per run

// Sam Rohde: "TO446013 - 8/20 (needed 3pm)". Deliberately strict -- no
// fuzzy variations attempted. Confirmed office365 channel, clean handle.
const SAM_ROHDE_PATTERN = /\bTO(\d{5,7})\s*-\s*(\d{1,2})\/(\d{1,2})\s*\(\s*needed\s*(\d{1,2})\s*(am|pm)\s*\)/i

// Daren Peet: "TO_447991 Print Transfer Status 8/24 1700". Requires the
// literal "Print Transfer Status" phrase to stay strict. Arrives via
// custom_channel -- see header note on the unresolved sender-handle risk.
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

// Scans the CAL Appointments INBOX (not a single channel -- see header
// note) for conversations CREATED since the watermark, paginating
// forward as needed. For each new conversation, fetches its messages and
// evaluates ONLY the earliest one -- per Dan's explicit direction, this
// pilot acts purely on a conversation's first message, regardless of any
// negotiation that happens afterward.
async function fetchRecentEligibleMessages() {
  log('fetchRecentEligibleMessages: starting (inbox-scoped)')
  const watermarkSeconds = await getWatermarkSeconds()
  const sinceSeconds = watermarkSeconds ?? Math.floor(Date.now() / 1000) - WATERMARK_LOOKBACK_HOURS * 3600
  log('fetchRecentEligibleMessages: sinceSeconds =', sinceSeconds, '(watermark was', watermarkSeconds, ')')

  let allConversations = []
  let path = `/inboxes/${CAL_INBOX_ID}/conversations?limit=50`
  let pagesFetched = 0

  while (path && pagesFetched < MAX_PAGES) {
    const data = await frontFetch(path)
    const pageConvos = data._results || []
    log(`page ${pagesFetched + 1}: fetched ${pageConvos.length} conversations`)
    allConversations.push(...pageConvos)
    pagesFetched++

    // Conversations are newest-first (same convention as every other
    // Front list endpoint in this app). Stop once this page's oldest
    // conversation is at or before the watermark.
    const oldestOnPage = pageConvos[pageConvos.length - 1]
    if (!oldestOnPage || (oldestOnPage.created_at ?? 0) <= sinceSeconds) {
      log('stopping pagination: reached watermark or empty page')
      break
    }

    const nextUrl = data._pagination?.next
    path = nextUrl ? nextUrl.replace('https://api2.frontapp.com', '') : null
    if (!path) log('stopping pagination: no next page URL')
  }

  log('fetchRecentEligibleMessages: total conversations collected =', allConversations.length)

  if (allConversations.length > 0) {
    const newestSeconds = allConversations.reduce((max, c) => Math.max(max, c.created_at ?? 0), sinceSeconds)
    await setWatermarkSeconds(newestSeconds)
  } else {
    log('fetchRecentEligibleMessages: allConversations is empty, skipping watermark write')
  }

  const newConvos = allConversations.filter((c) => (c.created_at ?? 0) > sinceSeconds)
  log('fetchRecentEligibleMessages: newConvos (after watermark filter) =', newConvos.length)

  const eligible = []
  for (const convo of newConvos) {
    let messagesData
    try {
      messagesData = await frontFetch(`/conversations/${convo.id}/messages?limit=50`)
    } catch (err) {
      console.error('[auto-appt-parse] failed to fetch messages for conversation', convo.id, err.message)
      continue
    }
    const msgList = messagesData._results || []
    if (msgList.length === 0) {
      log('conversation', convo.id, 'has no messages, skipping')
      continue
    }
    // Sort-order-agnostic: take the message with the smallest created_at
    // rather than assuming a particular order, since a brand-new
    // conversation won't have enough messages for this to be expensive.
    const firstMessage = msgList.reduce((earliest, m) =>
      (m.created_at ?? Infinity) < (earliest.created_at ?? Infinity) ? m : earliest
    )
    if (!firstMessage.is_inbound) {
      log('conversation', convo.id, 'first message is not inbound, skipping')
      continue
    }
    const fromHandle = (firstMessage.recipients || []).find((r) => r.role === 'from')?.handle?.toLowerCase()
    log('conversation', convo.id, 'first message from handle:', fromHandle)
    if (!fromHandle) continue
    const match = ELIGIBLE_SENDER_PATTERNS.find((p) => p.sender === fromHandle)
    if (match) eligible.push({ message: firstMessage, senderConfig: match, conversationId: convo.id })
  }
  log('fetchRecentEligibleMessages: eligible (matched sender on first message) =', eligible.length)
  return eligible
}

function getMessageText(message) {
  if (message.text) return message.text
  if (message.body) return stripHtml(message.body)
  return ''
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
  const notes = `Auto-parsed from ${senderLabel} email (first message only) — needed by ${formatDisplayDatetime(neededBy)}, appointment scheduled ${LEAD_TIME_HOURS} hours prior. Please verify all fields before pushing to Datex, and check the conversation for any later replies that may have changed the plan.`
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

async function processMessage(message, senderConfig, conversationId) {
  const messageId = message.id
  const subject = message.subject || ''
  const senderHandle = senderConfig.sender
  log('processMessage: start', messageId, senderHandle, 'conversation', conversationId)

  if (await alreadyProcessed(messageId)) {
    log('processMessage: already processed, skipping', messageId)
    return { messageId, outcome: 'skipped_already_processed' }
  }

  const text = getMessageText(message)
  const parsed = parseBody(text, senderConfig)

  if (!parsed) {
    log('processMessage: parse_failed', messageId)
    await logAttempt({ front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject, outcome: 'parse_failed' })
    return { messageId, outcome: 'parse_failed' }
  }

  const { reference, neededBy, scheduledArrival } = parsed
  log('processMessage: parsed', reference, neededBy, '->', scheduledArrival)

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
    for (const { message, senderConfig, conversationId } of eligible) {
      results.push(await processMessage(message, senderConfig, conversationId))
    }
    log('runScan: complete, results =', JSON.stringify(results))
    return results
  } catch (err) {
    console.error('[auto-appt-parse] runScan THREW:', err.message, err.stack?.slice(0, 1000))
    throw err
  }
}

module.exports = {
  CAL_INBOX_ID,
  ELIGIBLE_SENDER_PATTERNS,
  PALERMO_OWNER_NAME,
  CAL_WAREHOUSE,
  LEAD_TIME_HOURS,
  fetchRecentEligibleMessages,
  alreadyProcessed,
  logAttempt,
  getMessageText,
  parseBody,
  lookupOrder,
  findDockDoorRule,
  getDockDoorRules,
  checkLabor,
  createPendingSubmission,
  runScan,
}
