// Data access for the Revisions tracker tab. Reads/writes revision_conversations
// and revision_comments, populated by the netlify/functions/revision-sync.cjs
// scheduled job (see that file for the sync/ownership rules). Added 2026-07-09.
// Appointment matching (matched_*/match_status/match_candidates/resolved_match)
// added same day — see effectiveMatch() below for how those columns combine.
//
// This module owns its own Supabase client rather than importing from the
// existing src/lib/supabase.js, since that file already carries the full
// weight of every other module's queries — keeping this self-contained
// makes it easy to find/review/remove independently of the rest of the app.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

export async function fetchRevisionConversations() {
  const { data, error } = await supabase
    .from('revision_conversations')
    .select('*')
    .order('last_message_at', { ascending: false })
  if (error) throw error
  return data
}

export async function fetchRevisionComments(conversationIds) {
  if (!conversationIds.length) return []
  const { data, error } = await supabase
    .from('revision_comments')
    .select('*')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

// Manager-owned fields only. Never touches subject/status/customer_name/
// inbox_name/last_message_at/sla_status/synced_at/matched_*/match_status/
// match_candidates — those belong to the sync job. See revision-sync.cjs
// header comment for the full ownership split (same pattern as
// roster_assignments.manually_edited).
export async function updateRevisionConversation(id, patch) {
  const allowed = {}
  for (const key of ['facility', 'order_number', 'resolved', 'resolved_by', 'resolved_at', 'resolved_match']) {
    if (key in patch) allowed[key] = patch[key]
  }
  const { error } = await supabase
    .from('revision_conversations')
    .update({ ...allowed, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export function markResolved(id, resolvedBy) {
  return updateRevisionConversation(id, {
    resolved: true,
    resolved_by: resolvedBy || null,
    resolved_at: new Date().toISOString(),
  })
}

export function markUnresolved(id) {
  return updateRevisionConversation(id, {
    resolved: false,
    resolved_by: null,
    resolved_at: null,
  })
}

// A manager confirming one candidate from an ambiguous match. Stores the
// full candidate snapshot (not just the id) so the UI has appointment_id/
// warehouse_name/scheduled_arrival/owner_name available without a second
// MotherDuck round-trip.
export function resolveAmbiguousMatch(id, candidate) {
  return updateRevisionConversation(id, { resolved_match: candidate })
}

// Clears a manager's prior resolution — falls back to whatever the sync
// job's own matched_* columns say (or back to ambiguous/none) on next read.
export function clearResolvedMatch(id) {
  return updateRevisionConversation(id, { resolved_match: null })
}

// Single source of truth for "what appointment does this conversation
// belong to, if any" — a manager's resolved_match always wins over the
// sync's own matched_* columns, since it represents a human confirming
// the right one out of several candidates that shared a numeric token.
export function effectiveMatch(conv) {
  if (conv.resolved_match) {
    return {
      appointment_id: conv.resolved_match.appointment_id,
      warehouse_name: conv.resolved_match.warehouse_name,
      scheduled_arrival: conv.resolved_match.scheduled_arrival,
      owner_name: conv.resolved_match.owner_name,
      source: 'resolved',
    }
  }
  if (conv.match_status === 'matched' && conv.matched_appointment_id) {
    return {
      appointment_id: conv.matched_appointment_id,
      warehouse_name: conv.matched_warehouse,
      scheduled_arrival: conv.matched_scheduled_arrival,
      owner_name: null,
      source: 'auto',
    }
  }
  return null
}
