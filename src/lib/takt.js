// Thin fetch wrapper for the top-level Takt tab (added 2026-08-02).
// Mirrors the wrPickCheck.js / wrCasesToPick.js convention — one function
// per shape, no client-side caching. Backed by
// netlify/functions/motherduck-takt-daily.cjs (separate from
// managerBonus.js's fetchLiveTakt, which powers the Manager tab's
// quarterly bonus scorecard and is untouched by this file).

const FN = '/.netlify/functions/motherduck-takt-daily'

// Facility-level rollup for all 5 facilities on a given day.
export async function fetchTaktDaily(date) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  })
  if (!res.ok) throw new Error((await res.text()) || `${res.status}`)
  return res.json()
}

// Same facility rollup PLUS a per-employee breakdown for one facility,
// sorted Performance highest → lowest.
export async function fetchTaktDailyByFacility(date, facility) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, facility }),
  })
  if (!res.ok) throw new Error((await res.text()) || `${res.status}`)
  return res.json()
}
