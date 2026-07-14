'use strict'

// Nightly FEFO Rotation digest — per-project (not per-facility, since all 5
// FEFO customers are KEN). Added 2026-07-14 per Dan's request for
// customer/project-level FEFO notify settings, similar in spirit to
// Pre-Pick/Cases-to-Pick/Daily Ops but scoped per PROJECT instead of per
// facility.
//
// ── Why one settings row per project instead of one combined digest ───────
// Dan's call: each of the 5 FEFO projects (Fair Oaks, Fair Oaks West,
// Richelieu, Crown Bakeries, Birchwood) gets its OWN prepick_notify_settings
// row — facility='ken', dashboard_type='fefo_<projectId>' (e.g.
// 'fefo_faioa5') — with its own Front conversation, its own send time, and
// its own Enabled toggle. No schema change was needed: the table's existing
// composite key (facility, dashboard_type) already supports this, we're
// just seeding 5 new dashboard_type values instead of 1.
//
// This one Netlify function is SHARED across all 5 rows (one file, one
// cron tick every 15 min) rather than 5 separate function files — the only
// thing that differs per row is which project's data to pull and which
// conversation to post to, so looping 5 settings rows inside one scheduled
// tick is simpler than 5 near-identical function files.
//
// ── Content date is TODAY, not tomorrow ─────────────────────────────────────
// Pre-Pick/Cases/Daily Ops summarize TOMORROW because they're appointment-
// staffing digests that fire the night before a shift. FEFO is "is rotation
// compliant right now" — there's no lead-time reason to summarize tomorrow's
// state before it exists. This digest summarizes TODAY, at whatever time of
// day is configured per project. Because content date === fire date here,
// this function does NOT need the skip_to_next_valid_day lookahead machinery
// the other three digests have (that existed specifically because THEIR
// content date is offset one day from the fire date). notify_days is
// checked directly against today's weekday.
//
// ── Content scope: full status, not violations-only ─────────────────────────
// Confirmed with Dan: the digest always states the full picture — order
// count, clean count, and every non-clean category (violations w/ severity,
// stale, hold, blocked, undated lots) — rather than only firing when
// something's wrong. An all-clear day still posts a short "no issues"
// comment, same full-status philosophy as the live tab's banners.
//
// Data source: proxies to fefo-orders.cjs (the same MotherDuck-backed
// function the live FEFO Rotation tab uses) with dayCount:1 so the query
// window is yesterday→today, matching the live tab's "day 0 = Today"
// bucket exactly. Verdict/severity/undated-lot logic below is a straight
// port of src/lib/fefo.js's pure functions — kept deliberately simple and
// dependency-free so it can run in this CJS function; mirror any future
// changes made to fefo.js's verdict engine here too.
//
// Two invocation paths (same convention as the other digests):
//   1. SCHEDULED (netlify.toml: "*/15 * * * *") — loops every
//      facility='ken' AND dashboard_type LIKE 'fefo_%' row, fires whichever
//      one(s) match the current America/Chicago time + configured day.
//   2. MANUAL TEST — POST { dashboardType: 'fefo_<projectId>' }. Unlike the
//      single-row digests, this one MUST be told which project's settings
//      row to use, since one function backs 5 rows. Always sends
//      immediately for TODAY regardless of time/day/active, and does not
//      touch last_sent_date (same "test doesn't interfere with the real
//      scheduled send" reasoning as the other digests).

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

const FEFO_PROJECTS = [
  { id: 'faioa5', code: 'FAIOA5', name: 'Fair Oaks Farms' },
  { id: 'fofwe5', code: 'FOFWE5', name: 'Fair Oaks Farms West' },
  { id: 'riche5', code: 'RICHE5', name: 'Richelieu Foods' },
  { id: 'golst5', code: 'GOLST5', name: 'Crown Bakeries' },
  { id: 'birch5', code: 'BIRCH5', name: 'Birchwood Foods' },
]
const PROJECT_BY_DASHBOARD_TYPE = new Map(FEFO_PROJECTS.map(p => [`fefo_${p.id}`, p]))

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

function buildDigestBody(orders, project, dateObj) {
  const lines = []
  lines.push(`FEFO Rotation — ${project.name} (${project.code}) — ${formatHeaderDate(dateObj)}`)
  lines.push('')

  if (orders.length === 0) {
    lines.push("No orders in today's FEFO window for this project.")
    return lines.join('\n')
  }

  const byVerdict = { violation: [], stale: [], hold: [], blocked: [], clean: [] }
  for (const o of orders) byVerdict[orderVerdict(o)].push(o)

  const critical = byVerdict.violation.filter(o => orderSeverity(o) === 'critical').length
  const warning = byVerdict.violation.filter(o => orderSeverity(o) === 'warning').length
  const undated = undatedLotCount(orders)

  const summaryParts = []
  if (byVerdict.violation.length) {
    const sevBits = [critical ? `${critical} critical` : '', warning ? `${warning} warning` : ''].filter(Boolean).join(' · ')
    summaryParts.push(`${byVerdict.violation.length} violation${byVerdict.violation.length === 1 ? '' : 's'}${sevBits ? ` (${sevBits})` : ''}`)
  }
  if (byVerdict.stale.length) summaryParts.push(`${byVerdict.stale.length} stale`)
  if (byVerdict.hold.length) summaryParts.push(`${byVerdict.hold.length} on hold`)
  if (byVerdict.blocked.length) summaryParts.push(`${byVerdict.blocked.length} in receiving`)
  lines.push(`${orders.length} orders in rotation window. ${byVerdict.clean.length} clean${summaryParts.length ? ', ' + summaryParts.join(', ') : ''}.`)

  if (byVerdict.violation.length) {
    lines.push('')
    lines.push('Violations:')
    for (const o of byVerdict.violation) {
      const days = orderMaxDaysOlder(o)
      const sev = orderSeverity(o)
      lines.push(`- ${o.id} — ${days}d older stock available, unallocated${sev ? ` (${sev.toUpperCase()})` : ''} — ${o.dest || 'dest unknown'}`)
    }
  }
  if (byVerdict.hold.length) {
    lines.push('')
    lines.push('On hold (older lot correctly skipped):')
    for (const o of byVerdict.hold) lines.push(`- ${o.id} — ${o.dest || 'dest unknown'}`)
  }
  if (byVerdict.blocked.length) {
    lines.push('')
    lines.push('In receiving / not put away:')
    for (const o of byVerdict.blocked) lines.push(`- ${o.id} — ${o.dest || 'dest unknown'}`)
  }
  if (byVerdict.stale.length) {
    lines.push('')
    lines.push('Stale (past appointment, still allocated):')
    for (const o of byVerdict.stale) lines.push(`- ${o.id} — ${o.dest || 'dest unknown'}`)
  }
  if (undated > 0) {
    lines.push('')
    lines.push(`⚠ ${undated} lot${undated === 1 ? '' : 's'} with no parseable date in this window — verify in Datex.`)
  }
  if (!byVerdict.violation.length && !byVerdict.stale.length && !byVerdict.hold.length && !byVerdict.blocked.length && undated === 0) {
    lines.push('')
    lines.push('✓ All orders pulling oldest available stock — no issues.')
  }
  return lines.join('\n')
}

// ── Core per-project run ────────────────────────────────────────────────────

async function runForProject({ settingsRow, project, dateObj, isManualTest }) {
  const conversationId = settingsRow?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for ${project.code}`, project: project.code }
  }

  const date = isoDate(dateObj)
  const ordersRes = await fetch(`${SITE_URL}/.netlify/functions/fefo-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility: 'ken', projectIds: [project.id], dayCount: 1 }),
  })
  const ordersText = await ordersRes.text()
  let ordersJson
  try { ordersJson = JSON.parse(ordersText) } catch { ordersJson = { raw: ordersText } }
  if (!ordersRes.ok) {
    return { ok: false, reason: 'fefo-orders failed', detail: ordersJson, project: project.code }
  }

  const allOrders = ordersJson.ordersByProject?.[project.id] || []
  const todayOrders = allOrders.filter(o => o.day === 0)

  const body = buildDigestBody(todayOrders, project, dateObj)

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
    await sbPatch(`prepick_notify_settings?facility=eq.ken&dashboard_type=eq.fefo_${project.id}`, { last_sent_date: date })
  }

  return { ok: true, date, project: project.code, conversationId, commentId: frontJson.id, orderCount: todayOrders.length }
}

async function runDigest({ isManualTest, dashboardType }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const dateObj = centralTodayDateObj()

  if (isManualTest) {
    const project = PROJECT_BY_DASHBOARD_TYPE.get(dashboardType)
    if (!project) return { ok: false, reason: `Unknown dashboardType '${dashboardType}'` }
    const rows = await sbFetch(
      `prepick_notify_settings?facility=eq.ken&dashboard_type=eq.${dashboardType}&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
    )
    const result = await runForProject({ settingsRow: rows?.[0], project, dateObj, isManualTest: true })
    return result
  }

  // Scheduled tick — loop every fefo_* row for ken and fire whichever
  // one(s) match the current time/day and haven't already sent today.
  const rows = await sbFetch(
    `prepick_notify_settings?facility=eq.ken&dashboard_type=like.fefo_*&select=dashboard_type,front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const results = []
  for (const row of (rows || [])) {
    const project = PROJECT_BY_DASHBOARD_TYPE.get(row.dashboard_type)
    if (!project) continue
    if (row.active === false) { results.push({ ok: true, skipped: true, project: project.code, reason: 'Digest disabled' }); continue }
    const notifyDays = row.notify_days ?? [1, 2, 3, 4, 5]
    if (!notifyDays.includes(isoWeekday(dateObj))) {
      results.push({ ok: true, skipped: true, project: project.code, reason: 'Not a configured notify day' })
      continue
    }
    const notifyHour = row.notify_hour ?? 22
    const notifyMinute = row.notify_minute ?? 15
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      results.push({ ok: true, skipped: true, project: project.code, reason: 'Not the configured send time yet' })
      continue
    }
    if (row.last_sent_date === isoDate(dateObj)) {
      results.push({ ok: true, skipped: true, project: project.code, reason: 'Already sent today' })
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
