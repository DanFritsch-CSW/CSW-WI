// Weekly agent learning report -- SCHEDULED path (Monday 12:00 UTC = 7am
// Central during DST; drifts to 6am Central after DST ends). Netlify Functions
// 2.0 style with the schedule declared in code, so NO netlify.toml change is
// needed. See lib/weekly-learning-report-shared.mjs for the full writeup.
// Manual runs: weekly-learning-report-test.
import { runWeeklyReport } from './lib/weekly-learning-report-shared.mjs'

export const config = { schedule: '0 12 * * 1' }

export default async () => {
  try {
    const result = await runWeeklyReport()
    return new Response(JSON.stringify({ success: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
}
