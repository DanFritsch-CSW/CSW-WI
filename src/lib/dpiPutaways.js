// Fetch wrapper for the DPI Putaways (F5+F8 slotting visibility) tab.
// Duplicated from jdfPutaways.js 2026-08-25 — thin POST wrapper, throws on
// non-2xx so the component's own try/catch controls the loading/error UI.

export async function fetchDpiPutaways() {
  const res = await fetch('/.netlify/functions/motherduck-dpi-putaways', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `DPI Putaways fetch failed (${res.status})`)
  }
  return res.json()
}
