import { createClient } from '@supabase/supabase-js'

// Self-contained Supabase client for cron_health — same pattern as
// managerBonus.js/pviShelfLife.js (doesn't grow the already-76KB
// supabase.js further). Backs the new "B2E Sync Health" tab in
// Settings.jsx, added 2026-08-11 alongside the nightly-b2e-sync
// shared/run/test split.

const url = import.meta.env.VITE_SUPABASE_URL || ''
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
const supabase = url && key ? createClient(url, key) : null

// fetchCronHealth — most-recent-first rows for one function_name.
// 'nightly-b2e-sync-summary' rows have facility=null (one per full run);
// 'nightly-b2e-sync' rows are per-facility (5 per run).
export async function fetchCronHealth(functionName, limit = 20) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('cron_health')
    .select('*')
    .eq('function_name', functionName)
    .order('ran_at', { ascending: false })
    .limit(limit)
  if (error) { console.error('fetchCronHealth:', error); return [] }
  return data ?? []
}
