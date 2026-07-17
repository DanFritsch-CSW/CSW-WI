'use strict'

// Nightly FEFO Rotation digest — per-project (not per-facility, since all 5
// FEFO customers are KEN). Added 2026-07-14 per Dan's request for
// customer/project-level FEFO notify settings, similar in spirit to
// Pre-Pick/Cases-to-Pick/Daily Ops but scoped per PROJECT instead of per
// facility.
//
// ── Why one settings row per project instead of one combined digest ───────
// Dan's call: each FEFO project (Fair Oaks, Fair Oaks West, Richelieu,
// Crown Bakeries, Birchwood — all KEN — plus Palermo's Caledonia at CAL,
// added 2026-07-17) gets its OWN prepick_notify_settings row —
// (facility, dashboard_type)=('ken'|'cal', 'fefo_<projectId>') — with its
// own Front conversation, its own send time, and its own Enabled toggle.
// No schema change was needed: the table's existing composite key
// (facility, dashboard_type) already supports this, we're just seeding a
// new dashboard_type value per project, in whichever facility that
// project actually lives at.
//
// This one Netlify function is SHARED across all 5 rows (one file, one
// cron tick every 15 min) rather than 5 separate function files — the only
// thing that differs per row is which project's data to pull and which
// conversation to post to, so looping 5 settings rows inside one scheduled
// tick is simpler than 5 near-identical function files.
//
// ── Content date is the NEXT BUSINESS DAY, always (2026-07-14, later) ──────
// Original version summarized TODAY (rotation compliance "right now"). Dan's
// follow-up feedback after seeing the first live test: both "Send test
// digest now" and the scheduled run should always look at the next business
// day instead — same content-date semantics as Pre-Pick/Cases/Daily Ops,
// just always-on rather than an opt-in checkbox. "Business day" is defined
// per-project by the same "Send on:" day toggles already in
// NotifySettingsPanel (notify_days) — that row IS the M-F-vs-7-days-a-week
// selector Dan asked for, reused rather than duplicated.
//
// Mechanism: nextBusinessDayDateObj() starts from tomorrow (Central) and
// advances forward day-by-day (capped at +6) until it lands on a date whose
// weekday is in notify_days. Unlike prepick-digest-run.cjs's
// skip_to_next_valid_day, this is NOT optional here — there is no "skip and
// post nothing" path for FEFO, so the checkbox from those other digests is
// intentionally not shown for FEFO (see NotifySettingsPanel's
// showSkipToNextValidDay=false usage in FefoRotationTab.jsx). The scheduled
// tick fires every day at the configured time and always resolves some
// next business day — it does not skip based on today's weekday the way
// the original version did.
//
// ── Content scope: full status, not violations-only ─────────────────────────
// Confirmed with Dan: the digest always states the full picture — order
// count, clean count, and every non-clean category (violations w/ severity,
// stale, hold, blocked, undated lots) — rather than only firing when
// something's wrong. An all-clear day still posts a short "no issues"
// comment, same full-status philosophy as the live tab's banners.
//
// ── Front message formatting (2026-07-14, later) ────────────────────────────
// Dan's feedback on the first live test: wording read too tight/dense, and
// the violation count (the single most important number) didn't stand out.
// Fixed by adding blank lines between every bullet (not just between
// sections) and wrapping the violation count in a bold, divider-bracketed
// block — same "make the most important number impossible to miss" pattern
// already used in wr-cases-digest-run.cjs's Total Pickline Volume treatment.
// Front's Markdown subset supports **bold** but not reliable headings (a
// leading "#" gets silently eaten as an ATX heading marker even mid-
// document — see wr-cases-digest-run.cjs's discovery of this), so emphasis
// here uses bold + plain unicode divider rules (─), not "#".
//
// ── Link back to the app (2026-07-14, still later) ──────────────────────────
// Dan asked for a link to the live FEFO Rotation tab, formatted like a
// Markdown link (`[CSW Operations Hub](url)`) — same request shape as the
// Daily Ops digest's link-back. Same fix applies: Front's comment API does
// NOT render `[text](url)` as clickable (shows the literal brackets), so
// this uses a bare URL instead (Front auto-linkifies it), with the label
// as a separate plain-text line rather than the link text itself.
//
// Data source: proxies to fefo-orders.cjs (the same MotherDuck-backed
// function the live FEFO Rotation tab uses). dayCount is sized dynamically
// to cover however many days out the resolved content date lands (capped at
// fefo-orders' own 7-day max), and orders are matched to the target date by
// the same day-bucket-offset convention fefo-orders.cjs already computes
// (see targetDayOffset below) rather than assuming day===0. Verdict/
// severity/undated-lot logic below is a straight port of src/lib/fefo.js's
// pure functions — kept deliberately simple and dependency-free so it can
// run in this CJS function; mirror any future changes made to fefo.js's
// verdict engine here too.
//
// Two invocation paths (same convention as the other digests):
//   1. SCHEDULED (netlify.toml: "*/15 * * * *") — loops every fefo_*
//      dashboard_type row across ALL facilities, fires whichever one(s)
//      match the current America/Chicago time, resolving each row's own
//      next business day from its own notify_days.
//   2. MANUAL TEST — POST { dashboardType: 'fefo_<projectId>' }. Unlike the
//      single-row digests, this one MUST be told which project's settings
//      row to use, since one function backs 5 rows. Always sends
//      immediately for the next business day regardless of time/active, and
//      does not touch last_sent_date (same "test doesn't interfere with the
//      real scheduled send" reasoning as the other digests).

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

const FEFO_PROJECTS = [
  { id: 'faioa5', code: 'FAIOA5', name: 'Fair Oaks Farms', facility: 'ken' },
  { id: 'fofwe5', code: 'FOFWE5', name: 'Fair Oaks Farms West', facility: 'ken' },
  { id: 'riche5', code: 'RICHE5', name: 'Richelieu Foods', facility: 'ken' },
  { id: 'golst5', code: 'GOLST5', name: 'Crown Bakeries', facility: 'ken' },
  { id: 'birch5', code: 'BIRCH5', name: 'Birchwood Foods', facility: 'ken' },
  // Added 2026-07-17 — first FEFO project outside KEN (see src/lib/fefo.js
  // for the full "why CAL" writeup). facility here MUST match the actual
  // stored facility column on this project's prepick_notify_settings row
  // (facility='cal') — it's used both to build the fefo-orders request and
  // as a WHERE-clause value when updating last_sent_date; a mismatch there
  // would silently update 0 rows rather than error.
  { id: 'palvi9', code: 'PALVI9', name: "Palermo's Caledonia", facility: 'cal' },
]
const PROJECT_BY_DASHBOARD_TYPE = new Map(FEFO_PROJECTS.map(p => [`fefo_${p.id}`, p]))
const DEFAULT_NOTIFY_DAYS = [1, 2, 3, 4, 5]
// APP_URL — added 2026-07-14 (later, per Dan's request), same link-back-to-
// the-app treatment as the other digests. Not scoped to a specific project
// (FefoRotationTab.jsx has no per-project URL param today), so every
// project's digest links to the same FEFO Rotation tab.
const APP_URL = 'https://csw-wi.netlify.app/customers?tab=fefo'

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

// ── Central-time helpers (same pattern as prepick-digest-run.cjs) ─────────

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function centralTodayDateObj() {
  const { year, month, day } = centralNowParts()
  return new Date(Date.UTC(year, month - 1, day))
}

// nextBusinessDayDateObj — always looks ahead, starting from tomorrow
// (Central), advancing until a weekday in notifyDays is found. Capped at
// +6 (i.e. never further than a week out) so a misconfigured empty
// notify_days can't loop forever. See file header for why this is
// unconditional for FEFO rather than the opt-in lookahead the other
// digests have.
function nextBusinessDayDateObj(notifyDays) {
  const days = (notifyDays && notifyDays.length) ? notifyDays : DEFAULT_NOTIFY_DAYS
  let d = new Date(centralTodayDateObj().getTime() + 24 * 60 * 60 * 1000)
  let advanced = 0
  while (!days.includes(isoWeekday(d)) && advanced < 6) {
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000)
    advanced++
  }
  return d
}

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

function isoWeekday(dateObj) {
  const dow = dateObj.getUTCDay()
  return dow === 0 ? 7 : dow
}

function isoDate(dateObj) { return dateObj.toISOString().slice(0, 10) }

function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
}

// todayUtcMidnight — mirrors fefo-orders.cjs's own "today" definition
// exactly (real server UTC date, NOT the Central-time date used above) so
// the day-bucket offset computed here lines up with the bucket fefo-orders
// assigns to each order. See "targetDayOffset" below for why this matters.
function todayUtcMidnight() {
  const n = new Date()
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
}

// ── Verdict engine — ported from src/lib/fefo.js (kept dependency-free) ────

const VERDICT_PRECEDENCE = { violation: 0, stale: 1, hold: 2, blocked: 3, clean: 4 }

function lineVerdict(line) {
  if (!line?.ship?.length) return 'clean'
  const datedShip = line.ship.filter(s => !s.dateUnknown)
  if (!datedShip.length) return 'clean'
  const oldKDay = Math.min(...datedShip.map(s => s.kDay ?? s.k))
  const rem = line.rem
  const remKDay = rem?.kDay ?? rem?.k
  if (rem && !rem.dateUnknown && rem.lps > 0 && remKDay != null && remKDay < oldKDay) {
    if (rem.hold) return 'hold'
    if (rem.locationBlocked) return 'blocked'
    return 'violation'
  }
  return 'clean'
}

function orderVerdict(order) {
  const verdicts = (order.lines || []).map(lineVerdict)
  const worst = verdicts.length
    ? verdicts.reduce((a, b) => VERDICT_PRECEDENCE[a] <= VERDICT_PRECEDENCE[b] ? a : b)
    : 'clean'
  if (order.past && worst !== 'violation') return 'stale'
  return worst
}

function parseDisplayDate(display) {
  if (!display || typeof display !== 'string') return null
  const m = display.match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/)
  if (!m) return null
  const month = Number(m[1]), day = Number(m[2])
  let year = Number(m[3]); if (year < 100) year += 2000
  const d = new Date(Date.UTC(year, month - 1, day))
  return Number.isNaN(d.getTime()) ? null : d
}

function lineDaysOlder(line) {
  if (lineVerdict(line) !== 'violation') return 0
  if (!line?.ship?.length || !line?.rem?.date) return 0
  const datedShip = line.ship.filter(s => !s.dateUnknown)
  if (!datedShip.length) return 0
  const oldShip = datedShip.reduce((a, b) => a.k < b.k ? a : b)
  const shipDate = parseDisplayDate(oldShip.date)
  const remDate = parseDisplayDate(line.rem.date)
  if (!shipDate || !remDate) return 0
  return Math.max(0, Math.round((shipDate.getTime() - remDate.getTime()) / 86400000))
}

function orderMaxDaysOlder(order) {
  let max = 0
  for (const line of (order.lines || [])) { const d = lineDaysOlder(line); if (d > max) max = d }
  return max
}

function orderSeverity(order) {
  const days = orderMaxDaysOlder(order)
  if (days === 0) return null
  return days >= 4 ? 'critical' : 'warning'
}

function undatedLotCount(orders) {
  const lots = new Set()
  for (const o of orders) {
    for (const line of (o.lines || [])) {
      for (const s of (line.ship || [])) if (s.dateUnknown && s.lot) lots.add(s.lot)
      for (const u of (line.undatedOnHand || [])) if (u.lot) lots.add(u.lot)
    }
  }
  return lots.size
}

// ── Digest body ─────────────────────────────────────────────────────────────
//
// Spacing (2026-07-14, later, per Dan's feedback on the first live test):
// a blank line now separates every bullet, not just every section, so the
// message breathes instead of reading as one dense block. The violation
// count — the single number Dan most wants to jump out — gets its own
// bold, divider-bracketed block, same "impossible to miss" treatment
// wr-cases-digest-run.cjs uses for Total Pickline Volume. Front's Markdown
// doesn't reliably render "#" as a heading (it gets silently eaten even
// mid-document), so this relies on **bold** plus plain unicode divider
// rules instead.

function buildDigestBody(orders, project, dateObj) {
  const lines = []
  lines.push(`FEFO Rotation — ${project.name} (${project.code})`)
  // Bare URL (not a Markdown link) — Front's comment API doesn't render
  // [text](url) as clickable, it shows the literal brackets. A bare URL is
  // what Front auto-linkifies. See file header "Link back to the app".
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push(`Next business day: ${formatHeaderDate(dateObj)}`)
  lines.push('')

  if (orders.length === 0) {
    lines.push('No orders in the FEFO window for this project on that date.')
    return lines.join('\n')
  }

  const byVerdict = { violation: [], stale: [], hold: [], blocked: [], clean: [] }
  for (const o of orders) byVerdict[orderVerdict(o)].push(o)

  const critical = byVerdict.violation.filter(o => orderSeverity(o) === 'critical').length
  const warning = byVerdict.violation.filter(o => orderSeverity(o) === 'warning').length
  const undated = undatedLotCount(orders)

  const summaryParts = []
  if (byVerdict.stale.length) summaryParts.push(`${byVerdict.stale.length} stale`)
  if (byVerdict.hold.length) summaryParts.push(`${byVerdict.hold.length} on hold`)
  if (byVerdict.blocked.length) summaryParts.push(`${byVerdict.blocked.length} in receiving`)
  lines.push(`${orders.length} order${orders.length === 1 ? '' : 's'} in rotation window · ${byVerdict.clean.length} clean${summaryParts.length ? ' · ' + summaryParts.join(' · ') : ''}`)
  lines.push('')

  // ── Violation count — highlighted block, always shown once orders exist,
  // even when the count is zero, so "no violations" is just as visible as
  // "3 violations" rather than only calling attention to bad news.
  const divider = '─'.repeat(28)
  lines.push(divider)
  if (byVerdict.violation.length > 0) {
    const sevBits = [critical ? `${critical} CRITICAL` : '', warning ? `${warning} WARNING` : ''].filter(Boolean).join(' · ')
    lines.push(`**⚠ ${byVerdict.violation.length} VIOLATION${byVerdict.violation.length === 1 ? '' : 'S'}${sevBits ? ` (${sevBits})` : ''}**`)
  } else {
    lines.push('**✓ 0 VIOLATIONS**')
  }
  lines.push(divider)
  lines.push('')

  if (byVerdict.violation.length) {
    lines.push('Violations:')
    lines.push('')
    for (const o of byVerdict.violation) {
      const days = orderMaxDaysOlder(o)
      const sev = orderSeverity(o)
      lines.push(`• ${o.id} — ${days}d older stock available, unallocated${sev ? ` (${sev.toUpperCase()})` : ''} — ${o.dest || 'dest unknown'}`)
      lines.push('')
    }
  }
  if (byVerdict.hold.length) {
    lines.push('On hold (older lot correctly skipped):')
    lines.push('')
    for (const o of byVerdict.hold) { lines.push(`• ${o.id} — ${o.dest || 'dest unknown'}`); lines.push('') }
  }
  if (byVerdict.blocked.length) {
    lines.push('In receiving / not put away:')
    lines.push('')
    for (const o of byVerdict.blocked) { lines.push(`• ${o.id} — ${o.dest || 'dest unknown'}`); lines.push('') }
  }
  if (byVerdict.stale.length) {
    lines.push('Stale (past appointment, still allocated):')
    lines.push('')
    for (const o of byVerdict.stale) { lines.push(`• ${o.id} — ${o.dest || 'dest unknown'}`); lines.push('') }
  }
  if (undated > 0) {
    lines.push(`⚠ ${undated} lot${undated === 1 ? '' : 's'} with no parseable date in this window — verify in Datex.`)
    lines.push('')
  }
  if (!byVerdict.violation.length && !byVerdict.stale.length && !byVerdict.hold.length && !byVerdict.blocked.length && undated === 0) {
    lines.push('✓ All orders pulling oldest available stock — no other issues.')
    lines.push('')
  }
  // Trim the single trailing blank line so the message doesn't end on
  // empty space.
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

// ── Core per-project run ────────────────────────────────────────────────────

async function runForProject({ settingsRow, project, dateObj, isManualTest }) {
  const conversationId = settingsRow?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for ${project.code}`, project: project.code }
  }

  const date = isoDate(dateObj)

  // targetDayOffset — number of days between fefo-orders.cjs's own "today"
  // (real UTC date, see todayUtcMidnight above) and our resolved content
  // date. Requesting dayCount = targetDayOffset + 1 means the query window
  // (today-1 .. today+dayCount-1) ends exactly on our target date, and any
  // order returned with day === dayCount-1 is genuinely on that date (not
  // folded in from further out, since the window itself doesn't extend
  // past it). Clamped to fefo-orders' accepted 1..7 range.
  let targetDayOffset = Math.round((dateObj.getTime() - todayUtcMidnight().getTime()) / 86400000)
  if (targetDayOffset < 0) targetDayOffset = 0
  if (targetDayOffset > 6) targetDayOffset = 6
  const dayCount = targetDayOffset + 1

  const ordersRes = await fetch(`${SITE_URL}/.netlify/functions/fefo-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility: project.facility, projectIds: [project.id], dayCount }),
  })
  const ordersText = await ordersRes.text()
  let ordersJson
  try { ordersJson = JSON.parse(ordersText) } catch { ordersJson = { raw: ordersText } }
  if (!ordersRes.ok) {
    return { ok: false, reason: 'fefo-orders failed', detail: ordersJson, project: project.code }
  }

  const allOrders = ordersJson.ordersByProject?.[project.id] || []
  const targetOrders = allOrders.filter(o => o.day === dayCount - 1)

  const body = buildDigestBody(targetOrders, project, dateObj)

  const frontRes = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const frontText = await frontRes.text()
  let frontJson
  try { frontJson = JSON.parse(frontText) } catch { frontJson = { raw: frontText } }
  if (!frontRes.ok) {
    return { ok: false, reason: 'Front API error posting comment', detail: frontJson, project: project.code }
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${project.facility}&dashboard_type=eq.fefo_${project.id}`, { last_sent_date: date })
  }

  return { ok: true, date, project: project.code, conversationId, commentId: frontJson.id, orderCount: targetOrders.length }
}

async function runDigest({ isManualTest, dashboardType }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  if (isManualTest) {
    const project = PROJECT_BY_DASHBOARD_TYPE.get(dashboardType)
    if (!project) return { ok: false, reason: `Unknown dashboardType '${dashboardType}'` }
    const rows = await sbFetch(
      `prepick_notify_settings?facility=eq.${project.facility}&dashboard_type=eq.${dashboardType}&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
    )
    const settingsRow = rows?.[0]
    const dateObj = nextBusinessDayDateObj(settingsRow?.notify_days)
    const result = await runForProject({ settingsRow, project, dateObj, isManualTest: true })
    return result
  }

  // Scheduled tick — loop every fefo_* row (across ALL facilities, not just
  // ken, now that Palermo's Caledonia/CAL exists — dashboard_type already
  // uniquely identifies the project, so facility isn't needed as a filter
  // here). Each row resolves its OWN next business day from its own
  // notify_days, then fires if this tick matches the configured send time
  // and it hasn't already sent for that resolved date.
  const rows = await sbFetch(
    `prepick_notify_settings?dashboard_type=like.fefo_*&select=facility,dashboard_type,front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const results = []
  for (const row of (rows || [])) {
    const project = PROJECT_BY_DASHBOARD_TYPE.get(row.dashboard_type)
    if (!project) continue
    if (row.active === false) { results.push({ ok: true, skipped: true, project: project.code, reason: 'Digest disabled' }); continue }
    const dateObj = nextBusinessDayDateObj(row.notify_days)
    const notifyHour = row.notify_hour ?? 22
    const notifyMinute = row.notify_minute ?? 15
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      results.push({ ok: true, skipped: true, project: project.code, reason: 'Not the configured send time yet' })
      continue
    }
    if (row.last_sent_date === isoDate(dateObj)) {
      results.push({ ok: true, skipped: true, project: project.code, reason: 'Already sent for this date' })
      continue
    }
    try {
      const r = await runForProject({ settingsRow: row, project, dateObj, isManualTest: false })
      results.push(r)
    } catch (e) {
      results.push({ ok: false, project: project.code, reason: e.message })
    }
  }
  return { ok: true, results }
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  const isManualTest = event.httpMethod === 'POST' && !isScheduled

  if (!isScheduled && !isManualTest) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only (or scheduled invocation)' }) }
  }

  let dashboardType
  if (isManualTest) {
    try { ({ dashboardType } = JSON.parse(event.body || '{}')) } catch { /* noop */ }
    if (!dashboardType) {
      return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'dashboardType required for manual test, e.g. "fefo_faioa5"' }) }
    }
  }

  try {
    const result = await runDigest({ isManualTest, dashboardType })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
