'use strict'

/**
 * Netlify Background Function: scheduling-push-to-datex-background
 * Ported from front_netlify_datex/functions/push-to-datex-background.js (2026-08-03).
 *
 * Handles the actual Datex API push after scheduling-approve-submission.cjs
 * has done the fast synchronous prep work (edits saved, status set to
 * 'processing'). Netlify returns 202 Accepted to the caller immediately;
 * this function then runs in the background — up to 15 minutes, though the
 * real Datex push completes in 1-3 seconds.
 *
 * The Plugin polls scheduling-get-submissions every 2s after triggering this
 * function, waiting for status to flip to 'approved' (with
 * datex_appointment_id) or 'failed'.
 *
 * Filename suffix -background.cjs is required by Netlify to get this
 * fire-and-forget 202 behavior — do not rename.
 *
 * POST /.netlify/functions/scheduling-push-to-datex-background
 * Body: { id: "<uuid>", source?: string, draft_template?: string, send_email?: boolean }
 */

const { pushToDatex } = require('./lib/datex-push-shared.cjs')
const { createFrontDraft, sendFrontEmail, createFrontComment, createFrontErrorNote } = require('./lib/front-draft-shared.cjs')

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
    await updateRecord(id, { status: 'failed', datex_error: 'Record not found — Supabase fetch error' })
    return
  }

  // Push to Datex with up to 3 attempts on clearly-transient failures.
  // Attempts are SKIPPED when the prior result was ambiguous (a network
  // timeout where Datex may have already committed the appointment) —
  // retrying an ambiguous result would create duplicate appointments.
  let datexResult
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const check = await fetchRecord(id)
      if (check?.datex_appointment_id != null || check?.status === 'approved') {
        console.warn(`[scheduling-push-to-datex-background] Already approved before attempt ${attempt} — skipping retry to prevent duplicate`)
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
      console.warn('[scheduling-push-to-datex-background] Ambiguous result (timeout) — not retrying to prevent duplicate appointment')
      break
    }
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[scheduling-push-to-datex-background] Attempt ${attempt} failed: ${datexResult.error}`)
    }
  }

  // Ambiguous timeout: surface as a warning, not a hard failure. Appointment
  // was likely created; CSR should verify in Datex.
  if (!datexResult.success && datexResult.ambiguous) {
    const warnMsg = datexResult.error || 'Datex request timed out — appointment may have been created. Verify in Datex before re-approving.'
    console.warn('[scheduling-push-to-datex-background] Marking approved with warning (ambiguous timeout):', warnMsg)
    await updateRecord(id, { status: 'approved', datex_pushed_at: new Date().toISOString(), datex_error: warnMsg })
    if (source === 'plugin' && record.front_conversation_id && FRONT_API_KEY) {
      const recordForDraft = { ...record, status: 'approved', datex_error: warnMsg }
      try {
        await createFrontDraft(recordForDraft, FRONT_API_KEY, draft_template)
      } catch (draftErr) {
        console.warn('[scheduling-push-to-datex-background] Draft after ambiguous timeout failed:', draftErr.message)
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

  // Create Front draft reply (or send immediately) when triggered from the plugin
  if (source === 'plugin' && record.front_conversation_id && FRONT_API_KEY) {
    const recordForDraft = { ...record, ...approveFields }
    if (send_email) {
      try {
        await sendFrontEmail(recordForDraft, FRONT_API_KEY, draft_template)
      } catch (sendErr) {
        console.warn('[scheduling-push-to-datex-background] Auto-send failed, falling back to draft:', sendErr.message)
        try {
          await createFrontDraft(recordForDraft, FRONT_API_KEY, draft_template)
        } catch (draftErr) {
          console.error('[scheduling-push-to-datex-background] Draft fallback also failed:', draftErr.message)
        }
      }
    } else {
      try {
        await createFrontDraft(recordForDraft, FRONT_API_KEY, draft_template)
      } catch (draftErr) {
        console.warn('[scheduling-push-to-datex-background] Draft failed, trying comment:', draftErr.message)
        try {
          await createFrontComment(recordForDraft, FRONT_API_KEY, draft_template)
        } catch (commentErr) {
          console.error('[scheduling-push-to-datex-background] Comment also failed:', commentErr.message)
        }
      }
    }
  }

  console.log(`[scheduling-push-to-datex-background] Done — id=${id} appt=${datexResult.datex_appointment_id ?? 'none'}`)
}
