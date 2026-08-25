import { supabase } from './supabase.js'

// Scorecard Draft Creator — frontend data layer, added 2026-08-06 alongside
// the "Scorecard Drafts" sub-tab in Customers.jsx. Kept as a SEPARATE file
// from supabase.js rather than appended to it — that file is ~75KB and
// documented elsewhere as fragile for exactly this reason (str_replace risk
// on a huge file); this app's established pattern for a self-contained
// feature is its own lib file (see managerBonus.js, pviShelfLife.js).
//
// Backs customer_scorecard_config (per-customer scorecard config: prompt
// style, Omni dashboard pointer, recipients/reviewers, metric tile names,
// active flag) and triggers scorecard-draft-test.cjs for the "test the
// prompt" workflow — see that function's own header for what it actually
// does (creates a REAL Front draft, not a dry run).
//
// insertScorecardConfig / updateScorecardConfigField (added 2026-08-06,
// "Add Customer" ask) — extends this pilot from Bernatello's-only to any
// customer, without needing a dev/Claude session for every new one.
//
// front_inbox_name (added 2026-08-24) — see scorecard-draft-shared.cjs's
// TRIGGER/DETECTION header for the full story: this replaced an
// unreliable Front tag + full-text search combo as the primary detection
// mechanism. Must be the exact Front inbox NAME a customer's scorecard
// emails land in, and that inbox must be a SHARED one the app connection
// can actually read (not personal/restricted).
//
// to_recipients / cc_recipients / reviewer_emails (added 2026-08-25) —
// see scorecard-draft-shared.cjs's CRITICAL RECIPIENT BUG note for why
// to_recipients/cc_recipients exist at all: the draft's real recipients
// used to be derived by "replying" to Omni's own internal delivery
// notification, which resolved to Omni's own address + our own inbox,
// NEVER the actual customer. All comma-separated plain-TEXT strings,
// parsed at draft-creation time.
//
// metric_tile_names (added 2026-08-25, "rebuild" per Dan's pushback: "why
// are we using MD with I provide you the OMNI - this seems like extra
// work and not scalable") — comma-separated EXACT Omni dashboard tile
// names, copied straight from the Dashboard Coverage Check panel. If set
// (and omni_dashboard_id is also set), this REPLACES the old fixed-field
// MotherDuck metrics path entirely for that customer — see
// scorecard-draft-shared.cjs's METRICS ARCHITECTURE header for the full
// story of why this exists and how it's wired in. Left NULL for
// Bernatello's intentionally (its numbers were validated under the old
// path and haven't been re-verified under this one).
//
// triggerDashboardCoverageCheck (added 2026-08-25, "Option B") — calls
// omni-dashboard-coverage.cjs, which live-reads a customer's real Omni
// dashboard and flags which tiles aren't yet in metric_tile_names. Now
// accepts configuredTileNames so a tile already added shows as truly
// covered, not just keyword-guessed — see that function's own header.

export async function fetchAllScorecardConfigs() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('customer_scorecard_config')
    .select('*')
    .order('customer_label')
  if (error) { console.error('fetchAllScorecardConfigs:', error); return [] }
  return data ?? []
}

export async function updateScorecardPromptStyle(customerKey, promptStyle) {
  if (!supabase) return
  const { error } = await supabase
    .from('customer_scorecard_config')
    .update({ prompt_style: promptStyle, updated_at: new Date().toISOString() })
    .eq('customer_key', customerKey)
  if (error) { console.error('updateScorecardPromptStyle:', error); throw error }
}

export async function updateScorecardActive(customerKey, active) {
  if (!supabase) return
  const { error } = await supabase
    .from('customer_scorecard_config')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('customer_key', customerKey)
  if (error) { console.error('updateScorecardActive:', error); throw error }
}

// insertScorecardConfig — creates a brand-new customer_scorecard_config row.
// Always inserted with active=false (same "prove it via manual test before
// turning on the schedule" convention as every other digest onboarding in
// this app — see attendance-points-shared.cjs's header for the precedent).
// customer_key must be unique (table's primary key) — the Supabase error
// surfaces naturally as a duplicate-key message if the person reuses one.
export async function insertScorecardConfig({
  customerKey, customerLabel, omniDashboardId, projectNameContains,
  warehouseName, facility, includeCasePickAccuracy, frontSubjectContains, frontInboxName,
  toRecipients, ccRecipients, reviewerEmails, metricTileNames, promptStyle,
}) {
  if (!supabase) return
  const payload = {
    customer_key: customerKey.trim(),
    customer_label: customerLabel.trim(),
    omni_dashboard_id: (omniDashboardId || '').trim() || null,
    project_name_contains: projectNameContains.trim(),
    warehouse_name: warehouseName,
    facility: facility || null,
    include_case_pick_accuracy: !!includeCasePickAccuracy,
    front_subject_contains: frontSubjectContains.trim(),
    front_inbox_name: (frontInboxName || '').trim() || null,
    to_recipients: (toRecipients || '').trim() || null,
    cc_recipients: (ccRecipients || '').trim() || null,
    reviewer_emails: (reviewerEmails || '').trim() || null,
    metric_tile_names: (metricTileNames || '').trim() || null,
    prompt_style: (promptStyle || '').trim(),
    active: false,
  }
  if (!payload.customer_key) throw new Error('Customer key is required')
  if (!payload.customer_label) throw new Error('Customer label is required')
  if (!payload.project_name_contains) throw new Error('MotherDuck project filter is required')
  if (!payload.warehouse_name) throw new Error('Warehouse is required')
  if (!payload.front_subject_contains) throw new Error('Front subject match is required')
  const { data, error } = await supabase
    .from('customer_scorecard_config')
    .insert(payload)
    .select()
    .single()
  if (error) { console.error('insertScorecardConfig:', error); throw error }
  return data
}

// updateScorecardConfigField — generic single-field update for the
// editable config fields. metric_tile_names added 2026-08-25 — see file
// header. Kept generic rather than one function per field since these
// are all simple same-shape writes to the same row.
const EDITABLE_CONFIG_FIELDS = new Set([
  'omni_dashboard_id', 'project_name_contains', 'warehouse_name',
  'facility', 'include_case_pick_accuracy', 'front_subject_contains', 'front_inbox_name',
  'to_recipients', 'cc_recipients', 'reviewer_emails', 'metric_tile_names',
])
export async function updateScorecardConfigField(customerKey, field, value) {
  if (!supabase) return
  if (!EDITABLE_CONFIG_FIELDS.has(field)) throw new Error(`Field '${field}' is not editable via this function`)
  const { error } = await supabase
    .from('customer_scorecard_config')
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq('customer_key', customerKey)
  if (error) { console.error('updateScorecardConfigField:', error); throw error }
}

// triggerScorecardDraftTest — calls scorecard-draft-test.cjs directly (no
// schedule on that function, so a direct POST works, same 403-avoidance
// pattern as every other *-digest-test.cjs in this app). NOT a dry run:
// creates a real Front draft on the given conversation and really calls
// the Claude API. conversationId must be a real Front conversation ID
// (e.g. a past scorecard email thread) — this does not search Front for
// you, by design (see scorecard-draft-test.cjs header).
export async function triggerScorecardDraftTest(customerKey, conversationId) {
  const res = await fetch('/.netlify/functions/scorecard-draft-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerKey, conversationId }),
  })
  const json = await res.json().catch(() => null)
  if (!json) throw new Error(`HTTP ${res.status} — no JSON body returned`)
  // scorecard-draft-test.cjs returns 200 on success, 502 on any pipeline
  // failure (with { ok: false, reason } either way) — surface the reason
  // rather than a bare status code, most of these are actionable (missing
  // ANTHROPIC_API_KEY, bad conversationId, etc.).
  if (!res.ok && !json.reason) throw new Error(`HTTP ${res.status}`)
  return json
}

// triggerDashboardCoverageCheck — calls omni-dashboard-coverage.cjs
// directly. Read-only (never modifies anything), but still surfaces a
// clear error rather than swallowing one, since a stale/wrong
// omniDashboardId would otherwise fail silently. configuredTileNames
// (added 2026-08-25) lets the check mark tiles already in metric_tile_names
// as truly covered rather than keyword-guessed — see that function's own
// header.
export async function triggerDashboardCoverageCheck(dashboardId, configuredTileNames) {
  const res = await fetch('/.netlify/functions/omni-dashboard-coverage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dashboardId, configuredTileNames: configuredTileNames || [] }),
  })
  const json = await res.json().catch(() => null)
  if (!json) throw new Error(`HTTP ${res.status} — no JSON body returned`)
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}
