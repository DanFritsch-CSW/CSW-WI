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
// Same run/test split as every other digest in this app.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

const REVIEW_CONVERSATION_ID = 'cnv_1c7dl7mc' // Dan's dedicated review thread, confirmed 2026-08-22

const OUTCOME_LABELS = {
  pending_created: '✅ Pending — ready for review',
  order_not_found: '⚠️ Order not found in Datex',
  owner_mismatch: '⚠️ Reference matched, but wrong owner',
  parse_failed: '⚠️ Could not parse email format',
  error: '❌ Error during processing',
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

function formatTimeShort(iso) {
  if (!iso || !iso.includes('T')) return null
  const hour24 = parseInt(iso.split('T')[1].split(':')[0], 10)
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  const ampm = hour24 < 12 ? 'am' : 'pm'
  return `${hour12}${ampm}`
}

function buildSummary(attempts) {
  const today = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Chicago' })
  const lines = [`Auto-Parse Review — ${today}`, '']

  const byOutcome = {}
  for (const a of attempts) {
    if (a.outcome === 'skipped_already_processed') continue
    if (!byOutcome[a.outcome]) byOutcome[a.outcome] = []
    byOutcome[a.outcome].push(a)
  }

  const order = ['pending_created', 'order_not_found', 'owner_mismatch', 'parse_failed', 'error']
  for (const outcome of order) {
    const rows = byOutcome[outcome]
    if (!rows?.length) continue
    lines.push(`${OUTCOME_LABELS[outcome] || outcome} (${rows.length})`)
    for (const r of rows) {
      const ref = r.matched_reference || '(no reference parsed)'
      // pending_created shows the needed-by -> scheduled-appointment time
      // pair explicitly, so the 3-hour lead-time adjustment is visible at
      // a glance rather than hidden in the submission itself.
      const timing =
        outcome === 'pending_created' && r.needed_by && r.parsed_arrival
          ? `needed ${formatTimeShort(r.needed_by)} → appt ${formatTimeShort(r.parsed_arrival)}`
          : null
      const detail =
        outcome === 'owner_mismatch'
          ? `found under "${r.owner_name}" instead`
          : outcome === 'error'
          ? r.error_detail
          : outcome === 'pending_created' && r.labor_warning
          ? r.labor_warning
          : null
      const parts = [timing, detail].filter(Boolean).join(', ')
      lines.push(`  • ${ref}${parts ? ` — ${parts}` : ''}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

async function postDigest() {
  const attempts = await fetchWindowAttempts()
  const meaningful = attempts.filter((a) => a.outcome !== 'skipped_already_processed')
  if (meaningful.length === 0) {
    return { posted: false, reason: 'no activity in the last 24 hours' }
  }

  const body = buildSummary(attempts)
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
