'use strict'

// A15 -- sends the finalized DPI Monthly route sheet PDF to the facility's
// carrier as a Front DRAFT (never auto-sent -- per this app's standing
// rule, every carrier/customer-facing send requires human review before
// going out). Creates a brand-new conversation draft via Front's
// POST /channels/{channel_id}/drafts endpoint -- "the first message of a
// new conversation" (dev.frontapp.com/reference/create-draft), which is a
// DIFFERENT endpoint from the one front-draft-shared.cjs already uses
// (POST /conversations/{id}/drafts, a REPLY to an existing conversation).
// That existing helper doesn't apply here: there's no pre-existing Front
// conversation this attaches to, and it has no attachment support at all,
// which this needs.
//
// Attachments MUST be sent as multipart/form-data per Front's own docs --
// JSON does not support them. Built here with the native FormData/Blob
// globals (available in Netlify's Node 18+ runtime) rather than adding a
// form-data dependency.
//
// POST body: { facility, monthKey, recipientEmail, pdfBase64 }

const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''

// One outbound channel per facility -- reuses the SAME channel IDs already
// established in front-draft-shared.cjs's WAREHOUSE_MAP for the Scheduling
// plugin's own reply drafts (MAD Appointments / EC Appointments). No
// separate DPI-only channel exists yet; these are the right identity to
// send from until/unless a dedicated one is set up.
const FACILITY_CHANNELS = {
  Madison: 'cha_ema8k',
  'Eau Claire': 'cha_eubx0',
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) }
  }
  if (!FRONT_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FRONT_API_TOKEN not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const { facility, monthKey, recipientEmail, pdfBase64 } = body
  if (!facility || !recipientEmail || !pdfBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'facility, recipientEmail, and pdfBase64 are all required' }) }
  }

  const channelId = FACILITY_CHANNELS[facility]
  if (!channelId) {
    return { statusCode: 400, body: JSON.stringify({ error: `No Front channel configured for facility "${facility}"` }) }
  }

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64')
    const filename = `DPI-${facility.replace(/\s+/g, '')}-${monthKey || ''}-carrier-routes.pdf`

    // multipart/form-data is REQUIRED for attachments (Front's own docs) --
    // the native FormData/Blob globals build this correctly, including the
    // multipart boundary in the Content-Type header fetch sets
    // automatically; do not set Content-Type manually here.
    const form = new FormData()
    form.append('to[]', recipientEmail)
    form.append('subject', `DPI ${facility} Route Sheet — ${monthKey || ''}`)
    form.append(
      'body',
      `Attached is the final route sheet for ${facility}'s DPI deliveries, ${monthKey || ''}. Please confirm receipt and let us know if anything looks off.`
    )
    form.append('mode', 'shared') // visible to all teammates with access, not just the author
    form.append('attachments', new Blob([pdfBuffer], { type: 'application/pdf' }), filename)

    const res = await fetch(`https://api2.frontapp.com/channels/${channelId}/drafts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FRONT_API_KEY}` }, // Content-Type set automatically for FormData (includes boundary)
      body: form,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { statusCode: 502, body: JSON.stringify({ error: `Front drafts API returned ${res.status}: ${text.slice(0, 500)}` }) }
    }

    const data = await res.json()
    return { statusCode: 200, body: JSON.stringify({ success: true, draftId: data.id || null }) }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
