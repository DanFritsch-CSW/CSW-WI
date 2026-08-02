// src/lib/expCheck.js
// Thin POST fetch wrapper for the EXP Check (Pretzilla) tab.
// Mirrors the pattern used by wrPickCheck.js / jdfPutaways.js.

export async function fetchExpCheck(dayWindow = 45) {
  const res = await fetch('/.netlify/functions/motherduck-exp-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dayWindow }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EXP Check fetch failed (${res.status}): ${text}`);
  }
  return res.json();
}
