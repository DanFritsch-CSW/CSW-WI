// Generic Front internal-discussion poster. Feature-agnostic — creates a new
// standalone discussion (comment-only conversation, never leaves Front) and
// adds the given teammates to it. No FEFO/Onboarding/etc-specific logic here;
// that lives in whatever calls this function.
//
// Required Front scope: conversations:write (distinct from messages:send used
// by front-send-email.cjs — verify the token has this scope too).
//
// Discussions are internal-only by design (Front's API has no concept of an
// external participant in a discussion) — teammateIds here MUST be Front
// teammate IDs (e.g. "tea_xxxxx"), not emails. For external notifications use
// front-send-email.cjs instead.
//
// Creates a NEW standalone discussion each call, not a reply/comment on an
// existing conversation. If a feature later needs "comment on an existing
// thread," that's Front's Add Comment endpoint (POST /conversations/{id}/comments)
// and should be a separate function rather than overloading this one.
const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }

  // Shared-secret guard — same rationale as front-send-email.cjs.
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

  const { teammateIds, body, subject, authorId } = payload;

  if (!Array.isArray(teammateIds) || teammateIds.length === 0) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"teammateIds" must be a non-empty array of Front teammate IDs (e.g. "tea_xxxxx")' }) };
  }
  if (!subject || typeof subject !== 'string') {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"subject" is required' }) };
  }
  if (!body || typeof body !== 'string') {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"body" is required' }) };
  }

  // Front @mentions use inline syntax in the comment body: [](mention:tea_xxxxx)
  // Adding this on top of teammate_ids ensures an actual @mention notification
  // fires, not just silent addition to the conversation's participant list.
  const mentionPrefix = teammateIds.map((id) => `[](mention:${id})`).join(' ');
  const fullBody = `${mentionPrefix} ${body}`;

  try {
    const res = await fetch('https://api2.frontapp.com/conversations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        type: 'discussion',
        teammate_ids: teammateIds,
        subject,
        comment: {
          body: fullBody,
          author_id: authorId || undefined,
        },
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
