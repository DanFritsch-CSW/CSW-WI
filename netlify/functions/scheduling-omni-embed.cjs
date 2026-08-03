'use strict'

/**
 * Netlify Function: scheduling-omni-embed
 * Ported from front_netlify_datex/functions/omni-embed.js (2026-08-03), no
 * changes needed — no Supabase dependency, pure env-var based URL builder.
 *
 * Returns the Omni workbook URL for the iframe. Without SSO embed access,
 * this returns a direct session-based URL — users must be logged into
 * csw.embed-omniapp.co in the same browser for the iframe to show the
 * dashboard instead of the login page.
 *
 * GET /.netlify/functions/scheduling-omni-embed?warehouse=CSW-Franksville&date=2026-03-28
 * Returns: { url, omniLoginUrl, mode: 'iframe' | 'sso' }
 *
 * Env vars:
 *   OMNI_EMBED_WORKBOOK_ID — workbook ID from the Omni URL
 *   OMNI_WORKBOOK_URL      — override: paste a full workbook URL here
 * If Omni SSO Embed is ever enabled, also set OMNI_EMBED_SECRET,
 * OMNI_FILTER_WAREHOUSE_ID, OMNI_FILTER_DATE_ID.
 */

const crypto = require('crypto')

const OMNI_EMBED_BASE = 'https://csw.embed-omniapp.co'

exports.handler = async (event) => {
  const secret = process.env.OMNI_EMBED_SECRET
  const workbookId = process.env.OMNI_EMBED_WORKBOOK_ID || 'd4d4c5af'

  const omniLoginUrl = `${OMNI_EMBED_BASE}/dashboards/${workbookId}`

  // ── SSO embed path (if OMNI_EMBED_SECRET is ever configured) ─────────────
  if (secret) {
    const { warehouse, date } = event.queryStringParameters || {}

    const loginUrl = `${OMNI_EMBED_BASE}/embed/login`
    const contentPath = `/w/${workbookId}`
    const externalId = 'csw-ops-user'
    const name = 'CSW Ops'
    const nonce = crypto.randomBytes(16).toString('hex')

    const optional = {}
    const filterParts = []

    const whFilterId = process.env.OMNI_FILTER_WAREHOUSE_ID
    const dateFilterId = process.env.OMNI_FILTER_DATE_ID

    if (warehouse && whFilterId) {
      const whValue = warehouse.replace(/^CSW-/i, '').toLowerCase()
      filterParts.push(`${whFilterId}=${encodeURIComponent(JSON.stringify({ values: [whValue] }))}`)
    }
    if (date && dateFilterId) {
      filterParts.push(`${dateFilterId}=${encodeURIComponent(JSON.stringify({ left_side: date, offset_interval_string: '' }))}`)
    }
    if (filterParts.length) {
      optional.filterSearchParam = filterParts.join('&')
    }

    const sortedOptional = Object.keys(optional).sort().map((k) => `${k}=${optional[k]}`)
    const toSign = [loginUrl, contentPath, externalId, name, nonce, ...sortedOptional].join('\n')
    const signature = crypto.createHmac('sha256', secret).update(toSign).digest('base64url')
    const params = new URLSearchParams({ contentPath, externalId, name, nonce, ...optional, signature })

    return {
      statusCode: 200,
      body: JSON.stringify({ url: `${loginUrl}?${params.toString()}`, omniLoginUrl, mode: 'sso' }),
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }
  }

  // ── Direct iframe path (no SSO) ───────────────────────────────────────────
  const baseUrl = process.env.OMNI_WORKBOOK_URL || `${OMNI_EMBED_BASE}/dashboards/${workbookId}`

  const { warehouse, date } = event.queryStringParameters || {}
  const whFilterId = process.env.OMNI_FILTER_WAREHOUSE_ID
  const dateFilterId = process.env.OMNI_FILTER_DATE_ID
  const filterParts = []

  if (warehouse && whFilterId) {
    const whValue = warehouse.replace(/^CSW-/i, '').toLowerCase()
    filterParts.push(`${whFilterId}=${encodeURIComponent(JSON.stringify({ values: [whValue] }))}`)
  }
  if (date && dateFilterId) {
    filterParts.push(`${dateFilterId}=${encodeURIComponent(JSON.stringify({ left_side: date, offset_interval_string: '' }))}`)
  }

  const iframeUrl = filterParts.length ? `${baseUrl}?${filterParts.join('&')}` : baseUrl

  return {
    statusCode: 200,
    body: JSON.stringify({ url: iframeUrl, omniLoginUrl, mode: 'iframe' }),
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  }
}
