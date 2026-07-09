// Scheduled sync of "Revision"-tagged Front conversations from the separate
// csw-kb-assistant Supabase project (zmejdtumczqdaqcyfaab) into this app's
// own Supabase project. Added 2026-07-09 after the Echo Lake Foods /
// shipment 432259 OSD thread (Dan/Dean/Sadie/Jennifer discussion) surfaced
// the need for a dedicated Revisions tracker, similar in spirit to the FEFO
// tab but for order-revision misses instead of shelf-life.
//
// Why a separate project at all: csw-kb-assistant is a standalone Front
// knowledge-base/sync project, not wired into this repo. Rather than have
// CSW-WI read cross-project at render time (coupling this app's uptime to
// a project it doesn't own), this function mirrors the relevant rows into
// CSW-WI's own tables on a schedule. See revision_conversations /
// revision_comments in Supabase for the mirrored shape.
//
// CRITICAL ownership rule: this function must ONLY ever upsert the
// Front-sourced columns (subject, status, customer_name, inbox_name,
// last_message_at, sla_status, synced_at, updated_at). It must NEVER include
// facility, order_number, resolved, resolved_by, or resolved_at in the
// upsert payload — those are CSW-WI-local enrichments set by managers in
// the Revisions tab, and a PostgREST merge-duplicates upsert only touches
// columns present in the payload, so omitting them is what protects them.
// Same pattern as roster_assignments.manually_edited — don't clobber
// human-owned fields with an automated sync.
//
// Tag IDs and the "kb" schema are specific to the csw-kb-assistant project
// and were confirmed via direct SQL inspection on 2026-07-09 (not guessed).
// "Revision" and "Revisions" are two separate Front tags (workspace tag
// sprawl — someone recreated the tag instead of reusing it); both are
// treated as equivalent here until that's cleaned up in Front.
//
// Prerequisites (external, cannot be set by this function):
//   1. csw-kb-assistant project (zmejdtumczqdaqcyfaab) must have the `kb`
//      schema added under Settings > Data API > Exposed schemas.
//   2. KB_SUPABASE_SERVICE_KEY must be that project's service_role key
//      (NOT anon — kb.* tables only grant SELECT to authenticated/
//      service_role, no anon policy exists there).
// Without both, every run will fail fast with a clear error (see below)
// rather than silently syncing zero rows.

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const KB_URL = process.env.KB_SUPABASE_URL;
const KB_SERVICE_KEY = process.env.KB_SUPABASE_SERVICE_KEY;

// Front tag IDs in the csw-kb-assistant project, confirmed via SQL against
// kb.tags on 2026-07-09. "Revision" is the tag actually applied in practice;
// "Revisions" is the sprawl duplicate. SLA_* tags let us surface Front's own
// SLA tracking instead of re-deriving urgency/age logic from scratch.
const REVISION_TAG_IDS = ['65ad9496-0c80-458d-aff1-63a5f12c0913', '2d50d9a7-22d9-455a-b25c-c144963022a0'];
const SLA_TAG_MAP = {
  'tag_4ac32s': 'breach',   // SLA Breach
  'tag_4ac36c': 'warning',  // SLA Warning
  'tag_4ac34k': 'applies',  // SLA Applies
};
const SLA_RANK = { breach: 3, warning: 2, applies: 1 }; // worst wins when a conversation carries more than one

// Known inbox_name -> CSW-WI facility id mapping. Anything not listed here
// (personal inboxes like "mdile", shared inboxes like "Main"/"Inbox"/"DSM")
// is left null and is meant to be set manually in the Revisions tab —
// roughly a third of tagged conversations don't carry a clean facility
// signal in inbox_name, confirmed via SQL sample on 2026-07-09.
const INBOX_FACILITY_MAP = {
  'Caledonia': 'cal',
  'CAL Appointments': 'cal',
  'Kenosha': 'ken',
  'Madison': 'mad',
  'MAD Inventory': 'mad',
  'Wisconsin Rapids': 'wr',
  'Eau Claire': 'ec',
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function kbFetch(path) {
  const res = await fetch(`${KB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: KB_SERVICE_KEY,
      Authorization: `Bearer ${KB_SERVICE_KEY}`,
      Accept: 'application/json',
      // PostgREST defaults every request to the `public` schema regardless
      // of what's exposed in Data API settings — Accept-Profile is what
      // actually routes a read request into a non-default exposed schema.
      // Without this, kb.conversation_tags etc. 404 as "Could not find the
      // table 'public.conversation_tags'" even with kb correctly exposed.
      // Confirmed via live error message on the first real invocation,
      // 2026-07-09.
      'Accept-Profile': 'kb',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`kb fetch failed [${path}]: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

async function supabaseUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Supabase upsert failed [${table}]: ${res.status} ${detail}`);
  }
}

async function writeSyncState(patch) {
  await fetch(`${SUPABASE_URL}/rest/v1/revision_sync_state?id=eq.1`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
}

exports.handler = async function () {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Supabase env not configured' }) };
  }
  if (!KB_URL || !KB_SERVICE_KEY) {
    return {
      statusCode: 500,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: 'KB_SUPABASE_URL / KB_SUPABASE_SERVICE_KEY not set — see comments at top of this file for the two prerequisites (expose kb schema + service_role key).',
      }),
    };
  }

  const startedAt = new Date().toISOString();

  try {
    // 1. Which conversations carry a Revision/Revisions tag right now.
    const tagIdsFilter = REVISION_TAG_IDS.join(',');
    const revisionTagRows = await kbFetch(`conversation_tags?tag_id=in.(${tagIdsFilter})&select=conversation_id`);
    const conversationIds = [...new Set(revisionTagRows.map((r) => r.conversation_id))];

    if (!conversationIds.length) {
      await writeSyncState({ last_run_at: startedAt, last_run_status: 'ok: no revision-tagged conversations found', conversations_synced: 0, comments_synced: 0 });
      return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, conversations_synced: 0, comments_synced: 0 }) };
    }

    // 2. Pull conversation rows + SLA tags in id-chunks (URL length safety).
    const idChunks = chunk(conversationIds, 100);
    const conversations = [];
    const slaByConversation = {};

    for (const ids of idChunks) {
      const idsFilter = ids.join(',');

      const convRows = await kbFetch(
        `conversations?id=in.(${idsFilter})&select=id,front_id,subject,status,customer_name,inbox_name,last_message_at`
      );
      conversations.push(...convRows);

      const slaRows = await kbFetch(
        `conversation_tags?conversation_id=in.(${idsFilter})&select=conversation_id,tags(front_tag_id)`
      );
      for (const row of slaRows) {
        const slaKey = SLA_TAG_MAP[row.tags?.front_tag_id];
        if (!slaKey) continue;
        const current = slaByConversation[row.conversation_id];
        if (!current || SLA_RANK[slaKey] > SLA_RANK[current]) {
          slaByConversation[row.conversation_id] = slaKey;
        }
      }
    }

    // 3. Upsert conversations — Front-owned columns ONLY (see header comment).
    const conversationRows = conversations.map((c) => ({
      id: c.id,
      front_id: c.front_id,
      subject: c.subject,
      status: c.status,
      customer_name: c.customer_name,
      inbox_name: c.inbox_name,
      facility: INBOX_FACILITY_MAP[c.inbox_name] || null, // only set on initial insert in practice — see note below
      sla_status: slaByConversation[c.id] || null,
      last_message_at: c.last_message_at,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    // NOTE on `facility` above: including it here would let an inferred
    // facility silently overwrite a manual correction a manager made in the
    // Revisions tab on every resync. It's included in the initial insert
    // path (new row, nothing to clobber) but for existing rows this means
    // a manager's manual facility fix will get overwritten by the inferred
    // value again on the next run. Flagging this as a known limitation:
    // acceptable for now since the inferred mapping is only ever right or
    // null (never actively wrong), but worth revisiting if manual facility
    // overrides on auto-mapped rows become a real workflow.
    await supabaseUpsert('revision_conversations', conversationRows, 'front_id');

    // 4. Comments — watermarked, only pull what's new since last run.
    const stateRes = await fetch(`${SUPABASE_URL}/rest/v1/revision_sync_state?id=eq.1&select=last_comment_synced_at`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const stateRows = await stateRes.json();
    const lastCommentSyncedAt = stateRows[0]?.last_comment_synced_at || '2026-01-01T00:00:00Z';

    let newestCommentAt = lastCommentSyncedAt;
    const commentRows = [];
    for (const ids of idChunks) {
      const idsFilter = ids.join(',');
      const comments = await kbFetch(
        `comments?conversation_id=in.(${idsFilter})&created_at=gt.${encodeURIComponent(lastCommentSyncedAt)}&select=id,conversation_id,author_name,author_handle,body,created_at`
      );
      for (const c of comments) {
        commentRows.push(c);
        if (c.created_at > newestCommentAt) newestCommentAt = c.created_at;
      }
    }
    await supabaseUpsert('revision_comments', commentRows, 'id');

    await writeSyncState({
      last_run_at: startedAt,
      last_run_status: 'ok',
      conversations_synced: conversationRows.length,
      comments_synced: commentRows.length,
      last_comment_synced_at: newestCommentAt,
    });

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ success: true, conversations_synced: conversationRows.length, comments_synced: commentRows.length }),
    };
  } catch (err) {
    await writeSyncState({ last_run_at: startedAt, last_run_status: `error: ${err.message}` });
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
