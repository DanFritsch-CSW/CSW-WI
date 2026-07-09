// Onboarding-specific task completion handler. Called directly by the
// browser (OnboardingTab.jsx) — deliberately does NOT require the
// FRONT_SEND_SECRET header that front-send-email.cjs / front-post-discussion.cjs
// use, because putting that secret in client-side React code would expose it
// in the page source, defeating the whole point of the guard on those generic
// functions. This endpoint is safe to leave open because its scope is fixed:
// given a taskId that actually exists in Supabase, it can only (a) mark that
// task done and (b) notify the next pending task's owner. It can't be used to
// send arbitrary email or messages to arbitrary people.
//
// Flow:
//   1. Look up the task instance + its customer.
//   2. Mark it done (status='done', completed_at=now).
//   3. Find the next pending task for this customer (by sort_order).
//   4. If found AND it has a resolved owner_teammate_id, POST a new Front
//      discussion @-adding that owner, with the task instance's
//      front_conversation_id updated to the new conversation.
//   5. If the next task has no owner_teammate_id (Tony/Kris case as of
//      2026-07-08 seed data), skip the Front push and say so in the response
//      — the app still works, just without the handoff notification.
//
// One-way push only, per the original design constraint: this function never
// reads Front state back into Supabase.
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
  const { taskId } = payload;
  if (!taskId) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '"taskId" is required' }) };
  }

  try {
    // 1. Look up the task + customer.
    const taskRows = await sbFetch(`onboarding_task_instances?id=eq.${encodeURIComponent(taskId)}&select=*`);
    const task = taskRows?.[0];
    if (!task) {
      return { statusCode: 404, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'task not found' }) };
    }

    const customerRows = await sbFetch(`onboarding_customers?id=eq.${task.customer_id}&select=name`);
    const customerName = customerRows?.[0]?.name || `customer #${task.customer_id}`;

    // 2. Mark this task done.
    await sbFetch(`onboarding_task_instances?id=eq.${taskId}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ status: 'done', completed_at: new Date().toISOString() }),
    });

    // 3. Find the next pending task for this customer.
    const nextRows = await sbFetch(
      `onboarding_task_instances?customer_id=eq.${task.customer_id}&status=eq.pending&sort_order=gt.${task.sort_order}&order=sort_order.asc&limit=1&select=*`
    );
    const nextTask = nextRows?.[0];

    if (!nextTask) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: true, completed: taskId, notified: false, reason: 'no remaining pending tasks' }),
      };
    }

    if (!nextTask.owner_teammate_id) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({
          success: true, completed: taskId, notified: false,
          reason: `next task owner (${nextTask.owner_name || 'unassigned'}) has no confirmed Front teammate_id`,
          nextTask: { id: nextTask.id, label: nextTask.label, bucket: nextTask.bucket },
        }),
      };
    }

    if (!FRONT_TOKEN) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: true, completed: taskId, notified: false, reason: 'FRONT_API_TOKEN not configured' }),
      };
    }

    // 4. Post the handoff discussion.
    const frontRes = await fetch('https://api2.frontapp.com/conversations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FRONT_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        type: 'discussion',
        teammate_ids: [nextTask.owner_teammate_id],
        subject: `Onboarding handoff — ${customerName}`,
        comment: {
          body: `"${task.label}" (${task.bucket}) is complete for ${customerName}. Next up: "${nextTask.label}" (${nextTask.bucket}), assigned to ${nextTask.owner_name || 'you'}.`,
        },
      }),
    });
    const frontText = await frontRes.text();
    let frontJson;
    try { frontJson = JSON.parse(frontText); } catch { frontJson = { raw: frontText }; }

    if (!frontRes.ok) {
      // Task is still marked done — Front push failing shouldn't roll that back.
      // Surface the error so the UI can show "handoff notification failed."
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: true, completed: taskId, notified: false, reason: 'Front API error', detail: frontJson }),
      };
    }

    // 5. Stash the new conversation ID on the next task instance for reference.
    if (frontJson?.id) {
      await sbFetch(`onboarding_task_instances?id=eq.${nextTask.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ front_conversation_id: frontJson.id }),
      });
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        success: true, completed: taskId, notified: true,
        nextTask: { id: nextTask.id, label: nextTask.label, bucket: nextTask.bucket, owner: nextTask.owner_name },
        frontConversationId: frontJson?.id || null,
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
