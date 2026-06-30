'use strict'

function arrowToRows(table) {
  const rows = []
  for (let i = 0; i < table.numRows; i++) {
    const row = {}
    for (const field of table.schema.fields) {
      const col = table.getChild(field.name)
      let val = col.get(i)
      if (typeof val === 'bigint') val = Number(val)
      if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1)
      }
      row[field.name] = val
    }
    rows.push(row)
  }
  return rows
}

// Server-side retry policy. Catches sub-second Omni hiccups before they
// bubble to the client (which has its own persistent retry layered on top
// — see fetchWithPersistentRetry in FacilityPanel.jsx).
const RETRY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 500
const RETRY_JITTER_MS     = 500

// Jittered delay between server retries. Without jitter the ALL tab's
// ~15-query fan-out has every concurrent query retry at the exact same
// instant — they then pile onto Omni simultaneously on retry too, which
// just reproduces the original failure. Jittering by 0-500ms spreads the
// retry burst across a 500ms window so each retry hits Omni separately.
function jitteredRetryDelay() {
  return RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS)
}

// Tell Omni: "work on this query for up to 20 seconds before giving up."
// Omni's API default is shorter — explicitly setting this means many queries
// that currently fail-and-retry will now succeed on the first attempt.
const OMNI_QUERY_TIMEOUT_SEC = 20

// Hard ceiling — stop attempting new retries this many ms before the Netlify
// function timeout fires. Netlify kills the process at the timeout boundary and
// returns an empty response (raw: "") to the client. Bailing out a few seconds
// early lets us return a structured 502 with a useful error message instead.
const FUNCTION_TIMEOUT_MS = 26000
const SAFETY_MARGIN_MS    = 3500
const HARD_DEADLINE_MS    = FUNCTION_TIMEOUT_MS - SAFETY_MARGIN_MS

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runOmniQuery(query, apiKey, startTime) {
  // Inject per-query Omni-side timeout so Omni waits longer before bailing.
  // Omni accepts `timeout` as a top-level field on the query body in seconds.
  const queryWithTimeout = { ...query, timeout: OMNI_QUERY_TIMEOUT_SEC }

  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(jitteredRetryDelay())

    // Bail out if we're about to hit the Netlify function timeout. Better to
    // return a structured 502 than to let the process get killed mid-stream.
    const elapsed = Date.now() - startTime
    if (elapsed >= HARD_DEADLINE_MS) {
      return {
        ok: false,
        raw: '',
        timedOut: true,
        reason: 'netlify_function_deadline',
        elapsed,
        attempts: attempt,
      }
    }

    let omniRes
    try {
      omniRes = await fetch('https://csw.omniapp.co/api/v1/query/run', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: queryWithTimeout }),
      })
    } catch (e) {
      // Network error reaching Omni — retry if attempts remain.
      if (attempt === RETRY_ATTEMPTS) {
        return { ok: false, raw: `network error: ${e.message}`, timedOut: false }
      }
      continue
    }

    const text = await omniRes.text()
    let completeJob = null
    let timedOut = false

    for (const line of text.trim().split('\n')) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.status === 'COMPLETE') { completeJob = parsed; break }
        if (parsed.timed_out === true) timedOut = true
      } catch { /* skip malformed lines */ }
    }

    if (completeJob) return { ok: true, job: completeJob, attempts: attempt + 1 }
    if (!timedOut) return { ok: false, raw: text.slice(0, 500) }
    if (attempt === RETRY_ATTEMPTS) {
      return { ok: false, raw: text.slice(0, 500), timedOut: true, attempts: attempt + 1 }
    }
  }
}

exports.handler = async (event) => {
  const startTime = Date.now()

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const API_KEY = process.env.OMNI_API_KEY
  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'OMNI_API_KEY not configured' }),
    }
  }

  let query
  try {
    ;({ query } = JSON.parse(event.body))
  } catch {
    return {
      statusCode: 400,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    }
  }

  const result = await runOmniQuery(query, API_KEY, startTime)

  if (!result.ok) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: 'Omni query did not complete',
        raw: result.raw,
        timedOut: result.timedOut === true,
        reason: result.reason ?? null,
        elapsedMs: Date.now() - startTime,
        attempts: result.attempts ?? null,
      }),
    }
  }

  const { tableFromIPC } = await import('apache-arrow')
  const buf = Buffer.from(result.job.result, 'base64')
  const table = tableFromIPC(buf)
  const rows = arrowToRows(table)

  return {
    statusCode: 200,
    headers: NO_CACHE_HEADERS,
    body: JSON.stringify({ rows }),
  }
}
