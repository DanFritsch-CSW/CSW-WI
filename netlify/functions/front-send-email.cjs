// Generic Front email sender. Feature-agnostic — takes recipients + content,
// sends via the configured Front channel. No FEFO/Onboarding/etc-specific
// logic here; those live in whatever calls this function.
//
// Sender channel is a hardcoded constant (not an env var) per Dan's call
// 2026-07-08 — expected to change occasionally, easy one-line edit here.
const FRONT_SEND_CHANNEL_ID = 'cha_erzf8'; // CSW Main

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }

  // Shared-secret guard — this endpoint sends real external email through a
  // live Front channel. Without this check, anyone who finds the URL could
  // relay arbitrary mail from CSW Main. Callers must pass this header.
  const expectedSecret = process.env.FRONT_SEND_SECRET;
  if (!expectedSecret) {
    return {
      statusCode: 500,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'FRONT_SEND_SECRET not configured' }),
    };
  }
  if (event.headers['x-csw-internal'] !== expectedSecret) {
    return { statusCode: 403, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
  }

  const token = process.env.FRONT_API_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'FRONT_API_TOKEN not set' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'invalid JSON body' }) };
  }

  const { to, subject, body, text, senderName } = payload;

  if (!Array.isArray(to) || to.length === 0) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"to" must be a non-empty array of email addresses' }) };
  }
  if (!subject || typeof subject !== 'string') {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"subject" is required' }) };
  }
  if (!body || typeof body !== 'string') {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"body" is required (HTML or plain text)' }) };
  }

  try {
    const res = await fetch(`https://api2.frontapp.com/channels/${FRONT_SEND_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        to,
        sender_name: senderName || 'CSW Operations',
        subject,
        body,
        text: text || undefined,
        options: { archive: false },
      }),
    });

    const responseText = await res.text();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ error: 'Front API error', status: res.status, detail: responseText }),
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = { raw: responseText };
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ success: true, front: parsed }),
    };
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
