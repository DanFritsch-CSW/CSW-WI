// src/lib/expCheck.js
// Thin POST fetch wrapper for the EXP Check tab. Multi-customer as of
// 2026-08-02 -- pass `customer` ('pretzilla' | 'bernatellos') alongside
// dayWindow; defaults to 'pretzilla' for backward compatibility.
// Mirrors the pattern used by wrPickCheck.js / jdfPutaways.js.

export const EXP_CHECK_CUSTOMERS = [
  { key: 'pretzilla', label: 'Pretzilla' },
  { key: 'bernatellos', label: "Bernatello's" },
];

// One entry per Datex project — mirrors EXP_CHECK_PROJECTS in
// netlify/functions/lib/exp-check-digest-shared.cjs. Used by
// ExpCheckNotifySettings.jsx to render one NotifySettingsPanel per
// project (same per-project pattern as FEFO Rotation's notify settings).
// Keep this list in sync with the digest shared lib's copy if a project
// is ever added/removed.
export const EXP_CHECK_PROJECTS = [
  { id: 230, key: 'pretzilla_ken', code: 'PRETZ5', name: 'Pretzilla Kenosha', facility: 'ken', customer: 'pretzilla' },
  { id: 342, key: 'pretzilla_ken_cooler', code: 'PRTZL5', name: 'Pretzilla COOLER Kenosha', facility: 'ken', customer: 'pretzilla' },
  { id: 28, key: 'pretzilla_cal_frozen', code: 'PRETZ9', name: 'Pretzilla FROZEN Caledonia', facility: 'cal', customer: 'pretzilla' },
  { id: 145, key: 'pretzilla_cal_cooler', code: 'PRTZL9', name: 'Pretzilla COOLER Caledonia', facility: 'cal', customer: 'pretzilla' },
  { id: 297, key: 'pretzilla_mad', code: 'PRETZ1', name: 'Pretzilla - CSW-Madison', facility: 'mad', customer: 'pretzilla' },
  { id: 336, key: 'pretzilla_mad_dry', code: 'PRETD1', name: 'Pretzilla - Dry - CSW-Madison', facility: 'mad', customer: 'pretzilla' },
  { id: 282, key: 'bernatellos_mad', code: 'BERNA1', name: "Bernatello's - CSW-Madison", facility: 'mad', customer: 'bernatellos' },
  { id: 320, key: 'bernatellos_wr', code: 'BERNA3', name: "Bernatello's - Wisconsin Rapids", facility: 'wr', customer: 'bernatellos' },
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
