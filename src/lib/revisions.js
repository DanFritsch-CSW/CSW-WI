// Data access for the Revisions tracker tab. Reads/writes revision_conversations
// and revision_comments, populated by the netlify/functions/revision-sync.cjs
// scheduled job (see that file for the sync/ownership rules). Added 2026-07-09.
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
// inbox_name/last_message_at/sla_status/synced_at — those belong to the
// sync job. See revision-sync.cjs header comment for the full ownership
// split (same pattern as roster_assignments.manually_edited).
export async function updateRevisionConversation(id, patch) {
  const allowed = {}
  for (const key of ['facility', 'order_number', 'resolved', 'resolved_by', 'resolved_at']) {
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
