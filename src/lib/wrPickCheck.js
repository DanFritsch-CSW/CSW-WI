// Fetch wrapper for the WR "Pick Location Lot Check" sub-tab.
// Mirrors the fetch-wrapper convention used by prePickStatus.js / wrCasesToPick.js --
// thin POST wrapper, throws on non-2xx so the component's own try/catch controls
// the loading/error UI. No body params needed -- this is a live "right now"
// snapshot, not date-scoped.

export async function fetchWrPickCheck() {
  const res = await fetch('/.netlify/functions/motherduck-wr-pick-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `Pick Location Lot Check fetch failed (${res.status})`)
  }
  return res.json()
}
