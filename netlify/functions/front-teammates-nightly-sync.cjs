// Scheduled nightly sync of Front teammates into Supabase (front_teammates).
// Added 2026-07-09 per Dan: as people join/leave/change roles, the @username
// picker in Customer Onboarding needs to stay current without a manual
// re-pull-and-reseed cycle every time.
//
// Runs nightly, same pattern as nightly-b2e-sync — schedule set in
// netlify.toml. Pulls GET /teammates from Front, upserts every row into
// front_teammates by teammate_id.
//
// Deliberately UPSERT-ONLY, no delete. If someone leaves CSW and their Front
// seat is removed, their row just stays in front_teammates (stale but
// harmless — picking them for a new task would only fail at @mention/
// reassign time, not silently corrupt anything). Matches the app's existing
// posture elsewhere (purgeTerminatedAcrossFuture etc.) of not deleting on
// ambiguous signals. A manual cleanup pass can prune stale rows later if it
// ever matters.
const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const FRONT_TOKEN = process.env.FRONT_API_TOKEN;

exports.handler = async function () {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Supabase env not configured' }) };
  }
  if (!FRONT_TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'FRONT_API_TOKEN not set' }) };
  }

  try {
    const frontRes = await fetch('https://api2.frontapp.com/teammates', {
      headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
    });
    const frontText = await frontRes.text();
    if (!frontRes.ok) {
      return { statusCode: frontRes.status, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Front API error', detail: frontText }) };
    }
    const frontData = JSON.parse(frontText);
    const teammates = frontData._results || [];

    if (!teammates.length) {
      return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, synced: 0, note: 'Front returned zero teammates — no-op, not treated as a delete signal' }) };
    }

    const rows = teammates.map((t) => ({
      teammate_id: t.id,
      email: t.email || null,
      username: t.username || null,
      first_name: t.first_name || null,
      last_name: t.last_name || null,
      synced_at: new Date().toISOString(),
    }));

    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/front_teammates?on_conflict=teammate_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (!upsertRes.ok) {
      const detail = await upsertRes.text();
      return { statusCode: upsertRes.status, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Supabase upsert error', detail }) };
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ success: true, synced: rows.length }),
    };
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
