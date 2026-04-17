import { tableFromIPC } from 'apache-arrow'

const OMNI_BASE = 'https://csw.omniapp.co'

function arrowToRows(table) {
  const rows = []
  for (let i = 0; i < table.numRows; i++) {
    const row = {}
    for (const field of table.schema.fields) {
      const col = table.getChild(field.name)
      let val = col.get(i)
      if (typeof val === 'bigint') val = Number(val)
      row[field.name] = val
    }
    rows.push(row)
  }
  return rows
}

export const handler = async (event) => {
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

  const omniRes = await fetch(`${OMNI_BASE}/api/v1/query/run`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })

  const text = await omniRes.text()
  let completeJob
  for (const line of text.trim().split('\n')) {
    try {
      const parsed = JSON.parse(line)
      if (parsed.status === 'COMPLETE') { completeJob = parsed; break }
    } catch { /* skip malformed lines */ }
  }

  if (!completeJob) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Omni query did not complete', raw: text.slice(0, 500) }),
    }
  }

  const buf = Buffer.from(completeJob.result, 'base64')
  const table = tableFromIPC(buf)
  const rows = arrowToRows(table)

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  }
}
