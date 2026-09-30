// Fetch wrapper for the CAL "Pick Location Lot Check" sub-tab (PALDSD9).
// Mirrors src/lib/wrPickCheck.js -- thin POST wrapper, throws on non-2xx so
// the component's own try/catch controls the loading/error UI. No body
// params: live "right now" snapshot, not date-scoped.

export async function fetchCalPickCheck() {
  const res = await fetch('/.netlify/functions/motherduck-cal-pick-check', {
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
