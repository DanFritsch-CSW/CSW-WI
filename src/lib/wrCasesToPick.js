// Fetch wrapper for the WR "Cases To Pick" sub-tab.
// Mirrors the fetch-wrapper convention already used by prePickStatus.js —
// thin POST wrapper, throws on non-2xx so the component's own try/catch
// controls the loading/error UI.

export async function fetchWrCasesToPick(planDate) {
  const res = await fetch('/.netlify/functions/motherduck-wr-cases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: planDate }),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `Cases To Pick fetch failed (${res.status})`)
  }
  return res.json()
}
