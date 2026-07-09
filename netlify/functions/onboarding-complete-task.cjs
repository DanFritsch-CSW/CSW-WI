// Onboarding-specific task completion handler. Called directly by the
// browser (OnboardingTab.jsx) — deliberately does NOT require the
// FRONT_SEND_SECRET header that front-send-email.cjs / front-post-discussion.cjs
// use, because putting that secret in client-side React code would expose it
// in the page source. Safe to leave open: given a taskId that actually exists
// in Supabase, this can only (a) mark that task done, (b) comment into the
// customer's own Front conversation, and (c) reassign that conversation.
//
// OPTION A BEHAVIOR (2026-07-09, per Dan) — replaces the original "always
// create a new standalone discussion" approach. Dan pointed out that
// completing a task was spawning a fresh cnv_ each time instead of staying
// in the customer's original Front thread (cnv_1bud7sus for the Test
// customer) — confusing, and not what he expected from "single source of
// truth" onboarding.
//
// New flow when customer.source_conversation_id IS set:
//   1. Mark the completed task done.
//   2. Find the next pending task.
//   3. POST a plain-text comment into the ORIGINAL conversation summarizing
//      the handoff (Add Comment endpoint — no @mention field exists on this
//      endpoint per Front's docs, confirmed 2026-07-09, so this is a log
//      entry, not itself the notification).
//   4. If the next task has a resolved owner_teammate_id, REASSIGN the
//      original conversation to that teammate (PUT .../assignee) — this is
//      what actually puts it in their queue, replacing the @mention.
//   5. If no owner_teammate_id, still comment (so the log is complete) but
//      skip reassignment and say why.
//
// Fallback when customer.source_conversation_id is NOT set: nothing to
// attach a comment to, so this falls back to the original standalone-
// discussion-with-mention behavior (Create Discussion endpoint,
// teammate_ids field) — the only case where a new cnv_ is still created.
//
// Required Front scopes: comments:write (Add Comment), plus whatever scope
// covers the assignee endpoint (appears to fall under conversations:write —
// same scope already used for the discussion fallback; verify if a 403
// shows up).
//
// One-way push only, per the original design constraint: never reads Front
// state back into Supabase.
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

async function frontFetch(path, opts = {}) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${FRONT_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
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

    const customerRows = await sbFetch(`onboarding_customers?id=eq.${task.customer_id}&select=name,source_conversation_id`);
    const customer = customerRows?.[0];
    const customerName = customer?.name || `customer #${task.customer_id}`;
    const sourceConvId = customer?.source_conversation_id || null;

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

    if (!FRONT_TOKEN) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: true, completed: taskId, notified: false, reason: 'FRONT_API_TOKEN not configured' }),
      };
    }

    const commentBody = `"${task.label}" (${task.bucket}) is complete for ${customerName}. Next up: "${nextTask.label}" (${nextTask.bucket}), assigned to ${nextTask.owner_name || 'unassigned'}.`;

    // ─── Path A: customer has a source Front conversation — comment there
    // and reassign it to the next owner. No new conversation is created. ───
    if (sourceConvId) {
      const commentRes = await frontFetch(`/conversations/${sourceConvId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: commentBody }),
      });

      if (!commentRes.ok) {
        return {
          statusCode: 200,
          headers: NO_CACHE_HEADERS,
          body: JSON.stringify({ success: true, completed: taskId, notified: false, reason: 'Front comment API error', detail: commentRes.json }),
        };
      }

      if (!nextTask.owner_teammate_id) {
        return {
          statusCode: 200,
          headers: NO_CACHE_HEADERS,
          body: JSON.stringify({
            success: true, completed: taskId, notified: false,
            reason: `logged in ${sourceConvId}, but next task owner (${nextTask.owner_name || 'unassigned'}) has no confirmed Front teammate — conversation not reassigned`,
            nextTask: { id: nextTask.id, label: nextTask.label, bucket: nextTask.bucket },
          }),
        };
      }

      const assignRes = await frontFetch(`/conversations/${sourceConvId}/assignee`, {
        method: 'PUT',
        body: JSON.stringify({ assignee_id: nextTask.owner_teammate_id }),
      });

      if (!assignRes.ok) {
        return {
          statusCode: 200,
          headers: NO_CACHE_HEADERS,
          body: JSON.stringify({
            success: true, completed: taskId, notified: false,
            reason: 'comment logged, but reassigning the conversation failed',
            detail: assignRes.json,
            nextTask: { id: nextTask.id, label: nextTask.label, bucket: nextTask.bucket, owner: nextTask.owner_name },
          }),
        };
      }

      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({
          success: true, completed: taskId, notified: true,
          nextTask: { id: nextTask.id, label: nextTask.label, bucket: nextTask.bucket, owner: nextTask.owner_name },
          frontConversationId: sourceConvId,
          mode: 'comment+reassign',
        }),
      };
    }

    // ─── Path B: no source conversation — fall back to the original
    // standalone-discussion-with-mention behavior. Only place a new cnv_
    // still gets created. ───
    if (!nextTask.owner_teammate_id) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({
          success: true, completed: taskId, notified: false,
          reason: `no source conversation on this customer, and next task owner (${nextTask.owner_name || 'unassigned'}) has no confirmed Front teammate_id`,
          nextTask: { id: nextTask.id, label: nextTask.label, bucket: nextTask.bucket },
        }),
      };
    }

    const discussionRes = await frontFetch('/conversations', {
      method: 'POST',
      body: JSON.stringify({
        type: 'discussion',
        teammate_ids: [nextTask.owner_teammate_id],
        subject: `Onboarding handoff — ${customerName}`,
        comment: { body: commentBody },
      }),
    });

    if (!discussionRes.ok) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ success: true, completed: taskId, notified: false, reason: 'Front API error', detail: discussionRes.json }),
      };
    }

    if (discussionRes.json?.id) {
      await sbFetch(`onboarding_task_instances?id=eq.${nextTask.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ front_conversation_id: discussionRes.json.id }),
      });
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        success: true, completed: taskId, notified: true,
        nextTask: { id: nextTask.id, label: nextTask.label, bucket: nextTask.bucket, owner: nextTask.owner_name },
        frontConversationId: discussionRes.json?.id || null,
        mode: 'new-discussion-fallback',
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
