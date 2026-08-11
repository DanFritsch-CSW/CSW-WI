// Fetch wrapper for the JDF Putaways (F8 slotting visibility) tab.
// Mirrors the fetch-wrapper convention used by wrPickCheck.js / wrCasesToPick.js --
// thin POST wrapper, throws on non-2xx so the component's own try/catch controls
// the loading/error UI. No body params needed -- this is a live "right now"
// snapshot, not date-scoped.
//
// 2026-08-11: response payload gained `dailyScorecard` and `buildingWide`
// keys (see motherduck-jdf-putaways.cjs's header) -- no change needed here,
// this wrapper just passes the whole JSON body through unchanged.

export async function fetchJdfPutaways() {
  const res = await fetch('/.netlify/functions/motherduck-jdf-putaways', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `JDF Putaways fetch failed (${res.status})`)
  }
  return res.json()
}
