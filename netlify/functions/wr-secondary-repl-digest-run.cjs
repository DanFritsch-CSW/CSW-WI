'use strict'

// WR Secondary Replenishments digest — added 2026-07-15 alongside the
// MotherDuck rewrite, per Dan's ask for a Notify panel on this tab like
// the other WR tabs. Content date is TODAY, not tomorrow — this is a
// live "how many bays are short right now" check, same reasoning as
// wr-pickcheck-digest-run.cjs / fefo-digest-run.cjs (no appointment
// lead-time to look ahead across). Single settings row: facility='wr',
// dashboard_type='secondary_repl' in prepick_notify_settings, editable
// from the Secondary Replenishments tab's Notify Settings panel
// (contentDateLabel="today", showSkipToNextValidDay={false} — see
// NotifySettingsPanel.jsx).
//
// Data source: proxies to wr-secondary-repl.cjs via internal HTTP call
// and reads its `summary` field (bays/emptyPositions/critical/
// noSecondaryInv/splitBays) — computed server-side there via a port of
// the client's buildBays algorithm, so this digest doesn't re-implement
// bay-building logic a second time. See that file's header comment.
//
// PDF attachment (added 2026-07-15, same-day follow-up per Dan) — the
// digest now also attaches a PDF similar to the tab's own Print button
// output, alongside the text summary on the same Front comment. Built
// via wr-secondary-repl-pdf.cjs (pdf-lib, pure JS, no native bindings —
// deliberately NOT a headless-browser screenshot of the live page, same
// "avoid Chromium-on-Lambda fragility" reasoning Dan already applied to
// dailyops-digest-run.cjs's canvas-based image rendering). Posted via
// multipart/form-data with attachments[] — same pattern
// dailyops-digest-run.cjs uses for its image attachments (Front's
// comment API doesn't accept file attachments in a plain JSON body).
//
// Two invocation paths (same convention as every other digest):
//   1. SCHEDULED (netlify.toml: "*/15 * * * *") — fires when current
//      America/Chicago time matches notify_hour/notify_minute and hasn't
//      already sent today (last_sent_date guard, keyed to today's date
//      since content date === fire date here).
//   2. MANUAL TEST (plain POST, no body) — bypasses time/active/
//      last_sent_date checks, never writes last_sent_date.

const { buildSecondaryReplPdf } = require('./wr-secondary-repl-pdf.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL
const APP_URL = 'https://csw-wi.netlify.app/facility/wr?tab=secondary'

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(t) }
}

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function centralTodayISO() {
  const { year, month, day } = centralNowParts()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function centralTodayDateObj() {
  const { year, month, day } = centralNowParts()
  return new Date(Date.UTC(year, month - 1, day))
}

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
}

function fmt(n) { return n == null ? '—' : Math.round(n).toLocaleString() }

function buildDigestBody(data, dateObj) {
  const s = data.summary || {}
  const lines = []
  lines.push(`Secondary Replenishments — Bernatello's - Wisconsin Rapids`)
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push(`As of: ${formatHeaderDate(dateObj)}`)
  lines.push('')

  const divider = '─'.repeat(28)
  lines.push(divider)
  lines.push(`**${fmt(s.emptyPositions)} EMPTY POSITIONS**`)
  lines.push(divider)
  lines.push('')
  lines.push(`Bays checked: ${fmt(s.bays)}`)
  lines.push(`Critical (5+ empty): ${fmt(s.critical)}`)
  lines.push(`No secondary inv.: ${fmt(s.noSecondaryInv)}`)
  lines.push(`Split bays: ${fmt(s.splitBays)}`)

  return lines.join('\n')
}

// Posts the text summary as the comment body, with the PDF attached in
// the same multipart request — same postImageComment pattern
// dailyops-digest-run.cjs uses for its PNG attachments, just with a PDF
// blob and MIME type instead.
async function postCommentWithPdf(conversationId, body, pdfBytes, filename) {
  const form = new FormData()
  form.set('body', body)
  form.set('attachments[]', new Blob([pdfBytes], { type: 'application/pdf' }), filename)
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
    body: form,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(`Front API error posting comment with PDF: ${JSON.stringify(json)}`)
  return json
}

async function runDigest({ isManualTest }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.wr&dashboard_type=eq.secondary_repl&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settings = settingsRows?.[0]
  const conversationId = settings?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for WR Secondary Replenishments in prepick_notify_settings' }
  }

  const dateObj = centralTodayDateObj()
  const date = centralTodayISO()

  if (!isManualTest) {
    if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }
    const notifyHour = settings.notify_hour ?? 7
    const notifyMinute = settings.notify_minute ?? 0
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
    }
    if (settings.last_sent_date === date) {
      return { ok: true, skipped: true, reason: 'Already sent for this date' }
    }
    const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
    const isoWeekday = dateObj.getUTCDay() === 0 ? 7 : dateObj.getUTCDay()
    if (!notifyDays.includes(isoWeekday)) {
      return { ok: true, skipped: true, reason: `${date} is not a configured notify day` }
    }
  }

  const dataRes = await fetch(`${SITE_URL}/.netlify/functions/wr-secondary-repl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const dataText = await dataRes.text()
  let dataJson
  try { dataJson = JSON.parse(dataText) } catch { dataJson = { raw: dataText } }
  if (!dataRes.ok) {
    return { ok: false, reason: 'wr-secondary-repl failed', detail: dataJson }
  }

  const body = buildDigestBody(dataJson, dateObj)

  let pdfBytes
  try {
    pdfBytes = await buildSecondaryReplPdf(dataJson)
  } catch (e) {
    // PDF generation failing shouldn't block the text summary from
    // going out — fall back to a text-only comment and surface the PDF
    // error so it's visible without silently losing the whole digest.
    const fallbackRes = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ body: `${body}\n\n(PDF attachment failed to generate: ${e.message})` }),
    })
    const fallbackText = await fallbackRes.text()
    let fallbackJson
    try { fallbackJson = JSON.parse(fallbackText) } catch { fallbackJson = { raw: fallbackText } }
    if (!fallbackRes.ok) {
      return { ok: false, reason: 'Front API error posting fallback comment', detail: fallbackJson }
    }
    if (!isManualTest) {
      await sbPatch(`prepick_notify_settings?facility=eq.wr&dashboard_type=eq.secondary_repl`, { last_sent_date: date })
    }
    return { ok: true, date, conversationId, commentId: fallbackJson.id, pdfError: e.message }
  }

  const frontJson = await postCommentWithPdf(conversationId, body, pdfBytes, `secondary-replenishments-${date}.pdf`)

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.wr&dashboard_type=eq.secondary_repl`, { last_sent_date: date })
  }

  return { ok: true, date, conversationId, commentId: frontJson.id }
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  const isManualTest = event.httpMethod === 'POST' && !isScheduled

  if (!isScheduled && !isManualTest) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only (or scheduled invocation)' }) }
  }

  try {
    const result = await runDigest({ isManualTest })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
