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

  // NOTE: no inline @mention markdown is added to the body. An earlier version
  // tried `[](mention:tea_xxxxx)` syntax to force an @mention, but Front's API
  // rejected it with "Comment text contains unsafe markdown" (empty-link-text
  // patterns look like phishing to their sanitizer, and this syntax isn't in
  // Front's public docs anyway — it was a guess). teammate_ids alone already
  // adds these people as participants on the conversation, which is what
  // actually triggers their notification, so the inline mention was redundant.

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
          body,
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
