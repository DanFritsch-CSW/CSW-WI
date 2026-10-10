'use strict'

/**
 * Netlify Background Function: scheduling-push-to-datex-background
 * Ported from front_netlify_datex/functions/push-to-datex-background.js (2026-08-03).
 *
 * Handles the actual Datex API push after scheduling-approve-submission.cjs
 * has done the fast synchronous prep work (edits saved, status set to
 * 'processing'). Netlify returns 202 Accepted to the caller immediately;
 * this function then runs in the background -- up to 15 minutes, though the
 * real Datex push completes in 1-3 seconds.
 *
 * The Plugin polls scheduling-get-submissions every 2s after triggering this
 * function, waiting for status to flip to 'approved' (with
 * datex_appointment_id) or 'failed'.
 *
 * Filename suffix -background.cjs is required by Netlify to get this
 * fire-and-forget 202 behavior -- do not rename.
 *
 * UPDATED 2026-10-10 -- the customer/carrier-facing reply (draft or send)
 * now goes through scheduling-agent-reply (a Supabase Edge Function using
 * Front's MCP create_draft/send_message tools via the scheduling_agent's
 * existing OAuth credentials), not front-draft-shared.cjs's raw REST API.
 * That file maintains its own channel-resolution (WAREHOUSE_MAP fallback)
 * and reply-all recipient union logic -- a 2026-08-20 fix already tried
 * resolving the channel from the conversation's own inbound message first,
 * but replies were still occasionally landing as a brand-new thread for
 * outside carriers instead of a real reply (Dan's report). Front's own
 * create_draft tool, called with no channelId/to/cc/bcc, replies on the
 * conversation's actual channel to the actual reply-all recipients
 * natively -- Front resolves both internally instead of us reimplementing
 * it. createFrontErrorNote (internal-only note, not customer-facing, not
 * the reported bug) is unchanged and is now also the fallback if the new
 * path itself fails, so a failure is never silent.
 *
 * POST /.netlify/functions/scheduling-push-to-datex-background
 * Body: { id: "<uuid>", source?: string, draft_template?: string, send_email?: boolean }
 */

const { pushToDatex } = require('./lib/datex-push-shared.cjs')
const { createFrontErrorNote } = require('./lib/front-draft-shared.cjs')

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

// New as of 2026-10-10 -- the Supabase Edge Function that posts the
// customer/carrier reply via Front's MCP instead of the raw REST API.
const SCHEDULING_AGENT_REPLY_URL = process.env.SCHEDULING_AGENT_REPLY_URL || ''
const SCHEDULING_REPLY_SERVICE_SECRET = process.env.SCHEDULING_REPLY_SERVICE_SECRET || ''

function supabaseHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) }
}

async function fetchRecord(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?select=*&id=eq.${encodeURIComponent(id)}`, { headers: supabaseHeaders() })
  if (!res.ok) return null
  const rows = await res.json()
  return rows?.[0] || null
}

async function updateRecord(id, fields) {
  await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(fields),
  }).catch((err) => console.error('[scheduling-push-to-datex-background] update failed:', err.message))
}

// Posts the customer/carrier confirmation reply via scheduling-agent-reply
// (Front MCP create_draft + optional send_message). Returns { ok: true, ... }
// or throws on failure so the caller can fall back to an internal error note.
async function postCustomerReply(record, { sendImmediately, template }) {
  if (!SCHEDULING_AGENT_REPLY_URL || !SCHEDULING_REPLY_SERVICE_SECRET) {
    throw new Error('SCHEDULING_AGENT_REPLY_URL / SCHEDULING_REPLY_SERVICE_SECRET not configured')
  }
  const res = await fetch(SCHEDULING_AGENT_REPLY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-service-secret': SCHEDULING_REPLY_SERVICE_SECRET },
    body: JSON.stringify({ conversationId: record.front_conversation_id, records: [record], template, sendImmediately: !!sendImmediately }),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok || !data?.ok) throw new Error(`scheduling-agent-reply -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`)
  return data
}

// Phase 2 of the Sam Rohde / Daren Peet full-automation confidence build
// (2026-10-10) -- see lib/auto-appt-parse-shared.cjs's header note. If this
// submission has a pending shadow-validation row in auto_appt_attempts
// (agent_submission_id = this id, match_status = 'pending_outcome'), fill
// in what actually happened and grade it against what scheduling_agent
// originally produced and what the dock-door-rule engine recommended.
// Deliberately isolated and non-fatal -- a confidence-building side
// channel, never allowed to affect the real Datex push or customer reply.
// Runs for every submission; a no-op (no matching row) for the other 4
// facilities and every other sender, so it's safe to call unconditionally.
async function compareShadowOutcome(record) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/auto_appt_attempts?agent_submission_id=eq.${encodeURIComponent(record.id)}&match_status=eq.pending_outcome&select=id,agent_scheduled_arrival,recommended_dock_door`,
      { headers: supabaseHeaders() }
    )
    if (!res.ok) return
    const rows = await res.json()
    const shadow = rows?.[0]
    if (!shadow) return

    const actualArrival = record.scheduled_arrival || null
    const actualDockDoor = record.scheduled_dock_door || null
    const arrivalMatches = shadow.agent_scheduled_arrival === actualArrival
    const dockDoorMatches = !shadow.recommended_dock_door || shadow.recommended_dock_door === actualDockDoor
    const matchStatus = arrivalMatches && dockDoorMatches ? 'matched' : 'mismatch'

    await fetch(`${SUPABASE_URL}/rest/v1/auto_appt_attempts?id=eq.${encodeURIComponent(shadow.id)}`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({
        actual_scheduled_arrival: actualArrival,
        actual_dock_door: actualDockDoor,
        actual_datex_appointment_id: record.datex_appointment_id ?? null,
        match_status: matchStatus,
        compared_at: new Date().toISOString(),
      }),
    })
    console.log('[scheduling-push-to-datex-background] shadow outcome graded:', matchStatus, 'submission', record.id)
  } catch (err) {
    console.error('[scheduling-push-to-datex-background] compareShadowOutcome failed (non-fatal):', err.message)
  }
}

exports.handler = async (event) => {
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    console.error('[scheduling-push-to-datex-background] Invalid JSON body')
    return
  }

  const { id, source, draft_template, send_email } = body
  if (!id) {
    console.error('[scheduling-push-to-datex-background] Missing submission id')
    return
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[scheduling-push-to-datex-background] Supabase env vars not configured')
    return
  }

  try {
    await _run({ id, source, draft_template, send_email })
  } catch (err) {
    console.error('[scheduling-push-to-datex-background] Unhandled error:', err.message)
    await updateRecord(id, { status: 'failed', datex_error: `Internal error: ${err.message}` })
  }
}

async function _run({ id, source, draft_template, send_email }) {
  const record = await fetchRecord(id)
  if (!record) {
    console.error('[scheduling-push-to-datex-background] Record not found:', id)
    await updateRecord(id, { status: 'failed', datex_error: 'Record not found -- Supabase fetch error' })
    return
  }

  // Push to Datex with up to 3 attempts on clearly-transient failures.
  // Attempts are SKIPPED when the prior result was ambiguous (a network
  // timeout where Datex may have already committed the appointment) --
  // retrying an ambiguous result would create duplicate appointments.
  let datexResult
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const check = await fetchRecord(id)
      if (check?.datex_appointment_id != null || check?.status === 'approved') {
        console.warn(`[scheduling-push-to-datex-background] Already approved before attempt ${attempt} -- skipping retry to prevent duplicate`)
        datexResult = { success: true, datex_appointment_id: check.datex_appointment_id }
        break
      }
      const delayMs = 2000 * (attempt - 1) // 2s, then 4s
      console.warn(`[scheduling-push-to-datex-background] Retrying (attempt ${attempt}/${MAX_ATTEMPTS}) after ${delayMs}ms...`)
      await new Promise((r) => setTimeout(r, delayMs))
    }

    try {
      datexResult = await pushToDatex(record)
    } catch (err) {
      console.error(`[scheduling-push-to-datex-background] Attempt ${attempt} threw:`, err.message)
      datexResult = { success: false, error: err.message }
    }

    if (datexResult.success) break
    if (datexResult.ambiguous) {
      console.warn('[scheduling-push-to-datex-background] Ambiguous result (timeout) -- not retrying to prevent duplicate appointment')
      break
    }
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[scheduling-push-to-datex-background] Attempt ${attempt} failed: ${datexResult.error}`)
    }
  }

  // Ambiguous timeout: surface as a warning, not a hard failure. Appointment
  // was likely created; CSR should verify in Datex.
  if (!datexResult.success && datexResult.ambiguous) {
    const warnMsg = datexResult.error || 'Datex request timed out -- appointment may have been created. Verify in Datex before re-approving.'
    console.warn('[scheduling-push-to-datex-background] Marking approved with warning (ambiguous timeout):', warnMsg)
    await updateRecord(id, { status: 'approved', datex_pushed_at: new Date().toISOString(), datex_error: warnMsg })
    if (source === 'plugin' && record.front_conversation_id) {
      const recordForDraft = { ...record, status: 'approved', datex_error: warnMsg }
      try {
        // Ambiguous timeout always drafts (never auto-sends) regardless of
        // send_email -- same as the prior REST version's behavior here.
        await postCustomerReply(recordForDraft, { sendImmediately: false, template: draft_template })
      } catch (draftErr) {
        console.warn('[scheduling-push-to-datex-background] Reply after ambiguous timeout failed:', draftErr.message)
        if (FRONT_API_KEY) {
          try { await createFrontErrorNote(record, FRONT_API_KEY, `Confirmation reply failed: ${draftErr.message}`) } catch (_) { /* ignore */ }
        }
      }
    }
    return
  }

  if (!datexResult.success) {
    const errMsg = datexResult.error || 'Unknown Datex error'
    console.error('[scheduling-push-to-datex-background] All attempts failed:', errMsg)
    await updateRecord(id, { status: 'failed', datex_error: errMsg })
    if (record.front_conversation_id && FRONT_API_KEY) {
      try {
        await createFrontErrorNote(record, FRONT_API_KEY, errMsg)
      } catch (noteErr) {
        console.error('[scheduling-push-to-datex-background] Failed to post error note:', noteErr.message)
      }
    }
    return
  }

  // Mark approved and store the Datex appointment ID
  const approveFields = { status: 'approved', datex_pushed_at: new Date().toISOString(), datex_error: null }
  if (datexResult.datex_appointment_id != null) approveFields.datex_appointment_id = datexResult.datex_appointment_id
  if (datexResult.warning) approveFields.datex_error = datexResult.warning // inactivity timeout but likely succeeded

  await updateRecord(id, approveFields)
  await compareShadowOutcome({ ...record, ...approveFields })

  // Post the confirmation reply (draft or send) when triggered from the plugin.
  // On failure, fall back to an internal error note -- never silent, and never
  // back to the old raw-REST draft/send/comment chain (that's the mechanism
  // we're moving away from).
  if (source === 'plugin' && record.front_conversation_id) {
    const recordForDraft = { ...record, ...approveFields }
    try {
      await postCustomerReply(recordForDraft, { sendImmediately: !!send_email, template: draft_template })
    } catch (replyErr) {
      console.error('[scheduling-push-to-datex-background] Confirmation reply failed:', replyErr.message)
      if (FRONT_API_KEY) {
        try {
          await createFrontErrorNote(record, FRONT_API_KEY, `Appointment pushed to Datex ok, but the confirmation reply failed: ${replyErr.message}. Please reply manually.`)
        } catch (noteErr) {
          console.error('[scheduling-push-to-datex-background] Fallback error note also failed:', noteErr.message)
        }
      }
    }
  }

  console.log(`[scheduling-push-to-datex-background] Done -- id=${id} appt=${datexResult.datex_appointment_id ?? 'none'}`)
}
