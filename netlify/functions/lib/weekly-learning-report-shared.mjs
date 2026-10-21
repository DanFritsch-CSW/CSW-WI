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
// REFERENCE # CALLOUT 2026-10-21 (Dan's explicit request: "call this out and
// watch the progress"): when public.weekly_reference_report_data() reports
// configured (settings.reference_fixes.deployed_at is set), the report gains a
// "Reference # fixes" block right under the per-field accuracy table:
// accuracy since go-live vs before for the three targeted customers
// (Palermo's, Pretzilla, Fair Oaks, Grassland, Birchwood, Sargento, Richelieu, Rhodes, Crown) combined and one by one, plus everyone else
// as a no-fix CONTROL line (it should stay flat -- if it moves too, the change
// is not the fixes), how often each fix fired in the last 7 days (from
// public.reference_fix_events written by the scheduling-reference-fixer Edge
// Function), a Grassland weekly-list health line (lists loaded, ship dates covered,
// pending requests waiting; warns when no list covers the next 6 days), and the
// biggest remaining misses on the targeted customers. Both
// periods are graded with the same normalizer (public.norm_reference), so the
// comparison is not flattered by the grading cleanup. The data call is
// optional: if it fails, the weekly report still goes out without the block.
//
// KEEP THE TEXT BUILDER IN SYNC with the Edge Function's buildReport()
// (supabase function weekly-learning-report) -- or delete that function once
// this path is live. (As of 2026-10-21 that copy does NOT have the Reference #
// block; Netlify is the delivery path that matters.)

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

const REF_TARGETS = ['palermo', 'pretzilla', 'fairoaks', 'grassland', 'birchwood', 'sargento', 'richelieu', 'rhodes', 'crown']
const REF_GROUP_LABELS = {
  palermo: "Palermo's", pretzilla: 'Pretzilla', fairoaks: 'Fair Oaks', grassland: 'Grassland',
  birchwood: 'Birchwood', sargento: 'Sargento', richelieu: 'Richelieu', rhodes: 'Rhodes', crown: 'Crown',
  other: 'Everyone else (no fix, control)',
}

// The "Reference # fixes" block -- see this file's 2026-10-21 header note.
// `ref` is the JSON from public.weekly_reference_report_data(); returns '' when
// it isn't configured/available so the report simply omits the block.
export function buildReferenceSection(ref) {
  if (!ref || ref.configured === false) return ''
  const groups = Array.isArray(ref.groups) ? ref.groups : []
  const get = (grp, period) => groups.find((g) => g.grp === grp && g.period === period) || { compared: 0, matched: 0, agent_blank: 0 }
  const sum = (grps, period) => grps.reduce((acc, g) => {
    const x = get(g, period)
    return { compared: acc.compared + Number(x.compared || 0), matched: acc.matched + Number(x.matched || 0) }
  }, { compared: 0, matched: 0 })
  const trend = (a, b) => {
    if (!a.compared || !b.compared) return ''
    const x = a.matched / a.compared
    const y = b.matched / b.compared
    return x > y + 0.005 ? ' \u25b2' : x < y - 0.005 ? ' \u25bc' : ' \u2248'
  }
  const line = (label, a, b) => `- ${label}: ${pct(a.matched, a.compared)} since go-live vs ${pct(b.matched, b.compared)} before${trend(a, b)}`
  const goLive = ref.deployed_at ? new Date(ref.deployed_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) : null

  const L = []
  L.push(`Reference # fixes${goLive ? ` \u2014 live since ${md(goLive)}` : ''} (appointments graded since go-live vs before, same normalized grading):`)
  const tA = sum(REF_TARGETS, 'after')
  const tB = sum(REF_TARGETS, 'before')
  L.push(line('Targeted customers combined', tA, tB))
  for (const g of REF_TARGETS) L.push(line(REF_GROUP_LABELS[g], get(g, 'after'), get(g, 'before')))
  L.push(line(REF_GROUP_LABELS.other, get('other', 'after'), get('other', 'before')))
  if (tA.compared < 10) L.push(`  (small sample so far: ${tA.compared} targeted appointments graded since go-live \u2014 read the trend loosely.)`)

  const tally = (list) => {
    const m = {}
    for (const f of list || []) m[f.kind] = (m[f.kind] || 0) + Number(f.n || 0)
    return m
  }
  const w = tally(ref.fires_week)
  L.push(`Fixes applied in the last 7 days: PU/SO/PO found in the first email ${w.label_applied || 0}, found only in a follow-up message ${w.followup_applied || 0}, Fair Oaks order # from Datex ${w.datex_owner_reference || 0}, Grassland order # from the weekly list ${w.list_applied || 0}, Birchwood/Sargento/Richelieu order # from Datex ${w.datex_order_pair || 0}, Richelieu PO prefix added ${w.prefix_applied || 0}, Rhodes S/R # from the load sheet ${w.loadsheet_applied || 0}, formatting clean-ups ${w.tidy_applied || 0}. PU/SO/PO not in the email at all (CSR has to ask the carrier): ${w.label_not_found || 0}. Fair Oaks order Datex couldn't resolve: ${w.datex_skipped || 0}.`)

  // Grassland weekly-list health: the list reader runs unattended, so a missing or changed list must be visible here.
  const gl = ref.grassland
  if (gl && Number(gl.map_rows) >= 0) {
    const cov = gl.coverage_through ? String(gl.coverage_through) : null
    let line = `Grassland weekly list: ${gl.lists_ingested || 0} list(s) loaded (${gl.map_rows || 0} loads)${cov ? `, covering ship dates through ${md(cov)}` : ''}; ${gl.pending_outbound_waiting || 0} pending Grassland outbound request(s) still waiting on a list.`
    if (!cov || (new Date(`${cov}T00:00:00Z`).getTime() - new Date(`${gl.today}T00:00:00Z`).getTime()) / 86400000 < 6) {
      line += ' \u26a0\ufe0f No list covers the coming week yet \u2014 check that Grassland sent it and that it landed in MAD Appointments.'
    }
    L.push(line)
  }

  const misses = Array.isArray(ref.misses) ? ref.misses : []
  if (misses.length) {
    L.push('Still wrong since go-live (targeted customers):')
    for (const m of misses) L.push(`- ${REF_GROUP_LABELS[m.grp] || m.grp}: "${clip(m.agent, 24)}" \u2192 "${clip(m.csr, 24)}" (${m.n}\u00d7)`)
  }
  return L.join('\n')
}

export function buildReport(data, refSection = '') {
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
  if (refSection) {
    L.push('')
    L.push(refSection)
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
    // Optional: never let the Reference # callout block the weekly report.
    let refData = null
    let refError = null
    try { refData = await rpc('weekly_reference_report_data') } catch (e) { refError = String(e.message).slice(0, 300) }
    const refSection = buildReferenceSection(refData)
    const { subject, description } = buildReport(data, refSection)
    if (dry) return { dry: true, proposalsWritten, subject, description, chars: description.length, refSection: !!refSection, refError }
    const attempt = await createFrontTask(subject, description)
    if (!attempt.ok) {
      const error = `Front create task -> HTTP ${attempt.status}: ${attempt.text.slice(0, 300)}`
      await logRun({ posted: false, error, detail: { channel: 'netlify', chars: description.length } })
      throw new Error(error)
    }
    await logRun({ posted: true, taskId: attempt.id, detail: { channel: 'netlify', chars: description.length, proposalsWritten, refSection: !!refSection, refError } })
    return { posted: true, taskId: attempt.id, chars: description.length, proposalsWritten }
  } catch (err) {
    if (!String(err.message).startsWith('Front create task')) await logRun({ posted: false, error: String(err.message).slice(0, 800), detail: { channel: 'netlify' } })
    throw err
  }
}
