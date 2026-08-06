'use strict'

// Scheduled tick for the Scorecard Draft Creator — Bernatello's pilot only.
// Same split-function pattern as every other digest in this app (Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` —
// see lib/fefo-digest-shared.cjs's header for the full story): this file is
// scheduled-tick-ONLY, scorecard-draft-test.cjs is the manual-test sibling.
//
// DETECTION (updated 2026-08-06, later same day): now tries the
// "qbr_case_study" Front tag FIRST via lib/scorecard-draft-shared.cjs's
// fetchScorecardCandidates() — resolved by tag NAME each run, not a
// hardcoded ID, since Dan may still be setting the tag/rule action up.
// Falls back to the older subject-string Front search automatically if the
// tag can't be resolved yet. Each result below reports which path fired
// (usedTag: true/false) so it's visible in the run's own output whether the
// tag is live yet.

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
      const { candidates, usedTag } = await fetchScorecardCandidates(config, 20)
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
