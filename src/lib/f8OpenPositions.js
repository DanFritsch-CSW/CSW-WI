// Fetch wrapper for the F8 Open Positions tab (F8B-F8E open pallet
// position counts). Same thin POST pattern as dpiPickline.js -- throws on
// non-2xx so the component's own try/catch controls the loading/error UI.

export async function fetchF8OpenPositions() {
  const res = await fetch('/.netlify/functions/motherduck-f8-open-positions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `F8 Open Positions fetch failed (${res.status})`)
  }
  return res.json()
}
