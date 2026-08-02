// src/lib/expCheck.js
// Thin POST fetch wrapper for the EXP Check tab. Multi-customer as of
// 2026-08-02 -- pass `customer` ('pretzilla' | 'bernatellos') alongside
// dayWindow; defaults to 'pretzilla' for backward compatibility.
// Mirrors the pattern used by wrPickCheck.js / jdfPutaways.js.

export const EXP_CHECK_CUSTOMERS = [
  { key: 'pretzilla', label: 'Pretzilla' },
  { key: 'bernatellos', label: "Bernatello's" },
];

export async function fetchExpCheck(dayWindow = 45, customer = 'pretzilla') {
  const res = await fetch('/.netlify/functions/motherduck-exp-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dayWindow, customer }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EXP Check fetch failed (${res.status}): ${text}`);
  }
  return res.json();
}
