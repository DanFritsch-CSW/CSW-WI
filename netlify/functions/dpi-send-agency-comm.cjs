'use strict'

// A4/A10 -- sends one real Agency Comms email per agency, as a Front
// DRAFT (never auto-sent, per this app's standing rule for anything
// customer-facing). Creates a brand-new conversation draft via Front's
// POST /channels/{channel_id}/drafts endpoint -- same pattern as
// dpi-send-carrier-final.cjs (A15), but a plain text/HTML body with no
// attachment, and sent from a single shared channel rather than a
// per-facility one.
//
// Channel: cha_ew1g4, the real "dpiorders@csw-wi.com" / "DPI Orders"
// inbox -- confirmed live via Front's list_channels, matching the sender
// identity shown in a real past DPI agency comms email Dan shared. One
// channel for BOTH facilities (unlike the carrier-send channels in
// dpi-send-carrier-final.cjs, which are split MAD/EC) -- Jen manages DPI
// comms for both facilities from this one shared inbox.
//
// Recipients: per Jen (JW<>DF DPI Monthly Build call), an agency's email
// should go to ALL THREE of its Primary, Delivery, and Alternate contact
// emails (whichever are populated) -- not just one. Deduplicated so the
// same address never appears twice if, say, Primary and Alternate happen
// to be the same person (a real, common case -- confirmed against the
// actual contact spreadsheet).
//
// Body: plain HTML with the delivery day/time BOLDED, matching a real
// reference email Dan shared (bold rather than the original's yellow
// highlight -- plain-text email highlighting isn't reliably supported
// across clients, bold is). Subject format confirmed explicitly by Dan:
// "{Month} {Year} Delivery - {agency number} {agency name}" -- the
// agency number stays in, even though Jen said she disliked it in an
// earlier, differently-built version; Dan's call on the final format.
//
// POST body: { agencyNumber, agencyName, city, facility, monthKey,
//   deliveryDateStr, deliverDayLabel, windowStr, carrierName,
//   recipientEmails: [...] }

const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const DPI_ORDERS_CHANNEL_ID = 'cha_ew1g4' // dpiorders@csw-wi.com / "DPI Orders" inbox -- shared by both facilities

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

  const {
    agencyNumber, agencyName, facility, monthKey,
    deliverDayLabel, windowStr, carrierName, recipientEmails,
  } = body

  if (!agencyNumber || !facility || !Array.isArray(recipientEmails) || recipientEmails.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'agencyNumber, facility, and at least one recipient email are all required' }),
    }
  }

  // Deduplicate case-insensitively -- Primary/Delivery/Alternate contacts
  // are frequently the same person at smaller agencies (confirmed against
  // the real contact spreadsheet).
  const uniqueRecipients = [...new Map(recipientEmails.filter(Boolean).map((e) => [e.toLowerCase(), e])).values()]
  if (uniqueRecipients.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No valid recipient emails after dedup' }) }
  }

  const [year, month] = (monthKey || '').split('-').map(Number)
  const monthName = year && month
    ? new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
    : ''
  const subject = `${monthName} ${year || ''} Delivery - ${agencyNumber} ${agencyName || ''}`.replace(/\s+/g, ' ').trim()

  const scheduleLine = deliverDayLabel && windowStr
    ? `<b>${deliverDayLabel}, ${windowStr}</b>`
    : '<i>(schedule not yet finalized)</i>'

  const bodyHtml = `
    <p>Hello,</p>
    <p>The upcoming Department of Public Instruction (DPI) delivery date will be</p>
    <p>${scheduleLine}</p>
    ${carrierName ? `<p><b>${carrierName}</b> will be responsible for finalizing transportation details.</p>` : ''}
    <p>Warm regards,<br>CSW-${facility}</p>
  `.trim()

  try {
    const form = new FormData()
    for (const addr of uniqueRecipients) form.append('to[]', addr)
    form.append('subject', subject)
    form.append('body', bodyHtml)
    form.append('mode', 'shared')

    const res = await fetch(`https://api2.frontapp.com/channels/${DPI_ORDERS_CHANNEL_ID}/drafts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FRONT_API_KEY}` }, // Content-Type set automatically for FormData (includes boundary)
      body: form,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { statusCode: 502, body: JSON.stringify({ error: `Front drafts API returned ${res.status}: ${text.slice(0, 500)}` }) }
    }

    const data = await res.json()
    return { statusCode: 200, body: JSON.stringify({ success: true, draftId: data.id || null, recipients: uniqueRecipients }) }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
