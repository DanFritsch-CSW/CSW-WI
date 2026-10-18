// Weekly agent learning report -- Dan's improvement #4 (2026-10-18). NETLIFY
// delivery path. The report itself (data + proposals) is built by Postgres
// functions in Supabase (public.generate_learning_proposals() and
// public.weekly_learning_report_data()); this file fetches that data over the
// Supabase REST API, formats a SHORT text, and posts it to Dan as a Front TASK
// (POST /conversations type:'task', teammate_ids -- same mechanism as the
// nightly digests). It exists because the Supabase-side Edge Function
// `weekly-learning-report` cannot deliver: Front refuses task creation from
// the scheduling_agent's AI identity ("An AI teammate cannot start a task")
// and that project has no Front API token secret. Netlify already holds
// FRONT_API_TOKEN and SUPABASE_SERVICE_ROLE_KEY, so no new env var is needed
// (this site is at Lambda's 4KB env-var ceiling -- do NOT add one).
//
// NOTHING proposed here is applied automatically. Dan approves/rejects in
// Claude chat; public.apply_learning_proposal(id) merges an approved owner
// alias into settings.owner_aliases (read by scheduling-agent-webhook on every
// intake). Every run -- posted or failed -- is logged to public.digest_runs.
//
// KEEP THE TEXT BUILDER IN SYNC with the Edge Function's buildReport()
// (supabase function weekly-learning-report) -- or delete that function once
// this path is live.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const DAN_TEAMMATE_ID = 'tea_a3e8k'
const DIGEST_NAME = 'weekly-learning-report'

const FIELD_LABELS = {
  warehouse: 'Warehouse', type: 'Type', project: 'Project', owner: 'Owner', arrival_date: 'Arrival Date',
  arrival_time: 'Arrival Time', dock_door: 'Dock Door', carrier: 'Carrier', reference: 'Reference #', notes: 'Notes',
}

const sbHeaders = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' })

async function rpc(name) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: sbHeaders(), body: '{}' })
  const text = await res.text()
  if (!res.ok) throw new Error(`rpc ${name} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  try { return JSON.parse(text) } catch { return text }
}

async function logRun({ posted, taskId, error, detail }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/digest_runs`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ digest: DIGEST_NAME, posted: !!posted, task_id: taskId || null, error: error || null, detail: detail || null }),
    })
  } catch (_) { /* best effort */ }
}

const md = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${m}/${d}` }
const pct = (m, c) => (c > 0 ? `${Math.round((m / c) * 100)}% (${m}/${c})` : 'no data')
const clip = (s, n = 28) => { const t = String(s == null ? '' : s).trim(); return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t }

export function buildReport(data) {
  const subject = `Weekly agent learning report \u2014 ${md(data.period_end)}`
  const L = []
  const g = data.graded || {}
  L.push(`Week ${md(data.period_start)}\u2013${md(data.period_end)}: ${g.cur ?? 0} graded appointments (prior week: ${g.prev ?? 0}).`)
  L.push('')
  L.push('Accuracy per field \u2014 this week vs prior week:')
  for (const f of data.fields || []) {
    const cur = f.cur_compared > 0 ? f.cur_matched / f.cur_compared : null
    const prev = f.prev_compared > 0 ? f.prev_matched / f.prev_compared : null
    let trend = ''
    if (cur !== null && prev !== null) trend = cur > prev + 0.005 ? ' \u25b2' : cur < prev - 0.005 ? ' \u25bc' : ' \u2248'
    L.push(`- ${FIELD_LABELS[f.field] || f.field}: ${pct(f.cur_matched, f.cur_compared)} vs ${pct(f.prev_matched, f.prev_compared)}${trend}`)
  }
  const fill = data.fill || {}
  L.push('')
  L.push(`Learning paths this week (counts start with the 10/18 deploy), out of ${fill.intakes ?? 0} intakes: owner from sender history ${fill.owner_from_sender ?? 0}, carrier from sender history ${fill.carrier_from_sender ?? 0}, Datex order matched ${fill.datex_found ?? 0} (applied ${fill.datex_applied ?? 0}, overruled by sender history ${fill.datex_conflict ?? 0}).`)
  L.push('')
  const props = data.proposals || []
  if (props.length === 0) {
    L.push('Proposals awaiting your decision: none.')
  } else {
    L.push(`Proposals awaiting your decision (${data.proposal_count}) \u2014 nothing is applied until you approve. In Claude chat say e.g. "approve 1,2" or "reject 3":`)
    for (const p of props) {
      L.push(`${p.id}. Owner alias: "${clip(p.agent_value, 40)}" \u2192 "${clip(p.csr_value, 40)}" (${p.occurrences}\u00d7, ${Math.round(Number(p.share) * 100)}% of the time)`)
    }
  }
  const misses = data.top_misses || []
  if (misses.length) {
    L.push('')
    L.push('Biggest real misses this week (agent and CSR both filled, different):')
    for (const m of misses) {
      L.push(`- ${FIELD_LABELS[m.field] || m.field} \u00b7 ${clip(m.customer, 32)}: ${m.misses} (e.g. "${clip(m.example_agent, 24)}" \u2192 "${clip(m.example_csr, 24)}")`)
    }
  }
  const senders = data.unresolved_senders || []
  if (senders.length) {
    L.push('')
    L.push("Senders with volume but no dominant customer (sender defaults can't help):")
    for (const s of senders) L.push(`- ${s.sender}: ${s.appointments} appointments \u2014 ${clip(s.owners, 90)}`)
  }
  return { subject, description: L.join('\n') }
}

async function createFrontTask(subject, description) {
  const res = await fetch('https://api2.frontapp.com/conversations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ type: 'task', teammate_ids: [DAN_TEAMMATE_ID], subject, description }),
  })
  const text = await res.text().catch(() => '')
  let id = null
  if (res.ok) { try { id = JSON.parse(text).id } catch (_) { /* leave null */ } }
  return { ok: res.ok, status: res.status, text, id }
}

export async function runWeeklyReport({ dry = false } = {}) {
  try {
    const proposalsWritten = await rpc('generate_learning_proposals')
    const data = await rpc('weekly_learning_report_data')
    const { subject, description } = buildReport(data)
    if (dry) return { dry: true, proposalsWritten, subject, description, chars: description.length }
    const attempt = await createFrontTask(subject, description)
    if (!attempt.ok) {
      const error = `Front create task -> HTTP ${attempt.status}: ${attempt.text.slice(0, 300)}`
      await logRun({ posted: false, error, detail: { channel: 'netlify', chars: description.length } })
      throw new Error(error)
    }
    await logRun({ posted: true, taskId: attempt.id, detail: { channel: 'netlify', chars: description.length, proposalsWritten } })
    return { posted: true, taskId: attempt.id, chars: description.length, proposalsWritten }
  } catch (err) {
    if (!String(err.message).startsWith('Front create task')) await logRun({ posted: false, error: String(err.message).slice(0, 800), detail: { channel: 'netlify' } })
    throw err
  }
}
