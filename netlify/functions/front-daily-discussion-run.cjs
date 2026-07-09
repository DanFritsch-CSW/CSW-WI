// Daily Front discussion creator — per-facility automated check-in threads.
// Added 2026-07-09 per Dean/Dan (Front check-in thread request, Slack
// 2026-07-09): instead of a dummy "Kenosha Leadership" shared inbox, Front's
// Create Discussion endpoint accepts teammate_ids directly, so this function
// creates a standalone discussion and adds the configured people with no
// inbox needed at all.
//
// Two invocation paths:
//
// 1. SCHEDULED (netlify.toml: schedule = "0 23 * * *", i.e. 23:00 UTC =
//    6pm CDT / 5pm CST — same DST caveat as every other scheduled function
//    in this app, see nightly-b2e-sync.cjs). Netlify sets the header
//    `x-netlify-event: schedule` on genuine cron invocations. On this path,
//    EVERY active row in front_daily_discussion_configs gets a new
//    discussion created for TOMORROW's date. Fires the evening before per
//    Dean's ask ("should be created the previous day though like at 6pm CT").
//
// 2. MANUAL TEST (plain POST with JSON body {"facility": "ken"}, called
//    directly from the Settings > Daily Discussions "Create Now" button).
//    Deliberately left OPEN — no FRONT_SEND_SECRET header required, unlike
//    front-post-discussion.cjs. This is safe for the same reason
//    onboarding-complete-task.cjs is safe to leave open: the client can only
//    select WHICH already-configured facility fires, never who gets added
//    or what the message says — both are always resolved server-side from
//    Supabase. Worst-case abuse is someone spamming test discussions for a
//    facility that's already active, not a data or access-control breach.
//
// Subject format: "{display_name} {Weekday} {M/D}" for the target date.
// Comment body:   "Daily {display_name} check-in — {M/D/YYYY}".
//
// Self-contained Front API call rather than proxying through
// front-post-discussion.cjs — same "self-contained port" convention as
// nightly-b2e-sync.cjs, avoids an extra internal HTTP hop and a
// URL/DEPLOY_URL env dependency for a scheduled job.
const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const FRONT_TOKEN = process.env.FRONT_API_TOKEN;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json));
  return json;
}

// "Tomorrow" in US Central time regardless of the function's own runtime TZ
// (Netlify functions run in UTC). Returns a UTC-midnight Date object whose
// Y/M/D fields represent Central-time tomorrow — good enough for a
// date-only subject/comment, not used for any timestamp math.
function tomorrowCentral() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);
  const todayCentral = new Date(Date.UTC(y, m - 1, d));
  todayCentral.setUTCDate(todayCentral.getUTCDate() + 1);
  return todayCentral;
}

function formatSubject(displayName, dateObj) {
  const weekday = WEEKDAYS[dateObj.getUTCDay()];
  return `${displayName} ${weekday} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}`;
}

function formatCommentDate(dateObj) {
  return `${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`;
}

async function createDiscussionForFacility(facility, displayName, targetDate) {
  const recipients = await sbFetch(
    `notification_recipients?list_name=eq.daily_discussion_${facility}&active=eq.true&front_teammate_id=not.is.null&select=front_teammate_id`
  );
  if (!recipients || !recipients.length) {
    return { facility, ok: false, reason: 'no active recipients with a resolved Front teammate_id' };
  }

  const subject = formatSubject(displayName, targetDate);
  const body = `Daily ${displayName} check-in — ${formatCommentDate(targetDate)}`;

  const res = await fetch('https://api2.frontapp.com/conversations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FRONT_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      type: 'discussion',
      teammate_ids: recipients.map((r) => r.front_teammate_id),
      subject,
      comment: { body },
    }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    return { facility, ok: false, reason: 'Front API error', detail: json };
  }
  return { facility, ok: true, subject, conversationId: json.id, recipientCount: recipients.length };
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule';
  const isManualTest = event.httpMethod === 'POST' && !isScheduled;

  if (!isScheduled && !isManualTest) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only (or scheduled invocation)' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Supabase env not configured' }) };
  }
  if (!FRONT_TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'FRONT_API_TOKEN not set' }) };
  }

  let onlyFacility = null;
  if (isManualTest && event.body) {
    try { onlyFacility = JSON.parse(event.body)?.facility || null; } catch { /* ignore malformed body */ }
    if (!onlyFacility) {
      return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"facility" is required for manual test calls' }) };
    }
  }

  try {
    const configs = await sbFetch('front_daily_discussion_configs?active=eq.true&select=facility,display_name');
    const targets = onlyFacility ? configs.filter((c) => c.facility === onlyFacility) : configs;

    if (!targets.length) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: true, results: [], note: onlyFacility ? `facility "${onlyFacility}" is not active` : 'no active facility configs' }),
      };
    }

    const targetDate = tomorrowCentral();
    const results = await Promise.all(
      targets.map((c) => createDiscussionForFacility(c.facility, c.display_name, targetDate))
    );

    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, results }) };
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
