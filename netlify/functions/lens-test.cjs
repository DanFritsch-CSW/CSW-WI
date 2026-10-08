'use strict'

/**
 * Netlify Function: lens-test
 * Added 2026-10-08. Manual entry point for the Customer Lens, called from the
 * /lens page. Never touches Front: no thread fetch, no comment post.
 *
 *   GET  ?preview=1&accountKey=lakeside&facilityKeys=Eau%20Claire
 *        -> { assembledContext, found }   (exact reference text the model sees)
 *   POST { text, requestText?, accountKey?, facilityKeys?[] }
 *        -> { ok, output, assembledContext, runId, error }
 *
 * See lib/lens-shared.cjs for the design notes.
 */

const { assembleContext, runLensFromText } = require('./lib/lens-shared.cjs')

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function reply(statusCode, obj) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(obj) }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {}
      if (!q.preview) return reply(400, { ok: false, error: 'GET requires preview=1' })
      const facilityKeys = (q.facilityKeys || '').split('|').map((s) => s.trim()).filter(Boolean)
      const ctx = await assembleContext({ accountKey: q.accountKey || null, facilityKeys })
      return reply(200, { ok: true, assembledContext: ctx.text, found: ctx.found })
    }

    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method Not Allowed' })

    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return reply(400, { ok: false, error: 'Invalid JSON' })
    }
    if (!body.text || !String(body.text).trim()) {
      return reply(400, { ok: false, error: 'text is required (paste the email or thread)' })
    }

    const result = await runLensFromText({
      text: String(body.text),
      requestText: body.requestText ? String(body.requestText) : '',
      accountKey: body.accountKey || null,
      facilityKeys: Array.isArray(body.facilityKeys) ? body.facilityKeys : [],
    })
    return reply(200, result)
  } catch (e) {
    console.error('[lens-test] error:', e.message)
    return reply(200, { ok: false, error: e.message })
  }
}
