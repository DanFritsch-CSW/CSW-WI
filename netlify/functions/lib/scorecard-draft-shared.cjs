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
// NOT YET DONE / KNOWN GAPS (see Notion Pending Issues):
// - No live Front webhook or tag-based trigger exists yet. Hill's ask was to
//   scope this via a "customer scorecard" Front tag + rule action, but no
//   such tag exists in the workspace as of 2026-08-06, and rule-editing
//   isn't available through this session's tools — Dan needs to add the tag
//   action to the existing "Scorecard Template" rule (rul_7kwwk) in Front's
//   own rule builder. Until then, scorecard-draft-run.cjs falls back to a
//   Front conversation SEARCH by subject string + recency, which is a real
//   but weaker filter than a tag.
// - Omni dashboard document-state read (drift-proofing) not implemented —
//   only the dashboard_id pointer is stored.
// - ANTHROPIC_API_KEY must be added to Netlify env vars — first LLM call in
//   this app. Nothing in this file will succeed until that's set.
// - End-to-end (real Front draft landing correctly, reply-all resolution,
//   Claude output quality) NOT yet verified live — run
//   scorecard-draft-test.cjs against a real past Bernatello's conversation
//   before trusting this for an upcoming real send.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

const CLAUDE_MODEL = 'claude-sonnet-4-5'

// Keyword flags Dan asked for (2026-08-05 Front feedback thread) — lines in
// recent thread context containing these are surfaced to Claude as explicit
// "don't bury this" signals rather than left to be found (or missed) inside
// a big raw text dump.
const CONTEXT_KEYWORDS = ['urgent', 'hold', 'escalat', 'complaint', 'asap', 'immediately']

// How far back to pull Front thread context for "ops context" per the
// 2026-08-05 decision (numbers + last week's thread, not numbers alone).
const THREAD_CONTEXT_DAYS = 7

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

// Creates a Front DRAFT reply on the conversation. Deliberately omits
// channel_id — Front's drafts endpoint falls back to the conversation's own
// default channel for a reply (channel_id is only required when starting a
// brand-new outbound conversation). NEVER calls Front's send-message
// endpoint — see file header.
async function createScorecardDraft(conversationId, bodyText) {
  const { to, cc } = await getReplyAllRecipients(conversationId)
  const payload = { body: toHtml(bodyText), mode: 'shared', type: 'replyAll' }
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
    draftResult = await createScorecardDraft(conversationId, draftBody)
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

// Searches Front for candidate conversations by subject string, for the
// scheduled runner's fallback path (no "customer scorecard" tag exists yet —
// see file header). Returns conversations updated in the last `sinceMinutes`.
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

module.exports = {
  fetchCustomerConfig, runForConversation, searchRecentScorecardConversations,
}
