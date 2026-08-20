import { supabase } from './supabase.js'

// Scheduling app "Datex Exceptions" view (2026-08-03) — surfaces
// `submissions` rows stuck between Front and Datex. Reads go straight
// against the `submissions` table via the shared Supabase client: it's the
// same table the standalone scheduling app (DanFritsch-CSW/front_netlify_datex)
// already writes to, already living in this Supabase project — no data
// migration needed.
//
// The retry action can't run client-side (it needs Datex's Azure AD client
// secret), so that goes through netlify/functions/datex-retry-push.cjs.
// Delete also goes through a function (scheduling-delete-submission.cjs)
// rather than a direct client-side Supabase call, to keep one write path.
//
// UPDATED 2026-08-19: added Load Container Timeouts — a 5th category
// reading `load_container_attempts` instead of `submissions`. This tracks
// an EARLIER, separate failure mode Dan flagged after reviewing this page:
// load container creation (scheduling-create-load-container.cjs) can time
// out ambiguously too, but that happens BEFORE a `submissions` row ever
// exists, so the original four categories here had no way to see it. See
// that function's header for the full root-cause writeup. Resolution goes
// through scheduling-resolve-load-container-attempt.cjs (server-side, same
// one-write-path convention as retry/delete above).

const STALE_PENDING_DAYS = 7
const STUCK_PROCESSING_MINUTES = 30

const SELECT_COLUMNS = [
  'id', 'created_at', 'status', 'warehouse', 'type', 'scheduled_arrival',
  'appointment_lookup_code', 'reference_number', 'carrier', 'owner', 'project',
  'notes', 'datex_error', 'datex_pushed_at', 'datex_appointment_id',
  'front_conversation_id', 'owner_datex_id', 'project_datex_id',
  'dock_door_datex_id', 'carrier_datex_id', 'load_container_id', 'appt_duration',
].join(', ')

export async function fetchFailed() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('submissions')
    .select(SELECT_COLUMNS)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
  if (error) { console.error('fetchFailed:', error); return [] }
  return data ?? []
}

export async function fetchStuckProcessing() {
  if (!supabase) return []
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_MINUTES * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('submissions')
    .select(SELECT_COLUMNS)
    .eq('status', 'processing')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: false })
  if (error) { console.error('fetchStuckProcessing:', error); return [] }
  return data ?? []
}

export async function fetchApprovedUnconfirmed() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('submissions')
    .select(SELECT_COLUMNS)
    .eq('status', 'approved')
    .is('datex_appointment_id', null)
    .order('created_at', { ascending: false })
  if (error) { console.error('fetchApprovedUnconfirmed:', error); return [] }
  return data ?? []
}

export async function fetchStalePending() {
  if (!supabase) return []
  const cutoff = new Date(Date.now() - STALE_PENDING_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('submissions')
    .select(SELECT_COLUMNS)
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: false })
  if (error) { console.error('fetchStalePending:', error); return [] }
  return data ?? []
}

// Load Container Timeouts — added 2026-08-19. Unresolved (status='ambiguous')
// load_container_attempts rows: a create-load-container call timed out and
// we genuinely don't know whether Datex created the container. Blocks a
// new attempt for the same lookupcode until resolved here — see
// scheduling-create-load-container.cjs's header for the full story.
export async function fetchLoadContainerTimeouts() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('load_container_attempts')
    .select('*')
    .eq('status', 'ambiguous')
    .order('created_at', { ascending: false })
  if (error) { console.error('fetchLoadContainerTimeouts:', error); return [] }
  return data ?? []
}

export async function fetchAllExceptionCategories() {
  const [failed, stuckProcessing, approvedUnconfirmed, stalePending, loadContainerTimeouts] = await Promise.all([
    fetchFailed(),
    fetchStuckProcessing(),
    fetchApprovedUnconfirmed(),
    fetchStalePending(),
    fetchLoadContainerTimeouts(),
  ])
  return { failed, stuckProcessing, approvedUnconfirmed, stalePending, loadContainerTimeouts }
}

// retryDatexPush — calls the server-side retry function. Never attempted
// client-side: pushing to Datex requires DATEX_CLIENT_SECRET, which must
// never reach the browser.
export async function retryDatexPush(id) {
  const res = await fetch('/.netlify/functions/datex-retry-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(json?.error || `HTTP ${res.status}`)
    err.status = res.status
    err.submission = json?.submission
    throw err
  }
  return json
}

// resolveLoadContainerAttempt — calls the server-side resolve function for
// an ambiguous load_container_attempts row. resolution is 'found' (pass
// loadcontainerId — the ID confirmed to exist in Datex) or 'not_found'
// (confirmed the container was never created; unblocks retries for that
// lookupcode).
export async function resolveLoadContainerAttempt(id, resolution, loadcontainerId) {
  const res = await fetch('/.netlify/functions/scheduling-resolve-load-container-attempt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, resolution, loadcontainer_id: loadcontainerId }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`)
  }
  return json
}

// deleteSubmission — permanently removes a submissions row. Added
// 2026-08-18 so junk/duplicate/unrecoverable records (e.g. old Stale
// Pending rows) can be cleared instead of only viewed or retried.
export async function deleteSubmission(id) {
  const res = await fetch('/.netlify/functions/scheduling-delete-submission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`)
  }
  return json
}

// front_conversation_id on submissions rows is the same public conversation
// ID format (cnv_xxx) used across Front's API and the Front MCP tools.
export function frontConversationUrl(frontConversationId) {
  if (!frontConversationId) return null
  return `https://app.frontapp.com/open/${frontConversationId}`
}
