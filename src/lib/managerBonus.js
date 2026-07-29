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

// Default templates used only to seed a brand-new quarter that has no rows
// yet (e.g. rolling into next quarter). WR drops OSDs — count in favor of
// Case Pick Accuracy per Dan's 2026-07-28 direction; every other facility
// keeps the standard 6-metric template. All values here are just starting
// points — every field is editable in the UI afterward.
export const DEFAULT_TEMPLATES = {
  standard: [
    { metric_key: 'takt',         label: 'Takt Performance',         unit: '%',     weight: 25,   anchor: 50,   target_100: 80,  target_120: 90,  sort_order: 1 },
    { metric_key: 'ott3',         label: 'OTT — 3 Hour',             unit: '%',     weight: 20,   anchor: 90,   target_100: 98,  target_120: 100, sort_order: 2 },
    { metric_key: 'ott2',         label: 'OTT — 2 Hour',             unit: '%',     weight: 5,    anchor: 85,   target_100: 95,  target_120: 98,  sort_order: 3 },
    { metric_key: 'osd_count',    label: 'OSDs — count',             unit: 'count', weight: 25,   anchor: 16,   target_100: 4,   target_120: 2,   sort_order: 4 },
    { metric_key: 'osd_dollar',   label: 'OSDs — $',                 unit: '$',     weight: 0,    anchor: 2000, target_100: 500, target_120: 0,   sort_order: 5 },
    { metric_key: 'discretionary',label: 'Discretionary Evaluation', unit: '%',     weight: 25,   anchor: 50,   target_100: 100, target_120: 120, sort_order: 6 },
  ],
  wr: [
    { metric_key: 'takt',         label: 'Takt Performance',         unit: '%', weight: 25,   anchor: 50,   target_100: 80,   target_120: 90,   sort_order: 1 },
    { metric_key: 'ott3',         label: 'OTT — 3 Hour',             unit: '%', weight: 20,   anchor: 90,   target_100: 98,   target_120: 100,  sort_order: 2 },
    { metric_key: 'ott2',         label: 'OTT — 2 Hour',             unit: '%', weight: 5,    anchor: 85,   target_100: 95,   target_120: 98,   sort_order: 3 },
    { metric_key: 'case_pick',    label: 'Case Pick Accuracy',       unit: '%', weight: 12.5, anchor: 99.2, target_100: 99.6, target_120: 99.8, sort_order: 4 },
    { metric_key: 'osd_dollar',   label: 'OSDs — $',                 unit: '$', weight: 12.5, anchor: 2000, target_100: 500,  target_120: 0,    sort_order: 5 },
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
// with ignoreDuplicates).
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
