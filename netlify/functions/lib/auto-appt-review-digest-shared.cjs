'use strict'

// Automated Appointment Creation pilot — daily review digest, added
// 2026-08-22 per Dan's explicit "single Front discussion thread to post
// results daily" request. Posts a comment summarizing the last 24 hours
// of auto_appt_attempts activity to the specific Front conversation Dan
// created for this (cnv_1c7dl7mc), so it's one continuous thread rather
// than a fresh discussion each day (unlike front-daily-discussion-run.cjs,
// which intentionally creates a NEW discussion per facility per day — this
// pilot's review log is deliberately the opposite, one persistent thread).
//
// Only posts when there was at least one attempt in the window — a quiet
// day (Sam Rohde didn't email) produces no comment at all, rather than a
// daily "nothing happened" noise post.
//
// UPDATED 2026-08-23: pending_created rows now show the needed-by ->
// appointment-time pair explicitly (e.g. "needed 3pm → appt 12pm"), so
// the 3-hour lead-time adjustment (see lib/auto-appt-parse-shared.cjs) is
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
// Same run/test split as every other digest in this app.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

const REVIEW_CONVERSATION_ID = 'cnv_1c7dl7mc' // Dan's dedicated review thread, confirmed 2026-08-22

// The day the TO-prefix lookup bug was fixed. Everything before this is
// pre-fix noise (444 attempts, 0 real matches) — the cumulative confidence
// tally only makes sense starting from here.
const SHADOW_START_DATE = '2026-10-10T00:00:00Z'

const OUTCOME_LABELS = {
  shadow_logged: '🔎 Validated — waiting on CSR approval to grade',
  agent_missing: '🚨 Validated, but scheduling_agent never created an entry',
  order_not_found: '⚠️ Order not found in Datex',
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
      if (r.match_status === 'matched') {
        return `• ${ref} (${project}) — ${who} asked for ${timing || 'an appointment'}. CSR approved it exactly as predicted. ✅`
      }
      if (r.match_status === 'mismatch') {
        const bits = []
        if (r.agent_scheduled_arrival !== r.actual_scheduled_arrival) {
          bits.push(`agent had ${formatTimeShort(r.agent_scheduled_arrival) || '(none)'}, CSR used ${formatTimeShort(r.actual_scheduled_arrival) || '(none)'}`)
        }
        if (r.recommended_dock_door && r.recommended_dock_door !== r.actual_dock_door) {
          bits.push(`recommended dock ${r.recommended_dock_door}, CSR used ${r.actual_dock_door || '(none)'}`)
        }
        return `• ${ref} (${project}) — ⚠️ MISMATCH: ${bits.join('; ') || 'CSR changed something before approving — check the submission'}`
      }
      const laborTxt = r.labor_warning ? ` (${r.labor_warning})` : ''
      return `• ${ref} (${project}) — ${who} asked for ${timing || 'an appointment'}${laborTxt}. Waiting on CSR approval to grade.`
    }
    case 'agent_missing':
      return `• ${ref} (${project}) — order's real, ${who}'s email parsed fine, but scheduling_agent never created a pending entry for it. Needs a manual look.`
    case 'order_not_found':
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

function buildSummary(attempts, tally) {
  const today = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Chicago' })
  const lines = [`Palermo's Auto-Scheduling — ${today}`, '']

  if (tally) {
    const pct = tally.compared > 0 ? ((tally.matched / tally.compared) * 100).toFixed(1) : null
    lines.push(
      pct !== null
        ? `Confidence so far: ${tally.matched}/${tally.compared} graded appointments matched exactly (${pct}%). ${tally.pending} more awaiting CSR approval before they can be graded. Target: 99%+ before Sam/Daren go fully automatic.`
        : `Confidence so far: no graded appointments yet (${tally.pending} awaiting CSR approval). Target: 99%+ before Sam/Daren go fully automatic.`
    )
    if (tally.mismatch > 0) {
      lines.push(`⚠️ ${tally.mismatch} mismatch${tally.mismatch === 1 ? '' : 'es'} so far — see below for today's, or ask me to pull the full list.`)
    }
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

  return lines.join('\n').trim()
}

async function postDigest() {
  const [attempts, tally] = await Promise.all([fetchWindowAttempts(), fetchConfidenceTally()])
  const meaningful = attempts.filter((a) => a.outcome !== 'skipped_already_processed')
  if (meaningful.length === 0) {
    return { posted: false, reason: 'no activity in the last 24 hours' }
  }

  const body = buildSummary(attempts, tally)
  const res = await fetch(`https://api2.frontapp.com/conversations/${REVIEW_CONVERSATION_ID}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Front comments API -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return { posted: true, count: meaningful.length }
}

module.exports = { postDigest }
