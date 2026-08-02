// Frontend helpers for the HR tab's Attendance Points sub-tab. Added
// 2026-08-02. Mirrors the fetchNotifySettings/upsertNotifySettings shape
// already used by prepick_notify_settings elsewhere in this app, plus a
// dedicated MotherDuck-backed read endpoint for live balances and a
// trigger for the (non-dry-run) manual digest test.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchNotifySettings(facility) {
  const rows = await sbFetch(`attendance_points_notify_settings?facility=eq.${facility}&select=*`)
  return rows?.[0] || { facility, front_conversation_id: null, active: false }
}

export async function upsertNotifySettings(facility, { frontConversationId, active }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/attendance_points_notify_settings`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      facility,
      front_conversation_id: frontConversationId,
      active,
      updated_at: new Date().toISOString(),
    }),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function fetchPointBalances(facility) {
  const res = await fetch('/.netlify/functions/motherduck-attendance-points', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error || 'Failed to fetch point balances')
  return data
}

// NOT a dry run — see attendance-points-digest-test.cjs header. Posts
// real Front comments and writes real attendance_points_actions rows.
export async function triggerDigestTest(facility) {
  const res = await fetch('/.netlify/functions/attendance-points-digest-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error || 'Digest test failed')
  return data
}

export async function fetchRecentActions(facility) {
  return sbFetch(`attendance_points_actions?facility=eq.${facility}&select=*&order=created_at.desc&limit=50`)
}
