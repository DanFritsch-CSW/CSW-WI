import { supabase } from './supabase.js'

// Scorecard Draft Creator — frontend data layer, added 2026-08-06 alongside
// the "Scorecard Drafts" sub-tab in Customers.jsx. Kept as a SEPARATE file
// from supabase.js rather than appended to it — that file is ~75KB and
// documented elsewhere as fragile for exactly this reason (str_replace risk
// on a huge file); this app's established pattern for a self-contained
// feature is its own lib file (see managerBonus.js, pviShelfLife.js).
//
// Backs customer_scorecard_config (Bernatello's-pilot config: prompt style,
// Omni dashboard pointer, MotherDuck project/warehouse filters, active flag)
// and triggers scorecard-draft-test.cjs for the "test the prompt" workflow —
// see that function's own header for what it actually does (creates a REAL
// Front draft, not a dry run).

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
