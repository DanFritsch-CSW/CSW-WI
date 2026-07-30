// Fetch wrapper for the Madison Dock Counts on-demand tab.
// Mirrors the fetch-wrapper convention used by wrPickCheck.js / wrCasesToPick.js —
// thin POST wrapper, throws on non-2xx so the component's own try/catch controls
// the loading/error UI.

export async function fetchDockCounts(date) {
  const res = await fetch('/.netlify/functions/motherduck-dock-counts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `Dock counts fetch failed (${res.status})`)
  }
  return res.json()
}

// DOCK_ROWS — display order/labels for the 3 known docks. Kept here (not
// just in the .cjs digest function) so the on-screen tab and the Front
// digest always show the same row order/labels without drifting apart.
export const DOCK_ROWS = [
  { key: 'dock8', label: 'Dock 8' },
  { key: 'east', label: 'East' },
  { key: 'west', label: 'West' },
]

// formatHeaderDate — matches the ops manager's own phrasing
// ("Looking ahead to tomorrow, ...").
export function formatHeaderDate(isoDateStr) {
  const d = new Date(isoDateStr + 'T00:00:00Z')
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`
}

// buildDockCountsMessage — same code-block layout the Front digest posts
// (netlify/functions/dockcounts-digest-run.cjs's buildDigestBody), so the
// "Copy message" button on the tab produces byte-identical text to what
// the automated digest would send once Dan re-enables it.
export function buildDockCountsMessage(isoDateStr, docks) {
  const pad = (str, len) => String(str).padEnd(len, ' ')
  const lines = []
  lines.push(`Looking ahead to ${formatHeaderDate(isoDateStr)}:`)
  lines.push('')
  lines.push('```')
  lines.push(`${pad('', 10)}IN    OUT`)
  for (const row of DOCK_ROWS) {
    const d = docks?.[row.key] || { in: 0, out: 0 }
    lines.push(`${pad(row.label, 10)}${pad(d.in, 6)}${d.out}`)
  }
  lines.push('```')
  if (docks?.other && (docks.other.in > 0 || docks.other.out > 0)) {
    lines.push('')
    lines.push(`Note: ${docks.other.in + docks.other.out} load(s) at an unrecognized dock/location.`)
  }
  return lines.join('\n')
}
