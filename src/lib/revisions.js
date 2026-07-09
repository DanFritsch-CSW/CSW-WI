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
  for (const key of [
    'facility', 'order_number', 'resolved', 'resolved_by', 'resolved_at',
    'resolved_match', 'dismissed', 'manual_ship_date',
  ]) {
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

// Dismiss — for Front tag false positives (e.g. the "Revision" tag rule
// matching a keyword in CSW's own reply, not anything the customer said).
// Distinct from resolved: dismissed means this was never really a
// revision issue; resolved means a real one got handled.
export function dismissConversation(id) {
  return updateRevisionConversation(id, { dismissed: true })
}

export function undismissConversation(id) {
  return updateRevisionConversation(id, { dismissed: false })
}

// Manual ship date — for conversations with a real target date written
// in plain text (not a Datex reference number the sync can match), e.g.
// "Pallet needed back from CSW 07/10/2026". Lets a manager type the date
// in by hand so it still shows up in the day-slider view. Pass null to
// clear.
export function setManualShipDate(id, dateStr) {
  return updateRevisionConversation(id, { manual_ship_date: dateStr || null })
}

// Single source of truth for "what appointment does this conversation
// belong to, if any" — priority order:
//   1. resolved_match (manager confirmed one of several ambiguous candidates)
//   2. matched_* (sync auto-matched exactly one candidate)
//   3. manual_ship_date (manager typed in a date by hand — no appointment_id/
//      warehouse, just a date to filter/display by)
//   4. null (no date signal at all)
//
// reference_number (added 2026-07-09, session 8) is included so the tab
// can pre-fill the Order/PO # field from the matched Datex reference
// instead of always showing "not linked" — see matched_reference_number
// in revision-sync.cjs for where the auto value comes from.
export function effectiveMatch(conv) {
  if (conv.resolved_match) {
    return {
      appointment_id: conv.resolved_match.appointment_id,
      warehouse_name: conv.resolved_match.warehouse_name,
      scheduled_arrival: conv.resolved_match.scheduled_arrival,
      owner_name: conv.resolved_match.owner_name,
      reference_number: conv.resolved_match.reference_number || null,
      source: 'resolved',
    }
  }
  if (conv.match_status === 'matched' && conv.matched_appointment_id) {
    return {
      appointment_id: conv.matched_appointment_id,
      warehouse_name: conv.matched_warehouse,
      scheduled_arrival: conv.matched_scheduled_arrival,
      owner_name: null,
      reference_number: conv.matched_reference_number || null,
      source: 'auto',
    }
  }
  if (conv.manual_ship_date) {
    return {
      appointment_id: null, // no real appointment — never grouped with other conversations
      warehouse_name: null,
      scheduled_arrival: conv.manual_ship_date,
      owner_name: null,
      reference_number: null,
      source: 'manual',
    }
  }
  return null
}
