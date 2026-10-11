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
 * ADDED 2026-10-11 (Dan's explicit request) -- app-wide per-field agent
 * accuracy logging via compareAgentFieldAccuracy(), separate from and
 * broader than compareShadowOutcome() below (which only ever applies to
 * the Palermo's pilot's own shadow-grading rows, Sam Rohde/Daren Peet
 * only). Dan wants a per-field confidence picture -- Warehouse, Type,
 * Project, Owner, Arrival Date, Arrival Time, Dock Door, Carrier,
 * Reference #, Notes -- across EVERY submission scheduling_agent creates,
 * any sender, any facility, so he can prioritize which fields in the
 * extraction prompt are actually worth fixing. Runs right alongside
 * compareShadowOutcome, same point in the flow (right after a successful
 * Datex push, i.e. once the CSR's edits are truly final), reading the
 * agent_* snapshot columns scheduling-agent-webhook now writes onto
 * `submissions` at creation time and logging one row per submission into
 * a new `agent_field_accuracy` table. See that function's own header note
 * for the Appointment Code exception (no agent_* counterpart -- it's
 * never independently agent-written, only ever computed client-side from
 * Project + Reference #).
 *
 * UPDATED 2026-10-11 (same day) -- compareAgentFieldAccuracy() now also
 * carries the submission's sender_email onto the logged row. This is what
 * makes scheduling-agent-webhook's new "Option A" correction-hint
 * retrieval possible: that function looks up a sender's history directly
 * in agent_field_accuracy by sender_email before extracting their next
 * email, so without this column every lookup for a repeat sender would
 * always come back empty.
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

// App-wide per-field agent accuracy comparison -- added 2026-10-11, Dan's
// explicit request. Separate from, and broader than, compareShadowOutcome
// above (Palermo's-only). Runs for EVERY submission scheduling_agent
// created (intake_source:'claude'), any sender, any facility. Compares
// the agent_* snapshot columns scheduling-agent-webhook wrote at creation
// time against the live columns here, at the moment of a successful Datex
// push -- i.e. once the CSR's edits are truly final -- and logs one row
// per submission into agent_field_accuracy with a match flag per field.
// This is the data the field-accuracy digest aggregates into a per-field
// confidence percentage. Isolated and non-fatal, same pattern as
// compareShadowOutcome: never allowed to affect the real Datex push.
// Only covers submissions created after the 2026-10-11 webhook deploy --
// older rows have no agent_* snapshot (all null) and would show every
// field as a false mismatch, so those are skipped entirely here rather
// than polluting the accuracy numbers; the digest script applies the same
// skip when reading this table, as a second line of defense.
// Appointment Code has no agent_* snapshot at all (it's never
// independently agent-written -- see the webhook's 2026-10-11 header
// note, it's computed client-side from Project + Reference # alone) and
// is logged here with lookup_code_agent/lookup_code_match left null; the
// digest can derive an "agent-would-have-been" code from
// agent_project + agent_reference_number if that's ever useful, but it's
// not a distinct signal worth snapshotting separately.
function splitDateTime(v) {
  if (!v || typeof v !== 'string' || !v.includes('T')) return { date: v || null, time: null }
  const [d, t] = v.split('T')
  return { date: d, time: (t || '').slice(0, 5) }
}
function fieldsEqual(a, b) {
  return (a || null) === (b || null)
}
async function compareAgentFieldAccuracy(record) {
  if (record.intake_source !== 'claude') return
  // No agent_* snapshot on this row at all (created before the 2026-10-11
  // webhook deploy) -- every field would show as a false mismatch against
  // nulls. Skip rather than log garbage into the accuracy numbers.
  if (!record.agent_warehouse && !record.agent_type && !record.agent_scheduled_arrival) return
  try {
    const agentSplit = splitDateTime(record.agent_scheduled_arrival)
    const actualSplit = splitDateTime(record.scheduled_arrival)

    const row = {
      submission_id: record.id,
      front_conversation_id: record.front_conversation_id || null,
      warehouse: record.warehouse || null,
      // Added 2026-10-11 alongside scheduling-agent-webhook's "Option A"
      // correction-hint retrieval -- that function looks up this exact
      // sender's history in THIS table before extracting a new email, so
      // without this column every future lookup for a repeat sender would
      // come back empty no matter how many times they've emailed before.
      sender_email: record.sender_email || null,

      warehouse_agent: record.agent_warehouse || null,
      warehouse_actual: record.warehouse || null,
      warehouse_match: fieldsEqual(record.agent_warehouse, record.warehouse),

      type_agent: record.agent_type || null,
      type_actual: record.type || null,
      type_match: fieldsEqual(record.agent_type, record.type),

      project_agent: record.agent_project || null,
      project_actual: record.project || null,
      project_match: fieldsEqual(record.agent_project, record.project),

      owner_agent: record.agent_owner || null,
      owner_actual: record.owner || null,
      owner_match: fieldsEqual(record.agent_owner, record.owner),

      arrival_date_agent: agentSplit.date,
      arrival_date_actual: actualSplit.date,
      arrival_date_match: fieldsEqual(agentSplit.date, actualSplit.date),

      arrival_time_agent: agentSplit.time,
      arrival_time_actual: actualSplit.time,
      arrival_time_match: fieldsEqual(agentSplit.time, actualSplit.time),

      dock_door_agent: record.agent_scheduled_dock_door || null,
      dock_door_actual: record.scheduled_dock_door || null,
      dock_door_match: fieldsEqual(record.agent_scheduled_dock_door, record.scheduled_dock_door),

      carrier_agent: record.agent_carrier || null,
      carrier_actual: record.carrier || null,
      carrier_match: fieldsEqual(record.agent_carrier, record.carrier),

      reference_agent: record.agent_reference_number || null,
      reference_actual: record.reference_number || null,
      reference_match: fieldsEqual(record.agent_reference_number, record.reference_number),

      lookup_code_agent: null,
      lookup_code_actual: record.appointment_lookup_code || null,
      lookup_code_match: null,

      notes_agent: record.agent_notes || null,
      notes_actual: record.notes || null,
      notes_match: fieldsEqual(record.agent_notes, record.notes),
    }

    await fetch(`${SUPABASE_URL}/rest/v1/agent_field_accuracy`, {
      method: 'POST',
      headers: supabaseHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(row),
    })
    console.log('[scheduling-push-to-datex-background] agent field accuracy logged for submission', record.id)
  } catch (err) {
    console.error('[scheduling-push-to-datex-background] compareAgentFieldAccuracy failed (non-fatal):', err.message)
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
  await compareAgentFieldAccuracy({ ...record, ...approveFields })

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
