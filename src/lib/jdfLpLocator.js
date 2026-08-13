// Fetch wrapper for the JDF LP Locator tool (inside the JDF Putaways tab).
// Mirrors fetchJdfPutaways.js's thin-POST-wrapper convention. Two modes via
// optional sku param, matching motherduck-jdf-lp-locations.cjs:
//   fetchJdfMaterialList()      -> POST {}       -> { materials: [...] }
//   fetchJdfLpLocations(sku)    -> POST { sku }   -> { sku, materialName, lps, ... }

async function postJdfLpLocations(body) {
  const res = await fetch('/.netlify/functions/motherduck-jdf-lp-locations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `JDF LP Locator fetch failed (${res.status})`)
  }
  return res.json()
}

export function fetchJdfMaterialList() {
  return postJdfLpLocations({})
}

export function fetchJdfLpLocations(sku) {
  return postJdfLpLocations({ sku })
}
