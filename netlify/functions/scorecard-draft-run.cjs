'use strict'

// Scheduled tick for the Scorecard Draft Creator — Bernatello's pilot only.
// Same split-function pattern as every other digest in this app (Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` —
// see lib/fefo-digest-shared.cjs's header for the full story): this file is
// scheduled-tick-ONLY, scorecard-draft-test.cjs is the manual-test sibling.
//
// DETECTION (updated 2026-08-06, later same day): now tries the
// "QBR - Case Study" Front tag FIRST via lib/scorecard-draft-shared.cjs's
// fetchScorecardCandidates() — resolved by tag NAME each run, not a
// hardcoded ID, since Dan may still be setting the tag/rule action up.
// Falls back to the older subject-string Front search automatically if the
// tag can't be resolved yet (or resolves but finds nothing tagged — see
// that file's 2026-08-07 fix). Each result below reports which path fired
// (usedTag: true/false) so it's visible in the run's own output whether the
// tag is live yet.
//
// FIXED 2026-08-24: candidate window widened from 20 MINUTES to 7 DAYS.
// Real bug found investigating why Grassland's cnv_1c7uwyfo never drafted:
// the 20-minute window meant that if a scheduled tick ever missed catching
// a conversation within 20 minutes of it landing (a deploy in progress, a
// transient error, literally any reason), it would NEVER be retried —
// silently, forever, no log entry, nothing. This is safe to widen freely
// because runForConversation() already dedupes via scorecard_draft_log
// (alreadyDrafted() checks customer_key + front_conversation_id before
// doing any work) — a wider window can only mean "catch things the
// previous ticks missed," never "draft the same email twice."
const CANDIDATE_WINDOW_MINUTES = 60 * 24 * 7 // 7 days

const { runForConversation, fetchScorecardCandidates } = require('./lib/scorecard-draft-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY

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

exports.handler = async () => {
  const NO_CACHE_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' }
  const results = []

  let configs
  try {
    configs = await sbFetch('customer_scorecard_config?active=eq.true&select=*')
  } catch (e) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Failed to load customer_scorecard_config: ${e.message}` }) }
  }

  for (const config of configs || []) {
    try {
      const { candidates, usedTag } = await fetchScorecardCandidates(config, CANDIDATE_WINDOW_MINUTES)
      for (const cnv of candidates) {
        const r = await runForConversation({ customerKey: config.customer_key, conversationId: cnv.id, isManualTest: false })
        results.push({ ...r, usedTag })
      }
    } catch (e) {
      results.push({ ok: false, customerKey: config.customer_key, reason: e.message })
    }
  }

  return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ results, ranAt: new Date().toISOString() }) }
}
