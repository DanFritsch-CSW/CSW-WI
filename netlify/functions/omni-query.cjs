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

const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 1500

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runOmniQuery(query, apiKey) {
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)

    const omniRes = await fetch('https://csw.omniapp.co/api/v1/query/run', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })

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

    if (completeJob) return { ok: true, job: completeJob }
    if (!timedOut) return { ok: false, raw: text.slice(0, 500) }
    if (attempt === RETRY_ATTEMPTS) return { ok: false, raw: text.slice(0, 500), timedOut: true }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  const API_KEY = process.env.OMNI_API_KEY
  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'OMNI_API_KEY not configured' }),
    }
  }

  let query
  try {
    ;({ query } = JSON.parse(event.body))
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    }
  }

  const result = await runOmniQuery(query, API_KEY)

  if (!result.ok) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Omni query did not complete', raw: result.raw }),
    }
  }

  const { tableFromIPC } = await import('apache-arrow')
  const buf = Buffer.from(result.job.result, 'base64')
  const table = tableFromIPC(buf)
  const rows = arrowToRows(table)

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  }
}
