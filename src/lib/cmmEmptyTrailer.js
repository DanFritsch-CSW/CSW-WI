// CMM Empty Trailer (Caledonia) — Settings helpers.
//
// Sibling to cmmOutbound.js, same split-module reasoning (keep
// supabase.js from growing further). Simpler than CMM Outbound Appts
// because this sends a live email directly (no draft/author layer — see
// netlify/functions/lib/cmm-empty-trailer-email-shared.cjs for why), but
// DOES keep an internal discussion PEOPLE picker (added 2026-10-09, same
// evening as the initial build):
//   1. Settings row (prepick_notify_settings, facility='cal',
//      dashboard_type='cmm_empty_trailer') — send time/days/active +
//      sender_name/email_subject_template/email_body_template +
//      from_channel_id (which Front address it sends from).
//   2. Email recipients (cmm_empty_trailer_email_recipients) — TO/CC,
//      own table, independent of cmm_outbound_email_recipients.
//   3. Discussion recipients (notification_recipients,
//      list_name='cmm_empty_trailer_<facility>') — internal Front
//      teammates added as conversation followers on the sent thread,
//      WITHOUT being a TO/CC recipient of the email itself. Same
//      list_name convention and upsert-then-prune pattern as
//      cmm_outbound_<facility> in cmmOutbound.js.
//   4. Front channels (front_channels) — reuses fetchFrontChannels /
//      triggerFrontChannelsSync from cmmOutbound.js directly; that sync
//      is channel-agnostic, not CMM-Outbound-specific.

import { supabase } from './supabase.js'

const DASHBOARD_TYPE = 'cmm_empty_trailer'
const FACILITY = 'cal'

// ─── Settings row ────────────────────────────────────────────────────────

export async function fetchCmmEmptyTrailerSettings() {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('prepick_notify_settings')
    .select('notify_hour, notify_minute, notify_days, active, last_sent_date, sender_name, email_subject_template, email_body_template, from_channel_id')
    .eq('facility', FACILITY)
    .eq('dashboard_type', DASHBOARD_TYPE)
    .maybeSingle()
  if (error) { console.error('fetchCmmEmptyTrailerSettings:', error); return null }
  return data
}

export async function upsertCmmEmptyTrailerSettings({ notifyHour, notifyMinute, notifyDays, active, senderName, emailSubjectTemplate, emailBodyTemplate, fromChannelId }) {
  if (!supabase) return
  const { error } = await supabase
    .from('prepick_notify_settings')
    .upsert(
      {
        facility: FACILITY, dashboard_type: DASHBOARD_TYPE,
        notify_hour: notifyHour, notify_minute: notifyMinute, notify_days: notifyDays, active,
        sender_name: senderName ?? null,
        email_subject_template: emailSubjectTemplate ?? null,
        email_body_template: emailBodyTemplate ?? null,
        from_channel_id: fromChannelId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'facility,dashboard_type' }
    )
  if (error) { console.error('upsertCmmEmptyTrailerSettings:', error); throw error }
}

// ─── TO/CC email recipients ──────────────────────────────────────────────

export async function fetchCmmEmptyTrailerEmailRecipients() {
  if (!supabase) return { to: [], cc: [] }
  const { data, error } = await supabase
    .from('cmm_empty_trailer_email_recipients')
    .select('id, email, role, active')
    .eq('facility', FACILITY)
    .order('email')
  if (error) { console.error('fetchCmmEmptyTrailerEmailRecipients:', error); return { to: [], cc: [] } }
  const rows = data ?? []
  return {
    to: rows.filter(r => r.role === 'to'),
    cc: rows.filter(r => r.role === 'cc'),
  }
}

// saveCmmEmptyTrailerEmailRecipients — full replace-set per role, same
// upsert-then-prune pattern as saveCmmOutboundEmailRecipients.
export async function saveCmmEmptyTrailerEmailRecipients(toEmails, ccEmails) {
  if (!supabase) return
  const rows = [
    ...(toEmails ?? []).map(email => ({ facility: FACILITY, email, role: 'to', active: true })),
    ...(ccEmails ?? []).map(email => ({ facility: FACILITY, email, role: 'cc', active: true })),
  ]
  if (rows.length) {
    const { error: upErr } = await supabase
      .from('cmm_empty_trailer_email_recipients')
      .upsert(rows, { onConflict: 'facility,email,role', ignoreDuplicates: false })
    if (upErr) { console.error('saveCmmEmptyTrailerEmailRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('cmm_empty_trailer_email_recipients')
    .select('id, email, role')
    .eq('facility', FACILITY)
  if (fetchErr) { console.error('saveCmmEmptyTrailerEmailRecipients fetch:', fetchErr); throw fetchErr }
  const keep = new Set(rows.map(r => `${r.email}|${r.role}`))
  const removeIds = (existing ?? []).filter(r => !keep.has(`${r.email}|${r.role}`)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('cmm_empty_trailer_email_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveCmmEmptyTrailerEmailRecipients delete:', delErr); throw delErr }
  }
}

// ─── Discussion recipients (internal Front teammates, followers-only) ────

export async function fetchCmmEmptyTrailerDiscussionRecipients() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notification_recipients')
    .select('*')
    .eq('list_name', `cmm_empty_trailer_${FACILITY}`)
    .order('name')
  if (error) { console.error('fetchCmmEmptyTrailerDiscussionRecipients:', error); return [] }
  return data ?? []
}

// saveCmmEmptyTrailerDiscussionRecipients — same upsert-then-prune pattern
// as saveCmmOutboundDiscussionRecipients.
export async function saveCmmEmptyTrailerDiscussionRecipients(chosenTeammates) {
  if (!supabase) return
  const listName = `cmm_empty_trailer_${FACILITY}`
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
    if (upErr) { console.error('saveCmmEmptyTrailerDiscussionRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('notification_recipients')
    .select('id, email')
    .eq('list_name', listName)
  if (fetchErr) { console.error('saveCmmEmptyTrailerDiscussionRecipients fetch:', fetchErr); throw fetchErr }
  const keepEmails = new Set(rows.map(r => r.email))
  const removeIds = (existing ?? []).filter(r => !keepEmails.has(r.email)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('notification_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveCmmEmptyTrailerDiscussionRecipients delete:', delErr); throw delErr }
  }
}

// ─── Manual test trigger ──────────────────────────────────────────────────

export async function triggerCmmEmptyTrailerTest() {
  const res = await fetch('/.netlify/functions/cmm-empty-trailer-email-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}
