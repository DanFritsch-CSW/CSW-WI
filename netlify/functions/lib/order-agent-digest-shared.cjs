'use strict'

// order_agent -- nightly USAGE digest. ADDED 2026-10-21, Dan's explicit
// request: "I don't have a good measure of how many times [order_agent] is
// being used, or how effective it is" -- same shape as the Scheduling
// Agent's field-accuracy digest (lib/agent-accuracy-digest-shared.cjs):
// percentages only, TODAY (America/Chicago calendar day) next to a ROLLING
// 7 DAYS column, delivered as a Front Task assigned to Dan, every night.
//
// THE METRIC. For each customer order_agent serves: of the outbound Sales
// Orders created in Datex that day, what share were created by the Datex
// user "SmartUp API" (the user order_agent's pushes run as -- Datex stamps
// the creator on orders.created_sys_user) versus any other user (a CSR
// keying it by hand). Read straight from MotherDuck, no Supabase / Front
// signal needed. Deliberately NOT tracked (Dan, 2026-10-21): orders the
// agent flagged to a CSR instead of creating -- those leave no Datex row.
//
// SOURCE + FILTERS (all confirmed live against production_db 2026-10-21):
//   - production_db.silver.datex_slv_orders is CDC: many versions per
//     order_id, so dedupe to the latest by parquet_record_sys_date_time and
//     drop parquet_record_operation_type = 'D'.
//   - order_class_id = 2 only (outbound Sales Order). The API user ALSO
//     stamps class-14 orders for Pedone/Richelieu -- one per agent order,
//     i.e. derived twins -- which would double-count the agent.
//   - Orders are joined to datex_slv_projects (latest version) on project
//     lookup_code. Add a customer = add one entry to CUSTOMERS below.
//   - created_sys_date_time is UTC; bucketed to the America/Chicago day.
//
// KNOWN LIMITS (the digest is honest about these, it does not hide them):
//   - "Other" includes orders that could never have been an agent order
//     (e.g. a Grassland order that did not arrive as a release-form
//     email). A low share for a customer therefore means "check why", not
//     "agent is broken" -- Datex alone cannot tell the two apart.
//   - A test push or a duplicate (e.g. Pedone 10/15) counts as agent usage.
//
// Delivery mirrors the other digests: posts EVERY night (the task is the
// heartbeat), posts a short "DIGEST FAILED" task if the MotherDuck query or
// the Front POST fails, and logs every run to public.digest_runs. No new
// env vars (this Netlify site is at Lambda's 4KB env ceiling) --
// MOTHERDUCK_TOKEN, FRONT_API_TOKEN/FRONT_API_KEY and the Supabase vars are
// all already set. Needs the duckdb bundling block in netlify.toml.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

// Dan Fritsch's Front teammate ID (same constant as the other digests).
const DAN_TEAMMATE_ID = 'tea_a3e8k'

const SMARTUP_USER = 'SmartUp API'
const OUTBOUND_SALES_ORDER_CLASS_ID = 2

// Render order = array order. `projects` are Datex project lookup codes.
const CUSTOMERS = [
  { label: 'Grassland', projects: ['GRAFG1', 'GRASM1', 'GRALA1'] },
  { label: 'Richelieu', projects: ['RICHR5'] },
  { label: 'Pedone Pinsa', projects: ['PEDPI5'] },
  { label: 'Thomas Foods', projects: ['THOMA5'] },
  { label: 'Echo Lake', projects: ['ECHOL5'] },
  { label: 'DSM', projects: ['DSMEN5', 'DSMFO8'] },
]

const PROJECT_TO_CUSTOMER = {}
for (const c of CUSTOMERS) for (const p of c.projects) PROJECT_TO_CUSTOMER[p] = c.label

// America/Chicago calendar date ('YYYY-MM-DD') for an ISO timestamp / Date.
function centralDateStr(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
}

// Today (Central) plus the 6 days before it, newest first. Built from the
// Central date string via UTC arithmetic so DST can never skip/repeat a day.
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

function buildSql(sinceDate) {
  const codes = Object.keys(PROJECT_TO_CUSTOMER).map((c) => `'${c}'`).join(',')
  return `
    WITH latest AS (
      SELECT * FROM production_db.silver.datex_slv_orders
      QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY parquet_record_sys_date_time DESC) = 1
    ), proj AS (
      SELECT * FROM production_db.silver.datex_slv_projects
      QUALIFY ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY parquet_record_sys_date_time DESC) = 1
    )
    SELECT
      strftime(CAST(timezone('America/Chicago', timezone('UTC', o.created_sys_date_time)) AS DATE), '%Y-%m-%d') AS day,
      p.lookup_code AS project,
      SUM(CASE WHEN o.created_sys_user = '${SMARTUP_USER}' THEN 1 ELSE 0 END) AS agent_n,
      SUM(CASE WHEN o.created_sys_user IS DISTINCT FROM '${SMARTUP_USER}' THEN 1 ELSE 0 END) AS other_n
    FROM latest o
    JOIN proj p USING (project_id)
    WHERE p.lookup_code IN (${codes})
      AND o.order_class_id = ${OUTBOUND_SALES_ORDER_CLASS_ID}
      AND o.created_sys_date_time >= TIMESTAMP '${sinceDate} 00:00:00'
      AND (o.parquet_record_operation_type IS NULL OR o.parquet_record_operation_type <> 'D')
    GROUP BY 1, 2
  `
}

// Rows: [{ day:'YYYY-MM-DD', project, agent, other }]
async function queryOrdersFromMotherDuck(sinceDate) {
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) throw new Error('MOTHERDUCK_TOKEN not configured')

  // Same duckdb connection pattern as owners-sync-shared.cjs /
  // scheduling-order-search.cjs (HOME=/tmp for the native module).
  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
  const conn = db.connect()
  try {
    await new Promise((resolve, reject) => conn.run('LOAD motherduck', (err) => (err ? reject(err) : resolve())))
    const rows = await new Promise((resolve, reject) => conn.all(buildSql(sinceDate), (err, r) => (err ? reject(err) : resolve(r))))
    return rows.map((r) => ({
      day: String(r.day),
      project: String(r.project),
      agent: Number(r.agent_n),
      other: Number(r.other_n),
    }))
  } finally {
    conn.close()
    db.close()
  }
}

function fmtShare(agent, total) {
  if (total === 0) return 'no orders'
  return `${((agent / total) * 100).toFixed(0)}% (${agent}/${total})`
}

// Pure function (unit-testable): rows -> { subject, description, ... }
function buildSummary(rows, dates = lastNCentralDates(7)) {
  const todayKey = dates[0]
  const weekSet = new Set(dates)
  const blank = () => ({ agent: 0, total: 0 })
  const today = {}
  const week = {}
  for (const c of CUSTOMERS) { today[c.label] = blank(); week[c.label] = blank() }

  for (const r of rows) {
    const cust = PROJECT_TO_CUSTOMER[r.project]
    if (!cust || !weekSet.has(r.day)) continue
    week[cust].agent += r.agent
    week[cust].total += r.agent + r.other
    if (r.day === todayKey) {
      today[cust].agent += r.agent
      today[cust].total += r.agent + r.other
    }
  }

  const sum = (m, skip) => {
    const t = blank()
    for (const c of CUSTOMERS) {
      if (skip && skip.includes(c.label)) continue
      t.agent += m[c.label].agent
      t.total += m[c.label].total
    }
    return t
  }
  const allToday = sum(today)
  const allWeek = sum(week)
  const exToday = sum(today, ['Grassland'])
  const exWeek = sum(week, ['Grassland'])

  const lines = []
  lines.push('Share of outbound orders created by order_agent (SmartUp API) vs. entered by hand')
  lines.push(`Today ${mdLabel(todayKey)} | rolling 7 days (${mdLabel(dates[dates.length - 1])}–${mdLabel(todayKey)}):`)
  lines.push('')
  for (const c of CUSTOMERS) {
    lines.push(`- ${c.label}: ${fmtShare(today[c.label].agent, today[c.label].total)} | ${fmtShare(week[c.label].agent, week[c.label].total)}`)
  }
  lines.push('')
  lines.push(`- All customers: ${fmtShare(allToday.agent, allToday.total)} | ${fmtShare(allWeek.agent, allWeek.total)}`)
  lines.push(`- Excluding Grassland: ${fmtShare(exToday.agent, exToday.total)} | ${fmtShare(exWeek.agent, exWeek.total)}`)

  // Customers with orders in the week but zero agent orders: where to look.
  const unused = CUSTOMERS.filter((c) => week[c.label].total > 0 && week[c.label].agent === 0).map((c) => c.label)
  if (unused.length) {
    lines.push('')
    lines.push(`No agent orders in the last 7 days: ${unused.join(', ')}`)
  }
  if (allToday.total === 0) {
    lines.push('')
    lines.push('No outbound orders were created for these customers today, so the left column is empty.')
  }

  return {
    subject: `order_agent Usage — ${mdLabel(todayKey)}`,
    description: lines.join('\n'),
    todayTotal: allToday.total,
    todayAgent: allToday.agent,
    weekTotal: allWeek.total,
    weekAgent: allWeek.agent,
  }
}

async function createFrontTask(subject, description) {
  const res = await fetch('https://api2.frontapp.com/conversations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ type: 'task', teammate_ids: [DAN_TEAMMATE_ID], subject, description }),
  })
  const text = await res.text().catch(() => '')
  let id = null
  if (res.ok) {
    try { id = JSON.parse(text).id } catch (_) { /* leave null */ }
  }
  return { ok: res.ok, status: res.status, text, id }
}

// Every run -- posted or failed -- is logged to public.digest_runs.
async function logRun({ posted, taskId, error, detail }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/digest_runs`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ digest: 'order-agent-digest', posted: !!posted, task_id: taskId || null, error: error || null, detail: detail || null }),
    })
  } catch (_) { /* best effort */ }
}

async function postDigest() {
  const dates = lastNCentralDates(7)
  let summary
  try {
    // One day of slack before the 7-day window for the Chicago/UTC offset;
    // buildSummary re-filters on the exact Central dates.
    const sinceDate = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) - 24 * 3600 * 1000).toISOString().slice(0, 10)
    const rows = await queryOrdersFromMotherDuck(sinceDate)
    summary = buildSummary(rows, dates)
  } catch (e) {
    const err = String(e.message).slice(0, 300)
    console.error('[order-agent-digest] query failed ->', err)
    const subject = `order_agent Usage — ${mdLabel(dates[0])} — DIGEST FAILED`
    await createFrontTask(subject, `The order_agent usage digest could not read Datex orders from MotherDuck.\n\nError: ${err}`)
    await logRun({ posted: false, error: err })
    const e2 = new Error(`MotherDuck query -> ${err}`)
    throw e2
  }

  const { subject, description, todayTotal, todayAgent, weekTotal, weekAgent } = summary
  const attempt = await createFrontTask(subject, description)
  if (!attempt.ok) {
    const err = `HTTP ${attempt.status}: ${attempt.text.slice(0, 300)}`
    console.error('[order-agent-digest] post failed ->', err)
    await createFrontTask(`${subject} — DIGEST FAILED`, `The order_agent usage digest could not be posted to Front.\n\nError: ${err}\n\nToday ${todayAgent}/${todayTotal} agent orders; last 7 days ${weekAgent}/${weekTotal}.`)
    await logRun({ posted: false, error: err, detail: { todayTotal, todayAgent, weekTotal, weekAgent } })
    throw new Error(`Front create-conversation (task) API -> ${err}`)
  }
  await logRun({ posted: true, taskId: attempt.id, detail: { todayTotal, todayAgent, weekTotal, weekAgent, chars: description.length } })
  return { posted: true, todayTotal, todayAgent, weekTotal, weekAgent, taskId: attempt.id }
}

module.exports = { postDigest, buildSummary, buildSql }
