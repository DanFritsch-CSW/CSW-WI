'use strict'

// Shared core for the Scorecard Draft Creator — added 2026-08-06, PILOT
// (Bernatello's + Grassland; see Notion changelog for the full scoping
// history: 2026-08-04/05 conversations with Dan/Hill). Goal: when Omni's
// weekly customer scorecard email lands in Front, auto-generate a DRAFT
// (never send) reply with a GM-style narrative, for a human to
// review/edit/send exactly as they do today.
//
// WHY THIS FILE IS SPLIT FROM THE -run/-test ENTRYPOINTS: same reason as
// every other digest on this project (see fefo-digest-shared.cjs's header) —
// Netlify blocks direct HTTP invocation of any function carrying a `schedule`
// in netlify.toml.
//
// KEY DESIGN DECISIONS (from the scoping conversation, in order):
// 1. Numbers come from THIS APP'S OWN already-validated MotherDuck queries
//    (motherduck-scorecard-metrics.cjs), not from parsing Omni's PNG image
//    and not from Omni's fuzzy natural-language layer.
// 2. Each customer's Omni dashboard ID is stored (customer_scorecard_config.
//    omni_dashboard_id) as a drift-fix pointer for a FUTURE pass that reads
//    the dashboard's live document state — not wired up yet.
// 3. Per-customer PROMPT holds tone/emphasis guidance only, never metric
//    definitions.
// 4. Recent Front thread context is pulled and scanned for a short keyword
//    list (urgent, hold, etc.) — flagged lines are passed to Claude as
//    explicit signals.
// 5. Output is ALWAYS a Front DRAFT, never sent automatically. No code path
//    in this file calls Front's send-message endpoint.
//
// TRIGGER/DETECTION — REWRITTEN 2026-08-24/25. Full history, oldest to newest:
//
// (a) ORIGINAL DESIGN (2026-08-06): a shared Front tag ("QBR - Case Study",
//     a company-level tag nested under Positive > Sentiment) was meant to
//     scope detection cheaply across all customers. Never worked: this
//     session's Front tools could not see the tag under any query variant
//     (exact name, partial, parent tag), even after Dan confirmed via
//     screenshot that it exists. The "Scorecard Template" rule that was
//     meant to apply it also never got a tag action added, and separately
//     doesn't even fire on newer delivery addresses (confirmed 2026-08-24:
//     no rule_action on a real madison@csw-wi.com email). Fell back to a
//     Front full-text subject search (see (b)).
// (b) SUBJECT SEARCH FALLBACK (2026-08-06 through 2026-08-24): worked for
//     the pilot's early manual tests, but the SCHEDULED path never
//     successfully found and drafted a single real production email on
//     its own. Widened the candidate time window from 20 minutes to 7
//     days on 2026-08-24 — did not fix it either.
// (c) DIRECT INBOX POLLING (2026-08-24, later found ALSO broken): replaced
//     (a)/(b) with polling a customer's known Front inbox directly (GET
//     /inboxes/{id}/conversations via customer_scorecard_config.
//     front_inbox_name). Seemed like the right fix, but the very next real
//     test (Grassland, cnv_1c7vbmdw, 2026-08-24 ~19:07 CT) still produced
//     no draft.
// (d) ROOT CAUSE FOUND 2026-08-25: ALL THREE recency filters — in (b)'s
//     searchRecentScorecardConversations, the tag fallback's
//     listConversationsByTag, AND (c)'s brand-new listRecentInboxConversations
//     — checked `c.last_message?.created_at`. Front's actual documented
//     Conversation object (confirmed via https://dev.frontapp.com/reference/conversations,
//     fetched directly) has NO such field: `last_message` only exists as a
//     URL string under `_links.related.last_message`, not an embedded
//     object with a timestamp. So `c.last_message?.created_at` was always
//     `undefined`, `(undefined || 0) * 1000` was always `0`, and
//     `0 >= cutoff` was always false — EVERY candidate was silently
//     filtered out, on every single scheduled run, since this feature's
//     first version. This is why nothing ever auto-drafted: not a
//     search-scope issue, not a tag-visibility issue, not a deploy-timing
//     issue — a wrong field name that discarded every real candidate
//     before it could ever be processed. Fixed by using the Conversation
//     object's real top-level `created_at` field (Unix seconds) instead.
//     Each customer's scorecard email creates a brand-new conversation
//     every week (confirmed early in this project), so a conversation's
//     own creation time is exactly the right "how recent is this
//     candidate" signal — this is not a workaround, it's the correct field.
//
// IMPORTANT OPEN ITEM: (c)'s direct inbox polling only works for a
// customer once their real Omni delivery is routed to a SHARED inbox this
// app can read (confirmed working: Grassland → "Madison", access_mode:
// everyone). Bernatello's real production email is NOT yet on this path —
// it still lands in Dan's personal restricted inbox (inb_azvro), which
// the app cannot read at all (confirmed via a direct 403 earlier this
// session). Bernatello's front_inbox_name is deliberately left NULL until
// Dan moves its Omni delivery to a shared inbox the same way Grassland's
// was moved.
//
// ALSO NOTE (2026-08-24): the "Madison" inbox that Grassland's
// front_inbox_name points to is NOT a dedicated scorecard inbox — it's
// the general Madison facility inbox, confirmed to contain 54,748+
// conversations (mostly routine "Shipment X has been completed"
// notifications). listRecentInboxConversations only fetches the newest 50
// conversations from that inbox per call. This has NOT caused a failure
// yet (the target conversation has always been within the first 1-2
// results by recency), but is a real fragility: if enough other traffic
// lands in the same inbox between scheduled ticks, a scorecard email
// could fall out of that top-50 window before ever being seen. Not fixed
// this pass — flagged for whoever picks this up next if a customer's
// inbox choice turns out to be high-traffic.
//
// FIXED 2026-08-24: resolveChannelIdForConversation resolves the draft's
// sending channel dynamically from whatever inbox the conversation
// actually lives in (GET /conversations/{id}/inboxes → GET
// /inboxes/{inbox_id}/channels), not a static warehouse→channel guess.
// Real bug found: Grassland's Madison-inbox channel (cha_duvx0) differs
// from the "MAD Appointments" channel the old static map pointed to for
// that facility — using the wrong one would have 400'd. Live-verified
// 2026-08-24 via a real successful test draft on cnv_1c7v4cgk.
//
// FIXED 2026-08-06: createScorecardDraft requires channel_id explicitly —
// Front's drafts API 400s without it even for a reply
// ("body.channel_id: missing"), confirmed via the first live test.
//
// FIXED 2026-08-06: buildClaudePrompt now includes Carrier % On-Time
// Arrival (see motherduck-scorecard-metrics.cjs) — the first live test's
// output correctly said "not reported this period" for a metric this
// function simply hadn't been built to compute yet; Bernatello's real
// dashboard does report it.
//
// NOT YET DONE / KNOWN GAPS (see Notion Pending Issues):
// - Bernatello's needs its real Omni delivery moved to a shared inbox
//   (see IMPORTANT OPEN ITEM above) before front_inbox_name can be set
//   for it and before its real weekly automation can work at all.
// - Omni dashboard document-state read (drift-proofing) not implemented.
// - Carrier % On-Time Arrival formula not fully validated against Omni's
//   literal underlying definition.
// - Grassland's MotherDuck numbers spot-checked once against Dan's own
//   knowledge (42 outbound appointments, confirmed correct 2026-08-24) —
//   a good first signal, not a full validation across several weeks.
// - The tag and subject-search fallback paths remain in the code for
//   customers without front_inbox_name set, but were never confirmed
//   working even after the 2026-08-25 recency-filter fix — only the
//   inbox-poll path has been live-verified.
// - The 54,748-conversation "Madison" inbox top-50 fragility noted above.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

const CLAUDE_MODEL = 'claude-sonnet-4-5'

// The Front tag original design relied on — see TRIGGER/DETECTION (a)
// above. Kept only as a last-resort fallback; not trusted as primary.
const SCORECARD_TAG_NAME = 'QBR - Case Study'

// Keyword flags Dan asked for (2026-08-05) — lines in recent thread
// context containing these are surfaced to Claude as explicit "don't bury
// this" signals rather than left to be found (or missed) inside a big raw
// text dump.
const CONTEXT_KEYWORDS = ['urgent', 'hold', 'escalat', 'complaint', 'asap', 'immediately']

// How far back to pull Front thread context for "ops context" per the
// 2026-08-05 decision (numbers + last week's thread, not numbers alone).
const THREAD_CONTEXT_DAYS = 7

// Warehouse → Front appointments-inbox channel map — FALLBACK ONLY (see
// resolveChannelIdForConversation's 2026-08-24 fix), used only if a
// conversation's own inbox can't be resolved to a channel for some reason.
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

// Resolves a Front inbox ID by exact NAME — PRIMARY detection mechanism as
// of 2026-08-24 (see TRIGGER/DETECTION (c) in file header). Case-
// insensitive exact match against GET /inboxes. Returns null if not
// found, so callers can gracefully fall back to the tag/search paths.
async function resolveInboxIdByName(inboxName) {
  const data = await frontGet('/inboxes?limit=100')
  const match = (data._results || []).find((i) => (i.name || '').toLowerCase() === inboxName.toLowerCase())
  return match ? match.id : null
}

// Lists a specific inbox's conversations directly (GET
// /inboxes/{inbox_id}/conversations), filtered by subject-contains and
// recency. PRIMARY detection path when a customer has front_inbox_name
// configured — a direct, scoped resource read, the same reliable class of
// call as resolveChannelIdForConversation/createScorecardDraft elsewhere
// in this file, not a fuzzy cross-workspace search.
//
// FIXED 2026-08-25: recency filter used `c.last_message?.created_at`,
// which does not exist on Front's real Conversation object (confirmed
// against Front's own API docs) — this silently discarded EVERY
// candidate, every time. Now uses the real top-level `created_at` field.
// See TRIGGER/DETECTION (d) in the file header for the full story.
async function listRecentInboxConversations(inboxId, subjectContains, sinceMinutes) {
  const data = await frontGet(`/inboxes/${inboxId}/conversations?limit=50`)
  const cutoff = Date.now() - sinceMinutes * 60 * 1000
  return (data._results || []).filter((c) =>
    (c.subject || '').includes(subjectContains) &&
    (c.created_at || 0) * 1000 >= cutoff
  )
}

// Resolves the "QBR - Case Study" tag's ID by name — LAST-RESORT FALLBACK
// only (see TRIGGER/DETECTION (a) in file header; this has never
// successfully resolved in this workspace as of 2026-08-24). Case-
// insensitive exact match. Paginates through /tags. Returns null if not
// found.
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
// `sinceMinutes`. Fallback only — see above. FIXED 2026-08-25: same
// created_at fix as listRecentInboxConversations above.
async function listConversationsByTag(tagId, sinceMinutes) {
  const data = await frontGet(`/tags/${tagId}/conversations?limit=50`)
  const cutoff = Date.now() - sinceMinutes * 60 * 1000
  return (data._results || []).filter((c) => (c.created_at || 0) * 1000 >= cutoff)
}

// Searches Front for candidate conversations by subject string —
// LAST-RESORT FALLBACK (see TRIGGER/DETECTION (b) in file header).
// FIXED 2026-08-25: same created_at fix as listRecentInboxConversations
// above — this was the actual root cause of this path never working,
// not a search-scope limitation as originally suspected.
async function searchRecentScorecardConversations(subjectContains, sinceMinutes) {
  const res = await fetch(
    `https://api2.frontapp.com/conversations/search/${encodeURIComponent(subjectContains)}`,
    { headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' } }
  )
  if (!res.ok) throw new Error(`Front search API → ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const cutoff = Date.now() - sinceMinutes * 60 * 1000
  return (data._results || []).filter((c) => (c.created_at || 0) * 1000 >= cutoff)
}

// Combined lookup used by scorecard-draft-run.cjs. Order of preference,
// per TRIGGER/DETECTION in the file header:
//   1. Direct inbox poll (config.front_inbox_name) — PRIMARY, deterministic.
//   2. Tag (SCORECARD_TAG_NAME) — fallback, unverified.
//   3. Subject-string full-text search — last resort, unverified.
// Returns { candidates, usedTag, usedInbox } so results can report which
// path actually produced the candidates.
async function fetchScorecardCandidates(config, sinceMinutes) {
  if (config.front_inbox_name) {
    try {
      const inboxId = await resolveInboxIdByName(config.front_inbox_name)
      if (inboxId) {
        const candidates = await listRecentInboxConversations(inboxId, config.front_subject_contains, sinceMinutes)
        return { candidates, usedTag: false, usedInbox: true }
      }
    } catch (_) { /* fall through to tag/search below */ }
  }

  let tagId = null
  try {
    tagId = await resolveScorecardTagId()
  } catch (_) { /* fall through to subject search */ }

  if (tagId) {
    const tagged = await listConversationsByTag(tagId, sinceMinutes)
    const candidates = tagged.filter((c) => (c.subject || '').includes(config.front_subject_contains))
    if (candidates.length) return { candidates, usedTag: true, usedInbox: false }
  }

  const candidates = await searchRecentScorecardConversations(config.front_subject_contains, sinceMinutes)
  return { candidates, usedTag: false, usedInbox: false }
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
// unconditionally. PRIMARY path is dynamic: look up the channel that
// actually belongs to the conversation's own inbox(es) — see 2026-08-24
// FIXED note in file header. Falls back to FRONT_CHANNEL_ID env override,
// then the static WAREHOUSE_MAP, then any available channel.
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
  resolveInboxIdByName, listRecentInboxConversations,
  resolveScorecardTagId, listConversationsByTag, searchRecentScorecardConversations,
  fetchScorecardCandidates, SCORECARD_TAG_NAME,
}
