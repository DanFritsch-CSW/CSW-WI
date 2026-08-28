// src/lib/pviShortage.js
// Thin POST fetch wrapper for the PVI Shortage Report tab. Mirrors the
// pattern used by expCheck.js / wrPickCheck.js / jdfPutaways.js.

export async function fetchPviShortage(dayWindow = 1, excludeLotLp = true) {
  const res = await fetch('/.netlify/functions/motherduck-pvi-shortage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dayWindow, excludeLotLp }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PVI Shortage Report fetch failed (${res.status}): ${text}`);
  }
  return res.json();
}
