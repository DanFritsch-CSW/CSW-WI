'use strict'

// AI Appointment Intake — shared core. Added 2026-09-05, replacing (with
// Front Playbook as an explicit fallback, not a replacement) the manual
// Playbook-only flow for prepopulating the scheduling plugin's Single
// APPT / Load Container / Multi APPT tabs from inbound carrier emails.
//
// SCOPING HISTORY (see Notion changelog for full detail): built after
// reading ~20 real conversations across all 5 Appointments inboxes
// (CAL/KEN/MAD/WR/EC) rather than assuming one inbox's traffic pattern
// generalizes. Real, confirmed findings that shaped this file:
//
// - Type (Inbound/Outbound), Date, and PO Number are reliably present in
//   the first inbound message across every inbox. High confidence.
// - Carrier is NOT reliably present in the first message — it surfaces in
//   later reply signatures more often than not (confirmed on real
//   PO 519978/TQL and other threads). NEVER extracted here — stays
//   CSR-entered, same as today.
// - Duration is never mentioned in source emails anywhere. NEVER
//   extracted — stays the existing system default.
// - Load Container signal (one truck, multiple orders) shows up as
//   explicit nose/tail language or a comma/ampersand-separated PO or
//   vendor list in one message. Real examples confirmed on CAL and KEN.
//   Known gap, not a bug: a second order sometimes only surfaces after
//   the driver checks in — this pipeline cannot see that at intake time,
//   and the CSR will still need to add it manually in that case.
// - Multi APPT (genuinely separate appointments, different times) is
//   real and inbox-specific in its SOURCE FORMAT — three different
//   shapes confirmed live, not one:
//     - MAD: grouped-by-destination lists ("3 loads [store] (PO,PO,PO)").
//       A meaningful share of MAD's batch volume arrives as an email
//       ATTACHMENT (spreadsheet), not body text — those are invisible to
//       this pipeline and fall through to Playbook/manual, same as today.
//     - WR: literal tables (CUSTOMER REF# / BOOKING / SALES ORDER# /
//       MW# / Requested Time / Notes). Real, LIVE evidence that Playbook
//       currently mishandles this shape: one real AGROPUR conversation
//       shows Playbook collapsing 15 distinct order rows (different
//       times) into a single Date field with all 15 POs comma-joined —
//       exactly the class of error this pipeline exists to fix.
//     - EC: clean line-per-PO ("PO – Deliver date @ time"). The most
//       reliably parseable of the three despite EC being the
//       lowest-volume inbox.
//   Same extraction schema runs across all 5 inboxes rather than being
//   gated per-facility — cheaper to maintain one prompt than five, and
//   CAL/KEN showing weak signal in a ~20-conversation sample doesn't mean
//   it never happens there.
//
// ONE CLAUDE CALL, NOT TWO: originally scoped as a "core fields" pass +
// a separate "routing" pass. Combined into a single structured-JSON call
// instead — same information, half the latency/cost, and the routing
// decision benefits from seeing the full extracted appointment list
// rather than being made blind to it.
//
// DATA-MODEL DECISION, FLAGGED FOR DAN'S REVIEW: Single and Load
// Container both still write to ONE `submissions` row per conversation
// (matching scheduling-front-webhook.cjs's existing findStub/updateStub
// shape exactly — Load Container's multiple PO numbers are stored
// comma-joined in reference_number, the same shape Playbook's own
// parsePlaybook() already produces). Multi APPT is different: it
// genuinely needs N independent rows (one per appointment, each its own
// date/time), so this pipeline writes N rows keyed as
// `${conversationId}::${index}` rather than the bare conversation ID, to
// avoid colliding with scheduling-front-webhook.cjs's single-row-per-
// conversation assumption. The backend writes these rows and logs the
// routing decision (submissions.intake_routing); wiring PluginView to
// actually recognize routing='multi' and open/prefill the Multi APPT tab
// automatically is a frontend change touching existing UI structure —
// per this project's mockup-first convention for structural UI changes,
// that part is intentionally NOT built in this pass and should be scoped
// as its own fast follow-up once Dan reviews the real row shape.
//
// CONFIDENCE GATING: below CONFIDENCE_THRESHOLD, or missing required
// fields, or any Claude/API error → nothing is written to `submissions`
// at all. The conversation is logged (ai_appt_intake_log) and Playbook's
// existing tag-driven flow (in scheduling-front-webhook.cjs) remains the
// fallback, exactly as it already runs today.
//
// CONFLICT RULE: scheduling-front-webhook.cjs's Playbook-tag path was
// patched (same commit as this file) to never overwrite a field this
// pipeline already populated — see that file's updated updateStub calls.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

const CLAUDE_MODEL = 'claude-sonnet-4-5'
const CONFIDENCE_THRESHOLD = 0.8

// Front inbox_id -> the exact warehouse name strings this app already
// uses elsewhere (confirmed live via Omni during the Scorecard build:
// CSW-Eau Claire, CSW-Franksville, CSW-Kenosha, CSW-Madison,
// CSW-Wisconsin Rapids). Warehouse is ALWAYS set from this map, never
// asked of Claude — deterministic beats inferred.
const INBOX_WAREHOUSE_MAP = {
  inb_aut78: 'CSW-Franksville', // CAL Appointments
  inb_awl90: 'CSW-Kenosha',     // KEN Appointments
  inb_awlas: 'CSW-Madison',     // MAD Appointments
  inb_b8n2s: 'CSW-Wisconsin Rapids', // WR Appointments
  inb_beis4: 'CSW-Eau Claire',  // EC Appointments
}

function supabaseHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  }
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: supabaseHeaders() })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

async function sbPost(path, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: prefer || 'return=minimal' }),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text)
  try { return text ? JSON.parse(text) : null } catch { return null }
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text)
  try { return text ? JSON.parse(text) : null } catch { return null }
}

async function frontGet(path) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Front GET ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

// Resolves the warehouse name for a given inbox_id. Returns null (not a
// throw) if the inbox isn't one of the 5 known Appointments inboxes —
// callers should skip processing entirely in that case.
function warehouseForInbox(inboxId) {
  return INBOX_WAREHOUSE_MAP[inboxId] || null
}

// Is this the conversation's first-ever message, and is it genuinely
// inbound (not a reply, not an internal note)? Fetches the conversation's
// message list and checks length + inbound flag on the earliest entry.
// Netlify inbound-message webhook payloads carry the conversation and
// message IDs but not a reliable "is this the first message" flag
// directly, so this is confirmed against Front's own API rather than
// trusted from the payload.
async function isFirstInboundMessage(conversationId, messageId) {
  const data = await frontGet(`/conversations/${conversationId}/messages?limit=2`)
  const results = data._results || []
  if (results.length !== 1) return false
  const only = results[0]
  return only.id === messageId && only.is_inbound !== false
}

async function fetchMessageBody(conversationId, messageId) {
  const data = await frontGet(`/messages/${messageId}`)
  return {
    text: data.text || data.body || '',
    subject: data.subject || '',
  }
}

// Dedupe: has this conversation already produced a submitted row? Also
// doubles as the manual-test bypass point — the test entrypoint never
// calls this.
async function alreadyProcessed(conversationId) {
  const rows = await sbGet(
    `ai_appt_intake_log?front_conversation_id=eq.${encodeURIComponent(conversationId)}&outcome=eq.submitted&select=id&limit=1`
  )
  return Array.isArray(rows) && rows.length > 0
}

async function logIntakeAttempt({ conversationId, inboxId, warehouse, outcome, routing, extractedFields, confidence, errorDetail, submissionId }) {
  try {
    await sbPost('ai_appt_intake_log', {
      front_conversation_id: conversationId,
      inbox_id: inboxId || null,
      warehouse: warehouse || null,
      outcome,
      routing: routing || null,
      extracted_fields: extractedFields || null,
      confidence: confidence != null ? confidence : null,
      error_detail: errorDetail || null,
      submission_id: submissionId || null,
    })
  } catch (_) {
    // Best-effort logging only — never let a logging failure mask the
    // real outcome of the intake attempt.
  }
}

// The single structured-extraction Claude call. Returns the parsed JSON
// object or throws. Handles all 3 real multi-appointment source shapes
// (MAD grouped-list, WR table, EC line-per-PO) via prompt instruction
// rather than per-inbox branching — same schema everywhere.
async function extractAppointmentData({ subject, text }) {
  const prompt = `You are extracting scheduling data from an inbound carrier/customer email to a warehouse's dock-appointment inbox. Return ONLY a JSON object, no other text, matching exactly this shape:

{
  "type": "Inbound" | "Outbound" | null,
  "routing": "single" | "load_container" | "multi",
  "appointments": [
    { "poNumber": string | null, "date": "YYYY-MM-DD" | null, "time": "HH:MM" | null }
  ],
  "confidence": number between 0 and 1,
  "reasoning": short string, one sentence
}

ROUTING RULES:
- "single": exactly one order, one truck, one appointment. Default when nothing below applies. appointments has exactly 1 entry.
- "load_container": ONE truck/appointment carrying MULTIPLE orders — signaled by explicit "nose"/"tail" language, or multiple PO/vendor references clearly tied to one pickup/delivery (same single date+time for all). appointments has 2+ entries sharing the same date/time.
- "multi": MULTIPLE GENUINELY SEPARATE appointments (different dates and/or times) requested in one message. This includes: numbered/grouped batch lists by destination, tabular data (columns like PO/booking/order#/requested time), or a line-per-order list ("PO – Deliver date @ time"). appointments has 2+ entries with differing date/time.

RULES:
- Never guess a field you cannot find. Use null rather than fabricating.
- "date" must be a real calendar date if a month/day is stated anywhere (assume the nearest future occurrence of that date if year is omitted).
- Do not extract carrier name or appointment duration under any circumstances — leave them out of the response entirely, they are not requested.
- confidence reflects your certainty in the EXTRACTED FIELDS overall, not just the routing choice.

EMAIL SUBJECT: ${subject || '(none)'}

EMAIL BODY:
${text}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const raw = await res.text()
  let data
  try { data = JSON.parse(raw) } catch { data = { raw } }
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`)
  const textBlock = (data.content || []).find((b) => b.type === 'text')
  if (!textBlock) throw new Error(`Claude API returned no text block: ${JSON.stringify(data)}`)

  let parsed
  try {
    // Strip any accidental markdown code-fence wrapping before parsing.
    const cleaned = textBlock.text.trim().replace(/^```json\s*|```$/g, '').trim()
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error(`Could not parse Claude's response as JSON: ${textBlock.text.slice(0, 300)}`)
  }
  return parsed
}

function isUsableSingleOrContainer(extracted) {
  if (!extracted.type) return false
  if (!Array.isArray(extracted.appointments) || extracted.appointments.length === 0) return false
  return extracted.appointments.every((a) => a.poNumber || a.date)
}

// Builds the scheduled_arrival string the way the rest of this app
// already stores it (ISO-ish datetime text — the plugin adds/edits time
// on top; see submissions.scheduled_arrival's existing text type).
function combineDateTime(date, time) {
  if (!date) return null
  return time ? `${date}T${time}:00` : date
}

// Single / Load Container: ONE submissions row per conversation, same
// findStub/updateStub shape scheduling-front-webhook.cjs already uses.
// Multiple PO numbers (Load Container case) are comma-joined into
// reference_number — identical shape to Playbook's own parsePlaybook().
async function writeSingleOrContainerSubmission({ conversationId, warehouse, extracted }) {
  const first = extracted.appointments[0]
  const poNumbers = extracted.appointments.map((a) => a.poNumber).filter(Boolean).join(',')
  const fields = {
    type: extracted.type,
    warehouse,
    scheduled_arrival: combineDateTime(first.date, first.time),
    reference_number: poNumbers || null,
    front_conversation_id: conversationId,
    intake_source: 'claude',
    intake_routing: extracted.routing,
    status: 'pending',
  }

  const existingRows = await sbGet(
    `submissions?front_conversation_id=eq.${encodeURIComponent(conversationId)}&select=id,status&limit=1`
  )
  const existing = Array.isArray(existingRows) && existingRows[0]

  if (existing) {
    if (existing.status === 'approved') return { skipped: true, reason: 'already approved' }
    const { front_conversation_id, ...patchFields } = fields
    const updated = await sbPatch(`submissions?id=eq.${encodeURIComponent(existing.id)}`, patchFields)
    return { submissionId: existing.id, updated: true, row: updated?.[0] }
  }

  const inserted = await sbPost('submissions', fields, 'return=representation')
  return { submissionId: inserted?.[0]?.id, inserted: true, row: inserted?.[0] }
}

// Multi APPT: N independent rows, one per real appointment, keyed as
// `${conversationId}::${index}` — see file header DATA-MODEL DECISION.
// Deliberately does NOT touch the bare conversationId row (Playbook's
// tag flow still owns that key), avoiding any collision.
async function writeMultiSubmissions({ conversationId, warehouse, extracted }) {
  const rows = []
  for (let i = 0; i < extracted.appointments.length; i++) {
    const appt = extracted.appointments[i]
    const fields = {
      type: extracted.type,
      warehouse,
      scheduled_arrival: combineDateTime(appt.date, appt.time),
      reference_number: appt.poNumber || null,
      front_conversation_id: `${conversationId}::${i}`,
      intake_source: 'claude',
      intake_routing: 'multi',
      status: 'pending',
    }
    const inserted = await sbPost('submissions', fields, 'return=representation')
    rows.push(inserted?.[0])
  }
  return { submissionIds: rows.map((r) => r?.id).filter(Boolean), rows }
}

// Full pipeline for one webhook event. Used identically by the live
// webhook handler and the manual test entrypoint — the only difference
// is whether the dedupe check runs (test bypasses it, same convention as
// every other -test.cjs in this app).
async function runIntakeForMessage({ conversationId, messageId, inboxId, isManualTest }) {
  const warehouse = warehouseForInbox(inboxId)
  if (!warehouse) {
    return { ok: false, skipped: true, reason: `Inbox ${inboxId} is not a known Appointments inbox` }
  }

  if (!ANTHROPIC_API_KEY) {
    await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'error', errorDetail: 'ANTHROPIC_API_KEY not configured' })
    return { ok: false, reason: 'ANTHROPIC_API_KEY not configured' }
  }

  if (!isManualTest) {
    const isFirst = await isFirstInboundMessage(conversationId, messageId).catch(() => false)
    if (!isFirst) {
      await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'skipped_not_first_message' })
      return { ok: false, skipped: true, reason: 'not the first inbound message' }
    }

    const dup = await alreadyProcessed(conversationId)
    if (dup) {
      await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'skipped_dedupe' })
      return { ok: false, skipped: true, reason: 'already processed' }
    }
  }

  let extracted
  try {
    const { text, subject } = await fetchMessageBody(conversationId, messageId)
    extracted = await extractAppointmentData({ subject, text })
  } catch (e) {
    await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'error', errorDetail: e.message })
    return { ok: false, reason: e.message }
  }

  const confidence = typeof extracted.confidence === 'number' ? extracted.confidence : 0
  const routing = extracted.routing === 'multi' || extracted.routing === 'load_container' ? extracted.routing : 'single'

  if (confidence < CONFIDENCE_THRESHOLD || !isUsableSingleOrContainer({ ...extracted, routing })) {
    await logIntakeAttempt({
      conversationId, inboxId, warehouse, outcome: 'skipped_low_confidence',
      routing, extractedFields: extracted, confidence,
    })
    return { ok: false, skipped: true, reason: 'low confidence or missing fields — left for Playbook fallback', extracted }
  }

  let writeResult
  try {
    writeResult = routing === 'multi'
      ? await writeMultiSubmissions({ conversationId, warehouse, extracted })
      : await writeSingleOrContainerSubmission({ conversationId, warehouse, extracted })
  } catch (e) {
    await logIntakeAttempt({
      conversationId, inboxId, warehouse, outcome: 'error', routing,
      extractedFields: extracted, confidence, errorDetail: e.message,
    })
    return { ok: false, reason: e.message }
  }

  await logIntakeAttempt({
    conversationId, inboxId, warehouse, outcome: 'submitted', routing,
    extractedFields: extracted, confidence,
    submissionId: writeResult.submissionId || (writeResult.submissionIds || [])[0],
  })

  return { ok: true, routing, confidence, extracted, writeResult }
}

module.exports = {
  warehouseForInbox,
  isFirstInboundMessage,
  fetchMessageBody,
  alreadyProcessed,
  logIntakeAttempt,
  extractAppointmentData,
  runIntakeForMessage,
  INBOX_WAREHOUSE_MAP,
  CONFIDENCE_THRESHOLD,
}
