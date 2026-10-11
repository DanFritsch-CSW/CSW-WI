'use strict'

// Scheduling Agent -- per-field accuracy digest. ADDED 2026-10-11, Dan's
// explicit request, built the same day scheduling-agent-webhook started
// writing agent_* snapshot columns onto `submissions` and
// scheduling-push-to-datex-background.cjs started logging the agent-vs-
// actual comparison into `agent_field_accuracy` (see both files' own
// header notes for the full architecture).
//
// SCOPE -- this is NOT the Palermo's pilot. That pilot
// (lib/auto-appt-parse-shared.cjs / lib/auto-appt-review-digest-shared.cjs)
// only ever covers Sam Rohde and Daren Peet's two addresses at CAL. This
// digest covers scheduling_agent's generic extraction APP-WIDE -- every
// facility, every sender -- because Dan's actual question was "what is
// this agent getting right or wrong, field by field, everywhere it runs,"
// not anything specific to Palermo's. The two digests are deliberately
// separate Front Tasks; this one never touches auto_appt_attempts or
// cnv_1c7dl7mc.
//
// WHAT IT SHOWS, same two-part shape as the Palermo's digest Dan already
// approved of:
//   1. A cumulative PER-FIELD confidence percentage (matched / compared)
//      since this feature launched, for Warehouse, Type, Project, Owner,
//      Arrival Date, Arrival Time, Dock Door, Carrier, Reference #, and
//      Notes -- the number Dan actually wants, to prioritize which fields
//      in the extraction prompt are worth fixing next. Appointment Code is
//      reported too, but flagged as non-independent (see below).
//   2. A table of the individual submissions compared in the last 24
//      hours, one line per field that actually DIFFERED (agent value ->
//      CSR's final value), grouped by submission -- exactly Dan's "what
//      was originally pulled vs. what the CSR manually created" ask.
//
// APPOINTMENT CODE has no real independent accuracy story: it's always
// computed client-side (PluginView.jsx) from Project + Reference # alone,
// identically whether a submission is agent-created or hand-entered --
// scheduling-agent-webhook never writes it, so there's no agent_* snapshot
// for it (see that file's 2026-10-11 header note). agent_field_accuracy
// still carries a `lookup_code_actual` value (what the final code ended up
// being) with `lookup_code_agent`/`lookup_code_match` always null; this
// digest derives an "agent-would-have-been" code on the fly from
// agent_project + agent_reference_number (the same formula PluginView.jsx
// uses) purely to show the mismatch count as a courtesy -- it is never
// counted as a genuinely independent field in the per-field percentage
// table, since it would only double-count Project/Reference accuracy.
//
// ONLY COVERS SUBMISSIONS CREATED FROM 2026-10-11 ONWARD -- see
// scheduling-agent-webhook's header note. Earlier submissions have no
// agent_* snapshot at all and are already filtered out at the logging
// step in scheduling-push-to-datex-background.cjs, so they never reach
// agent_field_accuracy in the first place; nothing further to filter here.
//
// Same run/test split as every other digest in this app. Delivered as a
// Front TASK (not a comment), matching the delivery-mechanism change Dan
// asked for on the Palermo's digest the same day -- see that file's own
// 2026-10-11 header note for the create-conversation (type:'task') API
// details, which this reuses verbatim.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

// Dan Fritsch's Front teammate ID -- confirmed 2026-10-11 via Front's own
// teammates list (dfritsch@csw-wi.com), same value already verified and
// used by the Palermo's digest the same day.
const DAN_TEAMMATE_ID = 'tea_a3e8k'

// The day agent_* snapshotting went live. Nothing in agent_field_accuracy
// should predate this, but pinning it explicitly keeps the cumulative
// tally honest even if a backdated or test row ever sneaks in.
const ACCURACY_START_DATE = '2026-10-11T00:00:00Z'

// Order matters -- this is the order both the per-field percentage table
// and the per-submission mismatch list render in. Appointment Code is
// last and handled specially (see header note) -- it is excluded from the
// core FIELD_KEYS confidence table and reported separately underneath.
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
  { key: 'notes', label: 'Notes' },
]

async function fetchWindowRows() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/agent_field_accuracy?compared_at=gte.${encodeURIComponent(since)}&order=compared_at.asc&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  if (!res.ok) throw new Error(`Supabase fetch failed: HTTP ${res.status}`)
  return res.json()
}

// Cumulative, since the feature launched -- not a 24-hour window. Same
// pattern as the Palermo's digest's confidence tally: a running percentage
// across a real sample is what tells Dan whether a field is actually
// unreliable, not a single day's handful of submissions.
async function fetchCumulativeRows() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/agent_field_accuracy?compared_at=gte.${encodeURIComponent(ACCURACY_START_DATE)}&select=*`,
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

// Appointment Code's own tally, reported separately -- see header note on
// why it's never folded into FIELD_KEYS. "Agent-would-have-been" is
// derived here (not stored) using the same (ABBR) - reference convention
// PluginView.jsx uses, best-effort: if agent_project can't be resolved to
// a known abbreviation this just compares against the stored
// lookup_code_actual's own prefix, which is a reasonable approximation
// for a courtesy count, not a precise one.
function deriveAgentLookupCode(r) {
  if (!r.reference_agent) return null
  const actual = r.lookup_code_actual || ''
  const prefixMatch = actual.match(/^\(([^)]+)\)/)
  const abbr = prefixMatch ? prefixMatch[1] : null
  return abbr ? `(${abbr}) - ${r.reference_agent}` : null
}

function buildLookupCodeTally(rows) {
  let matched = 0
  let compared = 0
  for (const r of rows) {
    const agentCode = deriveAgentLookupCode(r)
    if (!agentCode || !r.lookup_code_actual) continue
    compared++
    if (agentCode === r.lookup_code_actual) matched++
  }
  return { matched, compared }
}

function fmtPct(matched, compared) {
  if (compared === 0) return 'no data yet'
  return `${matched}/${compared} (${((matched / compared) * 100).toFixed(1)}%)`
}

function senderLine(r) {
  return r.front_conversation_id ? r.front_conversation_id : '(unknown thread)'
}

// One line per field that actually differed on a given submission --
// nothing printed for fields that matched, so a clean submission
// contributes nothing to this list at all.
function describeMismatches(r) {
  const lines = []
  for (const { key, label } of FIELD_KEYS) {
    if (r[`${key}_match`] === false) {
      const agentVal = r[`${key}_agent`] || '(blank)'
      const actualVal = r[`${key}_actual`] || '(blank)'
      lines.push(`    - ${label}: agent had "${agentVal}", CSR used "${actualVal}"`)
    }
  }
  const agentCode = deriveAgentLookupCode(r)
  if (agentCode && r.lookup_code_actual && agentCode !== r.lookup_code_actual) {
    lines.push(`    - Appointment Code: agent would've been "${agentCode}", actual "${r.lookup_code_actual}" (usually just reflects the Project/Reference mismatch above, not a separate issue)`)
  }
  return lines
}

function buildSummary(windowRows, cumulativeRows) {
  const today = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Chicago' })
  const subject = `Scheduling Agent Field Accuracy — ${today}`

  const tally = buildFieldTally(cumulativeRows)
  const lookupTally = buildLookupCodeTally(cumulativeRows)

  const lines = []
  lines.push(`Per-field confidence, cumulative since 2026-10-11 (${cumulativeRows.length} submission${cumulativeRows.length === 1 ? '' : 's'} graded so far):`)
  lines.push('')
  for (const { key, label } of FIELD_KEYS) {
    lines.push(`- ${label}: ${fmtPct(tally[key].matched, tally[key].compared)}`)
  }
  lines.push(`- Appointment Code: ${fmtPct(lookupTally.matched, lookupTally.compared)} (not independent -- just echoes Project/Reference, see note below)`)
  lines.push('')
  lines.push('Appointment Code is always computed from Project + Reference # alone, so it never carries its own extraction accuracy -- a low number there just means Project or Reference # was off, already counted above.')
  lines.push('')

  if (windowRows.length === 0) {
    lines.push('No submissions graded in the last 24 hours.')
  } else {
    lines.push(`Submissions graded in the last 24 hours (${windowRows.length}):`)
    for (const r of windowRows) {
      const mismatches = describeMismatches(r)
      if (mismatches.length === 0) {
        lines.push(`  • ${senderLine(r)} (${r.warehouse || 'unknown warehouse'}) — every field matched exactly. ✅`)
      } else {
        lines.push(`  • ${senderLine(r)} (${r.warehouse || 'unknown warehouse'}) — ${mismatches.length} field${mismatches.length === 1 ? '' : 's'} off:`)
        lines.push(...mismatches)
      }
    }
  }

  return { subject, description: lines.join('\n').trim() }
}

async function postDigest() {
  const [windowRows, cumulativeRows] = await Promise.all([fetchWindowRows(), fetchCumulativeRows()])
  if (windowRows.length === 0) {
    return { posted: false, reason: 'no submissions graded in the last 24 hours' }
  }

  const { subject, description } = buildSummary(windowRows, cumulativeRows)
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
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Front create-conversation (task) API -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const created = await res.json()
  return { posted: true, count: windowRows.length, taskId: created.id }
}

module.exports = { postDigest }
