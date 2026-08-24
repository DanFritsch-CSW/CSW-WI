'use strict'

// Shared core for the Scorecard Draft Creator — added 2026-08-06, BERNATELLO'S
// ONLY PILOT (see Notion changelog for the full scoping history: 2026-08-04/05
// conversations with Dan/Hill). Goal: when Omni's weekly customer scorecard
// email lands in Front, auto-generate a DRAFT (never send) reply with a
// GM-style narrative, for a human to review/edit/send exactly as they do
// today.
//
// WHY THIS FILE IS SPLIT FROM THE -run/-test ENTRYPOINTS: same reason as
// every other digest on this project (see fefo-digest-shared.cjs's header) —
// Netlify blocks direct HTTP invocation of any function carrying a `schedule`
// in netlify.toml.
//
// KEY DESIGN DECISIONS (from the scoping conversation, in order):
// 1. Numbers come from THIS APP'S OWN already-validated MotherDuck queries
//    (motherduck-scorecard-metrics.cjs, itself a project_name/week-scoped
//    sibling of motherduck-ott.cjs / motherduck-case-pick-accuracy.cjs), not
//    from parsing Omni's PNG image and not from Omni's fuzzy natural-language
//    layer. Vision-reading the PNG was explicitly discussed and intentionally
//    NOT used as the primary source — an LLM misreading a chart percentage
//    into a customer-facing email is a worse failure mode than a wrong
//    internal-dashboard number. (Room for PNG-as-secondary-cross-check later,
//    not built this pass.)
// 2. Each customer's Omni dashboard ID is stored (customer_scorecard_config.
//    omni_dashboard_id) as the drift-fix pointer for a FUTURE pass that reads
//    the dashboard's live document state (GET /v2/documents/{id}) — not
//    wired up yet in this pilot; flagged as not-yet-done below.
// 3. Per-customer PROMPT holds tone/emphasis guidance only, never metric
//    definitions — those live in the MotherDuck query + Omni, so they can't
//    silently drift out of sync with a hand-maintained prompt.
// 4. Recent Front thread context is pulled and scanned for a short keyword
//    list (urgent, hold, etc.) per Dan's ask — flagged lines are passed to
//    Claude as explicit signals, not just dumped in as raw noise.
// 5. Output is ALWAYS a Front DRAFT, never sent automatically. No code path
//    in this file calls Front's send-message endpoint. This must not change
//    without an explicit re-review of the data-exposure risk (an internal
//    ops comment ending up quoted in a customer-facing draft).
//
// TRIGGER/DETECTION (updated 2026-08-06, confirmed with Dan via screenshot):
// scoped via a real Front tag, "QBR - Case Study" — a company-level tag
// nested under Positive > Sentiment (Front Settings → Tags → Company). Note
// the exact spelling: spaces + hyphen, NOT the "qbr_case_study" placeholder
// name used earlier during scoping — that name was wrong, corrected once
// Dan confirmed the real tag via a screenshot of Front's tag settings.
// resolveScorecardTagId() looks this tag up BY NAME every run (GET /tags,
// exact case-insensitive match) rather than hardcoding a tag ID. Confirmed
// via Front's own API docs: GET /tags/{tag_id}/conversations is the real
// "List tagged conversations" endpoint. Per-customer front_subject_contains
// is still used to partition tagged conversations by customer (multiple
// customers' scorecard emails likely share this one tag, per Hill's
// original "tag anything with 'customer scorecard'" framing). If the tag
// isn't found, falls back to the older subject-string-only Front search.
//
// UNVERIFIED RISK, flagged rather than assumed away: this session's Front
// MCP tool (list_tags) could NOT find "QBR - Case Study" under any query
// variant (exact name, partial, unfiltered listing, even searching for its
// parent "Sentiment" tag) even after Dan confirmed via screenshot that it
// exists at the company level, nested under a parent tag. That strongly
// suggests company-level/nested tags aren't returned the same way by
// whatever tags-listing surface that tool wraps. resolveScorecardTagId()
// below calls Front's REST API directly (GET /tags) with FRONT_API_TOKEN —
// NOT the same code path as the MCP tool — so it may or may not have the
// same blind spot. This has NOT been verified live from inside a deployed
// function. Confirmed live 2026-08-07 (Grassland's real inbound email,
// cnv_1c3896fo) that the conversation itself carries zero tags regardless
// (tagIds: []) — the "Scorecard Template" rule only posts a comment, it
// has no tag action yet. Given BOTH of these gaps stack, the tag path is
// realistically not doing anything useful yet either way — see the FIXED
// note below for how the code now tolerates that gracefully instead of
// silently failing.
//
// FIXED 2026-08-24: resolveChannelId (renamed resolveChannelIdForConversation)
// previously guessed the draft's sending channel from a STATIC
// warehouse-name → channel map (WAREHOUSE_MAP below), assuming one fixed
// inbox per facility. Real bug found when Dan routed Omni's Grassland
// delivery to a new shared "Madison" inbox (madison@csw-wi.com,
// access_mode: everyone — the correct fix for the earlier restricted-
// personal-inbox 403): that inbox's own channel (cha_duvx0) is DIFFERENT
// from the "MAD Appointments" channel (cha_ema8k) the static map pointed
// to for Madison. Front's drafts API requires channel_id to belong to one
// of the conversation's own inboxes — using the wrong one would have
// failed the exact same way the missing-channel_id bug did originally.
// Fixed by resolving the channel dynamically from whatever inbox the
// conversation ACTUALLY lives in (GET /conversations/{id}/inboxes, then
// GET /inboxes/{inbox_id}/channels) as the PRIMARY path, falling back to
// FRONT_CHANNEL_ID / WAREHOUSE_MAP / generic /channels only if that fails.
// This means routing a customer's scorecard email to any shared inbox Dan
// sets up going forward works automatically, without a future code change
// per new inbox. NOT YET LIVE-VERIFIED — GET /conversations/{id}/inboxes
// and GET /inboxes/{id}/channels are standard, documented Front API
// endpoints, but this exact code path hasn't been exercised by a real
// test yet; watch the next real draft attempt closely.
//
// FIXED 2026-08-07: fetchScorecardCandidates() previously only fell back
// to subject search when resolveScorecardTagId() itself failed/returned
// null — if the tag DID resolve but zero conversations were actually
// tagged for a given customer (exactly Grassland's real situation: no tag
// action on the rule yet), the function returned zero candidates and
// NEVER fell back, meaning that customer would silently never get a draft
// no matter how many scheduled ticks passed. Now falls back to subject
// search whenever the tag path yields zero candidates, not just when tag
// resolution errors outright.
//
// FIXED 2026-08-06 (first real test run via the new UI tab): createScorecardDraft
// was wrongly assuming Front's drafts endpoint would default to the
// conversation's own channel for a reply, omitting channel_id entirely.
// Real error from the first live test: "Front drafts API → 400:
// {"_errors":{"status":400,"title":"Bad request","message":"Body did not
// satisfy requirements","details":["body.channel_id: missing"]}}". Front's
// drafts API requires channel_id unconditionally — confirmed by
// front-draft-shared.cjs (this app's other, already-working Front-draft
// caller) always resolving and passing one.
//
// FIXED 2026-08-06 (same first test's real output): buildClaudePrompt was
// only fed OTT (2hr/3hr) and Case Pick Accuracy — Claude correctly wrote
// "Carrier Performance: not reported this period" rather than inventing a
// number, but Dan pointed out Bernatello's real Omni dashboard DOES have a
// "Carrier % On-Time Arrival" metric this function was simply never built
// to compute. Added — see motherduck-scorecard-metrics.cjs's header for
// the formula (derived from the same arrival_status data already computed
// for OTT) and its validation caveats. metricLines below now includes it
// whenever motherduck-scorecard-metrics.cjs returns a non-null value.
//
// FIXED 2026-08-24 (separate fix, in scorecard-draft-run.cjs, not this
// file): candidate window widened from 20 minutes to 7 days for the same
// "narrow window with no safety net" reason as the tag fallback above.
//
// NOT YET DONE / KNOWN GAPS (see Notion Pending Issues):
// - Add a "tag conversation" action for "QBR - Case Study" on the existing
//   "Scorecard Template" rule (rul_7kwwk) so it actually gets applied to
//   incoming Omni scorecard emails — rule-editing isn't available through
//   this session's tools. Until this exists, EVERY customer relies on the
//   subject-search fallback, not the tag path — confirmed this is fine
//   functionally after the 2026-08-07 fix above, just weaker/slower than
//   the intended design (depends on Omni's subject line never changing).
//   Also confirmed 2026-08-24: this rule apparently doesn't fire at all
//   for madison@csw-wi.com-delivered emails (no rule_action entry seen on
//   a real one) — likely scoped to the older delivery address/channel.
//   Doesn't block this pipeline (subject search doesn't depend on the
//   rule), but worth fixing if the tag path is ever meant to go live.
// - Omni dashboard document-state read (drift-proofing) not implemented —
//   only the dashboard_id pointer is stored.
// - Carrier % On-Time Arrival formula not fully validated against Omni's
//   literal underlying definition — see motherduck-scorecard-metrics.cjs.
// - Grassland's actual MotherDuck data (project_name containing
//   'Grassland', warehouse 'CSW-Madison') has never been spot-checked
//   against a known-good week the way Bernatello's was during scoping —
//   worth doing once a real draft succeeds, to confirm the numbers are
//   sane, not just that the pipeline runs without erroring.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

const CLAUDE_MODEL = 'claude-sonnet-4-5'

// The Front tag that scopes which conversations this feature looks at at
// all. CORRECTED 2026-08-06 (later same day) — Dan confirmed via a Front
// Settings screenshot that the real tag is "QBR - Case Study" (company
// level, nested under Positive > Sentiment), not the "qbr_case_study"
// placeholder name used earlier. Resolved by name at runtime (see
// resolveScorecardTagId below), not hardcoded as an ID — see the
// UNVERIFIED RISK note above regarding whether this lookup can actually
// see a company-level/nested tag.
const SCORECARD_TAG_NAME = 'QBR - Case Study'

// Keyword flags Dan asked for (2026-08-05 Front feedback thread) — lines in
// recent thread context containing these are surfaced to Claude as explicit
// "don't bury this" signals rather than left to be found (or missed) inside
// a big raw text dump.
const CONTEXT_KEYWORDS = ['urgent', 'hold', 'escalat', 'complaint', 'asap', 'immediately']

// How far back to pull Front thread context for "ops context" per the
// 2026-08-05 decision (numbers + last week's thread, not numbers alone).
const THREAD_CONTEXT_DAYS = 7

// Warehouse → Front appointments-inbox channel map — now a FALLBACK ONLY
// (see 2026-08-24 FIXED note above), used only if a conversation's own
// inbox can't be resolved to a channel for some reason. Keys match
// warehouseKey()'s normalization: lowercase, spaces → hyphens.
const WAREHOUSE_MAP = {
  'csw-franksville':      { channel: 'cha_ema1g', inbox: 'inb_aut78' }, // CAL Appointments
  'csw-kenosha':          { channel: 'cha_ema6s', inbox: 'inb_awl90' }, // KEN Appointments
  'csw-madison':          { channel: 'cha_ema8k', inbox: 'inb_awlas' }, // MAD Appointments
  'csw-wisconsin-rapids': { channel: 'cha_euvx0', inbox: 'inb_b8n2s' }, // WR Appointments
  'csw-eau-claire':       { channel: 'cha_eubx0', inbox: 'inb_beis4' }, // EC Appointments
}

function warehouseKey(warehouse) {
  return (warehouse || '').toLowerCase().replace(/\s+/g, '-')
}

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

async function sbPost(path, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: prefer || 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text)
  try { return text ? JSON.parse(text) : null } catch { return null }
}

async function fetchCustomerConfig(customerKey) {
  const rows = await sbFetch(`customer_scorecard_config?customer_key=eq.${encodeURIComponent(customerKey)}&select=*`)
  if (!rows || !rows.length) throw new Error(`No customer_scorecard_config row for '${customerKey}'`)
  return rows[0]
}

async function alreadyDrafted(customerKey, conversationId) {
  const rows = await sbFetch(
    `scorecard_draft_log?customer_key=eq.${encodeURIComponent(customerKey)}&front_conversation_id=eq.${encodeURIComponent(conversationId)}&select=id`
  )
  return Array.isArray(rows) && rows.length > 0
}

async function logDraftResult({ customerKey, conversationId, draftId, status, errorDetail, isManualTest }) {
  // Manual test re-runs are expected to hit the same conversation repeatedly
  // (that's the point of a test button) — the UNIQUE constraint would reject
  // a second row, so manual tests don't attempt to log at all. Only the
  // scheduled path needs the dedupe log.
  if (isManualTest) return
  try {
    await sbPost('scorecard_draft_log', {
      customer_key: customerKey, front_conversation_id: conversationId, draft_id: draftId || null,
      status, error_detail: errorDetail || null, is_manual_test: false,
    })
  } catch (_) { /* best-effort logging only, never block on this */ }
}

async function fetchMetrics(config) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/motherduck-scorecard-metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectNameContains: config.project_name_contains.replace(/%/g, ''),
      warehouseName: config.warehouse_name,
      includeCasePickAccuracy: !!config.include_case_pick_accuracy,
    }),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok) throw new Error(`motherduck-scorecard-metrics failed: ${JSON.stringify(data)}`)
  return data
}

async function frontGet(path) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Front GET ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

// Same as frontGet but takes a full URL (Front's pagination cursors — via
// _pagination.next — are already-complete URLs, not relative paths).
async function frontGetUrl(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Front GET ${url} → ${res.status}: ${await res.text()}`)
  return res.json()
}

// Resolves the "QBR - Case Study" tag's ID by name — see UNVERIFIED RISK
// note in the file header regarding company-level/nested tag visibility.
// Case-insensitive exact match. Paginates through /tags in case the
// workspace has more than one page of tags. Returns null (not a throw) if
// not found, so callers can gracefully fall back — a missing tag is an
// expected, documented state during rollout, not a bug.
async function resolveScorecardTagId() {
  let all = []
  let data = await frontGet('/tags?limit=100')
  all = all.concat(data._results || [])
  while (data._pagination?.next) {
    data = await frontGetUrl(data._pagination.next)
    all = all.concat(data._results || [])
  }
  const match = all.find((t) => (t.name || '').toLowerCase() === SCORECARD_TAG_NAME.toLowerCase())
  return match ? match.id : null
}

// Lists conversations carrying the resolved tag, updated within the last
// `sinceMinutes`. This is the PRIMARY detection path once the tag exists.
async function listConversationsByTag(tagId, sinceMinutes) {
  const data = await frontGet(`/tags/${tagId}/conversations?limit=50`)
  const cutoff = Date.now() - sinceMinutes * 60 * 1000
  return (data._results || []).filter((c) => (c.last_message?.created_at || 0) * 1000 >= cutoff)
}

// Searches Front for candidate conversations by subject string — FALLBACK
// ONLY, used when the "QBR - Case Study" tag can't be resolved (see
// UNVERIFIED RISK above). Weaker than the tag-based path since it depends
// on Omni never changing its subject line wording.
async function searchRecentScorecardConversations(subjectContains, sinceMinutes) {
  const res = await fetch(
    `https://api2.frontapp.com/conversations/search/${encodeURIComponent(subjectContains)}`,
    { headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' } }
  )
  if (!res.ok) throw new Error(`Front search API → ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const cutoff = Date.now() - sinceMinutes * 60 * 1000
  return (data._results || []).filter((c) => (c.last_message?.created_at || 0) * 1000 >= cutoff)
}

// Combined lookup used by scorecard-draft-run.cjs: tries the tag first,
// falls back to subject search if the tag can't be resolved OR resolves
// but finds zero tagged candidates for this customer (FIXED 2026-08-07 —
// see file header). Returns { candidates, usedTag: boolean } so results
// can report which path actually produced the candidates.
async function fetchScorecardCandidates(config, sinceMinutes) {
  let tagId = null
  try {
    tagId = await resolveScorecardTagId()
  } catch (_) { /* fall through to subject search */ }

  if (tagId) {
    const tagged = await listConversationsByTag(tagId, sinceMinutes)
    const candidates = tagged.filter((c) => (c.subject || '').includes(config.front_subject_contains))
    if (candidates.length) return { candidates, usedTag: true }
    // Tag resolved but nothing tagged yet for this customer — don't give up,
    // fall through to the subject search below as a safety net.
  }

  const candidates = await searchRecentScorecardConversations(config.front_subject_contains, sinceMinutes)
  return { candidates, usedTag: false }
}

// Pulls comments (internal discussion) from the last THREAD_CONTEXT_DAYS on
// this conversation, flags any line containing a watch keyword. Returns
// nothing if the conversation has no recent comments — a quiet week is not
// an error, the draft just proceeds on numbers alone.
async function fetchRecentThreadContext(conversationId) {
  const cutoff = Date.now() - THREAD_CONTEXT_DAYS * 24 * 60 * 60 * 1000
  let data
  try {
    data = await frontGet(`/conversations/${conversationId}/comments?limit=50`)
  } catch (e) {
    return { comments: [], flagged: [], error: e.message }
  }
  const comments = (data._results || [])
    .filter((c) => new Date(c.posted_at || c.created_at || 0).getTime() >= cutoff)
    .map((c) => ({
      author: c.author?.first_name ? `${c.author.first_name} ${c.author.last_name || ''}`.trim() : 'Unknown',
      body: c.body || '',
      postedAt: c.posted_at || c.created_at,
    }))
  const flagged = comments.filter((c) =>
    CONTEXT_KEYWORDS.some((kw) => c.body.toLowerCase().includes(kw))
  )
  return { comments, flagged, error: null }
}

function buildClaudePrompt(config, metrics, threadContext) {
  const metricLines = []
  if (metrics.ott2?.pct != null) metricLines.push(`Under 2 Hours: ${metrics.ott2.pct}% (${metrics.ott2.numerator}/${metrics.ott2.denominator})`)
  if (metrics.ott3?.pct != null) metricLines.push(`Under 3 Hours: ${metrics.ott3.pct}% (${metrics.ott3.numerator}/${metrics.ott3.denominator})`)
  if (metrics.carrierOnTime?.pct != null) metricLines.push(`Carrier % On-Time Arrival: ${metrics.carrierOnTime.pct}% (${metrics.carrierOnTime.numerator}/${metrics.carrierOnTime.denominator})`)
  if (metrics.casePickAccuracy?.pct != null) metricLines.push(`Case Pick Accuracy: ${metrics.casePickAccuracy.pct}%`)
  metricLines.push(`Total completed outbound appointments: ${metrics.totalCompletedAppointments}`)

  const contextBlock = threadContext.comments.length
    ? threadContext.comments.map((c) => `- [${c.postedAt}] ${c.author}: ${c.body}`).join('\n')
    : '(no recent internal discussion on this thread)'

  const flaggedBlock = threadContext.flagged.length
    ? threadContext.flagged.map((c) => `- ${c.author}: ${c.body}`).join('\n')
    : '(none)'

  return `You are drafting a weekly performance scorecard email to ${config.customer_label}, on behalf of a CSW-WI facility GM. This draft will be reviewed and edited by a human before it is ever sent — never claim otherwise, never sign it as though it's final.

STYLE GUIDANCE FOR THIS CUSTOMER:
${config.prompt_style}

THIS WEEK'S METRICS (week of ${metrics.weekStart} to ${metrics.weekEndExclusive}):
${metricLines.join('\n')}

RECENT INTERNAL THREAD CONTEXT (last ${THREAD_CONTEXT_DAYS} days — internal CSW discussion, NOT customer-facing; use only to inform tone/color, and NEVER quote or reference anything here that would be inappropriate for the customer to see):
${contextBlock}

FLAGGED LINES (contain urgent/hold/escalation-type keywords — weigh these carefully; do not surface anything internal-only):
${flaggedBlock}

Write the email body now (no subject line, no HTML — plain text with line breaks). Do not fabricate any number not given above. Do not reference internal staffing, disciplinary, or other-customer information even if present in the thread context above.`
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`)
  const textBlock = (data.content || []).find((b) => b.type === 'text')
  if (!textBlock) throw new Error(`Claude API returned no text block: ${JSON.stringify(data)}`)
  return textBlock.text
}

function toHtml(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped.split('\n').map((line) => `<div>${line === '' ? '<br />' : line}</div>`).join('')
}

// Resolves reply-all recipients from the most recent inbound message on the
// conversation — same convention as front-draft-shared.cjs's
// getReplyAllRecipients (includes original 'to' recipients, not just 'from').
async function getReplyAllRecipients(conversationId) {
  try {
    const data = await frontGet(`/conversations/${conversationId}/messages?limit=50`)
    const messages = data._results || []
    const inbound = messages.slice().reverse().find((m) => m.is_inbound) || messages[messages.length - 1]
    if (!inbound) return { to: [], cc: [] }
    const recipients = inbound.recipients || []
    const to = recipients.filter((r) => r.role === 'from' || r.role === 'to').map((r) => r.handle).filter(Boolean)
    const cc = recipients.filter((r) => r.role === 'cc').map((r) => r.handle).filter(Boolean)
    return { to, cc }
  } catch {
    return { to: [], cc: [] }
  }
}

// Lists the inbox IDs a conversation actually belongs to.
async function resolveConversationInboxIds(conversationId) {
  const data = await frontGet(`/conversations/${conversationId}/inboxes`)
  return (data._results || []).map((i) => i.id)
}

// Lists channel IDs for a given inbox, preferring real email-type channels.
async function resolveChannelForInbox(inboxId) {
  const data = await frontGet(`/inboxes/${inboxId}/channels`)
  const results = data._results || []
  const ch = results.find((c) => ['smtp', 'office365', 'gmail', 'imap'].includes(c.type)) || results[0]
  return ch?.id || null
}

// Resolves a Front channel_id to send from — REQUIRED by Front's drafts API
// unconditionally (confirmed live 2026-08-06: omitting it 400s with
// "body.channel_id: missing" even for a reply draft).
//
// FIXED 2026-08-24 — PRIMARY path is now dynamic: look up the channel that
// actually belongs to the conversation's own inbox(es), since a static
// facility→channel guess breaks the moment a customer's email is routed to
// a different shared inbox than the map expects (real example: Grassland's
// Madison-routed email landed in a "Madison" inbox with its own channel,
// cha_duvx0, not the "MAD Appointments" channel the old WAREHOUSE_MAP
// pointed to for that facility). Falls back to FRONT_CHANNEL_ID env
// override, then the static WAREHOUSE_MAP, then any available channel —
// only if the dynamic lookup can't find anything, which shouldn't normally
// happen for a real conversation.
async function resolveChannelIdForConversation(conversationId, warehouseName) {
  try {
    const inboxIds = await resolveConversationInboxIds(conversationId)
    for (const inboxId of inboxIds) {
      const chId = await resolveChannelForInbox(inboxId)
      if (chId) return chId
    }
  } catch (_) { /* fall through to the static fallbacks below */ }

  if (process.env.FRONT_CHANNEL_ID) return process.env.FRONT_CHANNEL_ID

  const key = warehouseKey(warehouseName)
  const mapping = WAREHOUSE_MAP[key]
  if (mapping?.channel) return mapping.channel

  const r = await frontGet('/channels')
  const ch = r._results?.find((c) => ['smtp', 'office365', 'gmail', 'imap'].includes(c.type)) || r._results?.[0]
  if (!ch?.id) throw new Error('Could not resolve a sending channel for the scorecard draft. Set FRONT_CHANNEL_ID in Netlify env vars.')
  return ch.id
}

// Creates a Front DRAFT reply on the conversation. NEVER calls Front's
// send-message endpoint — see file header. channel_id is REQUIRED (see
// resolveChannelIdForConversation above).
async function createScorecardDraft(conversationId, bodyText, warehouseName) {
  const [channelId, { to, cc }] = await Promise.all([
    resolveChannelIdForConversation(conversationId, warehouseName),
    getReplyAllRecipients(conversationId),
  ])
  const payload = { channel_id: channelId, body: toHtml(bodyText), mode: 'shared', type: 'replyAll' }
  if (to.length) payload.to = to
  if (cc.length) payload.cc = cc

  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!res.ok) throw new Error(`Front drafts API → ${res.status}: ${text}`)
  return data
}

// Full pipeline for one conversation. Used identically by both the
// scheduled runner and the manual test entrypoint — the only difference
// between them is how they arrive at { customerKey, conversationId } and
// whether the dedupe log gets written (see logDraftResult above).
async function runForConversation({ customerKey, conversationId, isManualTest }) {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, reason: 'ANTHROPIC_API_KEY not configured', customerKey, conversationId }
  }

  const config = await fetchCustomerConfig(customerKey)

  if (!isManualTest) {
    const dup = await alreadyDrafted(customerKey, conversationId)
    if (dup) return { ok: false, reason: 'already drafted for this conversation', customerKey, conversationId, skipped: true }
  }

  let metrics, threadContext, draftBody, draftResult
  try {
    metrics = await fetchMetrics(config)
    threadContext = await fetchRecentThreadContext(conversationId)
    const prompt = buildClaudePrompt(config, metrics, threadContext)
    draftBody = await callClaude(prompt)
    draftResult = await createScorecardDraft(conversationId, draftBody, config.warehouse_name)
  } catch (e) {
    await logDraftResult({ customerKey, conversationId, status: 'error', errorDetail: e.message, isManualTest })
    return { ok: false, reason: e.message, customerKey, conversationId }
  }

  await logDraftResult({ customerKey, conversationId, draftId: draftResult.id, status: 'ok', isManualTest })

  return {
    ok: true,
    customerKey,
    conversationId,
    draftId: draftResult.id,
    weekStart: metrics.weekStart,
    weekEndExclusive: metrics.weekEndExclusive,
    flaggedContextCount: threadContext.flagged.length,
    draftPreview: draftBody.slice(0, 300),
  }
}

module.exports = {
  fetchCustomerConfig, runForConversation,
  resolveScorecardTagId, listConversationsByTag, searchRecentScorecardConversations,
  fetchScorecardCandidates, SCORECARD_TAG_NAME,
}
