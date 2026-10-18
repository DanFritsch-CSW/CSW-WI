'use strict'

// Automated Appointment Creation pilot — daily review digest, added
// 2026-08-22 per Dan's explicit "single Front discussion thread to post
// results daily" request. Originally posted a comment summarizing the
// last 24 hours of auto_appt_attempts activity to Dan's dedicated Front
// conversation (cnv_1c7dl7mc), so it was one continuous thread rather
// than a fresh discussion each day (unlike front-daily-discussion-run.cjs,
// which intentionally creates a NEW discussion per facility per day).
//
// Only runs when there was at least one attempt in the window — a quiet
// day (Sam Rohde didn't email) produces nothing at all, rather than a
// daily "nothing happened" noise post.
//
// UPDATED 2026-08-23: pending_created rows now show the needed-by ->
// appointment-time pair explicitly (e.g. "needed 3pm → appt 12pm"), so
// the lead-time adjustment (see lib/auto-appt-parse-shared.cjs) is
// visible at a glance in the review rather than hidden inside the
// submission itself.
//
// REDESIGNED 2026-10-10 — Phase 1/2 of the Sam Rohde / Daren Peet
// full-automation confidence build (see lib/auto-appt-parse-shared.cjs's
// header note for the full architecture). Two changes:
//
// 1. This digest used to just dump raw outcome buckets with bare reference
//    numbers and no context (e.g. "Order not found in Datex (22)" followed
//    by 22 bare TO-numbers) — accurate but useless at a glance. Every row
//    now reads as a plain sentence: what the email asked for, what the
//    system did or couldn't do, and why.
// 2. `pending_created` is retired (this function no longer creates its own
//    submission — see header note) in favor of `shadow_logged` (validated,
//    waiting on a CSR to approve scheduling_agent's own submission so the
//    outcome can be graded) and `agent_missing` (validation succeeded but
//    scheduling_agent never created a submission for this email — a real
//    gap worth seeing immediately, not just a funnel count). The digest
//    now leads with the CUMULATIVE confidence tally (matched/mismatched/
//    still-awaiting-outcome since the 2026-10-10 bug fix, not just today's
//    activity) — that running number, not any single day, is what Dan is
//    actually watching before flipping these two senders to live
//    auto-push with no human review (target: 99%+ confidence).
//
// FIXED 2026-10-11 (Dan's explicit direction, order-not-found gating):
// `order_not_found` used to be its own gating outcome in
// lib/auto-appt-parse-shared.cjs, which meant a row with no matching
// Datex order yet NEVER reached shadow_logged and so could never be
// graded — effectively treating "not in Datex yet" as a stop gap for the
// whole evaluation. Dan's point: the team schedules the appointment
// straight from the email regardless of whether the order exists in
// Datex yet (completely normal timing), and the real grading question is
// purely whether the agent populated every field correctly — the CSR's
// own edits before pushing are the signal that matters. The order lookup
// now runs as pure information: a miss is carried as `order_found: false`
// on the SAME shadow_logged row instead of blocking it. This digest
// reflects that — `order_not_found` is no longer a row scheduling_agent's
// own pipeline can newly produce (kept below only for any residual
// pre-fix historical rows, same treatment as `pending_created`), and
// `describeRow`'s shadow_logged branches append a short "order not yet in
// Datex" courtesy note when `order_found` is false, without excluding the
// row from the confidence tally in any way.
//
// CHANGED 2026-10-11 (Dan's explicit direction, delivery mechanism): a
// daily Front COMMENT into one long-lived thread (cnv_1c7dl7mc) replaced
// with a brand-new Front TASK every morning, assigned directly to Dan.
// Uses Front's native task-conversation support, added to the Core API
// 2026-06-02 (POST /conversations with type:'task' -- see
// https://dev.frontapp.com/reference/create-conversation): `teammate_ids`
// (not `inbox_id` -- the two are mutually exclusive on this endpoint) set
// to Dan's own teammate ID so the task lands directly in his task list,
// with no inbox involved, matching how "Dan's dedicated thread" worked
// before. The task's `subject` is the short date-stamped title (shown in
// task lists); the full confidence tally + per-row breakdown goes in the
// task's `description` field (shown immediately when the task is opened,
// up to 65,535 chars -- comfortably enough), not as a starter comment,
// since there's no need for a second copy of the same text. Each day is
// now its own standalone task rather than one entry in a running thread
// -- history lives in Front's own task list (done/archived tasks) instead
// of being scrollable in a single conversation. Dan Fritsch's teammate ID
// (tea_a3e8k) was looked up directly against Front's teammates list
// before writing this, not guessed. REVIEW_CONVERSATION_ID is retired
// (left undefined below is fine since nothing references it) -- the old
// thread itself is untouched and still exists in Front if ever needed.
//
// NOTE: this endpoint requires the `conversations:write` scope on
// FRONT_API_TOKEN, whereas the old comment-based approach only needed
// `comments:write`. If the token backing FRONT_API_TOKEN/FRONT_API_KEY
// predates this change and was scoped narrowly, the first live run may
// 403 until that scope is added in Front's API token settings -- flagged
// here rather than assumed, since this app has a real history of broken
// integration calls that were never verified live before being built on.
//
// ADDED 2026-10-13 (Dan's explicit request): a per-field confidence
// breakdown, same shape and same ten tracked fields as the app-wide
// Scheduling Agent Field Accuracy digest (lib/agent-accuracy-digest-
// shared.cjs) -- "Warehouse: 114/114 (100.0%)" etc. -- but scoped to just
// this pilot's three eligible senders (PALERMO_FIELD_SENDERS) instead of
// every scheduling_agent submission app-wide. Sourced from the SAME
// agent_field_accuracy table that digest reads (compareAgentFieldAccuracy
// in scheduling-push-to-datex-background.cjs writes one row there per
// graded submission, Palermo's included, via the sender_email column). No
// new table or write path -- this is purely a differently-filtered read
// of data that was already being collected. Expect Warehouse/Type/Owner/
// Project/Dock Door/Carrier to read at or near 100% here, since the
// Palermo's immediate override (see scheduling-agent-webhook's own header
// note) force-fills those six fields from hardcoded constants before the
// write for these senders -- the fields actually worth watching in this
// view are Arrival Date/Time (the lead-time math), Reference #, and
// Notes, which the override does NOT hardcode. Only covers submissions
// from 2026-10-11 onward (when agent_field_accuracy's sender_email
// column and the snapshot mechanism went live) -- same start date as the
// app-wide digest, not SHADOW_START_DATE above (which is one day earlier
// and predates this table).
//
// CHANGED 2026-10-18 (Dan's explicit request): the confidence headline and
// the cumulative-since-10/11 per-field block are replaced by a SINGLE-DAY
// view (today, America/Chicago) and a ROLLING 7-DAY view, shown side by
// side per field, plus a one-line "fully correct" figure for each and a
// day-by-day trend. Reason: the first two days of the pilot ran before the
// webhook override, lead-time and owner fixes landed (10/11-10/12), so a
// cumulative number can never reach the 99% bar no matter how well the
// agent does now. The old headline ("N/M graded appointments matched
// exactly") came from auto_appt_attempts.match_status, which flagged rows
// whose agent and CSR times printed identically as MISMATCH, so it read
// 0% regardless of reality; it is gone. Everything in the new view comes
// from agent_field_accuracy (one row per graded submission, per-field
// *_match booleans), bucketed by the America/Chicago calendar day of
// compared_at (the moment the CSR's final values were compared). "Fully
// correct" = every tracked field with a non-null *_match is true.
// describeRow's mismatch text now also shows the date, and the raw stored
// values when the short labels look identical, so whatever
// compareShadowOutcome() is actually tripping on becomes visible.
// Same day: Notes removed from FIELD_KEYS here (see that constant's note).
//
// QUIET DAYS + DELIVERY LOG 2026-10-18: postDigest now posts every night even
// when there were no attempts in the window (it used to return silently),
// posts a short "DIGEST FAILED" task if Front rejects the post, and logs
// every run to public.digest_runs (digest 'palermo-auto-appt-digest').
//
// Same run/test split as every other digest in this app.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

// Dan Fritsch's Front teammate ID -- confirmed 2026-10-11 via Front's own
// teammates list (dfritsch@csw-wi.com), not guessed. Used as the sole
// teammate_ids entry so the daily task lands directly in Dan's task list.
const DAN_TEAMMATE_ID = 'tea_a3e8k'

// The day the TO-prefix lookup bug was fixed. Everything before this is
// pre-fix noise (444 attempts, 0 real matches) — the cumulative confidence
// tally only makes sense starting from here.
const SHADOW_START_DATE = '2026-10-10T00:00:00Z'

// The ten fields agent_field_accuracy tracks per submission -- identical
// set and order to lib/agent-accuracy-digest-shared.cjs's FIELD_KEYS, kept
// in sync deliberately so the two digests read the same way. Appointment
// Code is left out here (unlike the app-wide digest) to match exactly
// what Dan asked for -- it has no independent accuracy story (see that
// file's header note) and would just add noise to a pilot-scoped view.
// Notes is ALSO left out (Dan's explicit call, 2026-10-18: not graded in
// this pilot digest), so this list is nine fields, not the app-wide ten --
// a Notes-only difference no longer counts against "fully correct" or
// shows in the per-field table. agent_field_accuracy still records it.
const FIELD_KEYS = [
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'type', label: 'Type' },
  { key: 'project', label: 'Project' },
  { key: 'owner', label: 'Owner' },
  { key: 'arrival_date', label: 'Arrival Date' },
  { key: 'arrival_time', label: 'Arrival Time' },
  { key: 'dock_door', label: 'Dock Door' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'reference', label: 'Reference #' },
]

// Same three addresses this pilot already tracks end-to-end (see
// senderLabel below) -- Sam, Daren, and Dan's own test sends. Dan's
// explicit 2026-10-10 call that his test runs count toward the live
// confidence tally rather than being broken out separately applies here
// too, for consistency with the existing match/mismatch tally.
const PALERMO_FIELD_SENDERS = ['s.rohde@palermospizza.com', 'da.peet@palermospizza.com', 'd_fritsch21@hotmail.com']

// agent_field_accuracy's sender_email column and snapshot mechanism only
// exist from 2026-10-11 onward -- see lib/agent-accuracy-digest-shared.cjs's
// header note. One day later than SHADOW_START_DATE above, which predates
// this table entirely.
const FIELD_ACCURACY_START_DATE = '2026-10-11T00:00:00Z'

const OUTCOME_LABELS = {
  shadow_logged: '🔎 Validated — waiting on CSR approval to grade',
  agent_missing: '🚨 Validated, but scheduling_agent never created an entry',
  order_not_found: '⚠️ Order not found in Datex', // retired 2026-10-11 as its own gating outcome -- kept for any residual pre-fix rows
  owner_mismatch: '⚠️ Reference matched, but wrong owner',
  parse_failed: '⚠️ Could not parse email format',
  error: '❌ Error during processing',
  pending_created: '✅ Pending — ready for review', // retired 2026-10-10, kept for any residual rows
}

async function fetchWindowAttempts() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/auto_appt_attempts?created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  if (!res.ok) throw new Error(`Supabase fetch failed: HTTP ${res.status}`)
  return res.json()
}

// Cumulative, since the fix — not a 24-hour window. This is the number
// Dan is actually watching to decide when to flip to live auto-push.
async function fetchConfidenceTally() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/auto_appt_attempts?match_status=not.is.null&created_at=gte.${encodeURIComponent(SHADOW_START_DATE)}&select=match_status`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  if (!res.ok) return null
  const rows = await res.json()
  const matched = rows.filter((r) => r.match_status === 'matched').length
  const mismatch = rows.filter((r) => r.match_status === 'mismatch').length
  const pending = rows.filter((r) => r.match_status === 'pending_outcome').length
  return { matched, mismatch, pending, compared: matched + mismatch }
}

// Cumulative per-field rows for this pilot's three eligible senders, since
// agent_field_accuracy started tracking sender_email. See header note.
async function fetchPalermoFieldAccuracy() {
  const senderList = PALERMO_FIELD_SENDERS.map((s) => encodeURIComponent(s)).join(',')
  // Only the last ~8 days are needed (today + rolling 7, with a day of slack
  // for the Chicago/UTC offset); never earlier than the table's start date.
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  const since = eightDaysAgo > FIELD_ACCURACY_START_DATE ? eightDaysAgo : FIELD_ACCURACY_START_DATE
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/agent_field_accuracy?sender_email=in.(${senderList})&compared_at=gte.${encodeURIComponent(since)}&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  if (!res.ok) return []
  return res.json()
}

function buildFieldTally(rows) {
  const tally = {}
  for (const { key } of FIELD_KEYS) tally[key] = { matched: 0, compared: 0 }
  for (const r of rows) {
    for (const { key } of FIELD_KEYS) {
      const matchVal = r[`${key}_match`]
      if (matchVal === null || matchVal === undefined) continue // field never stated by either side, or not tracked -- not counted as a comparison
      tally[key].compared++
      if (matchVal === true) tally[key].matched++
    }
  }
  return tally
}

function fmtFieldPct(matched, compared) {
  if (compared === 0) return 'no data yet'
  return `${matched}/${compared} (${((matched / compared) * 100).toFixed(1)}%)`
}

// America/Chicago calendar date ('YYYY-MM-DD') for an ISO timestamp / Date.
function centralDateStr(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
}

// Today (Central) plus the 6 days before it, newest first, as 'YYYY-MM-DD'.
// Built from the Central date string via UTC arithmetic so DST changes can
// never skip or repeat a day.
function lastNCentralDates(n) {
  const [y, m, d] = centralDateStr(new Date()).split('-').map(Number)
  const out = []
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10))
  return out
}

function mdLabel(ymd) {
  const [, m, d] = ymd.split('-').map(Number)
  return `${m}/${d}`
}

// A graded submission is "fully correct" when every tracked field that has a
// comparison (non-null *_match) matched. Rows with no comparable field at all
// return null and are left out of the count.
function rowFullyCorrect(r) {
  let compared = 0
  for (const { key } of FIELD_KEYS) {
    const v = r[`${key}_match`]
    if (v === null || v === undefined) continue
    compared++
    if (v !== true) return false
  }
  return compared > 0 ? true : null
}

function fullyCorrectTally(rows) {
  let ok = 0
  let total = 0
  for (const r of rows) {
    const v = rowFullyCorrect(r)
    if (v === null) continue
    total++
    if (v) ok++
  }
  return { ok, total }
}

// Today + rolling-7-day views over agent_field_accuracy rows. Returns null
// when there's nothing in the 7-day window at all.
function buildPeriodViews(fieldRows) {
  const dates = lastNCentralDates(7) // newest first
  const todayKey = dates[0]
  const windowSet = new Set(dates)
  const byDay = {}
  for (const k of dates) byDay[k] = []
  for (const r of fieldRows || []) {
    if (!r.compared_at) continue
    const k = centralDateStr(r.compared_at)
    if (windowSet.has(k)) byDay[k].push(r)
  }
  const todayRows = byDay[todayKey]
  const weekRows = dates.flatMap((k) => byDay[k])
  return { dates, byDay, todayKey, todayRows, weekRows }
}

function formatTimeShort(iso) {
  if (!iso || !iso.includes('T')) return null
  const hour24 = parseInt(iso.split('T')[1].split(':')[0], 10)
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  const ampm = hour24 < 12 ? 'am' : 'pm'
  return `${hour12}${ampm}`
}

function senderLabel(sender) {
  if (sender === 's.rohde@palermospizza.com') return 'Sam'
  if (sender === 'da.peet@palermospizza.com') return 'Daren'
  if (sender === 'd_fritsch21@hotmail.com') return 'Dan (test)'
  return sender || 'this sender'
}

// One plain-English sentence per attempt, instead of a bare reference
// number with no context. This is the thing a human actually reads.
function describeRow(r) {
  const ref = r.matched_reference || '(no reference parsed)'
  const who = senderLabel(r.sender)
  const project = r.project_name ? `Palermo's ${r.project_name}` : "Palermo's"
  const neededTxt = formatTimeShort(r.needed_by)
  const apptTxt = formatTimeShort(r.parsed_arrival)
  const timing = neededTxt && apptTxt ? `needed ${neededTxt} → scheduled ${apptTxt}` : null

  switch (r.outcome) {
    case 'shadow_logged': {
      // order_found:false is purely informational (2026-10-11, see header
      // note) -- it never changes which branch a row falls into below,
      // only adds a short courtesy note at the end.
      const orderNote = r.order_found === false ? ' (order not yet in Datex -- not a problem, just FYI)' : ''
      if (r.match_status === 'matched') {
        return `• ${ref} (${project}) — ${who} asked for ${timing || 'an appointment'}. CSR approved it exactly as predicted. ✅${orderNote}`
      }
      if (r.match_status === 'mismatch') {
        const bits = []
        if (r.agent_scheduled_arrival !== r.actual_scheduled_arrival) {
          const a = formatTimeShort(r.agent_scheduled_arrival) || '(none)'
          const c = formatTimeShort(r.actual_scheduled_arrival) || '(none)'
          const ad = r.agent_scheduled_arrival ? String(r.agent_scheduled_arrival).slice(0, 10) : ''
          const cd = r.actual_scheduled_arrival ? String(r.actual_scheduled_arrival).slice(0, 10) : ''
          // Same hour label but flagged anyway: show the date, and the raw
          // stored strings, so the real difference (date, timezone suffix,
          // seconds) is visible instead of "6am vs 6am".
          const same = a === c
          const dateTxt = ad && cd && ad !== cd ? ` [date ${ad} vs ${cd}]` : ''
          const rawTxt = same ? ` [raw: ${r.agent_scheduled_arrival} vs ${r.actual_scheduled_arrival}]` : ''
          bits.push(`agent had ${a}, CSR used ${c}${dateTxt}${rawTxt}`)
        }
        if (r.recommended_dock_door && r.recommended_dock_door !== r.actual_dock_door) {
          bits.push(`recommended dock ${r.recommended_dock_door}, CSR used ${r.actual_dock_door || '(none)'}`)
        }
        return `• ${ref} (${project}) — ⚠️ MISMATCH: ${bits.join('; ') || 'CSR changed something before approving — check the submission'}${orderNote}`
      }
      const laborTxt = r.labor_warning ? ` (${r.labor_warning})` : ''
      return `• ${ref} (${project}) — ${who} asked for ${timing || 'an appointment'}${laborTxt}. Waiting on CSR approval to grade.${orderNote}`
    }
    case 'agent_missing':
      return `• ${ref} (${project}) — order's real, ${who}'s email parsed fine, but scheduling_agent never created a pending entry for it. Needs a manual look.`
    case 'order_not_found': // retired 2026-10-11, residual pre-fix rows only -- see header note
      return `• ${ref} — ${who} referenced this, but it's not in Datex yet (likely not entered as an order yet, or a typo).`
    case 'owner_mismatch':
      return `• ${ref} — found in Datex, but under "${r.owner_name}" instead of Palermo's. Probably a coincidental reference-number collision.`
    case 'parse_failed':
      return `• ${who}'s email didn't match the expected format — subject: "${r.subject || '(no subject)'}"`
    case 'error':
      return `• ${ref || '(unparsed)'} — processing error: ${r.error_detail || 'unknown'}`
    case 'pending_created': // retired, residual rows only
      return `• ${ref} (${project}) — ${timing || 'scheduled'}${r.labor_warning ? ` (${r.labor_warning})` : ''}`
    default:
      return `• ${ref} — ${r.outcome}`
  }
}

// Returns { subject, description } for the daily task -- subject is the
// short date-stamped title shown in task lists, description is the full
// tally + per-row breakdown shown when the task is opened. Split out of
// a single joined string (the old comment-body shape) since a Front task
// has these as two separate fields.
function buildSummary(attempts, tally, fieldRows) {
  const today = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Chicago' })
  const subject = `Palermo's Auto-Scheduling — ${today}`
  const lines = []

  if (fieldRows) {
    const { dates, byDay, todayKey, todayRows, weekRows } = buildPeriodViews(fieldRows)
    const todayFc = fullyCorrectTally(todayRows)
    const weekFc = fullyCorrectTally(weekRows)
    const fcTxt = (t) => (t.total === 0 ? 'no graded appointments' : `${t.ok}/${t.total} appointments fully correct (${((t.ok / t.total) * 100).toFixed(1)}%)`)
    lines.push(`Today (${mdLabel(todayKey)}): ${fcTxt(todayFc)}`)
    lines.push(`Rolling 7 days (${mdLabel(dates[dates.length - 1])}–${mdLabel(todayKey)}): ${fcTxt(weekFc)}`)
    lines.push('"Fully correct" = every tracked field matched what the CSR finally approved. Target: 99%+ on the 7-day number before Sam/Daren go fully automatic.')
    if (tally && tally.pending > 0) {
      lines.push(`${tally.pending} appointment${tally.pending === 1 ? '' : 's'} still awaiting CSR approval (not graded yet).`)
    }
    lines.push('')

    const todayTally = buildFieldTally(todayRows)
    const weekTally = buildFieldTally(weekRows)
    lines.push('Per-field confidence — today | rolling 7 days:')
    lines.push('')
    for (const { key, label } of FIELD_KEYS) {
      lines.push(`- ${label}: ${fmtFieldPct(todayTally[key].matched, todayTally[key].compared)} | ${fmtFieldPct(weekTally[key].matched, weekTally[key].compared)}`)
    }
    lines.push('')

    lines.push('Day by day (fully correct):')
    for (const k of dates) {
      const t = fullyCorrectTally(byDay[k])
      lines.push(`- ${mdLabel(k)}: ${t.total === 0 ? 'no graded appointments' : `${t.ok}/${t.total} (${((t.ok / t.total) * 100).toFixed(0)}%)`}`)
    }
    lines.push('')
  } else if (tally) {
    lines.push(`Per-field confidence unavailable this run (agent_field_accuracy fetch failed). ${tally.pending} appointment${tally.pending === 1 ? '' : 's'} awaiting CSR approval.`)
    lines.push('')
  }

  const byOutcome = {}
  for (const a of attempts) {
    if (a.outcome === 'skipped_already_processed') continue
    if (!byOutcome[a.outcome]) byOutcome[a.outcome] = []
    byOutcome[a.outcome].push(a)
  }

  const order = ['shadow_logged', 'agent_missing', 'order_not_found', 'owner_mismatch', 'parse_failed', 'error', 'pending_created']
  for (const outcome of order) {
    const rows = byOutcome[outcome]
    if (!rows?.length) continue
    lines.push(`${OUTCOME_LABELS[outcome] || outcome} (${rows.length})`)
    for (const r of rows) lines.push(describeRow(r))
    lines.push('')
  }

  return { subject, description: lines.join('\n').trim() }
}

async function createFrontTask(subject, description) {
  const res = await fetch('https://api2.frontapp.com/conversations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      type: 'task',
      teammate_ids: [DAN_TEAMMATE_ID],
      subject,
      description,
    }),
  })
  const text = await res.text().catch(() => '')
  let id = null
  if (res.ok) {
    try { id = JSON.parse(text).id } catch (_) { /* leave null */ }
  }
  return { ok: res.ok, status: res.status, text, id }
}

// Every run -- posted or failed -- is logged to public.digest_runs (added
// 2026-10-18) so "did it run, did it reach Front" is a query, not a mystery.
async function logRun({ posted, taskId, error, detail }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/digest_runs`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ digest: 'palermo-auto-appt-digest', posted: !!posted, task_id: taskId || null, error: error || null, detail: detail || null }),
    })
  } catch (_) { /* best effort */ }
}

// Front caps a task description at 65,535 chars; stay under it.
const MAX_DESCRIPTION_CHARS = 60000

async function postDigest() {
  try {
    const [attempts, tally, fieldRows] = await Promise.all([fetchWindowAttempts(), fetchConfidenceTally(), fetchPalermoFieldAccuracy()])
    const meaningful = attempts.filter((a) => a.outcome !== 'skipped_already_processed')
    // CHANGED 2026-10-18 (Dan: be kept in the loop): this used to post
    // NOTHING on a day with no attempts. It now always posts -- the
    // today / rolling-7-day confidence figures are useful on a quiet day, and
    // a task that shows up every night is the heartbeat that the job ran.
    const built = buildSummary(attempts, tally, fieldRows)
    const subject = built.subject
    let description = built.description
    if (description.length > MAX_DESCRIPTION_CHARS) description = `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n\n…(truncated to fit Front's task size limit)`

    const attempt = await createFrontTask(subject, description)
    if (!attempt.ok) {
      const err = `HTTP ${attempt.status}: ${attempt.text.slice(0, 300)}`
      console.error("[palermo-digest] post failed ->", err)
      await createFrontTask(`${subject} — DIGEST FAILED`, `The Palermo's Auto-Scheduling digest could not be posted to Front.\n\nError: ${err}\n\n${meaningful.length} attempts were logged in the last 24 hours (auto_appt_attempts).`)
      await logRun({ posted: false, error: err, detail: { attempts: meaningful.length } })
      const e = new Error(`Front create-conversation (task) API -> ${err}`)
      e.logged = true
      throw e
    }
    await logRun({ posted: true, taskId: attempt.id, detail: { attempts: meaningful.length, chars: description.length } })
    return { posted: true, count: meaningful.length, taskId: attempt.id }
  } catch (e) {
    if (!e.logged) await logRun({ posted: false, error: String(e.message).slice(0, 800) })
    throw e
  }
}

module.exports = { postDigest }
