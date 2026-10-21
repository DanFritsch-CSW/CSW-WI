'use strict'

// Scheduling Agent -- per-field accuracy digest (APP-WIDE). ADDED
// 2026-10-11, Dan's explicit request, built the same day
// scheduling-agent-webhook started writing agent_* snapshot columns onto
// `submissions` and scheduling-push-to-datex-background.cjs started logging
// the agent-vs-actual comparison into `agent_field_accuracy` (one row per
// graded submission, per-field *_match booleans -- see both files' own
// header notes). Covers every facility and every sender scheduling_agent
// processes; the Palermo's pilot has its own separate digest
// (lib/auto-appt-review-digest-shared.cjs).
//
// REDESIGNED 2026-10-18 (Dan's explicit request): the nightly Front task is
// now JUST percentages -- for each tracked field, accuracy for TODAY
// (America/Chicago calendar day of compared_at, i.e. when the CSR's final
// values were compared) and for the ROLLING 7 DAYS, side by side. No
// per-submission list, no cumulative-since-launch block, no Appointment
// Code line (it only ever echoed Project/Reference). Anything deeper is
// done on demand in Claude chat against agent_field_accuracy in Supabase,
// not pushed into Front every night.
//
// Why this is also the delivery-reliability fix: the old digest listed
// every graded submission in the Front task description. Once daily volume
// passed ~110-120 (10/13 onward: 141, 86, 175, 171), the description
// exceeded Front's 65,535-char limit, the create-task POST failed with a
// 4xx and the function simply threw -- a scheduled function's 502 reaches
// nobody, so the 10/13, 10/15 and 10/16 tasks were never created. The new
// text is a few hundred characters no matter the volume. Two more
// guarantees so Dan is always kept in the loop:
//   - It posts EVERY night, including days (weekends) with nothing graded
//     -- the task itself is the heartbeat that the job ran.
//   - If the Front POST fails, a short "DIGEST FAILED" task carrying the
//     error is posted before the function throws, so a failure is never
//     silent.
// Supabase reads are paginated (a plain REST GET silently caps at 1,000
// rows; ~8 days of rows already approaches that).
//
// GRADING CLEANUP 2026-10-18 (Dan's improvement #2): a field is now graded
// by comparing the agent's value to the CSR's value after normalizing case,
// periods, spaces around commas and repeated whitespace (effectiveMatch),
// instead of trusting the stored *_match flag, which compares raw strings.
// Measured on 2026-10-12..18 data this only moves a little (Carrier +11,
// Owner +8, Reference +2, Notes +1 of 687 -- most "misses" are real: blanks,
// wrong customer, or a different reference convention), but "Crown
// Bakeries" vs "CROWN BAKERIES" is no longer counted wrong. Arrival Date
// and Time stay exact string comparisons. If a row somehow lacks the
// agent/actual columns the stored flag is used.
//
// REFERENCE # GRADING 2026-10-21 (Dan's reference-number plan, fix #4):
// Reference # is now compared with normReference() instead of normText():
// uppercase, "PUR/PO/SO 123" -> "PUR123", the nose/middle/tail/target role
// labels (and N)/M)/T) markers) are dropped, only tokens containing a digit
// are kept (so store names in parentheses vanish), a leading SO on SO+digits
// is stripped, and the token set is de-duplicated and sorted -- so order,
// spacing, case, role labels and the SO prefix are no longer counted as
// misses ("522069,522710" == "NOSE: 522069 / TAIL: 522710";
// "621935" == "SO621935"). References with no digit at all ("HOLD") are
// compared as plain normalized text so blank-vs-"HOLD" still counts. From
// 2026-10-21 (Dan approved) leading zeros on all-digit values are ignored too
// ("00516272" == "516272", "0010315636" == "10315636"): zero padding is
// formatting, not a different number. Real
// differences stay misses (a different number, an extra order number the CSR
// added, "-100" suffixes). Measured on 10/11-10/21 non-pilot rows this alone
// moves Reference # from 556/885 (63%) to 611/885 (69%) -- a GRADING step
// change, not agent improvement; the weekly report's before/after callout
// uses the identical normalizer on both sides. IDENTICAL LOGIC LIVES IN
// Postgres as public.norm_reference (used by the weekly report) -- keep the
// two in sync if either changes. Everything else is graded as before.
//
// DELIVERY LOG 2026-10-18: every run is also written to public.digest_runs
// (digest 'agent-accuracy-digest': posted, task_id, error, detail).
//
// Same run/test split as every other digest in this app. Delivered as a
// Front TASK via POST /conversations (type:'task', teammate_ids) -- see
// lib/auto-appt-review-digest-shared.cjs's 2026-10-11 header note.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

// Dan Fritsch's Front teammate ID -- confirmed 2026-10-11 via Front's own
// teammates list (dfritsch@csw-wi.com).
const DAN_TEAMMATE_ID = 'tea_a3e8k'

// The day agent_* snapshotting went live; nothing in agent_field_accuracy
// should predate it.
const ACCURACY_START_DATE = '2026-10-11T00:00:00Z'

// Order is the order the table renders in.
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

// Only the columns this digest needs -- keeps the payload small.
const SELECT_COLUMNS = ['compared_at', ...FIELD_KEYS.flatMap((f) => [`${f.key}_match`, `${f.key}_agent`, `${f.key}_actual`])].join(',')

// Normalized text for grading: lowercase, drop periods, no spaces around
// commas, collapse whitespace. Blank and null are equivalent.
function normText(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
}

// Reference # grading normalizer (2026-10-21) -- see this file's header note.
// Mirrors public.norm_reference in Supabase. Returns '' for a blank value.
function normReference(v) {
  const raw = String(v == null ? '' : v)
  let s = raw.toUpperCase()
  s = s.replace(/\b(PUR|PO|SO)\s+(\d)/g, '$1$2')
  s = s.replace(/\b(MIDDLE\s+NOSE|MIDDLE\s+TAIL|NOSE|MIDDLE|TAIL|TARGET)\b|\b[NMT]\)/g, ' ')
  const toks = new Set()
  for (const m of s.matchAll(/[A-Z0-9][A-Z0-9-]*[A-Z0-9]|[A-Z0-9]/g)) {
    if (/[0-9]/.test(m[0])) toks.add(m[0].replace(/^SO(\d+)$/, '$1').replace(/^0+(\d+)$/, '$1'))
  }
  if (toks.size) return [...toks].sort().join(',')
  return normText(raw)
}

const EXACT_FIELDS = new Set(['arrival_date', 'arrival_time'])

// true / false / null (null = neither side stated the field, not a comparison).
function effectiveMatch(r, key) {
  const a = r[`${key}_agent`]
  const c = r[`${key}_actual`]
  if (a === undefined && c === undefined) return r[`${key}_match`]
  const norm = key === 'reference' ? normReference : normText
  const na = EXACT_FIELDS.has(key) ? String(a == null ? '' : a).trim() : norm(a)
  const nc = EXACT_FIELDS.has(key) ? String(c == null ? '' : c).trim() : norm(c)
  if (!na && !nc) return null
  return na === nc
}

// Pages through the full result set explicitly -- a plain unbounded
// Supabase REST GET silently caps at 1,000 rows (same bug class fixed in
// scheduling-agent-webhook's sbGetAll on 2026-10-12).
async function sbGetAllRows(path) {
  const PAGE = 1000
  let offset = 0
  let all = []
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    if (!res.ok) throw new Error(`Supabase fetch failed: HTTP ${res.status}`)
    const page = await res.json()
    if (!Array.isArray(page) || page.length === 0) break
    all = all.concat(page)
    if (page.length < PAGE) break
    offset += PAGE
  }
  return all
}

// Last ~8 days (today + rolling 7, with a day of slack for the Chicago/UTC
// offset), never earlier than the table's start date. Stable order
// (compared_at, id) so paging can't skip or repeat rows.
async function fetchRecentRows() {
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  const since = eightDaysAgo > ACCURACY_START_DATE ? eightDaysAgo : ACCURACY_START_DATE
  return sbGetAllRows(`agent_field_accuracy?compared_at=gte.${encodeURIComponent(since)}&order=compared_at.asc,id.asc&select=${SELECT_COLUMNS}`)
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

function buildFieldTally(rows) {
  const tally = {}
  for (const { key } of FIELD_KEYS) tally[key] = { matched: 0, compared: 0 }
  for (const r of rows) {
    for (const { key } of FIELD_KEYS) {
      const matchVal = effectiveMatch(r, key)
      if (matchVal === null || matchVal === undefined) continue // field never stated by either side -- not a comparison
      tally[key].compared++
      if (matchVal === true) tally[key].matched++
    }
  }
  return tally
}

function fmtPct(matched, compared) {
  if (compared === 0) return 'no data'
  return `${((matched / compared) * 100).toFixed(0)}% (${matched}/${compared})`
}

function buildSummary(rows) {
  const dates = lastNCentralDates(7) // newest first
  const todayKey = dates[0]
  const windowSet = new Set(dates)
  const todayRows = []
  const weekRows = []
  for (const r of rows) {
    if (!r.compared_at) continue
    const k = centralDateStr(r.compared_at)
    if (!windowSet.has(k)) continue
    weekRows.push(r)
    if (k === todayKey) todayRows.push(r)
  }

  const subject = `Scheduling Agent Field Accuracy — ${mdLabel(todayKey)}`
  const todayTally = buildFieldTally(todayRows)
  const weekTally = buildFieldTally(weekRows)

  const lines = []
  lines.push(`Graded appointments: today ${todayRows.length} | rolling 7 days (${mdLabel(dates[dates.length - 1])}–${mdLabel(todayKey)}) ${weekRows.length}`)
  lines.push('')
  lines.push('Accuracy per field — today | rolling 7 days:')
  lines.push('')
  for (const { key, label } of FIELD_KEYS) {
    lines.push(`- ${label}: ${fmtPct(todayTally[key].matched, todayTally[key].compared)} | ${fmtPct(weekTally[key].matched, weekTally[key].compared)}`)
  }
  if (todayRows.length === 0) {
    lines.push('')
    lines.push('Nothing was graded today (no approved appointments), so the left column is empty.')
  }
  return { subject, description: lines.join('\n'), gradedToday: todayRows.length, gradedWeek: weekRows.length }
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
      body: JSON.stringify({ digest: 'agent-accuracy-digest', posted: !!posted, task_id: taskId || null, error: error || null, detail: detail || null }),
    })
  } catch (_) { /* best effort */ }
}

async function postDigest() {
  try {
    const rows = await fetchRecentRows()
    const { subject, description, gradedToday, gradedWeek } = buildSummary(rows)

    const attempt = await createFrontTask(subject, description)
    if (!attempt.ok) {
      // Never let a failure be silent (see header note).
      const err = `HTTP ${attempt.status}: ${attempt.text.slice(0, 300)}`
      console.error('[agent-accuracy-digest] post failed ->', err)
      await createFrontTask(`${subject} — DIGEST FAILED`, `The Scheduling Agent Field Accuracy digest could not be posted to Front.\n\nError: ${err}\n\nThe data is in agent_field_accuracy (${gradedToday} graded today, ${gradedWeek} in the last 7 days).`)
      await logRun({ posted: false, error: err, detail: { gradedToday, gradedWeek } })
      const e = new Error(`Front create-conversation (task) API -> ${err}`)
      e.logged = true
      throw e
    }
    await logRun({ posted: true, taskId: attempt.id, detail: { gradedToday, gradedWeek, chars: description.length } })
    return { posted: true, gradedToday, gradedWeek, taskId: attempt.id }
  } catch (e) {
    if (!e.logged) await logRun({ posted: false, error: String(e.message).slice(0, 800) })
    throw e
  }
}

module.exports = { postDigest }
