import { useState, useEffect } from 'react'
import CoachingDashboard from './CoachingDashboard.jsx'

// CoachingTab — HR sub-tab (added 2026-08-17). Wraps Tim Morris's own
// Coaching Dashboard prototype (sent via Front, cnv_1c58erkk, built by
// him with Claude's help) so it fetches live from SharePoint instead of
// his original workflow (download xlsx -> run xlsx_to_json.py locally ->
// commit coaching-data.json -> rebuild app). CoachingDashboard.jsx itself
// is UNCHANGED design/logic-wise — only the static JSON import was
// removed so it takes data as a prop instead, which the component already
// supported.
//
// Read-only, deliberately: per Tim's own documented workflow (see his
// README), edits happen in Excel (add a session row) or by asking Claude
// directly to pull a Fathom transcript and draft the recap/homework/LOE
// fields — not through this dashboard.
//
// BLOCKED as of 2026-08-17: SHAREPOINT_COACHING_URL not set — Tim needs
// to confirm whether this workbook is on SharePoint yet. Preview fallback
// below is the exact output of the live parser run against Tim's own
// uploaded workbook — Alex Andino is explicitly labeled a "worked
// example supplied by Claude, not real data" in Tim's own README, so it's
// safe to ship as the fallback rather than inventing separate placeholder
// data.

const FN_BASE = '/.netlify/functions/sharepoint-coaching'

const PREVIEW_DATA = {
  source: 'Coaching_Dashboard_Data.xlsx (preview — worked example, not live)',
  generatedAt: new Date().toISOString(),
  pendingProcessing: 0,
  managers: [
    {
      name: 'Alex Andino',
      title: 'Operations Manager',
      team: 'Wisconsin Rapids',
      active: true,
      sessionCount: 1,
      sessions: [
        {
          row: 3,
          manager: 'Alex Andino',
          date: '2026-08-11',
          fathomUrl: 'https://fathom.video/calls/123456789',
          recap: 'Alex is out of the freezer noticeably more than last month and is answering on Front the same day. The 1on1s with Bryan and Robert are on the calendar and both happened. Customer communication has not started - Alex is still routing everything through Andrew rather than owning the reply.',
          lastHomework: 'Schedule bi-weekly 1on1 check-ins with Robert and Bryan.',
          lastHomeworkItems: ['Schedule bi-weekly 1on1 check-ins with Robert and Bryan.'],
          hwCompletion: 'Complete',
          loes: [
            { n: 1, goal: "Communicate on Front / don't get stuck in freezer", status: 'On Track', notes: 'Front response time is much better. Still defaults to the freezer when it gets busy - watch this.' },
            { n: 2, goal: 'Coach Bryan/Robert in reg 1on1 sessions', status: 'On Track', notes: 'Both 1on1s happened and Alex came with an agenda. Next step is written follow-ups.' },
            { n: 3, goal: 'Take on customer-communication', status: 'At Risk', notes: "Hasn't started. Needs Andrew to hand off two accounts so Alex has something real to own." },
          ],
          overallComment: 'Progressing on LOE 1/2, need Andrew to help with customer communication',
          processingStatus: 'Processed',
        },
      ],
      latest: null, // filled in below to avoid duplicating the object
    },
  ],
}
PREVIEW_DATA.managers[0].latest = PREVIEW_DATA.managers[0].sessions[0]

async function fetchDashboardData() {
  const res = await fetch(FN_BASE)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

export default function CoachingTab() {
  const [data, setData] = useState(null)
  const [live, setLive] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchDashboardData()
      .then((d) => {
        if (cancelled) return
        setData(d)
        setLive(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setData(PREVIEW_DATA)
        setLive(false)
      })
    return () => { cancelled = true }
  }, [])

  if (!data) {
    return (
      <div className="stub-page" style={{ opacity: 0.6, marginTop: 16 }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading coaching data…</p>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 16 }}>
      {!live && (
        <div className="omni-warning-banner" style={{ marginBottom: 12 }}>
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">
            Preview data (Tim's own worked example, not live) — SharePoint connection not yet configured{error ? ` (${error})` : ''}. Add
            {' '}<code>SHAREPOINT_COACHING_URL</code> in Netlify env vars to go live.
          </span>
        </div>
      )}
      <CoachingDashboard data={data} />
    </div>
  )
}
