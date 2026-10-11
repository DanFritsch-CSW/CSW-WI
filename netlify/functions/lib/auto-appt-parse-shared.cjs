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
//
// FIXED 2026-09-05 (later same day) — the first real tick after the
// inbox-scoped redesign confirmed page 1 worked (200, 50 conversations —
// real backlog exists), then threw a generic "fetch failed" TypeError on
// page 2. Root cause: Front's pagination `next` link is an
// ALREADY-ABSOLUTE URL on a company-specific subdomain
// (central-storage-and-warehouse-co.api.frontapp.com), not the generic
// api2.frontapp.com host used for the initial request. The old code
// tried to strip a hardcoded api2.frontapp.com prefix off that URL
// (never matched) and re-prepend it in frontFetch, producing a garbage
// double-URL. frontFetch now detects an already-absolute URL and uses it
// as-is. Also restructured fetchRecentEligibleMessages to check
// eligibility PER PAGE and advance the watermark only after a page's
// conversations are FULLY evaluated (not just listed) — with a real
// backlog this large, the per-conversation message-fetch calls needed
// for eligibility checking could plausibly exceed Netlify's 26s timeout,
// and advancing the watermark too early (right after listing, before
// checking) would risk silently losing a real message if that happened.
//
// MAJOR REDESIGN 2026-10-10 — Phase 1/2 of building toward full
// no-human-intervention automation for these two senders:
//
// BUG FOUND: this function's own order lookup had been silently failing
// on literally every message since the 2026-09-05 redesign — 444 attempts
// logged in auto_appt_attempts, 0 ever matched a real order. Root cause:
// resolveDatesFromParts() built `reference = "TO" + digits` and that
// prefixed string was fed straight into lookupOrder's exact-match SQL,
// but Datex stores these references WITHOUT the "TO" prefix (confirmed
// directly against production_db.silver.datex_slv_orders — e.g. email
// "TO470534" / Datex owner_reference "470534"). Every order Sam Rohde and
// Daren Peet had ever referenced genuinely existed; this function was
// just never going to find it. Fixed by using the bare digits everywhere.
//
// ARCHITECTURE CHANGE: now that scheduling_agent (see
// scheduling-agent-webhook, the Front External AI Agent built 2026-10-10)
// fires on every inbound message to the CAL Appointments inbox regardless
// of sender, it was ALREADY creating its own pending submission for every
// Sam Rohde / Daren Peet email in parallel with this function's own
// createPendingSubmission() call — two competing submissions per email.
// This function no longer creates a submission at all. Instead it finds
// scheduling_agent's own submission (via findAgentSubmission, matched on
// front_conversation_id) and GRADES it: runs the same independently-
// computed order lookup / dock-door-rule / labor-check this function
// always did, logs the comparison to auto_appt_attempts (new columns:
// agent_submission_id, agent_scheduled_arrival, agent_dock_door,
// recommended_dock_door, match_status, actual_*, compared_at), and waits.
// scheduling-push-to-datex-background.cjs fills in the actual_* columns
// and sets match_status once a CSR actually approves that submission —
// that comparison (what the agent would have auto-pushed vs. what a human
// approved) is the real-world evidence Dan wants before flipping Sam
// Rohde + Daren Peet to live auto-push with no human review at all. Target
// per Dan: 99%+ confidence, meaning effectively zero mismatches across a
// large enough sample (not a quick clean streak) before going live. See
// Dan's "Sam Rohde automation" / "Palermo's full automation" notes.
//
// createPendingSubmission() is retired (left unused below, not deleted,
// in case this needs to revert) — this function's job now is validation
// and grading, not creation.
//
// TEST ADDRESS ADDED 2026-10-10 (same day): d_fritsch21@hotmail.com,
// style 'either' — Dan's own address, so he can resend real Sam/Daren
// emails verbatim to generate shadow-validation test runs without
// waiting on live customer traffic. Counts toward the live confidence
// tally (his call, not excluded).
//
// SIGNATURE-BOX GATE ADDED 2026-10-10 (same day, Dan's rule): the test
// address can ALSO be used to test a generic "some other carrier"
// scenario that scheduling_agent's own generic path should handle
// normally — this pilot must stay out of the way for those. The signal
// Dan chose: whether the email carries Sam's or Daren's own signature
// block (hasPalermoSignature — checks for their names in the stripped
// body text). Present → treated as a Sam/Daren-style test, full 3-hour
// lead-time treatment. Absent → skipped entirely here (not logged to
// auto_appt_attempts at all, same as any other non-matching sender) so
// it's left purely to scheduling_agent. Real Sam/Daren senders don't need
// this check — their own address already proves identity.
//
// FIELD-BACKFILL ADDED 2026-10-10, MOVED TO WEBHOOK same day: Dan's
// "grading, not creating" redesign earlier today left a real gap —
// scheduling_agent's own generic extraction has no idea Warehouse/Type/
// Owner/Project/Dock Door/Carrier are structurally constant for these two
// senders, and no idea the 3-hour lead-time rule exists at all.
// backfillAgentSubmission() (still defined below, exported, UNUSED as of
// this move) originally PATCHed this correction onto scheduling_agent's
// submission from this file's own 15-minute cron tick — which worked, but
// meant a CSR opening the thread before that next tick saw the agent's
// uncorrected first guess for up to 15 minutes, confirmed live twice
// (cnv_1cm5cxg4/TO471153, cnv_1cm5f0r8/TO470285 — both still showed Type
// "Inbound", blank Project/Owner/Dock Door/Carrier, and an un-adjusted
// arrival time when checked under a minute after the submission was
// created). Dan asked to fix the lag itself, not just paper over it:
// scheduling-agent-webhook now applies the identical correction (same
// hardcoded constants, same regex + lead-time math, kept in sync) at
// write time, before the write AND before the confirmation comment, so
// both are right immediately — no cron dependency at all. The function
// here is left in place, unused, in case this needs reverting.

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

// Structurally constant for every Sam/Daren email -- never stated in the
// body, always the same regardless of which PO is referenced. Confirmed
// 2026-10-10 via live MotherDuck query (owner/project) and Dan's real
// example (cnv_1cm5cxg4, order 471161 -- dock door and carrier read
// directly off that submission). See backfillAgentSubmission's header
// note for why these are asserted here instead of left to extraction.
const PALERMO_PROJECT_NAME = 'Palermos CALEDONIA materials bulk'
const PALERMO_PROJECT_DATEX_ID = 8
const PALERMO_OWNER_DATEX_ID = 704
const PALERMO_DOCK_DOOR = 'OUTBOUND PALERMO'
const PALERMO_CARRIER_NAME = 'CMM'
const PALERMO_CARRIER_DATEX_ID = 8170 // confirmed via scheduling_carriers: 7,194 historical appointments -- clearly the real one, not the near-zero "ZZ-CMM" placeholder variants in the same table

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
  // Dan's own test address -- added 2026-10-10 so he can resend real
  // Sam/Daren emails verbatim to generate shadow-validation test runs
  // without waiting on live customer traffic. Matches EITHER format
  // (style: 'either'), since he may copy either sender's wording. Counts
  // toward the live confidence tally (Dan's explicit call) -- not
  // excluded or tracked separately.
  { sender: 'd_fritsch21@hotmail.com', pattern: null, style: 'either' },
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

async function frontFetch(pathOrUrl, options) {
  // Front's pagination `next` links come back as ALREADY-ABSOLUTE URLs on
  // a company-specific subdomain (e.g.
  // central-storage-and-warehouse-co.api.frontapp.com), NOT the generic
  // api2.frontapp.com host used for the initial request. FIXED 2026-09-05
  // after this caused a "fetch failed" TypeError on every page 2+: the
  // old code tried to strip a hardcoded "https://api2.frontapp.com"
  // prefix off the next URL (which never matched) and then re-prepended
  // it in the fetch() call below, producing a garbage double-URL like
  // "https://api2.frontapp.comhttps://central-storage-and-warehouse-co...".
  // Now: if what's passed in is already an absolute URL, use it as-is;
  // only prepend the generic host for a relative path.
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api2.frontapp.com${pathOrUrl}`
  log('frontFetch ->', url)
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, Accept: 'application/json', ...(options?.headers || {}) },
  })
  log('frontFetch <-', url, 'status', res.status)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[auto-appt-parse] frontFetch FAILED', url, res.status, text.slice(0, 500))
    throw new Error(`Front API ${url} -> ${res.status}: ${text.slice(0, 300)}`)
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
//
// RESTRUCTURED 2026-09-05 to process eligibility PER PAGE rather than
// collecting all pages first and checking eligibility in one big batch
// afterward. With a real backlog (first page alone returned a full 50
// conversations, with more to go), the per-conversation message-fetch
// calls needed for eligibility checking add up fast, and Netlify's
// function timeout (26s) is a real constraint. Advancing the watermark
// only after a page's conversations have been FULLY evaluated (not just
// fetched) means: if a later page or a later eligibility check times out
// mid-run, nothing already processed gets silently skipped (the
// watermark only ever reflects fully-checked ground) AND nothing gets
// needlessly re-fetched next run (already-checked pages don't get
// re-listed). The alternative -- advancing the watermark right after
// LISTING a page, before checking its conversations for eligibility --
// would risk silently losing a real Sam/Daren message if eligibility
// checking timed out before reaching it.
async function fetchRecentEligibleMessages() {
  log('fetchRecentEligibleMessages: starting (inbox-scoped)')
  const watermarkSeconds = await getWatermarkSeconds()
  let sinceSeconds = watermarkSeconds ?? Math.floor(Date.now() / 1000) - WATERMARK_LOOKBACK_HOURS * 3600
  log('fetchRecentEligibleMessages: sinceSeconds =', sinceSeconds, '(watermark was', watermarkSeconds, ')')

  const eligible = []
  let path = `/inboxes/${CAL_INBOX_ID}/conversations?limit=50`
  let pagesFetched = 0

  while (path && pagesFetched < MAX_PAGES) {
    const data = await frontFetch(path)
    const pageConvos = data._results || []
    log(`page ${pagesFetched + 1}: fetched ${pageConvos.length} conversations`)
    pagesFetched++

    const newOnPage = pageConvos.filter((c) => (c.created_at ?? 0) > sinceSeconds)
    log(`page ${pagesFetched}: ${newOnPage.length} new (post-watermark) conversations`)

    for (const convo of newOnPage) {
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
      // Sort-order-agnostic: take the message with the smallest
      // created_at rather than assuming a particular order, since a
      // brand-new conversation won't have enough messages for this to
      // be expensive.
      const firstMessage = msgList.reduce((earliest, m) =>
        (m.created_at ?? Infinity) < (earliest.created_at ?? Infinity) ? m : earliest
      )
      if (!firstMessage.is_inbound) {
        log('conversation', convo.id, 'first message is not inbound, skipping')
        continue
      }
      const fromHandle = (firstMessage.recipients || []).find((r) => r.role === 'from')?.handle?.toLowerCase()
      log('conversation', convo.id, 'first message from handle:', fromHandle)
      if (fromHandle) {
        const match = ELIGIBLE_SENDER_PATTERNS.find((p) => p.sender === fromHandle)
        if (match) {
          // Dan's test address: only pull this pilot in when the message
          // carries Sam's or Daren's signature -- otherwise it's a
          // generic test of some other carrier and should be invisible
          // here (see header note on hasPalermoSignature).
          if (match.sender === 'd_fritsch21@hotmail.com' && !hasPalermoSignature(getMessageText(firstMessage))) {
            log('conversation', convo.id, 'test address, no Sam/Daren signature -- generic test, skipping pilot')
            continue
          }
          eligible.push({ message: firstMessage, senderConfig: match, conversationId: convo.id })
        }
      }
    }

    // This page's conversations are now FULLY evaluated (fetched +
    // eligibility-checked) -- safe to advance the watermark to this
    // page's newest created_at. If this run times out or errors on a
    // LATER page, this progress is preserved for the next run rather
    // than being silently lost or repeated.
    if (pageConvos.length > 0) {
      const pageNewest = pageConvos.reduce((max, c) => Math.max(max, c.created_at ?? 0), sinceSeconds)
      if (pageNewest > sinceSeconds) {
        await setWatermarkSeconds(pageNewest)
        sinceSeconds = pageNewest
      }
    }

    // Conversations are newest-first (same convention as every other
    // Front list endpoint in this app). Stop once this page's oldest
    // conversation is at or before the (possibly just-advanced) watermark.
    const oldestOnPage = pageConvos[pageConvos.length - 1]
    if (!oldestOnPage || (oldestOnPage.created_at ?? 0) <= sinceSeconds) {
      log('stopping pagination: reached watermark or empty page')
      break
    }

    path = data._pagination?.next || null
    if (!path) log('stopping pagination: no next page URL')
  }

  log('fetchRecentEligibleMessages: eligible (matched sender on first message) =', eligible.length)
  return eligible
}

// Dan's test address (d_fritsch21@hotmail.com) sends two kinds of test
// email: a copy of a real Sam/Daren-style email (should get the 3-hour
// lead-time treatment, same as the real thing) or a generic test of some
// OTHER carrier's scenario (should be invisible to this pilot entirely --
// no shadow grading, no lead-time assumption -- and left for
// scheduling_agent's own generic path to handle like any other email).
// Dan's rule, 2026-10-10: the signature block is the signal. Real
// Sam/Daren senders don't need this check -- their own address already
// proves identity.
const PALERMO_SIGNATURE_NAMES = [/sam\s+rohde/i, /daren\s+peet/i]
function hasPalermoSignature(text) {
  return PALERMO_SIGNATURE_NAMES.some((re) => re.test(text))
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
  // FIXED 2026-10-10: Datex stores this reference WITHOUT a "TO" prefix
  // (see header note). Bare digits match both lookupOrder's SQL and the
  // CSR's own order-search box.
  const reference = digits
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
  // 'either' (Dan's test address) tries both formats in turn, since he may
  // copy either sender's wording verbatim into a test email.
  if (senderConfig.style === 'needed_ampm' || senderConfig.style === 'either') {
    const match = SAM_ROHDE_PATTERN.exec(text)
    if (match) {
      const [, digits, monthStr, dayStr, hourStr, ampm] = match
      let hour24 = parseInt(hourStr, 10) % 12
      if (ampm.toLowerCase() === 'pm') hour24 += 12
      return resolveDatesFromParts(digits, parseInt(monthStr, 10), parseInt(dayStr, 10), hour24)
    }
    if (senderConfig.style === 'needed_ampm') return null
  }

  if (senderConfig.style === 'raw_24h' || senderConfig.style === 'either') {
    const match = DAREN_PEET_PATTERN.exec(text)
    if (match) {
      const [, digits, monthStr, dayStr, rawTime] = match
      const mm = rawTime.slice(-2)
      const hh = rawTime.length === 3 ? rawTime.slice(0, 1) : rawTime.slice(0, 2)
      const hour24 = parseInt(hh, 10)
      if (parseInt(mm, 10) !== 0) return null
      return resolveDatesFromParts(digits, parseInt(monthStr, 10), parseInt(dayStr, 10), hour24)
    }
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

// Finds scheduling_agent's own submission for this conversation, so this
// function can grade it instead of creating a competing one. One
// submission per conversation is the expectation (scheduling_agent's
// Front rule fires only on a conversation's first inbound message).
async function findAgentSubmission(conversationId) {
  if (!conversationId) return null
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/submissions?front_conversation_id=eq.${encodeURIComponent(conversationId)}&select=id,scheduled_arrival,scheduled_dock_door,status,reference_number,project,owner&limit=1`,
    { headers: sbHeaders() }
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[auto-appt-parse] findAgentSubmission FAILED', res.status, text.slice(0, 300))
    return null
  }
  const rows = await res.json()
  return rows?.[0] || null
}

// Dan's rule, 2026-10-10: Warehouse, Type, Owner, Project, Dock Door and
// Carrier are structurally CONSTANT for every Sam/Daren email -- never
// stated in the body, always the same regardless of which PO is
// referenced. The lead-time-adjusted Arrival time is also fully
// deterministic once the email is correctly parsed (resolveDatesFromParts
// already does the -3hr math reliably). scheduling_agent's own generic
// extraction has no way to know any of this: Dan's first live test
// (cnv_1cm5cxg4) came back with Type "Inbound" (wrong), Project/Owner/
// Dock Door/Carrier blank, and the raw "needed by" time used AS the
// arrival time -- the 3-hour lead-time rule never applied at all, because
// that rule only ever lived in this file, and this file stopped writing
// anything once it became a grader instead of a creator (see the earlier
// 2026-10-10 architecture-change header note). This function takes all of
// that back over on scheduling_agent's own submission, independent of
// whether the Datex order lookup below succeeds -- none of these fields
// depend on that. Only touches a submission still at 'pending' (the
// PATCH's own WHERE clause is the real guard, not just this status read)
// so it never overwrites something a CSR has already started working on.
//
// KNOWN GAP: scheduling_agent's Front confirmation comment (posted the
// moment the email arrives) will still show its own wrong first guess --
// this function runs on the next 15-minute tick after that, and only
// corrects the Supabase row, not the already-posted comment. A CSR
// reading the thread before opening the Scheduling tab could see stale
// info for a few minutes. Not fixed here; flagged for Dan to decide if
// it's worth moving this logic into scheduling-agent-webhook itself for
// immediate consistency.
async function backfillAgentSubmission(submission, { reference, scheduledArrival }) {
  if (submission.status !== 'pending') {
    log('backfillAgentSubmission: submission', submission.id, 'no longer pending (', submission.status, ') -- not touching it')
    return
  }
  const fields = {
    warehouse: CAL_WAREHOUSE,
    type: APPT_TYPE,
    owner: PALERMO_OWNER_NAME,
    owner_datex_id: PALERMO_OWNER_DATEX_ID,
    project: PALERMO_PROJECT_NAME,
    project_datex_id: PALERMO_PROJECT_DATEX_ID,
    scheduled_dock_door: PALERMO_DOCK_DOOR,
    carrier: PALERMO_CARRIER_NAME,
    carrier_datex_id: PALERMO_CARRIER_DATEX_ID,
    scheduled_arrival: scheduledArrival,
    reference_number: reference,
    appointment_lookup_code: `(${PALERMO_ABBR}) - ${reference}`,
  }
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(submission.id)}&status=eq.pending`,
    { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(fields) }
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[auto-appt-parse] backfillAgentSubmission FAILED', res.status, text.slice(0, 300))
  } else {
    log('backfillAgentSubmission OK', submission.id)
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

  // Find and take over scheduling_agent's own submission FIRST, before the
  // order lookup below -- none of Warehouse/Type/Owner/Project/Dock Door/
  // Carrier/Arrival depend on confirming the order exists. See
  // backfillAgentSubmission's header note.
  const agentSubmission = await findAgentSubmission(conversationId)
  if (!agentSubmission) {
    log('processMessage: agent_missing', reference, conversationId)
    await logAttempt({
      front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
      matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival, outcome: 'agent_missing',
    })
    return { messageId, outcome: 'agent_missing', reference }
  }
  // backfillAgentSubmission() is NOT called here anymore -- see 2026-10-10
  // header note (MOVED TO WEBHOOK). scheduling-agent-webhook now applies
  // this correction immediately at write time, so by the time this scan
  // runs, agentSubmission already has the right fields unless a CSR has
  // since edited it. The function itself is left defined/exported below
  // in case this needs reverting.

  let order
  try {
    order = await lookupOrder(reference)
  } catch (err) {
    console.error('[auto-appt-parse] lookupOrder threw:', err.message)
    await logAttempt({
      front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
      matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival,
      agent_submission_id: agentSubmission.id,
      outcome: 'error', error_detail: `Order lookup failed: ${err.message}`,
    })
    return { messageId, outcome: 'error', error: err.message }
  }

  if (!order) {
    log('processMessage: order_not_found', reference)
    await logAttempt({
      front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
      matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival, outcome: 'order_not_found',
      agent_submission_id: agentSubmission.id,
    })
    return { messageId, outcome: 'order_not_found', reference }
  }

  if (order.owner_name !== PALERMO_OWNER_NAME) {
    log('processMessage: owner_mismatch', reference, order.owner_name)
    await logAttempt({
      front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
      matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival, outcome: 'owner_mismatch',
      owner_name: order.owner_name, project_name: order.project_name,
      agent_submission_id: agentSubmission.id,
    })
    return { messageId, outcome: 'owner_mismatch', reference, foundOwner: order.owner_name }
  }

  // Dock door is now a hardcoded constant (see PALERMO_DOCK_DOOR) rather
  // than looked up dynamically -- findDockDoorRule/getDockDoorRules remain
  // defined/exported below for any future sender that genuinely needs
  // per-project dock-door resolution, just unused by this pilot now.
  const laborWarning = await checkLabor(CAL_WAREHOUSE, scheduledArrival)

  log('processMessage: shadow_logged', reference, agentSubmission.id)
  await logAttempt({
    front_message_id: messageId, front_conversation_id: conversationId, sender: senderHandle, subject,
    matched_reference: reference, needed_by: neededBy, parsed_arrival: scheduledArrival, outcome: 'shadow_logged',
    owner_name: order.owner_name, project_name: order.project_name,
    agent_submission_id: agentSubmission.id,
    agent_scheduled_arrival: scheduledArrival,
    agent_dock_door: PALERMO_DOCK_DOOR,
    recommended_dock_door: PALERMO_DOCK_DOOR,
    labor_warning: laborWarning,
    match_status: 'pending_outcome',
  })

  return { messageId, outcome: 'shadow_logged', reference, agentSubmissionId: agentSubmission.id }
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
  findAgentSubmission,
  backfillAgentSubmission,
  runScan,
}
