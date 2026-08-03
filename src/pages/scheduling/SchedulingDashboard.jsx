import { useState, useEffect, useCallback } from 'react'
import { getSubmissions, getOmniEmbedUrl } from '../../lib/schedulingApi.js'
import StatusBadge from '../../components/scheduling/StatusBadge.jsx'
import ReviewModal from '../../components/scheduling/ReviewModal.jsx'
import RecurringForm from '../../components/scheduling/RecurringForm.jsx'

// Ported from front_netlify_datex/src/views/Dashboard.jsx (2026-08-03).
// Import paths updated. Changed h-screen → h-full (2026-08-03): the
// original app owned the whole browser viewport; here this mounts inside
// CSW-WI's app shell below TopNav, so a fixed viewport-height layout would
// push content off-screen. Needs a quick visual check once routing is wired
// up to confirm the surrounding container gives this a real height to fill.

const STATUS_FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'Failed', value: 'failed' },
]

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function RefreshIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  )
}

export default function Dashboard() {
  const [rightPanel, setRightPanel] = useState('submissions') // 'submissions' | 'recurring'
  const [statusFilter, setStatusFilter] = useState('all')
  const [submissions, setSubmissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [omniUrl, setOmniUrl] = useState(null)
  const [omniError, setOmniError] = useState(null)

  useEffect(() => {
    getOmniEmbedUrl()
      .then(setOmniUrl)
      .catch((e) => setOmniError(e.message))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getSubmissions({ status: statusFilter })
      setSubmissions(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col h-full bg-gray-100 overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 shrink-0 z-10">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">CSW Carrier Onboarding</h1>
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-40 transition-colors">
            <RefreshIcon />
            Refresh
          </button>
        </div>
      </header>

      {/* ── Two-panel body ──────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — Omni Labor Planning (~35%) */}
        <div className="w-[35%] min-w-[280px] flex flex-col border-r border-gray-200 bg-white">
          <div className="px-4 py-2.5 border-b border-gray-100 shrink-0">
            <h2 className="text-sm font-medium text-gray-700">Labor Planning</h2>
          </div>
          <div className="flex-1 relative">
            {omniError ? (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <p className="text-sm text-red-500 text-center">{omniError}</p>
              </div>
            ) : omniUrl ? (
              <iframe src={omniUrl} title="Labor Planning" className="absolute inset-0 w-full h-full border-0" allow="fullscreen" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-gray-400">Loading dashboard…</p>
              </div>
            )}
          </div>
        </div>

        {/* Right panel — Submissions / Recurring (~65%) */}
        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">
          <div className="px-5 py-3 border-b border-gray-200 bg-white shrink-0 flex items-center gap-3">
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              <button
                onClick={() => setRightPanel('submissions')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${rightPanel === 'submissions' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
              >
                Submissions
              </button>
              <button
                onClick={() => setRightPanel('recurring')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${rightPanel === 'recurring' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
              >
                Recurring
              </button>
            </div>

            {rightPanel === 'submissions' && (
              <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 ml-2">
                {STATUS_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    onClick={() => setStatusFilter(f.value)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${statusFilter === f.value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {rightPanel === 'recurring' ? (
            <RecurringForm />
          ) : (
            <div className="flex-1 overflow-auto px-5 py-4">
              {error && <div className="mb-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {loading ? (
                  <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
                ) : submissions.length === 0 ? (
                  <div className="py-16 text-center text-gray-400 text-sm">No {statusFilter !== 'all' ? statusFilter : ''} submissions found.</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50 text-left">
                        <th className="px-4 py-3 font-medium text-gray-600">Carrier</th>
                        <th className="px-4 py-3 font-medium text-gray-600">Warehouse</th>
                        <th className="px-4 py-3 font-medium text-gray-600">Type</th>
                        <th className="px-4 py-3 font-medium text-gray-600">Arrival</th>
                        <th className="px-4 py-3 font-medium text-gray-600">Submitted</th>
                        <th className="px-4 py-3 font-medium text-gray-600">Status</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {submissions.map((row) => (
                        <tr key={row.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 font-medium text-gray-900">{row.carrier || '—'}</td>
                          <td className="px-4 py-3 text-gray-600">{row.warehouse || '—'}</td>
                          <td className="px-4 py-3 text-gray-600">{row.type || '—'}</td>
                          <td className="px-4 py-3 text-gray-500">{row.scheduled_arrival || '—'}</td>
                          <td className="px-4 py-3 text-gray-500">{formatDate(row.created_at)}</td>
                          <td className="px-4 py-3">
                            <StatusBadge status={row.status} />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button onClick={() => setSelected(row)} className="text-indigo-600 hover:text-indigo-800 font-medium">
                              Review
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {!loading && submissions.length > 0 && (
                <p className="mt-2 text-xs text-gray-400 text-right">
                  {submissions.length} record{submissions.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <ReviewModal
          submission={selected}
          onClose={() => {
            setSelected(null)
            load()
          }}
        />
      )}
    </div>
  )
}
