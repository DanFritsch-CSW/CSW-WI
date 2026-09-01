// Daily Discussion EMAIL draft — Settings helpers. Added 2026-09-01 per
// Dan's ask. Deliberately separate from front-daily-discussion-run.cjs
// (the internal Front discussion) — this is a fresh, standalone email
// draft capability. See netlify/functions/lib/daily-discussion-email-
// shared.cjs for the full backend design writeup.
//
// Directly mirrors src/lib/cmmOutbound.js (same four concepts: settings
// row, TO/CC email recipients, internal-discussion-follower recipients,
// Front channels for the From picker) with facility passed through
// everywhere instead of hardcoded to 'cal' — this feature is meant to
// work across any of the 5 facilities, chosen via a dropdown in the UI.

import { supabase } from './supabase.js'

const DASHBOARD_TYPE = 'daily_discussion_email'

// ─── Settings row (reuses prepick_notify_settings, same table CMM
// Outbound uses, keyed by facility + dashboard_type) ──────────────────────

export async function fetchDailyDiscussionEmailSettings(facility) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('prepick_notify_settings')
    .select('notify_hour, notify_minute, notify_days, active, last_sent_date, discussion_comment, author_teammate_id, from_channel_id')
    .eq('facility', facility)
    .eq('dashboard_type', DASHBOARD_TYPE)
    .maybeSingle()
  if (error) { console.error('fetchDailyDiscussionEmailSettings:', error); return null }
  return data
}

export async function upsertDailyDiscussionEmailSettings(facility, { notifyHour, notifyMinute, notifyDays, active, discussionComment, authorTeammateId, fromChannelId }) {
  if (!supabase) return
  const { error } = await supabase
    .from('prepick_notify_settings')
    .upsert(
      {
        facility, dashboard_type: DASHBOARD_TYPE,
        notify_hour: notifyHour, notify_minute: notifyMinute, notify_days: notifyDays, active,
        discussion_comment: discussionComment ?? null,
        author_teammate_id: authorTeammateId ?? null,
        from_channel_id: fromChannelId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'facility,dashboard_type' }
    )
  if (error) { console.error('upsertDailyDiscussionEmailSettings:', error); throw error }
}

// ─── TO/CC email recipients (daily_discussion_email_recipients — own
// table, kept separate from cmm_outbound_email_recipients so the two
// features' lists never collide for a shared facility like 'cal') ────────

export async function fetchDailyDiscussionEmailRecipients(facility) {
  if (!supabase) return { to: [], cc: [] }
  const { data, error } = await supabase
    .from('daily_discussion_email_recipients')
    .select('id, email, role, active')
    .eq('facility', facility)
    .order('email')
  if (error) { console.error('fetchDailyDiscussionEmailRecipients:', error); return { to: [], cc: [] } }
  const rows = data ?? []
  return {
    to: rows.filter(r => r.role === 'to'),
    cc: rows.filter(r => r.role === 'cc'),
  }
}

// saveDailyDiscussionEmailRecipients — full replace-set per role, same
// upsert-then-prune pattern as saveCmmOutboundEmailRecipients.
export async function saveDailyDiscussionEmailRecipients(facility, toEmails, ccEmails) {
  if (!supabase) return
  const rows = [
    ...(toEmails ?? []).map(email => ({ facility, email, role: 'to', active: true })),
    ...(ccEmails ?? []).map(email => ({ facility, email, role: 'cc', active: true })),
  ]
  if (rows.length) {
    const { error: upErr } = await supabase
      .from('daily_discussion_email_recipients')
      .upsert(rows, { onConflict: 'facility,email,role', ignoreDuplicates: false })
    if (upErr) { console.error('saveDailyDiscussionEmailRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('daily_discussion_email_recipients')
    .select('id, email, role')
    .eq('facility', facility)
  if (fetchErr) { console.error('saveDailyDiscussionEmailRecipients fetch:', fetchErr); throw fetchErr }
  const keep = new Set(rows.map(r => `${r.email}|${r.role}`))
  const removeIds = (existing ?? []).filter(r => !keep.has(`${r.email}|${r.role}`)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('daily_discussion_email_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveDailyDiscussionEmailRecipients delete:', delErr); throw delErr }
  }
}

// ─── Discussion recipients (internal Front teammates, reuses
// notification_recipients — list_name='daily_discussion_email_<facility>',
// deliberately distinct from 'daily_discussion_<facility>' used by the
// internal Front discussion feature, and from 'cmm_outbound_<facility>')

export async function fetchDailyDiscussionEmailFollowers(facility) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notification_recipients')
    .select('*')
    .eq('list_name', `daily_discussion_email_${facility}`)
    .order('name')
  if (error) { console.error('fetchDailyDiscussionEmailFollowers:', error); return [] }
  return data ?? []
}

export async function saveDailyDiscussionEmailFollowers(facility, chosenTeammates) {
  if (!supabase) return
  const listName = `daily_discussion_email_${facility}`
  const rows = (chosenTeammates ?? []).map(t => ({
    list_name: listName,
    name: [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email,
    email: t.email,
    front_teammate_id: t.teammate_id,
    active: true,
    updated_at: new Date().toISOString(),
  }))
  if (rows.length) {
    const { error: upErr } = await supabase
      .from('notification_recipients')
      .upsert(rows, { onConflict: 'list_name,email', ignoreDuplicates: false })
    if (upErr) { console.error('saveDailyDiscussionEmailFollowers upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('notification_recipients')
    .select('id, email')
    .eq('list_name', listName)
  if (fetchErr) { console.error('saveDailyDiscussionEmailFollowers fetch:', fetchErr); throw fetchErr }
  const keepEmails = new Set(rows.map(r => r.email))
  const removeIds = (existing ?? []).filter(r => !keepEmails.has(r.email)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('notification_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveDailyDiscussionEmailFollowers delete:', delErr); throw delErr }
  }
}

// ─── Manual test trigger ──────────────────────────────────────────────────

export async function triggerDailyDiscussionEmailTest(facility) {
  const res = await fetch('/.netlify/functions/daily-discussion-email-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}

// Front channels (From picker) — reuses the SAME front_channels table and
// sync function as CMM Outbound; re-exported here so this file is a
// complete, self-contained set of imports for the Settings UI, without
// importing from cmmOutbound.js (a CMM-specific module) for a
// CMM-unrelated feature.
export { fetchFrontChannels, triggerFrontChannelsSync } from './cmmOutbound.js'
