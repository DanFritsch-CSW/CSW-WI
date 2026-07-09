// TEMPORARY diagnostic function — lists Front teammates + IDs, needed to
// @mention people in discussions (Front requires teammate_id, not name/email).
// Delete this file once teammate IDs have been captured.
exports.handler = async function () {
  const token = process.env.FRONT_API_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'FRONT_API_TOKEN not set in Netlify env' }),
    };
  }

  try {
    const res = await fetch('https://api2.frontapp.com/teammates', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    const text = await res.text();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
        body: text,
      };
    }

    const data = JSON.parse(text);
    const teammates = (data._results || []).map((t) => ({
      id: t.id,
      email: t.email,
      username: t.username,
      first_name: t.first_name,
      last_name: t.last_name,
      is_admin: t.is_admin,
      is_available: t.is_available,
      is_blocked: t.is_blocked,
    }));

    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: teammates.length, teammates }, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
