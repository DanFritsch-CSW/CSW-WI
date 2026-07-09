// TEMPORARY diagnostic function — lists Front channels + IDs for initial setup.
// Delete this file once channel IDs have been captured (see Notion changelog).
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
    const res = await fetch('https://api2.frontapp.com/channels', {
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
    const channels = (data._results || []).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      address: c.address,
      send_as: c.send_as,
      is_private: c.is_private,
    }));

    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: channels.length, channels }, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
