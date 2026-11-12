// Scheduling Agent: Front agent webhook as a Supabase Edge Function.
// Replaces the dead Playbook->ai-appt-intake-webhook.cjs trigger path.
//
// See Notion/CSW-WI Architecture > Scheduling for full design history
// (carrier/owner fuzzy matching, sender-default fills, Datex order lookup
// at intake, reply-after-confirmation handling, etc.) -- condensed here.
//
// FIXED 2026-10-23 (Dan's live report, cnv_1cpmql90) -- classifyConfirmedReply
// now strips signature blocks / mail-system banners / disclaimers before
// judging pureAcknowledgment, since real replies almost always carry one and
// the un-stripped prompt was flagging every real "Confirmed, thanks!" as a
// non-acknowledgment.
//
// ADDED 2026-10-23 (Dan's explicit decision) -- PALERMO'S FULL AUTOMATION
// EXCEPT SAME-DAY. A Sam/Daren appointment NOT scheduled for today (Central
// time) now pushes to Datex and sends the carrier confirmation with zero CSR
// review; same-day stays on the normal CSR-reviewed path as a safety valve.
// "Same day" = the Palermo override's own final computed appointment date
// (post-lead-time, post-midnight-snap) vs. today's America/Chicago date
// (centralDateStr). Not same day -> PATCH submission to 'processing', POST
// to scheduling-push-to-datex-background.cjs with { id,
// source:'palermo_auto', send_email:true } (that function now recognizes
// 'palermo_auto' alongside 'plugin' for the reply/archive step), and append
// an @dfritsch-mentioning line to the usual confirmation comment (Dan's
// explicit ask, validation period; mention syntax UNVERIFIED).
//
// REDEPLOYED 2026-10-24 -- this auto-push logic was part of v40, deployed
// earlier, but v41 (the classifyConfirmedReply fix above) was deployed from
// a stale pre-automation copy and silently reverted it -- Supabase Edge
// Functions replace the whole function on every deploy, they don't merge.
// Confirmed live: every Sam/Daren appointment from go-live through this
// redeploy posted "Pending review in the Scheduling tab" and was pushed by a
// human CSR via the normal Approve & Push flow -- the automation never
// actually ran. Re-merged onto v41's base so both fixes are live together.
//
// FIXED 2026-11-05 (Arielle/Sadie/Kay's report, cnv_1b15rcyc) -- Notes field
// exploding into dozens of lines on multi-stop/LTL appointments, bloating
// the Datex notes and pushing printed pickslips/check-in sheets onto a
// second page. Root cause: the extraction prompt's DESTINATION field had no
// formatting guidance for a load with several stops, so Claude mirrored the
// email's own per-stop layout (company/city/state/order#, one per line,
// repeated per stop) straight into `destination`, and buildNotesValue()
// passed that multi-line blob into Notes verbatim. Fixed in two places: (1)
// the DESTINATION prompt instruction now tells Claude to compress multiple
// stops into "ORDER_NUMBER - CITY - STATE" segments joined with " | ", no
// company name, no line breaks; (2) buildNotesValue() now runs destination
// through normalizeDestinationForNotes() first, which collapses any line
// breaks into " | "-joins regardless of what the model returns, so this
// can't regress even on a non-compliant extraction.
//
// FIXED 2026-11-10 (Dan's explicit decision, following Nate Williams' Datex
// carrier-list cleanup 2026-11-09) -- CMM and Peters Bros are each
// represented by multiple real, independently-active Datex carrier_ids
// (see Notion/CSW-WI Architecture > Scheduling, "Known carrier ambiguity"),
// and Nate's cleanup renamed the historically-dominant records (CMM 8170/
// 8423 -> oldCMM3/oldCMM4; Peters Bros 15832 and several others -> x.../
// xold... variants) to clean up the Datex carrier picker. The clean,
// currently-named records are CMM -> 3730 and Peters Bros -> 12268. Both
// are now hardcoded (CARRIER_OVERRIDES below, plus PALERMO_CARRIER_DATEX_ID)
// rather than left to fuzzy-match against scheduling_carriers, since that
// table only syncs weekly and had duplicate un-deduped rows for "Peters
// Bros" under different casings even before the rename. NOTE: 8170 was by
// far the higher-volume historical CMM for Palermo's specifically (~4-5x
// more appointments than 3730) -- if appointments booked against the old
// carrier_id keep materializing, that is why; flagged to Dan at the time.
//
// INCIDENT 2026-11-10 (Dan's own account, self-reported) -- a deploy of this
// function (to make the CMM/Peters Bros fix above) was sent with PLACEHOLDER
// text instead of real file contents for all 4 files, wiping the live
// function down to a stub for a window that morning (every mention errored,
// silently, since the top-level handler always returns HTTP 200). index.ts
// itself was recovered intact (it was saved outside Supabase before the bad
// deploy). sender-defaults.ts, learned-owner.ts and datex-lookup.ts were
// NOT recoverable -- no Supabase Edge Function version history/rollback is
// exposed, and this function was never committed to the CSW-WI GitHub repo
// (only order-agent-* and grassland-order-* are). Those three files were
// rebuilt from scratch from this file's own call sites plus the Notion
// Scheduling page's documented behavior for each (v35/v37 sender defaults,
// v49 learned owner, v36 Datex lookup) -- see each file's own header. They
// have NOT been diffed byte-for-byte against the originals. Watch
// agent_field_accuracy / CSR corrections and ai_appt_intake_log closely for
// a few days to confirm behavior matches pre-incident.
import {
  applySenderCarrierDefault,
  applySenderDockDoorDefault,
  applySenderOwnerDefault,
  computeSenderDefaults,
  formatSenderFillNote,
  normKey,
  type SenderDefault,
  type SenderDefaults,
} from './sender-defaults.ts'
import {
  LEARNED_WINDOW_DAYS,
  buildOwnerModel,
  formatLearnedOwnerNote,
  predictOwner,
  type OwnerModel,
  type OwnerPrediction,
} from './learned-owner.ts'
import {
  applyDatexOrder,
  extractCandidateReferences,
  formatDatexNote,
  pickDatexOrder,
  type CandidateResult,
  type DatexMatch,
} from './datex-lookup.ts'

const PALERMO_OWNER_NAME = 'Palermo Villa, Inc.'
const PALERMO_OWNER_DATEX_ID = 704
const PALERMO_PROJECT_NAME = 'Palermos CALEDONIA materials bulk'
const PALERMO_PROJECT_DATEX_ID = 8
const PALERMO_DOCK_DOOR = 'OUTBOUND PALERMO'
const PALERMO_DOCK_DOOR_DATEX_ID = 47465
const PALERMO_CARRIER_NAME = 'CMM'
const PALERMO_CARRIER_DATEX_ID = 3730
const PALERMO_LEAD_TIME_HOURS = 4
const PALERMO_MIDNIGHT_SNAP_MINUTES = 15
const PALERMO_SIGNATURE_NAMES = [/sam\s+rohde/i, /daren\s+peet/i]
const SAM_ROHDE_PATTERN = /\bTO(\d{5,7})\s*-\s*(\d{1,2})\/(\d{1,2})\s*\(\s*needed\s*(\d{1,2})\s*(am|pm)\s*\)/i
const DAREN_PEET_PATTERN = /\bTO_(\d{5,7})\s+Print\s+Transfer\s+Status\s+(\d{1,2})\/(\d{1,2})\s+(\d{3,4})\b/i

// FIXED 2026-10-27 (Dan's live report, cnv_1cqpsx78/cnv_1cqptclw, TO481801 /
// TO481803) -- a cancellation reply that quotes CSW's own prior confirmation
// email below it (standard Outlook "reply with history") was mis-read as a
// brand-new Palermo appointment request: parsePalermoBody() scanned the
// WHOLE body, including the quoted block, which still contains a complete,
// already-fulfilled TO-number/date/time match from the original (now
// cancelled) request -- while "This TO has been cancelled" itself has no
// TO-pattern in it at all, so nothing flagged it. Both Palermo regex checks
// now run ONLY against the sender's own new text, with the quoted/forwarded
// reply chain cut off first, and a cancellation-keyword check in that new
// text is a second, independent gate that suppresses the override even if
// some quoted content slips through unstripped.
const QUOTED_REPLY_CUT_RES = [
  // Outlook/Exchange pasted header block: "From:" followed within a few
  // lines by "Sent:"/"Date:" and then "Subject:" -- the standard
  // "reply with history" quote these clients insert.
  /\n\s*From:[^\n]+\n\s*(Sent|Date):[^\n]+[\s\S]{0,300}?\n\s*Subject:[^\n]+/i,
  // Gmail-style: "On <date>, <name> wrote:"
  /\n\s*On\s.{0,80}\swrote:\s*\n/i,
]
const CANCELLATION_PATTERN = /\b(cancell?ed|cancell?ing|cancel|no longer needed|disregard(?:\s+this)?|void(?:ed)?|scratch that|please ignore)\b/i

function stripQuotedReplyContent(text: string): string {
  let cut = text.length
  for (const re of QUOTED_REPLY_CUT_RES) {
    const m = re.exec(text)
    if (m && m.index < cut) cut = m.index
  }
  // A run of 3+ "> " quoted lines (plain-text quoting) cuts there too, if earlier.
  const quoteLines = /\n\s*>.*(\n\s*>.*){2,}/.exec(text)
  if (quoteLines && quoteLines.index < cut) cut = quoteLines.index
  return text.slice(0, cut).trim()
}

function hasCancellationLanguage(text: string): boolean {
  return CANCELLATION_PATTERN.test(text)
}

// ADDED 2026-10-23 -- see header note (Palermo's full automation except
// same-day). PALERMO_AUTO_PUSH_URL points at the existing Netlify push
// function -- no new endpoint.
// REMOVED 2026-11-05 (Dan's explicit request) -- the @dfritsch validation-
// period mention on every auto-pushed confirmation comment is gone; the
// comment now just states what happened, no notify-Dan step.
const PALERMO_AUTO_PUSH_URL = (Deno.env.get('SCHEDULING_PUSH_URL') || '') || 'https://csw-wi.netlify.app/.netlify/functions/scheduling-push-to-datex-background'

function hasPalermoSignature(text: string): boolean {
  return PALERMO_SIGNATURE_NAMES.some((re) => re.test(text))
}

function fmtLocalPalermo(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${dd}T${hh}:${mi}`
}

function resolvePalermoDatesFromParts(digits: string, month: number, day: number, hour24: number) {
  const now = new Date()
  let year = now.getFullYear()
  let neededByDate = new Date(year, month - 1, day, hour24, 0, 0)
  const diffDays = (now.getTime() - neededByDate.getTime()) / (1000 * 60 * 60 * 24)
  if (diffDays > 60) {
    year += 1
    neededByDate = new Date(year, month - 1, day, hour24, 0, 0)
  }
  let apptDate = new Date(neededByDate.getTime() - PALERMO_LEAD_TIME_HOURS * 60 * 60 * 1000)
  if (apptDate.getHours() === 0 && apptDate.getMinutes() === 0) {
    apptDate = new Date(apptDate.getTime() - PALERMO_MIDNIGHT_SNAP_MINUTES * 60 * 1000)
  }
  return { reference: digits, scheduledArrival: fmtLocalPalermo(apptDate) }
}

// ADDED 2026-10-23 -- today's calendar date in America/Chicago, the same
// timezone convention every other digest/report in this app already uses.
// Used only to decide whether a Palermo's appointment is "today" (stays
// CSR-reviewed) or not (auto-pushes).
function centralDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function parsePalermoBody(text: string): { reference: string; scheduledArrival: string } | null {
  let m = SAM_ROHDE_PATTERN.exec(text)
  if (m) {
    const [, digits, monthStr, dayStr, hourStr, ampm] = m
    let hour24 = parseInt(hourStr, 10) % 12
    if (ampm.toLowerCase() === 'pm') hour24 += 12
    return resolvePalermoDatesFromParts(digits, parseInt(monthStr, 10), parseInt(dayStr, 10), hour24)
  }
  m = DAREN_PEET_PATTERN.exec(text)
  if (m) {
    const [, digits, monthStr, dayStr, rawTime] = m
    const mm = rawTime.slice(-2)
    const hh = rawTime.length === 3 ? rawTime.slice(0, 1) : rawTime.slice(0, 2)
    const hour24 = parseInt(hh, 10)
    if (parseInt(mm, 10) !== 0) return null
    return resolvePalermoDatesFromParts(digits, parseInt(monthStr, 10), parseInt(dayStr, 10), hour24)
  }
  return null
}

// Secrets (Supabase > Edge Functions > Secrets):
//   FRONT_SCHEDULING_AGENT_CLIENT_ID, FRONT_SCHEDULING_AGENT_CLIENT_SECRET,
//   FRONT_SCHEDULING_AGENT_SIGNING_SECRET, FRONT_SCHEDULING_AGENT_TOKEN_URL,
//   ANTHROPIC_API_KEY
// Optional: ORDER_SEARCH_URL (override), DATEX_LOOKUP_ENABLED=false,
// SCHEDULING_PUSH_URL (override for the Palermo's auto-push trigger).
// Auto-provided: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Kill switch: SCHEDULING_AGENT_ENABLED=false.
// deploy with verify_jwt=false (Front cannot send a Supabase JWT; auth is
// the HMAC signature).

// deno-lint-ignore-file no-explicit-any
const env = (k: string) => Deno.env.get(k) || ''
const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY')
const CLAUDE_MODEL = 'claude-sonnet-4-5'
const CONFIDENCE_THRESHOLD = 0.8
const CARRIER_MATCH_THRESHOLD = 0.8
const MCP_URL = 'https://mcp.frontapp.com/mcp'
const MCP_PROTOCOL = '2025-11-25'
const MAX_SKEW_MS = 10 * 60 * 1000

const ORDER_SEARCH_URL = env('ORDER_SEARCH_URL') || 'https://csw-wi.netlify.app/.netlify/functions/scheduling-order-search'
const ORDER_SEARCH_TIMEOUT_MS = 20000
const WAREHOUSE_SHORT: Record<string, string> = {
  'CSW-Franksville': 'CAL',
  'CSW-Kenosha': 'KEN',
  'CSW-Madison': 'MAD',
  'CSW-Wisconsin Rapids': 'WR',
  'CSW-Eau Claire': 'EC',
}

const MIN_HINT_REPEAT_COUNT = 2
const MIN_HINT_MAJORITY_SHARE = 0.6
const HINT_FIELDS = ['owner', 'project', 'carrier', 'dock_door'] as const
const HINT_FIELD_LABELS: Record<string, string> = { owner: 'Owner', project: 'Project', carrier: 'Carrier', dock_door: 'Dock Door' }

const INBOX_WAREHOUSE_MAP: Record<string, string> = {
  inb_aut78: 'CSW-Franksville',
  inb_awl90: 'CSW-Kenosha',
  inb_awlas: 'CSW-Madison',
  inb_b8n2s: 'CSW-Wisconsin Rapids',
  inb_beis4: 'CSW-Eau Claire',
}

const WAREHOUSE_CITY_HINTS: Record<string, string[]> = {
  'CSW-Franksville': ['Franksville', 'Caledonia', 'CAL'],
  'CSW-Kenosha': ['Kenosha'],
  'CSW-Madison': ['Madison', 'MAD'],
  'CSW-Wisconsin Rapids': ['Wisconsin Rapids', 'WR'],
  'CSW-Eau Claire': ['Eau Claire', 'EC'],
}

const sbH = (extra?: any) => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) })
async function sbGet(path: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH() })
  const t = await res.text()
  if (!res.ok) throw new Error(t)
  return t ? JSON.parse(t) : null
}
async function sbGetAll(path: string): Promise<any[]> {
  const PAGE_SIZE = 1000
  let offset = 0
  let all: any[] = []
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=${PAGE_SIZE}&offset=${offset}`, { headers: sbH() })
    const t = await res.text()
    if (!res.ok) throw new Error(t)
    const page = t ? JSON.parse(t) : []
    if (!Array.isArray(page) || page.length === 0) break
    all = all.concat(page)
    if (page.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return all
}
async function sbPost(path: string, body: any, prefer?: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'POST', headers: sbH({ Prefer: prefer || 'return=minimal' }), body: JSON.stringify(body) })
  const t = await res.text()
  if (!res.ok) throw new Error(t)
  try { return t ? JSON.parse(t) : null } catch { return null }
}
async function sbPatch(path: string, body: any): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: sbH({ Prefer: 'return=representation' }), body: JSON.stringify(body) })
  const t = await res.text()
  if (!res.ok) throw new Error(t)
  try { return t ? JSON.parse(t) : null } catch { return null }
}

async function alreadyProcessed(conversationId: string) {
  const rows = await sbGet(`ai_appt_intake_log?front_conversation_id=eq.${encodeURIComponent(conversationId)}&outcome=eq.submitted&select=id&limit=1`)
  return Array.isArray(rows) && rows.length > 0
}

async function fetchSubmissionStatuses(conversationId: string): Promise<string[]> {
  try {
    const cid = encodeURIComponent(conversationId)
    const rows = await sbGet(`submissions?or=(front_conversation_id.eq.${cid},front_conversation_id.like.${cid}::*)&select=status`)
    return Array.isArray(rows) ? rows.map((r: any) => r.status).filter(Boolean) : []
  } catch (_) {
    return []
  }
}

function classifyConversationBucket(statuses: string[]): 'none' | 'pending' | 'confirmed' {
  if (statuses.length === 0) return 'none'
  if (statuses.some((s) => s === 'pending' || s === 'processing')) return 'pending'
  if (statuses.some((s) => s === 'approved')) return 'confirmed'
  return 'pending'
}

// FIXED 2026-10-23 (Dan's live report, cnv_1cpmql90) -- strips signature
// blocks / mail-system banners / disclaimers before judging
// pureAcknowledgment, since real replies almost always carry one and the
// un-stripped prompt was flagging every real "Confirmed, thanks!" as a
// non-acknowledgment.
async function classifyConfirmedReply(text: string): Promise<{ archive: boolean; reasoning: string }> {
  const prompt = `A carrier/customer appointment was already confirmed, and a confirmation email was already sent to them. They have now replied on that same email thread. Decide whether the SUBSTANCE of this reply is a PURE ACKNOWLEDGMENT -- a bare "Thanks", "Confirmed", "Received", "Thank you", or equivalent, with no other content -- or whether it contains ANYTHING ELSE: a new date or time, a question, a change request, or any other substantive content.

FIRST, mentally strip out anything that is NOT part of the sender's own written message: email signature blocks (name, job title, phone numbers, company name/tagline, links), automated banners added by the mail system (e.g. "Caution: sent by an external sender"), legal disclaimers, and quoted/forwarded text from earlier in the thread. These appear on nearly every real email and are NEVER by themselves evidence of a non-acknowledgment reply -- a name and phone number sitting in a signature block is not "a number" or "a name" for the purposes of this decision, and must not by itself push you toward false.

THEN judge pureAcknowledgment using ONLY what remains: the sender's own written words. If that remainder is just a greeting plus a bare acknowledgment ("Confirmed, thank you!", "Thanks!", "Received, appreciate it"), it IS a pure acknowledgment -- even though the full raw email around it contains a signature, banner, or disclaimer. An out-of-office auto-reply is judged the same way: if its own substance states a new return date and alternate contact for urgent matters, that IS substantive content (not a pure ack), regardless of any signature attached to it.

Return ONLY a JSON object, no other text, matching exactly this shape:
{ "pureAcknowledgment": boolean, "reasoning": short string, one sentence }

If, after removing signature/banner/disclaimer noise, the sender's own words still contain a new date or time, a question, a change request, or any other substantive request or information, set pureAcknowledgment to false. If there is genuine doubt even after that filtering, also set it to false. A false negative here (leaving a thread open that could safely have been archived) costs a CSR one manual click to re-archive it. A false positive (archiving a thread that actually needed attention) can hide a real appointment change from the team. The safe default on genuine ambiguity is false -- but a signature block or mail-system banner alone is not genuine ambiguity.

REPLY BODY:
${text}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  })
  const raw = await res.text()
  let data: any
  try { data = JSON.parse(raw) } catch { data = { raw } }
  if (!res.ok) throw new Error(`Claude API error (reply classify): ${JSON.stringify(data).slice(0, 500)}`)
  const textBlock = (data.content || []).find((b: any) => b.type === 'text')
  if (!textBlock) throw new Error('Claude API returned no text block (reply classify)')
  const cleaned = textBlock.text.trim().replace(/^```json\s*|```$/g, '').trim()
  let parsed: any
  try { parsed = JSON.parse(cleaned) } catch { throw new Error(`Could not parse reply-classify response as JSON: ${cleaned.slice(0, 300)}`) }
  return { archive: parsed.pureAcknowledgment === true, reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '' }
}

async function handleConfirmedReply(conversationId: string) {
  let inboxId: string | null = null
  let warehouse: string | null = null
  try {
    const { raw, call } = await withMcp(async (call) => ({ raw: await call('read_conversation', { conversationId, limit: 20 }), call }))
    const resolved = resolveInboxAndWarehouse(raw)
    inboxId = resolved.inboxId
    warehouse = resolved.warehouse
    const { text } = await fetchLatestInboundMessage(raw, call)

    const { archive, reasoning } = await classifyConfirmedReply(text)

    if (archive) {
      await withMcp((c) => c('update_conversation_status', {
        conversationId,
        status: 'archived',
        reason: 'Reply after appointment confirmation classified as a plain acknowledgment.',
      }))
      await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'reply_archived', errorDetail: reasoning })
      return { ok: true, action: 'archived', reasoning }
    }

    await withMcp((c) => c('add_comment', {
      conversationId,
      body: `Possible date/time change or other follow-up on an already-confirmed appointment -- please verify against Datex. No auto-update was made.\n\n(${reasoning})`,
    }))
    await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'reply_flagged', errorDetail: reasoning })
    return { ok: true, action: 'flagged', reasoning }
  } catch (e) {
    const msg = (e as Error).message
    await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'error', errorDetail: `reply-classify: ${msg}`.slice(0, 1000) })
    return { ok: false, error: msg }
  }
}

async function logIntakeAttempt(o: { conversationId: string; inboxId?: string | null; warehouse?: string | null; outcome: string; routing?: string | null; extractedFields?: any; confidence?: number | null; errorDetail?: string | null; submissionId?: string | null }) {
  try {
    await sbPost('ai_appt_intake_log', {
      front_conversation_id: o.conversationId,
      inbox_id: o.inboxId || null,
      warehouse: o.warehouse || null,
      outcome: o.outcome,
      routing: o.routing || null,
      extracted_fields: o.extractedFields || null,
      confidence: o.confidence != null ? o.confidence : null,
      error_detail: o.errorDetail || null,
      submission_id: o.submissionId || null,
    })
  } catch (_) { /* best effort */ }
}

function combineDateTime(date: string | null, time: string | null) {
  if (!date) return null
  return time ? `${date}T${time}:00` : date
}

function isUsableSingleOrContainer(extracted: any) {
  if (!extracted.type) return false
  if (!Array.isArray(extracted.appointments) || extracted.appointments.length === 0) return false
  return extracted.appointments.every((a: any) => a.poNumber || a.date)
}

function hasPastDate(extracted: any): string | null {
  const todayStr = new Date().toISOString().slice(0, 10)
  for (const a of extracted.appointments || []) {
    if (a.date && a.date < todayStr) return a.date
  }
  return null
}

function normalizeCarrierName(s: string) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
function bigrams(s: string) {
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return out
}
function diceCoefficient(a: string, b: string): number {
  const na = normalizeCarrierName(a), nb = normalizeCarrierName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ba = bigrams(na), bb = bigrams(nb)
  if (ba.length === 0 || bb.length === 0) return 0
  const counts = new Map<string, number>()
  for (const bg of ba) counts.set(bg, (counts.get(bg) || 0) + 1)
  let matches = 0
  for (const bg of bb) {
    const c = counts.get(bg) || 0
    if (c > 0) { matches++; counts.set(bg, c - 1) }
  }
  return (2 * matches) / (ba.length + bb.length)
}
async function fetchCarrierList(): Promise<Array<{ carrier_name: string; carrier_id: number }>> {
  try {
    const rows = await sbGetAll('scheduling_carriers?select=carrier_name,carrier_id')
    return Array.isArray(rows) ? rows : []
  } catch (_) {
    return []
  }
}
type CarrierResolution = {
  matched: boolean
  name: string | null
  id: number | null
  attempted?: string
  bestGuess?: { name: string; score: number } | null
}

// ADDED 2026-11-10 (Dan's explicit decision, following Nate Williams'
// 2026-11-09 Datex carrier-list cleanup). CMM and Peters Bros each have
// multiple real, independently-active Datex carrier_ids sharing the same
// (or near-same) name -- see the header comment above. Rather than rely on
// fuzzy-matching against scheduling_carriers (weekly sync; had un-deduped
// case-variant rows for Peters Bros even before the cleanup, and is a
// guaranteed single candidate for CMM only because of its own dedup-by-
// appointment-count logic), these two are hardcoded so resolution is
// deterministic regardless of sync timing or further Datex renames.
// Checked BEFORE the fuzzy match below, keyed on the same normalized form
// diceCoefficient uses internally. To change which Datex id "CMM" or
// "Peters Bros" resolves to, update this map (and PALERMO_CARRIER_DATEX_ID
// above for the Palermo/Sam-Daren override path, which doesn't go through
// resolveCarrier at all).
const CARRIER_OVERRIDES: Record<string, { name: string; id: number }> = {
  cmm: { name: 'CMM', id: 3730 },
  'peters bros': { name: 'Peters Bros', id: 12268 },
  'peters brothers': { name: 'Peters Bros', id: 12268 },
}

function resolveCarrier(rawName: string | null, carriers: Array<{ carrier_name: string; carrier_id: number }>): CarrierResolution {
  if (!rawName) return { matched: false, name: null, id: null }
  const override = CARRIER_OVERRIDES[normalizeCarrierName(rawName)]
  if (override) return { matched: true, name: override.name, id: override.id }
  if (!carriers.length) return { matched: false, name: null, id: null, attempted: rawName, bestGuess: null }
  let best: { carrier_name: string; carrier_id: number; score: number } | null = null
  for (const c of carriers) {
    const score = diceCoefficient(rawName, c.carrier_name)
    if (!best || score > best.score) best = { ...c, score }
  }
  if (best && best.score >= CARRIER_MATCH_THRESHOLD) {
    return { matched: true, name: best.carrier_name, id: best.carrier_id }
  }
  return { matched: false, name: null, id: null, attempted: rawName, bestGuess: best ? { name: best.carrier_name, score: best.score } : null }
}

const OWNER_MATCH_THRESHOLD = 0.8
async function fetchOwnerAliases(): Promise<Record<string, string>> {
  try {
    const rows = await sbGet(`settings?key=eq.owner_aliases&select=value&limit=1`)
    const value = Array.isArray(rows) ? rows[0]?.value : null
    return value && typeof value === 'object' ? value : {}
  } catch (_) {
    return {}
  }
}
async function fetchOwnerList(): Promise<Array<{ owner_name: string; owner_id: number }>> {
  try {
    const rows = await sbGetAll('scheduling_owners?select=owner_name,owner_id')
    return Array.isArray(rows) ? rows : []
  } catch (_) {
    return []
  }
}
type OwnerResolution = {
  matched: boolean
  name: string | null
  id: number | null
  method?: 'alias' | 'fuzzy'
  attempted?: string
  bestGuess?: { name: string; score: number } | null
}
function resolveOwnerName(rawName: string | null, aliases: Record<string, string>, owners: Array<{ owner_name: string; owner_id: number }>): OwnerResolution {
  if (!rawName) return { matched: false, name: null, id: null }
  const aliasHit = aliases[rawName.toLowerCase().trim()]
  if (aliasHit) {
    const ownerRow = owners.find((o) => o.owner_name.toLowerCase() === aliasHit.toLowerCase())
    return { matched: true, name: aliasHit, id: ownerRow ? ownerRow.owner_id : null, method: 'alias' }
  }
  if (!owners.length) return { matched: false, name: null, id: null, attempted: rawName, bestGuess: null }
  let best: { owner_name: string; owner_id: number; score: number } | null = null
  for (const o of owners) {
    const score = diceCoefficient(rawName, o.owner_name)
    if (!best || score > best.score) best = { ...o, score }
  }
  if (best && best.score >= OWNER_MATCH_THRESHOLD) {
    return { matched: true, name: best.owner_name, id: best.owner_id, method: 'fuzzy' }
  }
  return { matched: false, name: null, id: null, attempted: rawName, bestGuess: best ? { name: best.owner_name, score: best.score } : null }
}

const PROJECT_DOCKDOOR_MATCH_THRESHOLD = 0.8
const PROJECT_DOCKDOOR_MIN_SAMPLE = 5

async function fetchProjectDockDoorMap(ownerName: string, warehouse: string, type: string) {
  try {
    const rows = await sbGet(
      `scheduling_project_dockdoor_map?owner_name=eq.${encodeURIComponent(ownerName)}&warehouse=eq.${encodeURIComponent(warehouse)}&type=eq.${encodeURIComponent(type)}&select=*&limit=1`
    )
    return Array.isArray(rows) ? rows[0] || null : null
  } catch (_) {
    return null
  }
}

type FieldFill = { filled: boolean; applied: string | null; candidate: string | null; confidence: number | null; total: number | null }
type ProjectDockDoorFill = { project: FieldFill; dockDoor: FieldFill }

function buildFieldFill(name: string | null, count: number | null, total: number | null): FieldFill {
  if (!name || !total) return { filled: false, applied: null, candidate: null, confidence: null, total: null }
  const confidence = (count || 0) / total
  const ok = confidence >= PROJECT_DOCKDOOR_MATCH_THRESHOLD && total >= PROJECT_DOCKDOOR_MIN_SAMPLE
  return { filled: ok, applied: ok ? name : null, candidate: name, confidence, total }
}

function resolveProjectDockDoorFill(mapRow: any | null): ProjectDockDoorFill {
  if (!mapRow) return { project: buildFieldFill(null, null, null), dockDoor: buildFieldFill(null, null, null) }
  return {
    project: buildFieldFill(mapRow.project_name, mapRow.project_count, mapRow.project_total),
    dockDoor: buildFieldFill(mapRow.dock_door, mapRow.dock_count, mapRow.dock_total),
  }
}

function extractFrontCustomNote(raw: string): string | null {
  const parsed = tryJson(raw)
  const fields = parsed?.customFields
  if (!Array.isArray(fields)) return null
  const match = fields.find((f: any) => typeof f?.name === 'string' && f.name.toLowerCase() === 'notes')
  const value = match?.value
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// ADDED 2026-11-05 (Arielle/Sadie/Kay's report, cnv_1b15rcyc) -- defensive
// normalizer so a multi-stop/LTL destination can never reach the Datex
// Notes field as a multi-line blob, regardless of whether the extraction
// prompt's new formatting instruction is followed. Collapses any line
// breaks into " | "-joined segments. See the header comment for full root
// cause.
function normalizeDestinationForNotes(destination: string | null): string | null {
  if (!destination) return null
  return destination
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' | ')
}

function buildNotesValue(frontCustomNote: string | null, destination: string | null): string | null {
  const parts: string[] = []
  if (frontCustomNote) parts.push(frontCustomNote)
  const normalizedDestination = normalizeDestinationForNotes(destination)
  if (normalizedDestination) parts.push(`Destination: ${normalizedDestination}`)
  return parts.length ? parts.join('\n') : null
}

type CorrectionHints = Partial<Record<typeof HINT_FIELDS[number], { value: string; count: number; total: number }>>

async function fetchSenderCorrectionHints(senderEmail: string): Promise<CorrectionHints> {
  try {
    const rows = await sbGet(
      `agent_field_accuracy?sender_email=eq.${encodeURIComponent(senderEmail)}&select=owner_actual,project_actual,carrier_actual,dock_door_actual`
    )
    if (!Array.isArray(rows) || rows.length === 0) return {}
    const hints: CorrectionHints = {}
    for (const field of HINT_FIELDS) {
      const counts = new Map<string, number>()
      let total = 0
      for (const r of rows) {
        const v = r[`${field}_actual`]
        if (!v) continue
        total++
        counts.set(v, (counts.get(v) || 0) + 1)
      }
      if (total === 0) continue
      let topValue: string | null = null
      let topCount = 0
      for (const [v, c] of counts) {
        if (c > topCount) { topValue = v; topCount = c }
      }
      if (topValue && topCount >= MIN_HINT_REPEAT_COUNT && topCount / total >= MIN_HINT_MAJORITY_SHARE) {
        hints[field] = { value: topValue, count: topCount, total }
      }
    }
    return hints
  } catch (_) {
    return {}
  }
}

function buildHintSection(hints: CorrectionHints): string {
  const entries = Object.entries(hints)
  if (entries.length === 0) return ''
  const lines = entries.map(([field, h]) => `- ${HINT_FIELD_LABELS[field]}: "${h!.value}" (seen in ${h!.count} of the last ${h!.total} emails from this exact sender address)`)
  return `\n\nKNOWN PATTERN FOR THIS SENDER ADDRESS (learned from past CSR-approved corrections, NOT stated in this specific email):\n${lines.join('\n')}\nThese describe this exact sender address's history, not this email. If the email body clearly states something different for a field above, trust the email over the pattern. If the email is silent on a field above, you may use the pattern value instead of leaving it null -- but this is a weaker signal than something actually stated in the email, so don't let it inflate your overall confidence.`
}

async function fetchSenderDefaults(senderEmail: string): Promise<SenderDefaults> {
  try {
    const rows = await sbGetAll(`agent_field_accuracy?sender_email=eq.${encodeURIComponent(senderEmail)}&select=owner_actual,carrier_actual,dock_door_actual&order=compared_at.asc`)
    return computeSenderDefaults(Array.isArray(rows) ? rows : [])
  } catch (_) {
    return {}
  }
}

// LEARNED OWNER (2026-10-30, Dan's learning rules 1-2) -- see learned-owner.ts.
// Per-facility model built from every APPROVED appointment in the last
// LEARNED_WINDOW_DAYS days (manual and agent-created alike). Cached per
// warehouse in module memory for 10 minutes so a burst of emails doesn't
// re-read ~6k rows each time; a cold instance just rebuilds it. Returns null
// on any read error -> caller falls back to the old sender default.
const OWNER_MODEL_TTL_MS = 10 * 60 * 1000
const ownerModelCache = new Map<string, { at: number; model: OwnerModel }>()
async function fetchOwnerModel(warehouse: string): Promise<OwnerModel | null> {
  const hit = ownerModelCache.get(warehouse)
  if (hit && Date.now() - hit.at < OWNER_MODEL_TTL_MS) return hit.model
  try {
    const since = new Date(Date.now() - LEARNED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const rows = await sbGetAll(
      `submissions?status=eq.approved&warehouse=eq.${encodeURIComponent(warehouse)}&created_at=gte.${encodeURIComponent(since)}&owner=not.is.null&select=owner,reference_number,notes,sender_email&order=created_at.asc,id.asc`,
    )
    const model = buildOwnerModel(Array.isArray(rows) ? rows : [])
    ownerModelCache.set(warehouse, { at: Date.now(), model })
    return model
  } catch (_) {
    return null
  }
}

// One prediction per appointment reference (a multi-appointment email has
// several). Only a unanimous 'agree' across them is used; any 'conflict' or
// disagreement between references is treated as no prediction (never blanks
// an owner on weak evidence).
function predictOwnerForAppointments(model: OwnerModel | null, senderEmail: string | null, appointments: any[], notes: string | null, opts: Parameters<typeof predictOwner>[2]): OwnerPrediction {
  const refs = (appointments || []).map((a: any) => a?.poNumber).filter(Boolean)
  const preds = (refs.length ? refs : [null]).map((r: string | null) => predictOwner(model, { senderEmail, reference: r, notes }, opts))
  if (preds.length === 1) return preds[0]
  const agree = preds.filter((p) => p.status === 'agree')
  const owners = new Set(agree.map((p) => (p.owner || '').toLowerCase()))
  if (agree.length === preds.length && owners.size === 1) return preds[0]
  return { status: 'none', owner: null, signals: {}, tier: null }
}

async function lookupDatexOrder(subject: string, text: string, appointments: any[], warehouse: string) {
  const candidates = extractCandidateReferences(subject, text, appointments)
  if (candidates.length === 0) return { candidates, results: [] as any[], match: { status: 'none' } as DatexMatch }
  const results: CandidateResult[] = await Promise.all(
    candidates.map(async (candidate): Promise<CandidateResult> => {
      try {
        const res = await fetch(ORDER_SEARCH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: candidate }),
          signal: AbortSignal.timeout(ORDER_SEARCH_TIMEOUT_MS),
        })
        if (!res.ok) return { candidate, orders: [], error: `HTTP ${res.status}` }
        const data = await res.json()
        return { candidate, orders: Array.isArray(data?.orders) ? data.orders : [] }
      } catch (e) {
        return { candidate, orders: [], error: (e as Error).message }
      }
    }),
  )
  const match = pickDatexOrder(results, WAREHOUSE_SHORT[warehouse] || null)
  return { candidates, results: results.map((r) => ({ candidate: r.candidate, orders: r.orders.length, error: r.error || null })), match }
}

async function writeSingleOrContainerSubmission({ conversationId, warehouse, extracted, carrierResolution, extraFields, senderEmail, frontCustomNote }: any) {
  const first = extracted.appointments[0]
  const poNumbers = extracted.appointments.map((a: any) => a.poNumber).filter(Boolean).join(',')
  const notesValue = buildNotesValue(frontCustomNote, extracted.destination)
  const scheduledArrivalValue = combineDateTime(first.date, first.time)
  const carrierNameValue = carrierResolution.matched ? carrierResolution.name : null
  const ownerValue = extracted.owner || null
  const dockDoorValue = extracted.dockDoor || null
  const fields: any = {
    type: extracted.type,
    warehouse,
    scheduled_arrival: scheduledArrivalValue,
    reference_number: poNumbers || null,
    carrier: carrierNameValue,
    carrier_datex_id: carrierResolution.matched ? carrierResolution.id : null,
    project: extracted.project || null,
    owner: ownerValue,
    scheduled_dock_door: dockDoorValue,
    notes: notesValue,
    front_conversation_id: conversationId,
    sender_email: senderEmail || null,
    intake_source: 'claude',
    intake_routing: extracted.routing,
    status: 'pending',
    agent_warehouse: warehouse,
    agent_type: extracted.type || null,
    agent_project: extracted.project || null,
    agent_owner: ownerValue || (extraFields && extraFields.owner) || null,
    agent_scheduled_arrival: scheduledArrivalValue,
    agent_scheduled_dock_door: dockDoorValue || (extraFields && extraFields.scheduled_dock_door) || null,
    agent_carrier: carrierNameValue,
    agent_reference_number: poNumbers || null,
    agent_notes: notesValue,
    ...(extraFields || {}),
  }
  const existingRows = await sbGet(`submissions?front_conversation_id=eq.${encodeURIComponent(conversationId)}&select=id,status&limit=1`)
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

async function writeMultiSubmissions({ conversationId, warehouse, extracted, carrierResolution, senderEmail, frontCustomNote }: any) {
  const rows = []
  for (let i = 0; i < extracted.appointments.length; i++) {
    const appt = extracted.appointments[i]
    const notesValue = buildNotesValue(frontCustomNote, extracted.destination)
    const scheduledArrivalValue = combineDateTime(appt.date, appt.time)
    const carrierNameValue = carrierResolution.matched ? carrierResolution.name : null
    const ownerValue = extracted.owner || null
    const dockDoorValue = extracted.dockDoor || null
    const fields = {
      type: extracted.type,
      warehouse,
      scheduled_arrival: scheduledArrivalValue,
      reference_number: appt.poNumber || null,
      carrier: carrierNameValue,
      carrier_datex_id: carrierResolution.matched ? carrierResolution.id : null,
      project: extracted.project || null,
      owner: ownerValue,
      scheduled_dock_door: dockDoorValue,
      notes: notesValue,
      front_conversation_id: `${conversationId}::${i}`,
      sender_email: senderEmail || null,
      intake_source: 'claude',
      intake_routing: 'multi',
      status: 'pending',
      agent_warehouse: warehouse,
      agent_type: extracted.type || null,
      agent_project: extracted.project || null,
      agent_owner: ownerValue,
      agent_scheduled_arrival: scheduledArrivalValue,
      agent_scheduled_dock_door: dockDoorValue,
      agent_carrier: carrierNameValue,
      agent_reference_number: appt.poNumber || null,
      agent_notes: notesValue,
    }
    const inserted = await sbPost('submissions', fields, 'return=representation')
    rows.push(inserted?.[0])
  }
  return { submissionIds: rows.map((r: any) => r?.id).filter(Boolean), rows }
}

async function extractAppointmentData({ subject, text, senderEmail, warehouse, correctionHints }: { subject: string; text: string; senderEmail: string | null; warehouse: string; correctionHints: CorrectionHints }) {
  const todayStr = new Date().toISOString().slice(0, 10)
  const cityHints = WAREHOUSE_CITY_HINTS[warehouse] || [warehouse]
  const hintSection = buildHintSection(correctionHints)
  const prompt = `You are extracting scheduling data from an inbound carrier/customer email to a warehouse's dock-appointment inbox. Return ONLY a JSON object, no other text, matching exactly this shape:

{
  "type": "Inbound" | "Outbound" | null,
  "routing": "single" | "load_container" | "multi",
  "appointments": [
    { "poNumber": string | null, "date": "YYYY-MM-DD" | null, "time": "HH:MM" | null }
  ],
  "carrier": string | null,
  "project": string | null,
  "owner": string | null,
  "dockDoor": string | null,
  "destination": string | null,
  "confidence": number between 0 and 1,
  "reasoning": short string, one sentence
}

TODAY'S ACTUAL DATE IS ${todayStr}. Use this as the anchor for resolving any date -- do not use your own training-data sense of "the current date," it is wrong. This matters most when the email states a date with no year (e.g. "10/14" or "next Tuesday"): resolve it to the nearest occurrence of that month/day that is ON OR AFTER ${todayStr}. A resolved date earlier than ${todayStr} is always wrong when the year was inferred -- never produce one.

ROUTING RULES:
- "single": exactly one order, one truck, one appointment. Default when nothing below applies. appointments has exactly 1 entry.
- "load_container": ONE truck/appointment carrying MULTIPLE orders -- signaled by explicit "nose"/"tail" language, or multiple PO/vendor references clearly tied to one pickup/delivery (same single date+time for all). appointments has 2+ entries sharing the same date/time.
- "multi": MULTIPLE GENUINELY SEPARATE appointments (different dates and/or times) requested in one message. This includes: numbered/grouped batch lists by destination, tabular data (columns like PO/booking/order#/requested time), or a line-per-order list ("PO - Deliver date @ time"). appointments has 2+ entries with differing date/time.

TYPE (Inbound vs Outbound): this message arrived at OUR warehouse, ${warehouse} -- also referred to in emails/documents as: ${cityHints.join(', ')}. Determine direction from OUR warehouse's perspective:
- If the email states a PICKUP location, ORIGIN, or "FROM" location matching our warehouse (by any of the names above, or its city), the load is LEAVING our warehouse -> "Outbound".
- If the email states a DESTINATION, DELIVERY, "TO", or "SHIP TO" location matching our warehouse, the load is ARRIVING at our warehouse -> "Inbound".
- If the email already explicitly labels itself Inbound or Outbound, defer to that label.
- If neither location clearly matches our warehouse and there's no explicit label, use your best judgment from context (e.g. who is asking whom to schedule what) and reflect the uncertainty by lowering confidence rather than guessing with full confidence.

CARRIER: the trucking company handling this load, if determinable. Check, in order: an explicit carrier name/signature block in the email body, the sender's email domain (e.g. someone@xyztrucking.com implies XYZ Trucking -- use judgment, a generic domain like gmail.com or the customer's own company domain is NOT a carrier), or an MC#/DOT# with an associated company name. ${senderEmail ? `The sender's email address for this message is: ${senderEmail}. Use its domain per the rule above if no stronger signal exists in the body.` : `The sender's email address could not be determined for this message -- rely on body/signature text only.`} A signature rendered as an IMAGE (not text) will not appear in the body below even if visible to a human reader -- the sender's email domain is often the only usable signal in that case. If genuinely not determinable, use null -- do not guess.

PROJECT: only if the email explicitly names a program, account, or project identifier distinct from the PO number (e.g. a customer program name). Most emails will not state this -- use null rather than inferring from the sender's company name alone. Never fabricate a project value by combining a name you saw elsewhere in the email with the warehouse name, city, or any other detail -- a project value must be literal text that actually appears in the email as the stated project/program for THIS shipment, never something you construct or infer.

OWNER: the customer/account this shipment belongs to (a company name). Treat this as explicitly stated whenever the email contains a labeled field naming the account for this shipment -- e.g. "VENDOR:", "CUSTOMER:", "ACCOUNT:", "SHIPPER:", "SOLD TO:", "BILL TO:" -- and use that field's value. Otherwise null if not stated; do not infer it from the sender's company name alone.

IGNORE BOILERPLATE / CONDITIONAL TEXT: carrier and broker emails are often a reusable template containing CONDITIONAL instructions that name OTHER customers who are NOT part of this shipment -- e.g. "(If you are scheduling for Pretzilla or Palermo's, an SO number is required)". A company name that appears ONLY inside a conditional clause ("if...", "for X or Y..."), a parenthetical note, or boilerplate instructions is NOT evidence about this shipment's actual vendor/owner/project -- do not use it for ANY field unless that exact name is also the value of an actual labeled field for this shipment (e.g. "VENDOR: Richelieu Foods"). When conditional/template text and a labeled field disagree or seem to conflict, the labeled field always wins and the conditional text is ignored entirely.

DOCK DOOR: the specific dock door or location to use for this appointment, only if explicitly stated in the email -- almost never stated in a first-contact email. null if not stated.

DESTINATION: the delivery/pickup destination(s) if explicitly stated in the email.
- SINGLE STOP: the facility, city, or address (e.g. "Front Royal, VA").
- MULTIPLE STOPS (an LTL load, a multi-stop pickup/delivery list, etc.): extract each stop as "ORDER_NUMBER - CITY - STATE" -- digits/alphanumerics only for the order number, NEVER the customer/company name -- and join stops with " | " between them, e.g. "SO622000 - MIAMI - FL | 8917145D - LEXINGTON - SC". NEVER use a line break inside this field, however many stops there are.
null if nothing applicable is stated.${hintSection}

RULES:
- Never guess a field you cannot find. Use null rather than fabricating.
- Never construct a field value out of pieces. Only use text that is a label's actual stated value in the email -- do not combine a name seen in boilerplate/conditional text with the warehouse, city, or anything else to produce a value that does not literally appear as such in the email.
- "date" must be a real calendar date if a month/day is stated anywhere (assume the nearest occurrence on or after ${todayStr} if year is omitted -- see above).
- Do not extract appointment duration under any circumstances -- leave it out of the response entirely, it is not requested.
- confidence reflects your certainty in the EXTRACTED FIELDS overall, not just the routing choice. A null Carrier/Project/Owner/Dock Door/Destination (because the email doesn't state them, and no sender-history pattern applies) should NOT by itself lower confidence -- confidence is about certainty in what you DID extract, not completeness.

EMAIL SUBJECT: ${subject || '(none)'}

EMAIL BODY:
${text}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
  })
  const raw = await res.text()
  let data: any
  try { data = JSON.parse(raw) } catch { data = { raw } }
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data).slice(0, 500)}`)
  const textBlock = (data.content || []).find((b: any) => b.type === 'text')
  if (!textBlock) throw new Error('Claude API returned no text block')
  const cleaned = textBlock.text.trim().replace(/^```json\s*|```$/g, '').trim()
  try { return JSON.parse(cleaned) } catch { throw new Error(`Could not parse Claude's response as JSON: ${cleaned.slice(0, 300)}`) }
}

let cachedToken: { token: string; expiresAt: number } | null = null
async function getAgentToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) return cachedToken.token
  const id = env('FRONT_SCHEDULING_AGENT_CLIENT_ID'), secret = env('FRONT_SCHEDULING_AGENT_CLIENT_SECRET'), url = env('FRONT_SCHEDULING_AGENT_TOKEN_URL')
  if (!id || !secret || !url) throw new Error('FRONT_SCHEDULING_AGENT_CLIENT_ID / _CLIENT_SECRET / _TOKEN_URL not configured')
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString() })
  const t = await res.text()
  if (!res.ok) throw new Error(`Agent token request failed ${res.status}: ${t.slice(0, 300)}`)
  const d = JSON.parse(t)
  cachedToken = { token: d.access_token, expiresAt: Date.now() + (d.expires_in || 900) * 1000 }
  return cachedToken.token
}
function parseRpc(raw: string, contentType: string | null, id: number) {
  if ((contentType || '').includes('text/event-stream')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (!p) continue
      try { const m = JSON.parse(p); if (m.id === id) return m } catch (_) { /* skip */ }
    }
    throw new Error('MCP: no matching response in event stream')
  }
  return JSON.parse(raw)
}
async function mcpPost(token: string, st: any, body: any, expect: boolean) {
  const headers: any = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }
  if (st.sessionId) headers['Mcp-Session-Id'] = st.sessionId
  if (st.protocol) headers['MCP-Protocol-Version'] = st.protocol
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) st.sessionId = sid
  const raw = await res.text()
  if (!res.ok) throw new Error(`MCP ${body.method} -> ${res.status}: ${raw.slice(0, 400)}`)
  if (!expect) return null
  const msg = parseRpc(raw, res.headers.get('content-type'), body.id)
  if (msg.error) throw new Error(`MCP ${body.method} error: ${JSON.stringify(msg.error).slice(0, 400)}`)
  return msg.result
}
async function withMcp<T>(fn: (call: (name: string, args: any) => Promise<T>) => Promise<T>) {
  const token = await getAgentToken()
  const st: any = { sessionId: null, protocol: null }
  const init = await mcpPost(token, st, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'csw-scheduling-agent', version: '1.0.0' } } }, true)
  st.protocol = (init && init.protocolVersion) || MCP_PROTOCOL
  await mcpPost(token, st, { jsonrpc: '2.0', method: 'notifications/initialized' }, false)
  let next = 2
  const call = async (name: string, args: any) => {
    const r = await mcpPost(token, st, { jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } }, true)
    const text = (r.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    if (r.isError) throw new Error(`MCP tool ${name} failed: ${text.slice(0, 400)}`)
    return text
  }
  return fn(call)
}

const tryJson = (s: string) => { try { return JSON.parse(s) } catch { return null } }
const stripTags = (s: string) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

function resolveInboxAndWarehouse(raw: string) {
  const parsed = tryJson(raw)
  const inboxId = parsed?.inboxes?.[0]?.id || null
  const warehouse = inboxId ? INBOX_WAREHOUSE_MAP[inboxId] || null : null
  return { inboxId, warehouse }
}

function extractSenderEmail(full: any): { email: string | null; rawKeys: string[] } {
  const rawKeys = full && typeof full === 'object' ? Object.keys(full) : []
  const fromEntry = Array.isArray(full?.recipients?.from) ? full.recipients.from[0] : null
  const candidates = [
    fromEntry?.handle,
    fromEntry?.email,
    fromEntry?.address,
    full?.recipients?.find?.((r: any) => r?.role === 'from')?.handle,
    full?.from?.handle,
    full?.from?.address,
    full?.from?.email,
    full?.author?.handle,
    full?.author?.email,
    full?.sender?.handle,
    full?.sender?.email,
  ]
  const found = candidates.find((c: any) => typeof c === 'string' && c.includes('@'))
  return { email: found ? found.toLowerCase() : null, rawKeys }
}

async function fetchLatestInboundMessage(raw: string, call: (name: string, args: any) => Promise<string>) {
  const parsed = tryJson(raw)
  const results = parsed?.entries?.results
  if (!Array.isArray(results)) throw new Error('read_conversation returned no entries')
  const inbound = results.find((e: any) => e.kind === 'message_inbound')
  if (!inbound) throw new Error('No inbound message found in conversation entries')
  const full = tryJson(await call('read_message', { messageId: inbound.messageId }))
  const { email: senderEmail, rawKeys: rawMessageKeys } = extractSenderEmail(full)
  return { subject: full?.subject || '', text: stripTags(full?.content || full?.text || ''), senderEmail, rawMessageKeys }
}

function formatConfirmation(warehouse: string, extracted: any, carrierResolution: CarrierResolution, ownerResolution: OwnerResolution, projectDockDoorFill: ProjectDockDoorFill | undefined, notesValue: string | null, senderFillNotes: string[] = [], autoPushNote: string | null = null) {
  const poList = extracted.appointments.map((a: any) => a.poNumber).filter(Boolean).join(', ')
  const carrierLine = carrierResolution.matched
    ? `- Carrier: ${carrierResolution.name}`
    : carrierResolution.attempted
      ? `- Carrier: (not confidently matched -- CSR to enter manually)`
      : `- Carrier: `
  const base = [
    `- Warehouse: ${warehouse}`,
    `- Type: ${extracted.type || ''}`,
    carrierLine,
    `- Project: ${extracted.project || ''}`,
    `- Owner: ${extracted.owner || ''}`,
    `- Dock Door: ${extracted.dockDoor || ''}`,
    `- Destination: ${extracted.destination || ''}`,
    `- Notes: ${notesValue || ''}`,
  ]
  const flagLines: string[] = []
  if (!carrierResolution.matched && carrierResolution.attempted) {
    const guess = carrierResolution.bestGuess
    flagLines.push(
      guess
        ? `⚠️ Carrier "${carrierResolution.attempted}" wasn't confidently matched in Datex (closest: "${guess.name}" at ${Math.round(guess.score * 100)}% -- below the 80% bar). CSR: please enter the carrier manually.`
        : `⚠️ Carrier "${carrierResolution.attempted}" wasn't found in Datex and no carrier list was available to compare against. CSR: please enter the carrier manually.`
    )
  }
  if (!ownerResolution.matched && ownerResolution.attempted) {
    const guess = ownerResolution.bestGuess
    flagLines.push(
      guess
        ? `⚠️ Owner "${ownerResolution.attempted}" wasn't confidently matched in Datex (closest: "${guess.name}" at ${Math.round(guess.score * 100)}% -- below the 80% bar). CSR: please enter the owner manually.`
        : `⚠️ Owner "${ownerResolution.attempted}" wasn't found in Datex and no owner list was available to compare against. CSR: please enter the owner manually.`
    )
  }
  if (projectDockDoorFill?.project && !projectDockDoorFill.project.filled && projectDockDoorFill.project.candidate && !extracted.project) {
    flagLines.push(
      `⚠️ Project not stated -- closest historical match for this owner/warehouse/type is "${projectDockDoorFill.project.candidate}" at ${Math.round((projectDockDoorFill.project.confidence || 0) * 100)}% (${projectDockDoorFill.project.total} appointments) -- below the 80% bar. CSR: please confirm.`
    )
  }
  if (projectDockDoorFill?.dockDoor && !projectDockDoorFill.dockDoor.filled && projectDockDoorFill.dockDoor.candidate && !extracted.dockDoor) {
    flagLines.push(
      `⚠️ Dock Door not stated -- closest historical match for this owner/warehouse/type is "${projectDockDoorFill.dockDoor.candidate}" at ${Math.round((projectDockDoorFill.dockDoor.confidence || 0) * 100)}% (${projectDockDoorFill.dockDoor.total} appointments) -- below the 80% bar. CSR: please confirm.`
    )
  }
  for (const n of senderFillNotes) flagLines.push(n)
  if (autoPushNote) flagLines.push(autoPushNote)
  const flagLine = flagLines.length ? `\n\n${flagLines.join('\n')}` : ''
  if (extracted.routing === 'multi') {
    const apptLines = extracted.appointments.map((a: any, i: number) => `  ${i + 1}. PO ${a.poNumber || '(none)'} -- Date: ${a.date || ''} Time: ${a.time || ''}`)
    return `Scheduling agent extracted ${extracted.appointments.length} appointments:\n${base.join('\n')}\n- Appointments:\n${apptLines.join('\n')}\n\nPending review in the Scheduling tab.${flagLine}`
  }
  const first = extracted.appointments[0]
  const lines = [
    ...base.slice(0, 2),
    `- Appt Date: ${first.date || ''}`,
    `- Appt Time: ${first.time || ''}`,
    ...base.slice(2),
    `- PO Number: ${poList}`,
  ]
  const pendingLine = autoPushNote ? 'Auto-scheduling (no CSR review) -- see note below.' : 'Pending review in the Scheduling tab.'
  return `Scheduling agent extracted an appointment:\n${lines.join('\n')}\n\n${pendingLine}${flagLine}`
}

async function runSchedulingAgentMention(conversationId: string, commentId: string) {
  if (env('SCHEDULING_AGENT_ENABLED') === 'false') return { skipped: 'kill switch' }

  const existingStatuses = await fetchSubmissionStatuses(conversationId)
  const bucket = classifyConversationBucket(existingStatuses)
  if (bucket === 'confirmed') return await handleConfirmedReply(conversationId)
  if (bucket === 'pending') {
    await logIntakeAttempt({ conversationId, outcome: 'reply_ignored_pending' })
    return { skipped: 'submission already in progress', conversationId, statuses: existingStatuses }
  }

  if (await alreadyProcessed(conversationId)) return { skipped: 'already processed', conversationId }

  let warehouse: string | null = null
  let inboxId: string | null = null
  try {
    const { raw, call } = await withMcp(async (call) => ({ raw: await call('read_conversation', { conversationId, limit: 20 }), call }))
    const resolved = resolveInboxAndWarehouse(raw)
    inboxId = resolved.inboxId
    warehouse = resolved.warehouse
    const frontCustomNote = extractFrontCustomNote(raw)

    if (!warehouse) {
      await logIntakeAttempt({ conversationId, inboxId, outcome: 'error', errorDetail: `Conversation's inbox (${inboxId || 'none found'}) is not a known Appointments inbox` })
      await withMcp((c) => c('add_comment', { conversationId, body: `Scheduling agent could not run: inbox ${inboxId || '(unknown)'} is not a recognized Appointments inbox.` }))
      return { ok: false, reason: 'inbox not recognized' }
    }

    const { subject, text, senderEmail, rawMessageKeys } = await fetchLatestInboundMessage(raw, call)
    const correctionHints = senderEmail ? await fetchSenderCorrectionHints(senderEmail) : {}
    const extracted = await extractAppointmentData({ subject, text, senderEmail, warehouse, correctionHints })
    let confidence = typeof extracted.confidence === 'number' ? extracted.confidence : 0
    const routing = extracted.routing === 'multi' || extracted.routing === 'load_container' ? extracted.routing : 'single'
    extracted.routing = routing

    const pastDate = hasPastDate(extracted)
    if (pastDate) {
      confidence = 0
      extracted.reasoning = `${extracted.reasoning || ''} [safety net: resolved date ${pastDate} is in the past -- forced to low confidence]`.trim()
    }

    if (confidence < CONFIDENCE_THRESHOLD || !isUsableSingleOrContainer(extracted)) {
      await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'skipped_low_confidence', routing, extractedFields: { ...extracted, senderEmail, correctionHints, ...(senderEmail ? {} : { rawMessageKeys }) }, confidence })
      await withMcp((c) => c('add_comment', { conversationId, body: `Scheduling agent: confidence too low to auto-fill (${confidence.toFixed(2)}). Left for manual entry.` }))
      return { ok: false, skipped: true, reason: 'low confidence', extracted }
    }

    const ownerAliases = await fetchOwnerAliases()
    const ownerList = await fetchOwnerList()
    const ownerResolution = resolveOwnerName(extracted.owner, ownerAliases, ownerList)
    extracted.owner = ownerResolution.matched ? ownerResolution.name : null

    const senderDefaults: SenderDefaults = senderEmail ? await fetchSenderDefaults(senderEmail) : {}
    // Owner: facility-scoped learner (sender + reference-number shape, then
    // domain / notes fallback tiers) with the old sender default as the
    // fallback when the model can't be read. Env switches: LEARNED_OWNER_ENABLED
    // (default on), LEARNED_OWNER_DOMAIN_TIER (default on),
    // LEARNED_OWNER_NOTES_TIER (default OFF -- ~63% precision in back-test).
    const ownerModel = env('LEARNED_OWNER_ENABLED') !== 'false' ? await fetchOwnerModel(warehouse) : null
    const learnedPred: OwnerPrediction | null = ownerModel
      ? predictOwnerForAppointments(ownerModel, senderEmail, extracted.appointments, buildNotesValue(frontCustomNote, extracted.destination), {
          domainTier: env('LEARNED_OWNER_DOMAIN_TIER') !== 'false',
          notesTier: env('LEARNED_OWNER_NOTES_TIER') === 'true',
          extractedOwnerBlank: !extracted.owner,
          legacySender: senderDefaults.owner || null,
        })
      : null
    let ownerDefaultResult: { owner: string | null; changed: boolean; llmOwner: string | null }
    let ownerLearnedNote: string | null = null
    if (learnedPred && learnedPred.status === 'agree') {
      ownerDefaultResult = { owner: learnedPred.owner, changed: normKey(extracted.owner) !== normKey(learnedPred.owner), llmOwner: extracted.owner }
      if (ownerDefaultResult.changed) ownerLearnedNote = formatLearnedOwnerNote(learnedPred)
    } else if (learnedPred && learnedPred.status === 'conflict') {
      ownerDefaultResult = { owner: null, changed: !!extracted.owner, llmOwner: extracted.owner }
      ownerLearnedNote = formatLearnedOwnerNote(learnedPred)
    } else {
      ownerDefaultResult = applySenderOwnerDefault(extracted.owner, senderDefaults.owner)
    }
    extracted.owner = ownerDefaultResult.owner
    const ownerLearnedUsed = !!learnedPred && learnedPred.status !== 'none'
    const ownerFilledFromSender: SenderDefault | null = !ownerLearnedUsed && ownerDefaultResult.changed ? senderDefaults.owner! : null

    let datexLog: any = { skipped: true }
    let datexUsed: { match: Extract<DatexMatch, { status: 'found' }>; ownerChanged: boolean; project: string | null } | null = null
    const palermoNewText = stripQuotedReplyContent(text)
    const looksPalermo = routing !== 'multi' && !!parsePalermoBody(palermoNewText) && hasPalermoSignature(palermoNewText) && !hasCancellationLanguage(palermoNewText)
    if (env('DATEX_LOOKUP_ENABLED') !== 'false' && routing !== 'multi' && !looksPalermo) {
      const lookup = await lookupDatexOrder(subject, text, extracted.appointments, warehouse)
      const ownerBeforeDatex: string | null = extracted.owner
      // A learned owner blocks a Datex override like a sender default always
      // did; a learned CONFLICT (owner left blank) does not -- a real Datex
      // order is better evidence than two learned signals disagreeing.
      const ownerHasDefault = learnedPred?.status === 'conflict' ? false : (!!senderDefaults.owner || learnedPred?.status === 'agree')
      const applied = applyDatexOrder(extracted.owner, ownerHasDefault, lookup.match)
      if (applied.used && lookup.match.status === 'found') {
        extracted.owner = applied.owner
        if (applied.project) extracted.project = applied.project
        datexUsed = { match: lookup.match, ownerChanged: normKey(ownerBeforeDatex) !== normKey(applied.owner), project: applied.project }
      }
      datexLog = {
        candidates: lookup.candidates,
        results: lookup.results,
        match: lookup.match.status === 'found'
          ? { status: 'found', ownerName: lookup.match.ownerName, projectName: lookup.match.projectName, via: lookup.match.via, orderIds: lookup.match.orders.map((o) => o.orderId) }
          : lookup.match,
        applied,
      }
    }

    let projectDockDoorFill: ProjectDockDoorFill = { project: buildFieldFill(null, null, null), dockDoor: buildFieldFill(null, null, null) }
    if (extracted.owner && extracted.type) {
      const baseType = extracted.type.split('/')[0]
      const mapRow = await fetchProjectDockDoorMap(extracted.owner, warehouse, baseType)
      projectDockDoorFill = resolveProjectDockDoorFill(mapRow)
      if (!extracted.project && projectDockDoorFill.project.applied) extracted.project = projectDockDoorFill.project.applied
      if (!extracted.dockDoor && projectDockDoorFill.dockDoor.applied) extracted.dockDoor = projectDockDoorFill.dockDoor.applied
    }

    let dockDoorFilledFromSender: SenderDefault | null = null
    const dockDoorDefaultResult = applySenderDockDoorDefault(extracted.dockDoor, senderDefaults.dockDoor)
    if (dockDoorDefaultResult.changed) {
      extracted.dockDoor = dockDoorDefaultResult.dockDoor
      dockDoorFilledFromSender = senderDefaults.dockDoor!
    }

    const palermoParsed = routing !== 'multi' ? parsePalermoBody(palermoNewText) : null
    const palermoCancelled = hasCancellationLanguage(palermoNewText)
    const palermoSignaturePresent = hasPalermoSignature(palermoNewText)
    const isPalermo = !!palermoParsed && palermoSignaturePresent && !palermoCancelled
    let effectiveExtracted = extracted
    let carrierOverride: CarrierResolution | null = null
    let extraFields: any = undefined
    let palermoAutoPush = false
    if (isPalermo) {
      effectiveExtracted = {
        ...extracted,
        type: 'Outbound/Drop',
        project: PALERMO_PROJECT_NAME,
        appointments: [{
          poNumber: palermoParsed!.reference,
          date: palermoParsed!.scheduledArrival.slice(0, 10),
          time: palermoParsed!.scheduledArrival.slice(11, 16),
        }],
      }
      carrierOverride = { matched: true, name: PALERMO_CARRIER_NAME, id: PALERMO_CARRIER_DATEX_ID }
      extraFields = {
        owner: PALERMO_OWNER_NAME,
        owner_datex_id: PALERMO_OWNER_DATEX_ID,
        project_datex_id: PALERMO_PROJECT_DATEX_ID,
        scheduled_dock_door: PALERMO_DOCK_DOOR,
        dock_door_datex_id: PALERMO_DOCK_DOOR_DATEX_ID,
        appointment_lookup_code: `(PVI) - RELOAD ${palermoParsed!.reference}`,
      }
      effectiveExtracted.owner = PALERMO_OWNER_NAME
      effectiveExtracted.dockDoor = PALERMO_DOCK_DOOR

      // "Same day" is THIS submission's own final computed appointment date
      // (post-lead-time, post-midnight-snap), compared to today's calendar
      // date in Central time.
      const apptDateStr = effectiveExtracted.appointments[0].date
      const isSameDay = apptDateStr === centralDateStr(new Date())
      palermoAutoPush = !isSameDay
    }

    const carrierList = carrierOverride ? [] : await fetchCarrierList()
    let carrierResolution: CarrierResolution = carrierOverride || resolveCarrier(effectiveExtracted.carrier, carrierList)
    let carrierFilledFromSender: SenderDefault | null = null
    if (!carrierOverride) {
      const cd = applySenderCarrierDefault(carrierResolution, senderDefaults.carrier, carrierList)
      carrierResolution = cd.resolution as CarrierResolution
      if (cd.changed) carrierFilledFromSender = senderDefaults.carrier!
    }
    const notesValue = buildNotesValue(frontCustomNote, effectiveExtracted.destination)

    const senderFillNotes: string[] = []
    if (ownerFilledFromSender && !isPalermo) senderFillNotes.push(formatSenderFillNote('Owner', effectiveExtracted.owner, ownerFilledFromSender))
    if (ownerLearnedNote && !isPalermo) senderFillNotes.push(ownerLearnedNote)
    if (carrierFilledFromSender) senderFillNotes.push(formatSenderFillNote('Carrier', carrierResolution.name, carrierFilledFromSender))
    if (dockDoorFilledFromSender && !isPalermo) senderFillNotes.push(formatSenderFillNote('Dock Door', effectiveExtracted.dockDoor, dockDoorFilledFromSender))
    if (datexUsed) senderFillNotes.push(formatDatexNote(datexUsed.match, datexUsed.ownerChanged, datexUsed.project))
    if (palermoParsed && palermoSignaturePresent && palermoCancelled) {
      senderFillNotes.push(`⚠️ This looks like a Sam Rohde/Daren Peet email that also contains cancellation language ("cancelled", "no longer needed", etc.) -- the Palermo auto-push override was skipped and this was routed for normal CSR review instead of being pushed to Datex automatically. CSR: please verify against Datex before approving.`)
    }
    const ownerResolutionForComment: OwnerResolution = ownerFilledFromSender || (learnedPred?.status === 'agree' && ownerDefaultResult.changed) || datexUsed?.ownerChanged ? { matched: true, name: effectiveExtracted.owner, id: null } : ownerResolution

    const writeResult = routing === 'multi'
      ? await writeMultiSubmissions({ conversationId, warehouse, extracted: effectiveExtracted, carrierResolution, senderEmail, frontCustomNote })
      : await writeSingleOrContainerSubmission({ conversationId, warehouse, extracted: effectiveExtracted, carrierResolution, extraFields, senderEmail, frontCustomNote })

    let autoPushNote: string | null = null
    const submissionIdForPush = (writeResult as any)?.submissionId
    if (palermoAutoPush && submissionIdForPush) {
      try {
        await sbPatch(`submissions?id=eq.${encodeURIComponent(submissionIdForPush)}`, { status: 'processing' })
        await fetch(PALERMO_AUTO_PUSH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: submissionIdForPush, source: 'palermo_auto', send_email: true }),
        })
        autoPushNote = `\u{1F501} Auto-scheduled with NO CSR review -- not today's appointment. Pushing to Datex and sending the carrier confirmation automatically.`
        await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'palermo_auto_push_triggered', routing, submissionId: submissionIdForPush })
      } catch (e) {
        console.error('[scheduling-agent] palermo auto-push trigger failed (non-fatal, falling back to CSR review)', (e as Error).message)
        await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'palermo_auto_push_trigger_failed', routing, submissionId: submissionIdForPush, errorDetail: (e as Error).message })
      }
    }

    await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'submitted', routing, extractedFields: { ...extracted, carrierResolution, ownerResolution, senderDefaults, ownerFilledFromSender, learnedOwner: learnedPred, llmOwnerBeforeDefault: ownerDefaultResult.llmOwner, carrierFilledFromSender, dockDoorFilledFromSender, datexLookup: datexLog, projectDockDoorFill, frontCustomNote, palermoOverrideApplied: isPalermo, palermoAutoPush, senderEmail, correctionHints, ...(senderEmail ? {} : { rawMessageKeys }) }, confidence, submissionId: submissionIdForPush || ((writeResult as any).submissionIds || [])[0] })

    await withMcp((c) => c('add_comment', { conversationId, body: formatConfirmation(warehouse!, effectiveExtracted, carrierResolution, ownerResolutionForComment, projectDockDoorFill, notesValue, senderFillNotes, autoPushNote) }))

    return { ok: true, routing, confidence, warehouse, carrierMatched: carrierResolution.matched, palermoAutoPush }
  } catch (e) {
    const msg = (e as Error).message
    await logIntakeAttempt({ conversationId, inboxId, warehouse, outcome: 'error', errorDetail: msg.slice(0, 1000) })
    try { await withMcp((c) => c('add_comment', { conversationId, body: 'Scheduling agent could not run on this thread. Details are in ai_appt_intake_log.' })) } catch (_) { /* ignore */ }
    return { ok: false, error: msg }
  }
}

async function verifySignature(raw: string, headers: Headers) {
  const ts = headers.get('x-front-request-timestamp'), sig = headers.get('x-front-signature'), secret = env('FRONT_SCHEDULING_AGENT_SIGNING_SECRET')
  if (!ts || !sig || !secret) return false
  const skew = Math.abs(Date.now() - Number(ts))
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${raw}`)))
  let bin = ''
  for (const b of mac) bin += String.fromCharCode(b)
  const expected = btoa(bin)
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req: Request) => {
  const ok = () => new Response('ok', { status: 200 })
  try {
    const raw = await req.text()
    const sigOk = await verifySignature(raw, req.headers)
    if (!sigOk) { console.warn('[scheduling-agent] signature check failed or secret not configured'); return ok() }
    const p = tryJson(raw)
    if (!p) return ok()
    console.log('[scheduling-agent] event', JSON.stringify({ type: p.type, id: p.event_id }))
    if (p.type !== 'mention' || !p.conversation_id || !p.comment_id) return ok()
    const work = runSchedulingAgentMention(p.conversation_id, p.comment_id)
      .then((r) => console.log('[scheduling-agent] result', JSON.stringify(r)))
      .catch((e) => console.error('[scheduling-agent] error', (e as Error).message))
    // deno-lint-ignore no-explicit-any
    ;(globalThis as any).EdgeRuntime?.waitUntil(work)
    return ok()
  } catch (e) {
    console.error('[scheduling-agent] fatal', (e as Error).message)
    return ok()
  }
})
