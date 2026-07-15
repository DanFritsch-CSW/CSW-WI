// Fetch wrapper for the WR "Secondary Replenishments" sub-tab (added 2026-07-15).
// Mirrors the fetch-wrapper convention used by wrPickCheck.js / wrCasesToPick.js --
// thin POST wrapper, throws on non-2xx so the component's own try/catch controls
// the loading/error UI. No body params needed -- this is a live "right now"
// snapshot, not date-scoped.

export async function fetchWrSecondaryRepl() {
  const res = await fetch('/.netlify/functions/wr-secondary-repl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `Secondary Replenishments fetch failed (${res.status})`)
  }
  return res.json()
}
