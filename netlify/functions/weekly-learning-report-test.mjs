// Manual trigger for the weekly learning report (no schedule). POST with
// ?dry=1 returns the text without posting anything; without it, REALLY
// creates the Front task for Dan.
import { runWeeklyReport } from './lib/weekly-learning-report-shared.mjs'

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  try {
    const dry = new URL(req.url).searchParams.get('dry') === '1'
    const result = await runWeeklyReport({ dry })
    return new Response(JSON.stringify({ success: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
}
