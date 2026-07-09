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
// Front-sourced / MotherDuck-derived columns (subject, status,
// customer_name, inbox_name, last_message_at, sla_status, synced_at,
// updated_at, matched_appointment_id, matched_warehouse,
// matched_scheduled_arrival, match_status, match_candidates). It must
// NEVER include facility, order_number, resolved, resolved_by,
// resolved_at, or resolved_match in the upsert payload — those are
// CSW-WI-local enrichments set by managers in the Revisions tab, and a
// PostgREST merge-duplicates upsert only touches columns present in the
// payload, so omitting them is what protects them. Same pattern as
// roster_assignments.manually_edited — don't clobber human-owned fields
// with an automated sync.
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
//   3. MOTHERDUCK_TOKEN (already used by other functions in this repo —
//      see motherduck-appointments.cjs) is required for the appointment
//      matching pass added 2026-07-09. If unset, sync still runs but
//      skips matching (conversations land with match_status=null).
// Without (1)/(2), every run will fail fast with a clear error rather
// than silently syncing zero rows.
//
// ── Appointment matching (added 2026-07-09) ────────────────────────────
// Confirmed live against MotherDuck on 2026-07-09: numeric tokens embedded
// in Front subject lines (shipment #, order #, PO #, DN #) frequently
// match production_db.gold.truck_appointments.reference_number or
// lookup_code directly, giving a real scheduled_arrival date + warehouse
// (facility) + a correlation key (appointment_id) for grouping multiple
// Front threads about the same shipment.
//
// Caveat, also confirmed live: the same numeric string can belong to a
// completely different customer/appointment from a prior year (e.g.
// "517450" matched both a 2025-03 Saputo/Madison appointment and a
// 2026-07 Palermo Villa/Franksville one). Two mitigations:
//   1. Only consider appointments within a recent window (default
//      -14d to +45d from now) — revisions are about live operational
//      issues, not year-old completed shipments, so this alone kills
//      most of the stale-year false positives.
//   2. If more than one appointment still matches within that window,
//      DO NOT auto-pick — mark match_status='ambiguous' and store every
//      candidate in match_candidates for a manager to confirm in the tab
//      (writes to the LOCAL-OWNED resolved_match field, never touched
//      by this function).
// Short tokens (3-4 digits) only match via exact reference_number
// equality — substring-matching short tokens against lookup_code would
// false-positive constantly (e.g. "749" appearing inside a longer code).
// Longer tokens (5+ digits) also try lookup_code substring matching.
// A 4-digit token that looks like a plain calendar year (2020-2035) is
// dropped entirely before matching — those are almost always a date
// mentioned in the subject line, not a reference number.
//
// ── Body-text extraction (added 2026-07-09, session 5) ─────────────────
// Subject-only extraction misses a real, common case: customer emails
// that only say "see attached" (the actual order numbers are in an Excel/
// PDF attachment we don't parse — out of scope, see Notion Pending
// Issues), but CSW's own reply in the SAME thread often restates the
// order numbers in plain text ("These orders have been revised: 515110,
// 517054"). Confirmed live on 2026-07-09 — recovers real matches that
// subject-only extraction was missing entirely.
//
// Email bodies are noisy in ways subjects aren't — signature blocks carry
// phone numbers, extensions, street addresses, and zip codes, all of
// which are 3-5 digit runs that could coincidentally collide with a real
// reference_number. stripSignatureNoise() removes the common patterns
// (phone numbers, "ext. 1234", street addresses, zip/zip+4) before token
// extraction runs. Not bulletproof, but removes the concrete noise
// sources actually observed in real message bodies during testing.

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const KB_URL = process.env.KB_SUPABASE_URL;
const KB_SERVICE_KEY = process.env.KB_SUPABASE_SERVICE_KEY;
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN;

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

// Known inbox_name -> CSW-WI facility id mapping. Used only as a fallback
// when appointment matching doesn't resolve a warehouse — see note in the
// conversationRows.map() below.
const INBOX_FACILITY_MAP = {
  'Caledonia': 'cal',
  'CAL Appointments': 'cal',
  'Kenosha': 'ken',
  'Madison': 'mad',
  'MAD Inventory': 'mad',
  'Wisconsin Rapids': 'wr',
  'Eau Claire': 'ec',
};

// production_db.gold.truck_appointments.warehouse_name -> CSW-WI facility id
const WAREHOUSE_FACILITY_MAP = {
  'CSW-Franksville': 'cal',
  'CSW-Kenosha': 'ken',
  'CSW-Madison': 'mad',
  'CSW-Wisconsin Rapids': 'wr',
  'CSW-Eau Claire': 'ec',
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Removes the concrete noise sources observed in real Front message bodies
// (signature blocks) before token extraction: phone numbers, extensions,
// street addresses, zip/zip+4. See header comment for why this matters —
// without it, body-text extraction would pick up things like the "7800"
// in "7800 95th St." or the "1524" in "ext. 1524" as if they were order
// references.
function stripSignatureNoise(text) {
  return text
    // phone numbers: 262-947-7800, 262.947.7800, (262) 947-7800
    .replace(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, ' ')
    // extensions: ext. 1524, extension 1524, x1158
    .replace(/\b(?:ext\.?|extension)\s*\d+/gi, ' ')
    .replace(/\bx\d{3,5}\b/gi, ' ')
    // street addresses: 7800 95th St., 12725 4 Mile Rd
    .replace(/\b\d+\s+\w+(\s+\w+)?\s+(St|Ave|Rd|Dr|Blvd|Street|Avenue|Road|Way|Ln|Lane)\.?\b/gi, ' ')
    // zip / zip+4 at end of an address line: "Pleasant Prairie, WI 53158"
    .replace(/\b\d{5}(-\d{4})?\b(?=[,.\n]|\s+USA|\s*$)/gi, ' ');
}

// Pull 3+ digit runs out of text, drop plain-calendar-year looking 4-digit
// tokens (2020-2035), dedupe. Used for both subject (as-is) and body text
// (after stripSignatureNoise).
function extractTokens(text) {
  if (!text) return [];
  const matches = text.match(/\d{3,}/g) || [];
  const isYearLike = (t) => t.length === 4 && Number(t) >= 2020 && Number(t) <= 2035;
  return [...new Set(matches.filter((t) => !isYearLike(t)))];
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

// Escape a string for embedding in a SQL literal (duckdb-node's .all()
// surface used here doesn't support parameter binding). Tokens are
// digit-only (validated by extractTokens' regex) so this is a belt-and-
// suspenders guard, not load-bearing.
function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Batch-match every extracted token (across ALL conversations in this run)
// against MotherDuck in a single query, rather than one query per
// conversation. Returns a Map<token, candidateAppointment[]>.
async function matchTokensAgainstMotherDuck(tokens) {
  if (!MOTHERDUCK_TOKEN || !tokens.length) return new Map();

  process.env.HOME = '/tmp';
  process.env.motherduck_token = MOTHERDUCK_TOKEN;

  const duckdb = require('duckdb');
  const db = new duckdb.Database('md:production_db', { motherduck_token: MOTHERDUCK_TOKEN });
  const conn = db.connect();

  await new Promise((resolve, reject) => {
    conn.run('LOAD motherduck', (err) => (err ? reject(err) : resolve()));
  });

  // Recent-window guard: only consider appointments from the last 14 days
  // through the next 45 days. Kills most stale-year false positives
  // (same reference number reused across customers/years) before
  // disambiguation even has to run.
  const shortTokens = tokens.filter((t) => t.length < 5);
  const longTokens = tokens.filter((t) => t.length >= 5);
  const shortList = shortTokens.map(sqlLit).join(',') || 'NULL';
  const longList = longTokens.map(sqlLit).join(',') || 'NULL';

  const sql = `
    SELECT appointment_id, owner_name, warehouse_name, reference_number, lookup_code,
           scheduled_arrival::VARCHAR AS scheduled_arrival
    FROM production_db.gold.truck_appointments
    WHERE scheduled_arrival >= (CURRENT_TIMESTAMP - INTERVAL 14 DAY)
      AND scheduled_arrival <= (CURRENT_TIMESTAMP + INTERVAL 45 DAY)
      AND (
        reference_number IN (${shortList}, ${longList})
        OR (${longTokens.length > 0} AND (${longTokens.map((t) => `lookup_code ILIKE '%${t.replace(/'/g, "''")}%'`).join(' OR ') || 'FALSE'}))
      )
  `;

  const rows = await new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => (err ? reject(err) : resolve(result)));
  });

  conn.close();
  db.close();

  const byToken = new Map();
  for (const token of tokens) {
    const candidates = rows.filter(
      (r) => r.reference_number === token || (token.length >= 5 && r.lookup_code && r.lookup_code.includes(token))
    );
    if (candidates.length) byToken.set(token, candidates);
  }
  return byToken;
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

    // 2. Pull conversation rows + SLA tags + message bodies (for token
    // extraction — see header comment) in id-chunks (URL length safety).
    const idChunks = chunk(conversationIds, 100);
    const conversations = [];
    const slaByConversation = {};
    const bodiesByConversation = new Map();

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

      const messageRows = await kbFetch(
        `messages?conversation_id=in.(${idsFilter})&select=conversation_id,body`
      );
      for (const row of messageRows) {
        if (!row.body) continue;
        if (!bodiesByConversation.has(row.conversation_id)) bodiesByConversation.set(row.conversation_id, []);
        bodiesByConversation.get(row.conversation_id).push(row.body);
      }
    }

    // 2b. Extract tokens per conversation (subject + all message bodies,
    // bodies noise-stripped first), batch-match against MotherDuck once.
    const tokensByConversation = new Map();
    const allTokens = new Set();
    for (const c of conversations) {
      const subjectTokens = extractTokens(c.subject);
      const bodies = bodiesByConversation.get(c.id) || [];
      const bodyTokens = bodies.flatMap((b) => extractTokens(stripSignatureNoise(b)));
      const tokens = [...new Set([...subjectTokens, ...bodyTokens])];
      tokensByConversation.set(c.id, tokens);
      tokens.forEach((t) => allTokens.add(t));
    }

    let matchByToken = new Map();
    let motherduckError = null;
    try {
      matchByToken = await matchTokensAgainstMotherDuck([...allTokens]);
    } catch (e) {
      // Don't fail the whole sync if MotherDuck has a bad moment — land
      // the Front data (subject/status/comments/SLA still valuable on
      // their own) and just skip matching this run. Next run tries again.
      motherduckError = e.message;
    }

    // 3. Upsert conversations — Front-owned + MD-derived columns ONLY.
    const conversationRows = conversations.map((c) => {
      const tokens = tokensByConversation.get(c.id) || [];
      // Union of candidate appointments across all of this conversation's
      // tokens, deduped by appointment_id (a conversation can mention more
      // than one number; we want the appointment(s) any of them point to).
      const candidatesById = new Map();
      for (const token of tokens) {
        for (const cand of matchByToken.get(token) || []) {
          candidatesById.set(cand.appointment_id, cand);
        }
      }
      const candidates = [...candidatesById.values()];

      let matchStatus = 'none';
      let matchedAppointmentId = null;
      let matchedWarehouse = null;
      let matchedScheduledArrival = null;
      if (candidates.length === 1) {
        matchStatus = 'matched';
        matchedAppointmentId = candidates[0].appointment_id;
        matchedWarehouse = candidates[0].warehouse_name;
        matchedScheduledArrival = candidates[0].scheduled_arrival;
      } else if (candidates.length > 1) {
        matchStatus = 'ambiguous';
      }

      const inferredFacility =
        (matchedWarehouse && WAREHOUSE_FACILITY_MAP[matchedWarehouse]) ||
        INBOX_FACILITY_MAP[c.inbox_name] ||
        null;

      return {
        id: c.id,
        front_id: c.front_id,
        subject: c.subject,
        status: c.status,
        customer_name: c.customer_name,
        inbox_name: c.inbox_name,
        facility: inferredFacility, // see known-limitation note in the 2026-07-09 changelog re: overwriting manual facility fixes
        sla_status: slaByConversation[c.id] || null,
        last_message_at: c.last_message_at,
        matched_appointment_id: matchedAppointmentId,
        matched_warehouse: matchedWarehouse,
        matched_scheduled_arrival: matchedScheduledArrival,
        match_status: matchStatus,
        match_candidates: candidates.length > 1 ? candidates : null, // NOT JSON.stringify()'d here — supabaseUpsert already stringifies the whole rows array once; double-encoding stored this as literal string text in the jsonb column instead of a real array, breaking `.map()` on the frontend (fixed 2026-07-09 after live "r.map is not a function" report)
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

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
      last_run_status: motherduckError ? `ok (motherduck matching skipped: ${motherduckError})` : 'ok',
      conversations_synced: conversationRows.length,
      comments_synced: commentRows.length,
      last_comment_synced_at: newestCommentAt,
    });

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        success: true,
        conversations_synced: conversationRows.length,
        comments_synced: commentRows.length,
        motherduck_error: motherduckError,
      }),
    };
  } catch (err) {
    await writeSyncState({ last_run_at: startedAt, last_run_status: `error: ${err.message}` });
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
