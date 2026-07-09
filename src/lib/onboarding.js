import { supabase } from './supabase.js'

// ─── Customer Onboarding ────────────────────────────────────────────────────
//
// Built 2026-07-08 from the design mock explored in a prior session (never
// implemented). Core mechanic: completing a checklist task auto-notifies the
// NEXT pending task's owner via a Front discussion (@mention), forming a
// handoff chain. Front push is ONE-WAY (app → Front only, nothing read back)
// and internal-only (discussions, never customer-facing email) — both
// deliberate constraints from the original design session.
//
// Bucket/owner content and the 8-task default template are pulled from that
// same mock, not invented. Two owners (Tony, Kris) don't have a confirmed
// Front teammate_id yet — see onboarding_task_templates migration comment.
// The app works fully for those buckets; only the Front auto-notify silently
// no-ops for them until a real teammate_id is supplied.

export const BUCKETS = ['Sales', 'Finance', 'OPS', 'IT', 'Quality']
export const STAGES = ['Lead', 'Setup', 'Go-Live', 'Active']
export const BUCKET_COLORS = {
  Sales: '#0ea5e9', Finance: '#10b981', OPS: '#f59e0b', IT: '#8b5cf6', Quality: '#ef4444',
}

export async function fetchOnboardingCustomers() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('onboarding_customers')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) { console.error('fetchOnboardingCustomers:', error); return [] }
  return data ?? []
}

export async function fetchTaskTemplate() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('onboarding_task_templates')
    .select('*')
    .order('sort_order')
  if (error) { console.error('fetchTaskTemplate:', error); return [] }
  return data ?? []
}

export async function fetchTaskInstances(customerId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('onboarding_task_instances')
    .select('*')
    .eq('customer_id', customerId)
    .order('sort_order')
  if (error) { console.error('fetchTaskInstances:', error); return [] }
  return data ?? []
}

// createOnboardingCustomer — inserts the customer row, then clones the
// CURRENT template into frozen task_instances for this customer. Per the
// original design decision: template is a snapshot at creation time, editing
// the template later does NOT retroactively change in-progress customers.
export async function createOnboardingCustomer({ name, facility, sourceConversationId }) {
  if (!supabase) return null
  const { data: customer, error: custErr } = await supabase
    .from('onboarding_customers')
    .insert({
      name: (name || '').trim(),
      facility: facility || null,
      source_conversation_id: sourceConversationId || null,
    })
    .select()
    .single()
  if (custErr) { console.error('createOnboardingCustomer insert:', custErr); throw custErr }

  const template = await fetchTaskTemplate()
  if (template.length) {
    const rows = template.map(t => ({
      customer_id: customer.id,
      bucket: t.bucket,
      label: t.label,
      sort_order: t.sort_order,
      owner_name: t.default_owner_name,
      owner_teammate_id: t.default_owner_teammate_id,
      status: 'pending',
    }))
    const { error: taskErr } = await supabase.from('onboarding_task_instances').insert(rows)
    if (taskErr) { console.error('createOnboardingCustomer task clone:', taskErr); throw taskErr }
  }
  return customer
}

export async function updateCustomerStage(customerId, stage) {
  if (!supabase) return
  const { error } = await supabase
    .from('onboarding_customers')
    .update({ stage, updated_at: new Date().toISOString() })
    .eq('id', customerId)
  if (error) console.error('updateCustomerStage:', error)
}

export async function setCustomerArchived(customerId, archived) {
  if (!supabase) return
  const { error } = await supabase
    .from('onboarding_customers')
    .update({ archived, updated_at: new Date().toISOString() })
    .eq('id', customerId)
  if (error) console.error('setCustomerArchived:', error)
}

export async function deleteOnboardingCustomer(customerId) {
  if (!supabase) return
  // ON DELETE CASCADE on onboarding_task_instances handles the task rows.
  const { error } = await supabase.from('onboarding_customers').delete().eq('id', customerId)
  if (error) console.error('deleteOnboardingCustomer:', error)
}

export async function addTaskInstance({ customerId, bucket, label, sortOrder, ownerName, ownerTeammateId }) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('onboarding_task_instances')
    .insert({
      customer_id: customerId,
      bucket, label,
      sort_order: sortOrder,
      owner_name: ownerName || null,
      owner_teammate_id: ownerTeammateId || null,
      status: 'pending',
    })
    .select()
    .single()
  if (error) { console.error('addTaskInstance:', error); throw error }
  return data
}

export async function updateTaskInstance(taskId, patch) {
  if (!supabase) return
  const { error } = await supabase
    .from('onboarding_task_instances')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', taskId)
  if (error) console.error('updateTaskInstance:', error)
}

export async function deleteTaskInstance(taskId) {
  if (!supabase) return
  const { error } = await supabase.from('onboarding_task_instances').delete().eq('id', taskId)
  if (error) console.error('deleteTaskInstance:', error)
}

// completeTaskAndNotifyNext — the core handoff mechanic from the original
// design. Marks the given task done, then calls the dedicated
// onboarding-complete-task Netlify function, which (server-side, no secret
// exposed to the client) finds the next pending task for this customer and
// posts a Front discussion @mentioning its owner — but only if that owner
// has a resolved teammate_id. Returns the function's response so the UI can
// show whether a Front notification actually fired.
export async function completeTaskAndNotifyNext(taskId) {
  const res = await fetch('/.netlify/functions/onboarding-complete-task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  })
  let json
  try { json = await res.json() } catch { json = null }
  if (!res.ok) {
    console.error('completeTaskAndNotifyNext:', json)
    throw new Error(json?.error || `Request failed (${res.status})`)
  }
  return json
}

// ─── Template Editor support ────────────────────────────────────────────────
// Added 2026-07-09 to back the Template Editor screen — lets Dan add/edit/
// reorder/delete master template tasks and their default owners without
// asking Claude to run SQL each time. Editing these rows only affects
// customers created AFTER the change; existing customers are frozen
// snapshots per the original design decision (see createOnboardingCustomer).

export async function addTemplateTask({ bucket, label, sortOrder, ownerName, ownerTeammateId }) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('onboarding_task_templates')
    .insert({
      bucket, label, sort_order: sortOrder,
      default_owner_name: ownerName || null,
      default_owner_teammate_id: ownerTeammateId || null,
    })
    .select()
    .single()
  if (error) { console.error('addTemplateTask:', error); throw error }
  return data
}

export async function updateTemplateTask(id, patch) {
  if (!supabase) return
  const { error } = await supabase
    .from('onboarding_task_templates')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) { console.error('updateTemplateTask:', error); throw error }
}

export async function deleteTemplateTask(id) {
  if (!supabase) return
  const { error } = await supabase.from('onboarding_task_templates').delete().eq('id', id)
  if (error) { console.error('deleteTemplateTask:', error); throw error }
}

// swapTemplateTaskOrder — swaps sort_order between two adjacent template
// rows, backing the up/down reorder controls in the Template Editor.
export async function swapTemplateTaskOrder(taskA, taskB) {
  if (!supabase) return
  const { error: e1 } = await supabase
    .from('onboarding_task_templates')
    .update({ sort_order: taskB.sort_order })
    .eq('id', taskA.id)
  const { error: e2 } = await supabase
    .from('onboarding_task_templates')
    .update({ sort_order: taskA.sort_order })
    .eq('id', taskB.id)
  if (e1 || e2) console.error('swapTemplateTaskOrder:', e1 || e2)
}

// ─── Front Teammate Lookup ──────────────────────────────────────────────────
// Added 2026-07-09. Seeded once from the 87-teammate pull (2026-07-08) —
// lets the UI show a real "@username — First Last" picker instead of asking
// people to type raw tea_xxxxx IDs, which nobody at CSW actually knows or
// uses day-to-day (they think in @dfritsch / @awasz terms, same as Front's
// own UI). No auto-refresh yet — if the team changes, re-seed by re-running
// the Front teammates pull and asking Claude to update this table.
export async function fetchFrontTeammates() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('front_teammates')
    .select('*')
    .order('username')
  if (error) { console.error('fetchFrontTeammates:', error); return [] }
  return data ?? []
}
