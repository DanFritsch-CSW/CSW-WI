// CMM Outbound Appts (Caledonia) — Settings helpers.
//
// Split into its own module rather than growing src/lib/supabase.js further
// (already ~76KB, past the documented ~50KB-fragile / 63KB-risky threshold
// for create_or_update_file pushes — see project notes). Reuses the shared
// `supabase` client and `triggerDigestTest`/`fetchFrontTeammates` from
// supabase.js instead of duplicating them.
//
// Three concepts, matching cmm-outbound-draft-create.cjs:
//   1. Settings row (prepick_notify_settings, facility='cal',
//      dashboard_type='cmm_outbound_appts') — send time/days/active +
//      the two new columns (discussion_comment, author_teammate_id).
//   2. Email recipients (cmm_outbound_email_recipients) — TO/CC, external
//      addresses. Land on the draft itself.
//   3. Discussion recipients (notification_recipients,
//      list_name='cmm_outbound_<facility>') — internal Front teammates,
//      added as conversation followers + see the discussion comment. Same
//      list_name convention as daily_discussion_<facility> in supabase.js.

import { supabase } from './supabase.js'

const DASHBOARD_TYPE = 'cmm_outbound_appts'

// ─── Settings row ────────────────────────────────────────────────────────

export async function fetchCmmOutboundSettings(facility) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('prepick_notify_settings')
    .select('notify_hour, notify_minute, notify_days, active, last_sent_date, discussion_comment, author_teammate_id')
    .eq('facility', facility)
    .eq('dashboard_type', DASHBOARD_TYPE)
    .maybeSingle()
  if (error) { console.error('fetchCmmOutboundSettings:', error); return null }
  return data
}

export async function upsertCmmOutboundSettings(facility, { notifyHour, notifyMinute, notifyDays, active, discussionComment, authorTeammateId }) {
  if (!supabase) return
  const { error } = await supabase
    .from('prepick_notify_settings')
    .upsert(
      {
        facility, dashboard_type: DASHBOARD_TYPE,
        notify_hour: notifyHour, notify_minute: notifyMinute, notify_days: notifyDays, active,
        discussion_comment: discussionComment ?? null,
        author_teammate_id: authorTeammateId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'facility,dashboard_type' }
    )
  if (error) { console.error('upsertCmmOutboundSettings:', error); throw error }
}

// ─── TO/CC email recipients ──────────────────────────────────────────────

export async function fetchCmmOutboundEmailRecipients(facility) {
  if (!supabase) return { to: [], cc: [] }
  const { data, error } = await supabase
    .from('cmm_outbound_email_recipients')
    .select('id, email, role, active')
    .eq('facility', facility)
    .order('email')
  if (error) { console.error('fetchCmmOutboundEmailRecipients:', error); return { to: [], cc: [] } }
  const rows = data ?? []
  return {
    to: rows.filter(r => r.role === 'to'),
    cc: rows.filter(r => r.role === 'cc'),
  }
}

// saveCmmOutboundEmailRecipients — full replace-set per role, same
// upsert-then-prune pattern as saveDiscussionRecipients in supabase.js.
export async function saveCmmOutboundEmailRecipients(facility, toEmails, ccEmails) {
  if (!supabase) return
  const rows = [
    ...(toEmails ?? []).map(email => ({ facility, email, role: 'to', active: true })),
    ...(ccEmails ?? []).map(email => ({ facility, email, role: 'cc', active: true })),
  ]
  if (rows.length) {
    const { error: upErr } = await supabase
      .from('cmm_outbound_email_recipients')
      .upsert(rows, { onConflict: 'facility,email,role', ignoreDuplicates: false })
    if (upErr) { console.error('saveCmmOutboundEmailRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('cmm_outbound_email_recipients')
    .select('id, email, role')
    .eq('facility', facility)
  if (fetchErr) { console.error('saveCmmOutboundEmailRecipients fetch:', fetchErr); throw fetchErr }
  const keep = new Set(rows.map(r => `${r.email}|${r.role}`))
  const removeIds = (existing ?? []).filter(r => !keep.has(`${r.email}|${r.role}`)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('cmm_outbound_email_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveCmmOutboundEmailRecipients delete:', delErr); throw delErr }
  }
}

// ─── Discussion recipients (internal Front teammates) ───────────────────

export async function fetchCmmOutboundDiscussionRecipients(facility) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notification_recipients')
    .select('*')
    .eq('list_name', `cmm_outbound_${facility}`)
    .order('name')
  if (error) { console.error('fetchCmmOutboundDiscussionRecipients:', error); return [] }
  return data ?? []
}

export async function saveCmmOutboundDiscussionRecipients(facility, chosenTeammates) {
  if (!supabase) return
  const listName = `cmm_outbound_${facility}`
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
    if (upErr) { console.error('saveCmmOutboundDiscussionRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('notification_recipients')
    .select('id, email')
    .eq('list_name', listName)
  if (fetchErr) { console.error('saveCmmOutboundDiscussionRecipients fetch:', fetchErr); throw fetchErr }
  const keepEmails = new Set(rows.map(r => r.email))
  const removeIds = (existing ?? []).filter(r => !keepEmails.has(r.email)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('notification_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveCmmOutboundDiscussionRecipients delete:', delErr); throw delErr }
  }
}
