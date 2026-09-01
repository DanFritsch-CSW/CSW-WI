// Customer Shortage Report EMAIL draft — helpers. Added 2026-09-01, MOVED
// same day from an earlier Daily Discussion Email version per Dan's
// follow-up: this needs to live within the Customer Shortage Report tab
// "for when we get more customers other than Pretzilla built within it."
// See netlify/functions/lib/shortage-report-email-shared.cjs for the full
// backend design writeup.
//
// Keyed by reportKey (not facility) everywhere — 'pretzilla_ken' today,
// more keys as more customers get added to the tab. Mirrors
// src/lib/cmmOutbound.js's four-concept shape (settings row, TO/CC
// recipients, internal-discussion followers, Front channels).

import { supabase } from './supabase.js'

const DASHBOARD_TYPE = 'shortage_report_email'

// ─── Settings row (reuses prepick_notify_settings — facility column
// repurposed to hold reportKey, see backend shared lib header) ──────────

export async function fetchShortageReportEmailSettings(reportKey) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('prepick_notify_settings')
    .select('notify_hour, notify_minute, notify_days, active, last_sent_date, discussion_comment, author_teammate_id, from_channel_id')
    .eq('facility', reportKey)
    .eq('dashboard_type', DASHBOARD_TYPE)
    .maybeSingle()
  if (error) { console.error('fetchShortageReportEmailSettings:', error); return null }
  return data
}

export async function upsertShortageReportEmailSettings(reportKey, { notifyHour, notifyMinute, notifyDays, active, discussionComment, authorTeammateId, fromChannelId }) {
  if (!supabase) return
  const { error } = await supabase
    .from('prepick_notify_settings')
    .upsert(
      {
        facility: reportKey, dashboard_type: DASHBOARD_TYPE,
        notify_hour: notifyHour, notify_minute: notifyMinute, notify_days: notifyDays, active,
        discussion_comment: discussionComment ?? null,
        author_teammate_id: authorTeammateId ?? null,
        from_channel_id: fromChannelId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'facility,dashboard_type' }
    )
  if (error) { console.error('upsertShortageReportEmailSettings:', error); throw error }
}

// ─── TO/CC email recipients (shortage_report_email_recipients — own
// table, keyed by report_key) ─────────────────────────────────────────

export async function fetchShortageReportEmailRecipients(reportKey) {
  if (!supabase) return { to: [], cc: [] }
  const { data, error } = await supabase
    .from('shortage_report_email_recipients')
    .select('id, email, role, active')
    .eq('report_key', reportKey)
    .order('email')
  if (error) { console.error('fetchShortageReportEmailRecipients:', error); return { to: [], cc: [] } }
  const rows = data ?? []
  return {
    to: rows.filter(r => r.role === 'to'),
    cc: rows.filter(r => r.role === 'cc'),
  }
}

// saveShortageReportEmailRecipients — full replace-set per role, same
// upsert-then-prune pattern as saveCmmOutboundEmailRecipients.
export async function saveShortageReportEmailRecipients(reportKey, toEmails, ccEmails) {
  if (!supabase) return
  const rows = [
    ...(toEmails ?? []).map(email => ({ report_key: reportKey, email, role: 'to', active: true })),
    ...(ccEmails ?? []).map(email => ({ report_key: reportKey, email, role: 'cc', active: true })),
  ]
  if (rows.length) {
    const { error: upErr } = await supabase
      .from('shortage_report_email_recipients')
      .upsert(rows, { onConflict: 'report_key,email,role', ignoreDuplicates: false })
    if (upErr) { console.error('saveShortageReportEmailRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('shortage_report_email_recipients')
    .select('id, email, role')
    .eq('report_key', reportKey)
  if (fetchErr) { console.error('saveShortageReportEmailRecipients fetch:', fetchErr); throw fetchErr }
  const keep = new Set(rows.map(r => `${r.email}|${r.role}`))
  const removeIds = (existing ?? []).filter(r => !keep.has(`${r.email}|${r.role}`)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('shortage_report_email_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveShortageReportEmailRecipients delete:', delErr); throw delErr }
  }
}

// ─── Discussion recipients (internal Front teammates, reuses
// notification_recipients — list_name='shortage_report_email_<reportKey>')

export async function fetchShortageReportEmailFollowers(reportKey) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notification_recipients')
    .select('*')
    .eq('list_name', `shortage_report_email_${reportKey}`)
    .order('name')
  if (error) { console.error('fetchShortageReportEmailFollowers:', error); return [] }
  return data ?? []
}

export async function saveShortageReportEmailFollowers(reportKey, chosenTeammates) {
  if (!supabase) return
  const listName = `shortage_report_email_${reportKey}`
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
    if (upErr) { console.error('saveShortageReportEmailFollowers upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('notification_recipients')
    .select('id, email')
    .eq('list_name', listName)
  if (fetchErr) { console.error('saveShortageReportEmailFollowers fetch:', fetchErr); throw fetchErr }
  const keepEmails = new Set(rows.map(r => r.email))
  const removeIds = (existing ?? []).filter(r => !keepEmails.has(r.email)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('notification_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveShortageReportEmailFollowers delete:', delErr); throw delErr }
  }
}

// ─── Manual test trigger ──────────────────────────────────────────────────

export async function triggerShortageReportEmailTest(reportKey) {
  const res = await fetch('/.netlify/functions/shortage-report-email-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportKey }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}

// Front channels (From picker) — reuses the SAME front_channels table and
// sync function as CMM Outbound; re-exported here so this file is a
// complete, self-contained set of imports for the tab, without importing
// from cmmOutbound.js (a CMM-specific module) for a CMM-unrelated feature.
export { fetchFrontChannels, triggerFrontChannelsSync } from './cmmOutbound.js'
