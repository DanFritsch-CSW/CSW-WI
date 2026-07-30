'use strict'

// Shared core for the FEFO Lot Reallocation Alert — split out 2026-07-30
// from fefo-lot-reallocation-alert.cjs.
//
// Same reason as lib/fefo-digest-shared.cjs's split: Netlify blocks direct
// HTTP invocation of any function carrying a `schedule` in netlify.toml.
// This module holds the actual detection/alerting logic; the scheduled
// function (fefo-lot-reallocation-alert.cjs, keeps its `schedule`) and the
// new manual-test-only function (fefo-lot-reallocation-alert-test.cjs, no
// schedule) both require this module rather than duplicating logic.
//
// See fefo-lot-reallocation-alert.cjs's original header (preserved in git
// history) for the full design history — most importantly, WHY this
// detects FEFO verdict transitions rather than raw task cancellations
// (the original cancel/reallocate-task approach was validated live and
// found unreliable — see that writeup for the full story).

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
  { id: 'palvi9', code: 'PALVI9', name: "Palermo's Caledonia", facility: 'cal' },
  { id: 'palma9', code: 'PALMA9', name: "Palermo's Caledonia Materials", facility: 'cal' },
  { id: 'paldsd9', code: 'PALDSD9', name: "Palermo's Caledonia DSD", facility: 'cal' },
]
const PROJECT_BY_DASHBOARD_TYPE = new Map(FEFO_PROJECTS.map(p => [`fefo_realloc_${p.id}`, p]))
const APP_URL = 'https://csw-wi.netlify.app/customers?tab=fefo'
const DAY_COUNT = 5

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

async function sbUpsert(path, rows) {
  if (!rows.length) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: `resolution=merge-duplicates,return=minimal`,
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(t) }
}

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

function buildAlertBody(newlyViolating, project) {
  const lines = []
  lines.push(`⚠ FEFO Lot Reallocation Alert — ${project.name} (${project.code})`)
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push('')
  const divider = '─'.repeat(28)
  lines.push(divider)
  lines.push(`**${newlyViolating.length} order${newlyViolating.length === 1 ? '' : 's'} newly out of rotation**`)
  lines.push(divider)
  lines.push('')
  lines.push('These orders were shipping the oldest available stock as of the last check (~30 min ago) and now are not — a newer lot got allocated in place of older, unallocated, off-hold stock that is still on hand.')
  lines.push('')
  for (const o of newlyViolating) {
    const days = orderMaxDaysOlder(o)
    const sev = orderSeverity(o)
    lines.push(`• ${o.id} — ${days}d older${sev ? ` (${sev.toUpperCase()})` : ''} — ${o.dest || 'dest unknown'}${o.appt ? ` — appt ${o.appt}` : ''}`)
    lines.push('')
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function buildTestOkBody(project) {
  return [
    `✓ FEFO Lot Reallocation Alert test — ${project.name} (${project.code})`,
    '',
    'Test successful — this Front conversation is wired up correctly. No newly-appearing FEFO violations were found for this project just now (that\'s expected most of the time — this only posts again when a real one shows up).',
  ].join('\n')
}

async function postFrontComment(conversationId, body) {
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

async function runForProject({ settingsRow, project, isManualTest }) {
  const conversationId = settingsRow?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for ${project.code}`, project: project.code }
  }

  const ordersRes = await fetch(`${SITE_URL}/.netlify/functions/fefo-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility: project.facility, projectIds: [project.id], dayCount: DAY_COUNT }),
  })
  const ordersText = await ordersRes.text()
  let ordersJson
  try { ordersJson = JSON.parse(ordersText) } catch { ordersJson = { raw: ordersText } }
  if (!ordersRes.ok) {
    return { ok: false, reason: 'fefo-orders failed', detail: ordersJson, project: project.code }
  }

  const orders = ordersJson.ordersByProject?.[project.id] || []
  const dashboardType = `fefo_realloc_${project.id}`

  const prevRows = orders.length
    ? await sbFetch(
        `fefo_order_verdict_state?dashboard_type=eq.${dashboardType}&order_id=in.(${orders.map(o => `"${o.id}"`).join(',')})&select=order_id,verdict`
      )
    : []
  const prevByOrderId = new Map((prevRows || []).map(r => [r.order_id, r.verdict]))

  const newlyViolating = []
  const stateRows = []
  for (const o of orders) {
    const verdict = orderVerdict(o)
    const severity = verdict === 'violation' ? orderSeverity(o) : null
    stateRows.push({ dashboard_type: dashboardType, order_id: o.id, verdict, severity, updated_at: new Date().toISOString() })
    const prevVerdict = prevByOrderId.get(o.id)
    if (verdict === 'violation' && prevVerdict !== 'violation') {
      newlyViolating.push(o)
    }
  }

  await sbUpsert('fefo_order_verdict_state', stateRows)

  if (newlyViolating.length > 0) {
    const body = buildAlertBody(newlyViolating, project)
    const front = await postFrontComment(conversationId, body)
    return { ok: true, project: project.code, alerted: true, newlyViolatingCount: newlyViolating.length, commentId: front.id }
  }

  if (isManualTest) {
    const front = await postFrontComment(conversationId, buildTestOkBody(project))
    return { ok: true, project: project.code, alerted: false, testConfirmation: true, commentId: front.id }
  }

  return { ok: true, project: project.code, alerted: false, orderCount: orders.length }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  FEFO_PROJECTS, PROJECT_BY_DASHBOARD_TYPE,
  sbFetch,
  runForProject,
}
