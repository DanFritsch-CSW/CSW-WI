// JDF Daily Comms (Madison) — Settings helpers.
//
// Sibling/mirror of cmmEmptyTrailer.js, same split-module reasoning. Added
// 2026-11-04 per Dan (cnv_1cspos44): the daily JDF outbound thread
// ("Outbounds {date}") never gets a fresh start from the JDF side, so it
// grows into one long back-and-forth every day. This sends a live kickoff
// email (no draft/review step) each morning to start a NEW thread, exactly
// the same mechanism as CMM Empty Trailer — content-free, no MotherDuck
// query, no structured "today's orders" data pulled in. Chris/Anne still
// reply into the resulting thread with the real outbound details, same as
// today.
//
// UNLIKE CMM Empty Trailer, this has NO hourly keep-on-top ping (per Dan —
// kickoff only). The JDF thread stays active all day via ordinary customer
// replies, unlike the CMM trailer thread which can go quiet. So there's no
// ping-shared.cjs sibling, no last_ping_at usage, and no ping test button in
// the UI below.
//
//   1. Settings row (prepick_notify_settings, facility='mad',
//      dashboard_type='jdf_daily_comms') — send time/days/active +
//      sender_name/email_subject_template/email_body_template +
//      from_channel_id (madison@csw-wi.com / cha_duvx0 by default) +
//      last_conversation_id (written by the backend after each send, kept
//      for reference/debugging only — nothing reads it back for a ping).
//   2. Email recipients (jdf_daily_comms_email_recipients) — TO/CC, own
//      table, independent of every other CMM/JDF recipient list. Seeded
//      2026-11-04 from the live "Outbounds 11.03.26" thread's own TO/CC.
//   3. Discussion recipients (notification_recipients,
//      list_name='jdf_daily_comms_mad') — internal Front teammates added as
//      conversation followers on the sent thread, WITHOUT being a TO/CC
//      recipient of the email itself. Same list_name convention and
//      upsert-then-prune pattern as cmm_empty_trailer_<facility>. Seeded
//      empty — add internal followers in Settings if wanted.
//   4. Front channels (front_channels) — reuses fetchFrontChannels /
//      triggerFrontChannelsSync from cmmOutbound.js directly, same as
//      cmmEmptyTrailer.js does.

import { supabase } from './supabase.js'

const DASHBOARD_TYPE = 'jdf_daily_comms'
const FACILITY = 'mad'

// ─── Settings row ────────────────────────────────────────────────────────

export async function fetchJdfDailyCommsSettings() {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('prepick_notify_settings')
    .select('notify_hour, notify_minute, notify_days, active, last_sent_date, sender_name, email_subject_template, email_body_template, from_channel_id, last_conversation_id')
    .eq('facility', FACILITY)
    .eq('dashboard_type', DASHBOARD_TYPE)
    .maybeSingle()
  if (error) { console.error('fetchJdfDailyCommsSettings:', error); return null }
  return data
}

export async function upsertJdfDailyCommsSettings({ notifyHour, notifyMinute, notifyDays, active, senderName, emailSubjectTemplate, emailBodyTemplate, fromChannelId }) {
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
  if (error) { console.error('upsertJdfDailyCommsSettings:', error); throw error }
}

// ─── TO/CC email recipients ──────────────────────────────────────────────

export async function fetchJdfDailyCommsEmailRecipients() {
  if (!supabase) return { to: [], cc: [] }
  const { data, error } = await supabase
    .from('jdf_daily_comms_email_recipients')
    .select('id, email, role, active')
    .eq('facility', FACILITY)
    .order('email')
  if (error) { console.error('fetchJdfDailyCommsEmailRecipients:', error); return { to: [], cc: [] } }
  const rows = data ?? []
  return {
    to: rows.filter(r => r.role === 'to'),
    cc: rows.filter(r => r.role === 'cc'),
  }
}

// saveJdfDailyCommsEmailRecipients — full replace-set per role, same
// upsert-then-prune pattern as saveCmmEmptyTrailerEmailRecipients.
export async function saveJdfDailyCommsEmailRecipients(toEmails, ccEmails) {
  if (!supabase) return
  const rows = [
    ...(toEmails ?? []).map(email => ({ facility: FACILITY, email, role: 'to', active: true })),
    ...(ccEmails ?? []).map(email => ({ facility: FACILITY, email, role: 'cc', active: true })),
  ]
  if (rows.length) {
    const { error: upErr } = await supabase
      .from('jdf_daily_comms_email_recipients')
      .upsert(rows, { onConflict: 'facility,email,role', ignoreDuplicates: false })
    if (upErr) { console.error('saveJdfDailyCommsEmailRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('jdf_daily_comms_email_recipients')
    .select('id, email, role')
    .eq('facility', FACILITY)
  if (fetchErr) { console.error('saveJdfDailyCommsEmailRecipients fetch:', fetchErr); throw fetchErr }
  const keep = new Set(rows.map(r => `${r.email}|${r.role}`))
  const removeIds = (existing ?? []).filter(r => !keep.has(`${r.email}|${r.role}`)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('jdf_daily_comms_email_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveJdfDailyCommsEmailRecipients delete:', delErr); throw delErr }
  }
}

// ─── Discussion recipients (internal Front teammates, followers-only) ────

export async function fetchJdfDailyCommsDiscussionRecipients() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notification_recipients')
    .select('*')
    .eq('list_name', `jdf_daily_comms_${FACILITY}`)
    .order('name')
  if (error) { console.error('fetchJdfDailyCommsDiscussionRecipients:', error); return [] }
  return data ?? []
}

// saveJdfDailyCommsDiscussionRecipients — same upsert-then-prune pattern as
// saveCmmEmptyTrailerDiscussionRecipients.
export async function saveJdfDailyCommsDiscussionRecipients(chosenTeammates) {
  if (!supabase) return
  const listName = `jdf_daily_comms_${FACILITY}`
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
    if (upErr) { console.error('saveJdfDailyCommsDiscussionRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('notification_recipients')
    .select('id, email')
    .eq('list_name', listName)
  if (fetchErr) { console.error('saveJdfDailyCommsDiscussionRecipients fetch:', fetchErr); throw fetchErr }
  const keepEmails = new Set(rows.map(r => r.email))
  const removeIds = (existing ?? []).filter(r => !keepEmails.has(r.email)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('notification_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveJdfDailyCommsDiscussionRecipients delete:', delErr); throw delErr }
  }
}

// ─── Manual test trigger ─────────────────────────────────────────────────

export async function triggerJdfDailyCommsTest() {
  const res = await fetch('/.netlify/functions/jdf-daily-comms-email-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}
