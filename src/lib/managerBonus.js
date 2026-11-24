// Data access + attainment math for the quarterly bonus scorecard (Manager
// tab). Added 2026-07-28. Self-contained Supabase client (same reasoning
// as src/lib/revisions.js) rather than importing the main supabase.js,
// which is already ~76KB.
//
// Tables: bonus_scorecard_metrics (one row per facility/quarter/metric —
// weight/anchor/target_100/target_120/actual, all manager-editable) and
// bonus_scorecard_settings (one row per facility/quarter — annual_target_bonus).
// All 4 CRUD RLS policies verified via pg_policies before shipping.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

export const FACILITY_LABELS = {
  cal: 'Caledonia',
  ken: 'Kenosha',
  mad: 'Madison',
  wr:  'Wisconsin Rapids',
  ec:  'Eau Claire',
}

// Default templates used to seed a brand-new quarter AND (as of 2026-08-02)
// to force-reset Weight/Anchor/100%Target/120%Target back to these exact
// values on every page load — see resetConfigToTemplate below.
//
// 2026-11-24 per Dan/Dean (Nov 13 + Nov 20 Dean<>Dan check-ins): OSDs — $
// is retired network-wide starting Q4 2026 — a single high-dollar damage
// incident was disproportionately tanking a manager's whole-quarter score
// off one event. It had already been zeroed out (weight 0) for every
// facility except WR back on 2026-07-28, but the row itself was never
// removed from the template, so it kept reappearing as a dead, editable
// $0-weighted row on every page load via resetConfigToTemplate. Removed
// outright here for cal/ken/mad/ec (OSDs — count already covers the same
// ground for them at 25% weight). WR still had OSDs — $ live at 12.5%
// weight (it uses Case Pick Accuracy instead of OSDs — count, per the
// original 2026-07-28 direction noted above) — it's swapped for an
// OSDs — count metric at the same 12.5% weight rather than just deleted,
// so WR managers still have an OSD-related metric, just count-based
// instead of dollar-based. anchor/target_100/target_120 reuse the same
// 16/4/2 used elsewhere — no WR-specific historical OSD-count data source
// exists yet to calibrate a WR-specific number (see motherduck-osd-count.cjs
// — cal/ken/mad only, no WR Silver table). Revisit these three numbers once
// a few quarters of real WR counts come in, or once a WR data source gets
// built — actual is manual-entry only for WR until then.
export const DEFAULT_TEMPLATES = {
  standard: [
    { metric_key: 'takt',         label: 'Takt Performance',         unit: '%',     weight: 25,   anchor: 50,   target_100: 80,  target_120: 90,  sort_order: 1 },
    { metric_key: 'ott3',         label: 'OTT — 3 Hour',             unit: '%',     weight: 20,   anchor: 90,   target_100: 98,  target_120: 100, sort_order: 2 },
    { metric_key: 'ott2',         label: 'OTT — 2 Hour',             unit: '%',     weight: 5,    anchor: 85,   target_100: 95,  target_120: 98,  sort_order: 3 },
    { metric_key: 'osd_count',    label: 'OSDs — count',             unit: 'count', weight: 25,   anchor: 16,   target_100: 4,   target_120: 2,   sort_order: 4 },
    { metric_key: 'discretionary',label: 'Discretionary Evaluation', unit: '%',     weight: 25,   anchor: 50,   target_100: 100, target_120: 120, sort_order: 6 },
  ],
  wr: [
    { metric_key: 'takt',         label: 'Takt Performance',         unit: '%', weight: 25,   anchor: 50,   target_100: 80,   target_120: 90,   sort_order: 1 },
    { metric_key: 'ott3',         label: 'OTT — 3 Hour',             unit: '%', weight: 20,   anchor: 90,   target_100: 98,   target_120: 100,  sort_order: 2 },
    { metric_key: 'ott2',         label: 'OTT — 2 Hour',             unit: '%', weight: 5,    anchor: 85,   target_100: 95,   target_120: 98,   sort_order: 3 },
    { metric_key: 'case_pick',    label: 'Case Pick Accuracy',       unit: '%', weight: 12.5, anchor: 99.2, target_100: 99.6, target_120: 99.8, sort_order: 4 },
    { metric_key: 'osd_count',    label: 'OSDs — count',             unit: 'count', weight: 12.5, anchor: 16,  target_100: 4,   target_120: 2,    sort_order: 5 },
    { metric_key: 'discretionary',label: 'Discretionary Evaluation', unit: '%', weight: 25,   anchor: 50,   target_100: 100,  target_120: 120,  sort_order: 6 },
  ],
}

export function templateFor(facility) {
  return facility === 'wr' ? DEFAULT_TEMPLATES.wr : DEFAULT_TEMPLATES.standard
}

// Current quarter as 'YYYY-Qn', and the prior quarter for comparison.
export function currentQuarter(d = new Date()) {
  const y = d.getFullYear()
  const q = Math.floor(d.getMonth() / 3) + 1
  return `${y}-Q${q}`
}

export function priorQuarter(quarterStr) {
  const [yStr, qStr] = quarterStr.split('-Q')
  let y = Number(yStr)
  let q = Number(qStr) - 1
  if (q < 1) { q = 4; y -= 1 }
  return `${y}-Q${q}`
}

export async function fetchScorecard(facility, quarter) {
  const { data, error } = await supabase
    .from('bonus_scorecard_metrics')
    .select('*')
    .eq('facility', facility)
    .eq('quarter', quarter)
    .order('sort_order', { ascending: true })
  if (error) throw error
  return data
}

export async function fetchSettings(facility, quarter) {
  const { data, error } = await supabase
    .from('bonus_scorecard_settings')
    .select('*')
    .eq('facility', facility)
    .eq('quarter', quarter)
    .maybeSingle()
  if (error) throw error
  return data
}

// Seeds a facility/quarter with the default template — only used when a
// brand-new quarter has no rows yet (e.g. rolling forward). Never
// overwrites existing rows (ON CONFLICT DO NOTHING equivalent via upsert
// with ignoreDuplicates). Superseded in practice by resetConfigToTemplate
// below (called on every load as of 2026-08-02), but left in place since
// it also seeds bonus_scorecard_settings — kept for that side effect even
// though nothing reads annual_target_bonus from it anymore.
export async function seedQuarterIfMissing(facility, quarter) {
  const template = templateFor(facility)
  const rows = template.map((m) => ({ facility, quarter, ...m }))
  const { error } = await supabase
    .from('bonus_scorecard_metrics')
    .upsert(rows, { onConflict: 'facility,quarter,metric_key', ignoreDuplicates: true })
  if (error) throw error
  const { error: settingsErr } = await supabase
    .from('bonus_scorecard_settings')
    .upsert([{ facility, quarter, annual_target_bonus: null }], { onConflict: 'facility,quarter', ignoreDuplicates: true })
  if (settingsErr) throw settingsErr
}

// Force-resets Weight/Anchor/100%Target/120%Target (plus label/unit/
// sort_order) back to the canonical DEFAULT_TEMPLATES values on every
// call — added 2026-08-02 per Dan: these four config columns are
// meant to be a stable, shared definition of the scorecard, not
// something that should silently drift if someone accidentally edits a
// cell. Called on every page load/tab open for BOTH the current and
// prior quarter, so any accidental edit gets wiped clean the next time
// anyone opens the tab, before they'd ever notice it "stuck."
//
// Deliberately does NOT touch `actual` — that's real data (live-pulled
// metrics, or Dean's manual Q2 entries for Discretionary) and must
// survive this reset untouched. Achieved simply by never including
// `actual` in the upserted row objects: Supabase's upsert only sets the
// columns present in the payload, so any column left out (here, `actual`)
// is left completely alone on conflict — this is standard INSERT ...
// ON CONFLICT DO UPDATE SET behavior, not a full-row replace.
export async function resetConfigToTemplate(facility, quarter) {
  const template = templateFor(facility)
  const rows = template.map((m) => ({
    facility,
    quarter,
    metric_key: m.metric_key,
    label: m.label,
    unit: m.unit,
    weight: m.weight,
    anchor: m.anchor,
    target_100: m.target_100,
    target_120: m.target_120,
    sort_order: m.sort_order,
    updated_at: new Date().toISOString(),
  }))
  const { error } = await supabase
    .from('bonus_scorecard_metrics')
    .upsert(rows, { onConflict: 'facility,quarter,metric_key' })
  if (error) throw error
}

export async function updateMetric(id, patch) {
  const allowed = {}
  for (const key of ['label', 'unit', 'weight', 'anchor', 'target_100', 'target_120', 'actual', 'sort_order']) {
    if (key in patch) allowed[key] = patch[key]
  }
  const { error } = await supabase
    .from('bonus_scorecard_metrics')
    .update({ ...allowed, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function upsertSettings(facility, quarter, annualTargetBonus) {
  const { error } = await supabase
    .from('bonus_scorecard_settings')
    .upsert(
      [{ facility, quarter, annual_target_bonus: annualTargetBonus, updated_at: new Date().toISOString() }],
      { onConflict: 'facility,quarter' }
    )
  if (error) throw error
}

// Live OTT pull (2hr v2 + 3hr all) — added 2026-07-30. Direct MotherDuck
// query, not proxied through Omni's API (see motherduck-ott.cjs header for
// the full field-level replication of Omni's own calculation logic, and
// why the 'v2' 2hr variant specifically was chosen — confirmed with Dan
// that's the version the team actually uses on their dashboards).
export async function fetchLiveOtt(facility, quarter) {
  const res = await fetch('/.netlify/functions/motherduck-ott', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility, quarter }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`OTT pull failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return res.json()
}

// Live Case Pick Accuracy pull (WR only) — added 2026-07-30. Direct
// MotherDuck query against audit_app.shipment_container_discrepancies —
// see motherduck-case-pick-accuracy.cjs header for the full formula
// replication and the facility-scope investigation (this source table has
// no facility column; confirmed empirically it's WR-only already).
export async function fetchLiveCasePickAccuracy(quarter) {
  const res = await fetch('/.netlify/functions/motherduck-case-pick-accuracy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility: 'wr', quarter }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Case Pick Accuracy pull failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return res.json()
}

// OSDs — $ metric retired network-wide 2026-11-24 (see DEFAULT_TEMPLATES
// header note) — fetchLiveOsdDollar and its motherduck-osd-dollar.cjs
// backend are gone; no facility's template has an osd_dollar metric for
// this call to write into anymore.

// Live OSD — count pull — added 2026-08-02. Two different backends
// depending on facility, both wired behind this one function so the
// caller doesn't need to know which:
//   - cal/ken/mad: motherduck-osd-count.cjs — reads the already-synced
//     SharePoint Silver tables (a separate data-platform pipeline owns
//     that sync; this app only reads the copy).
//   - ec: sharepoint-ec-osd-count.cjs — direct read-only Graph read of
//     the live SharePoint file, since no Silver table exists yet for EC.
//   - wr: no backend yet. WR's template gained an osd_count metric
//     2026-11-24 (replacing osd_dollar — see DEFAULT_TEMPLATES header
//     note), but there's no Silver table or known SharePoint OSD tracker
//     for WR to read from, so it's deliberately left out of the
//     autoPullLiveMetrics facility list in Manager.jsx — WR's OSD count
//     is manual-entry only until a data source exists. Calling this
//     function with facility: 'wr' will throw (motherduck-osd-count.cjs's
//     TABLE_NAME map is still cal/ken/mad only) — don't add 'wr' to that
//     call site without building a backend for it first.
// Both backends apply the same two rules (confirmed with Dan): only rows
// where "CSW at Fault?" is true count, and the quarter is defined by
// "Initial Email Date". This app never writes to any of these trackers.
export async function fetchLiveOsdCount(facility, quarter) {
  const endpoint = facility === 'ec' ? '/.netlify/functions/sharepoint-ec-osd-count' : '/.netlify/functions/motherduck-osd-count'
  const body = facility === 'ec' ? { quarter } : { facility, quarter }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`OSD count pull failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return res.json()
}

// Live Takt Performance pull (all 5 facilities) — added 2026-08-02.
// Direct MotherDuck query against gold.takt_productivity_v2_agg — see
// motherduck-takt.cjs header for the FULL validation story: the source
// table, the weighted-seconds-ratio formula, the null-employee-row
// exclusion, and the known unresolved residual bias (every facility-month
// tested came out slightly HIGH vs the real Takt dashboard, worst on
// Caledonia). Shipped anyway per Dan's explicit decision after the gap
// was reduced from ~2x-inflated down to single digits — this is "close,
// confirmed good enough to ship," not "verified exact."
export async function fetchLiveTakt(facility, quarter) {
  const res = await fetch('/.netlify/functions/motherduck-takt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility, quarter }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Takt pull failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return res.json()
}

// --- Attainment math ---
// Anchor = 0% attainment. target_100 = 100% attainment. target_120 =
// 120% attainment (extends beyond target_100, capped at 120). Direction
// (higher-is-better vs lower-is-better) is inferred from whether
// target_100 sits above or below anchor — this is what lets OSD counts/$
// (lower is better) share the same formula as Takt/OTT (higher is better)
// with no separate "direction" field to keep in sync.
//
// Returns null (not 0) when any required input is missing, so the UI can
// show "—" instead of a misleading 0% for an unconfigured/not-yet-entered
// metric.
export function computeAttainment(metric) {
  const { anchor, target_100: t100, target_120: t120, actual } = metric
  if (anchor == null || t100 == null || actual == null) return null
  if (anchor === t100) return null // can't compute a slope with no anchor-to-target range

  const higherIsBetter = t100 > anchor

  if (higherIsBetter) {
    if (actual <= anchor) return 0
    if (actual <= t100) return ((actual - anchor) / (t100 - anchor)) * 100
    if (t120 == null || t120 === t100) return 100
    const extended = 100 + ((actual - t100) / (t120 - t100)) * 20
    return Math.min(120, extended)
  } else {
    if (actual >= anchor) return 0
    if (actual >= t100) return ((anchor - actual) / (anchor - t100)) * 100
    if (t120 == null || t120 === t100) return 100
    const extended = 100 + ((t100 - actual) / (t100 - t120)) * 20
    return Math.min(120, extended)
  }
}

// Weighted overall attainment across every metric that has a computable
// attainment value. Metrics with weight 0 or unset actual simply don't
// contribute (weight 0 contributes 0 either way; missing actual is
// excluded from both numerator and the weight-sum denominator so an
// incomplete scorecard doesn't silently understate itself).
export function computeOverallAttainment(metrics) {
  let weightedSum = 0
  let weightTotal = 0
  for (const m of metrics) {
    const w = Number(m.weight) || 0
    if (w <= 0) continue
    const att = computeAttainment(m)
    if (att == null) continue
    weightedSum += w * att
    weightTotal += w
  }
  if (weightTotal === 0) return null
  return weightedSum / weightTotal
}
