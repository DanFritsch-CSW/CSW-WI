'use strict'

// Shared core for the WR Secondary Replenishments digest — split out
// 2026-07-31 from wr-secondary-repl-digest-run.cjs. Same fix as
// lib/prepick-digest-shared.cjs / lib/fefo-digest-shared.cjs: Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` in
// netlify.toml, which made "Send test digest now" 403 here too. The
// scheduled function (wr-secondary-repl-digest-run.cjs) keeps the
// schedule and only handles the cron tick; the manual test button now
// calls the sibling wr-secondary-repl-digest-test.cjs, which has no
// schedule.
//
// Everything below is otherwise unchanged from the original
// wr-secondary-repl-digest-run.cjs — see that file's original header
// (preserved in git history) for the fuller feature history (PDF
// attachment via wr-secondary-repl-pdf.cjs, the PDF-failure fallback
// path, etc).

const { buildSecondaryReplPdf } = require('./wr-secondary-repl-pdf.cjs')

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

// postDigest — the actual send: fetch live bay data, build the summary,
// attach the PDF, post to Front, and (unless a manual test) stamp
// last_sent_date. Shared by both the scheduled runner and the manual
// test function.
async function postDigest({ conversationId, dateObj, isManualTest }) {
  const date = centralTodayISO()

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

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  sbFetch, sbPatch,
  centralTodayISO, centralTodayDateObj, isNotifyTimeMatch, formatHeaderDate,
  buildDigestBody, postDigest,
}
