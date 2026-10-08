import { supabase } from './supabase.js'

// Customer Lens data layer (/lens). Added 2026-10-08. Kept out of supabase.js
// per the file-hygiene convention (that file is already ~76KB).
//
// Tables (all with 4 CRUD anon RLS policies, verified via pg_policies):
//   lens_context(scope 'global'|'account'|'facility', key, title, body, active,
//                reviewed_at, updated_at, updated_by)  unique(scope,key)
//   lens_context_history  snapshot per save (written HERE, not by a trigger:
//                         DDL for a trigger timed out on the Supabase MCP)
//   lens_account_map(match_type 'domain'|'email'|'front_account_id',
//                    match_value, account_key)  unique(match_type,match_value)
//   lens_runs  log of every Lens run, with optional thumbs rating
//
// Server side lives in netlify/functions/lib/lens-shared.cjs.

export async function fetchContexts() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('lens_context')
    .select('*')
    .order('scope')
    .order('key')
  if (error) { console.error('fetchContexts:', error); return [] }
  return data ?? []
}

export async function saveContext({ scope, key, title, body, updatedBy = 'Dan' }) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const now = new Date().toISOString()
  const row = {
    scope,
    key: key.trim(),
    title: (title || '').trim() || null,
    body: body ?? '',
    updated_by: updatedBy,
    updated_at: now,
    reviewed_at: now,
    active: true,
  }
  const { data, error } = await supabase
    .from('lens_context')
    .upsert(row, { onConflict: 'scope,key', ignoreDuplicates: false })
    .select()
    .single()
  if (error) { console.error('saveContext:', error); return { success: false, error: error.message } }
  // Best-effort history snapshot; never fail the save over it.
  const { error: hErr } = await supabase.from('lens_context_history').insert({
    context_id: data.id, scope, key: row.key, title: row.title, body: row.body, updated_by: updatedBy,
  })
  if (hErr) console.warn('lens history insert failed:', hErr.message)
  return { success: true, row: data }
}

export async function markContextReviewed(scope, key) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { data, error } = await supabase
    .from('lens_context')
    .update({ reviewed_at: new Date().toISOString() })
    .eq('scope', scope)
    .eq('key', key)
    .select()
    .single()
  if (error) return { success: false, error: error.message }
  return { success: true, row: data }
}

export async function deleteContext(scope, key) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { error } = await supabase.from('lens_context').delete().eq('scope', scope).eq('key', key)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function fetchContextHistory(scope, key, limit = 10) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('lens_context_history')
    .select('*')
    .eq('scope', scope)
    .eq('key', key)
    .order('saved_at', { ascending: false })
    .limit(limit)
  if (error) { console.error('fetchContextHistory:', error); return [] }
  return data ?? []
}

export async function fetchAccountMap() {
  if (!supabase) return []
  const { data, error } = await supabase.from('lens_account_map').select('*').order('account_key')
  if (error) { console.error('fetchAccountMap:', error); return [] }
  return data ?? []
}

export async function addAccountMap(matchType, matchValue, accountKey) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { data, error } = await supabase
    .from('lens_account_map')
    .insert({ match_type: matchType, match_value: matchValue.trim().toLowerCase(), account_key: accountKey })
    .select()
    .single()
  if (error) return { success: false, error: error.message }
  return { success: true, row: data }
}

export async function deleteAccountMap(id) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { error } = await supabase.from('lens_account_map').delete().eq('id', id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function fetchRuns(limit = 20) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('lens_runs')
    .select('id,created_at,source,front_conversation_id,account_key,facility_key,request_text,output,error,rating,rating_note')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) { console.error('fetchRuns:', error); return [] }
  return data ?? []
}

export async function rateRun(id, rating, note = null) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { error } = await supabase.from('lens_runs').update({ rating, rating_note: note }).eq('id', id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// Calls the Netlify function. facilityKeys are joined with '|' for GET.
export async function previewLensContext(accountKey, facilityKeys) {
  const qs = new URLSearchParams({
    preview: '1',
    accountKey: accountKey || '',
    facilityKeys: (facilityKeys || []).join('|'),
  })
  const res = await fetch(`/.netlify/functions/lens-test?${qs.toString()}`)
  return res.json()
}

export async function runLensTest({ text, requestText, accountKey, facilityKeys }) {
  const res = await fetch('/.netlify/functions/lens-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, requestText, accountKey, facilityKeys }),
  })
  return res.json()
}
