'use strict'

// Scheduled tick for the Scorecard Draft Creator — Bernatello's pilot only.
// Same split-function pattern as every other digest in this app (Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` —
// see lib/fefo-digest-shared.cjs's header for the full story): this file is
// scheduled-tick-ONLY, scorecard-draft-test.cjs is the manual-test sibling.
//
// FALLBACK DETECTION, NOT THE REAL DESIGN: this loops each active
// customer_scorecard_config row and searches Front by subject string for a
// conversation updated in the last 20 minutes (matches the */15 tick with a
// small buffer). This is a weaker filter than Hill's proposed "customer
// scorecard" Front tag + rule action, which does not exist yet in this
// workspace as of 2026-08-06 — Dan needs to add that tag action to the
// existing "Scorecard Template" rule (rul_7kwwk) in Front's own rule
// builder; rule-editing isn't available through this session's tools.
// Once that tag exists, this should be switched to a tag-filtered search
// instead of a subject-string search.

const { fetchCustomerConfig, runForConversation, searchRecentScorecardConversations } = require('./lib/scorecard-draft-shared.cjs')

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
      const candidates = await searchRecentScorecardConversations(config.front_subject_contains, 20)
      for (const cnv of candidates) {
        const r = await runForConversation({ customerKey: config.customer_key, conversationId: cnv.id, isManualTest: false })
        results.push(r)
      }
    } catch (e) {
      results.push({ ok: false, customerKey: config.customer_key, reason: e.message })
    }
  }

  return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ results, ranAt: new Date().toISOString() }) }
}
