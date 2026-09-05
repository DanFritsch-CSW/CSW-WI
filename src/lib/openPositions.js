// Fetch wrapper for Current Open Positions — CAL/KEN/WR/EC (Madison uses
// fetchF8OpenPositions instead, its own dedicated endpoint). Same thin
// POST pattern as f8OpenPositions.js.

export async function fetchOpenPositions(facility) {
  const res = await fetch('/.netlify/functions/motherduck-open-positions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility }),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `Open Positions fetch failed (${res.status})`)
  }
  return res.json()
}
