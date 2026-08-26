// Fetch wrapper for the DPI Pickline (F8E/F8F primary pick reslot check) tab.
// Same thin POST pattern as dpiPutaways.js — throws on non-2xx so the
// component's own try/catch controls the loading/error UI.

export async function fetchDpiPickline() {
  const res = await fetch('/.netlify/functions/motherduck-dpi-pickline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `DPI Pickline fetch failed (${res.status})`)
  }
  return res.json()
}
