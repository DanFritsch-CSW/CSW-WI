// Employee Onboarding HR handoff. Called directly by the browser
// (EmployeeOnboarding.jsx "Notify HR" button) — deliberately does NOT
// require the FRONT_SEND_SECRET header that front-send-email.cjs /
// front-post-discussion.cjs use, same rationale as onboarding-complete-task.cjs:
// putting that secret in client-side React code would expose it in the page
// source, and this function is bounded to safe actions given a real
// onboardingId (comment into ONE pre-configured Front conversation, patch
// ONE Supabase row's hr_notified_at).
//
// Built 2026-07-18 per Tim's original request (2026-07-15 Slack thread):
// "when at the end of onboarding the contents that was all inputted for an
// individual — we can press a button that will message HR and they will
// have the ability to print a PDF of this entire onboarding document."
//
// Design: rather than generating a PDF server-side (heavier, another
// dependency), this posts a Front comment with a link to the app's own
// print view (?view=print&employee=<id>), which HR opens and uses the
// browser's native print-to-PDF. Matches the existing print-CSS pattern
// used elsewhere in the app (Inventory count sheet, WR digests).
//
// Target conversation comes from eo_hr_settings.front_conversation_id (set
// once by Dan via the Template Editor's HR Settings block). If unset or
// notify_enabled is false, returns success:false with a clear reason so the
// UI can tell the user HR notify isn't configured yet, rather than failing
// silently or throwing.
const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const FRONT_TOKEN = process.env.FRONT_API_TOKEN;

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json));
  return json;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Supabase env not configured' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'invalid JSON body' }) };
  }
  const { onboardingId, printUrl } = payload;
  if (!onboardingId) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"onboardingId" is required' }) };
  }

  try {
    const settingsRows = await sbFetch('eo_hr_settings?id=eq.1&select=*');
    const settings = settingsRows?.[0];

    if (!settings?.notify_enabled || !settings?.front_conversation_id) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: false, reason: 'HR notify not configured — set a Front conversation ID and enable it in Template Editor > HR Settings' }),
      };
    }
    if (!FRONT_TOKEN) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: false, reason: 'FRONT_API_TOKEN not configured' }),
      };
    }

    const employeeRows = await sbFetch(`employee_onboarding?id=eq.${onboardingId}&select=*`);
    const employee = employeeRows?.[0];
    if (!employee) {
      return { statusCode: 404, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'employee not found' }) };
    }

    const commentBody = [
      `Employee Onboarding complete: ${employee.employee_name}`,
      employee.facility ? `Facility: ${employee.facility.toUpperCase()}` : null,
      employee.trainer_name ? `Trainer: ${employee.trainer_name}` : null,
      employee.start_date ? `Start date: ${employee.start_date}` : null,
      '',
      'Full record (open and print/save as PDF for the personnel file):',
      printUrl || '(print link not provided)',
    ].filter(Boolean).join('\n');

    const commentRes = await fetch(`https://api2.frontapp.com/conversations/${settings.front_conversation_id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FRONT_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ body: commentBody }),
    });
    const commentText = await commentRes.text();

    if (!commentRes.ok) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: false, reason: 'Front comment API error', detail: commentText }),
      };
    }

    await sbFetch(`employee_onboarding?id=eq.${onboardingId}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ hr_notified_at: new Date().toISOString() }),
    });

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ success: true, notified: true, frontConversationId: settings.front_conversation_id }),
    };
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
