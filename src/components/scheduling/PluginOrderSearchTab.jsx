import { useState } from 'react'
import { searchOrder } from '../../lib/schedulingApi.js'

// PluginOrderSearchTab — Kenosha Order Search, Phase 1. Added 2026-08-21
// per Dan/Kay's 2026-08-20 meeting. Self-contained (no shared state with
// the rest of PluginView needed), matching the presentational-component
// pattern already used for PluginLoadContainerTab/PluginMultiApptTab.
//
// Deliberately shows ONLY existence + identifying info (owner/project/
// warehouse/status) for now, per the meeting's explicit phasing — even
// though scheduling-order-search.cjs already returns
// requestedDeliveryDate/notes in the response. Phase 2 is adding those two
// fields to the card below; no new fetch or backend work needed when that
// happens, only this display decision.

export default function PluginOrderSearchTab() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('idle') // idle | loading | done | error
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function handleSearch() {
    const trimmed = query.trim()
    if (!trimmed) return
    setStatus('loading')
    setError(null)
    setResult(null)
    try {
      const data = await searchOrder(trimmed)
      setResult(data)
      setStatus('done')
    } catch (e) {
      setError(e.message)
      setStatus('error')
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleSearch()
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Order Reference</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Owner ref, vendor ref, or lookup code"
            className="flex-1 text-sm text-gray-900 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
          />
          <button
            onClick={handleSearch}
            disabled={status === 'loading' || !query.trim()}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {status === 'loading' ? 'Searching…' : 'Search'}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-1">Checks owner reference, vendor reference, and lookup code in Datex.</p>
      </div>

      {error && <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {status === 'done' && result && !result.found && (
        <div className="px-3 py-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
          <p className="font-semibold">Not found in Datex</p>
          <p className="text-xs mt-0.5 text-amber-700">No order matched "{result.query}" on owner reference, vendor reference, or lookup code.</p>
        </div>
      )}

      {status === 'done' && result && result.found && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-green-700">
            {result.count} match{result.count !== 1 ? 'es' : ''} found
          </p>
          {result.orders.map((o) => (
            <div key={o.orderId} className="border border-gray-200 rounded-lg p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-gray-900 break-all">{o.lookupCode || `Order #${o.orderId}`}</span>
                {o.statusName && (
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {o.statusName}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600">
                {o.ownerName && (
                  <div>
                    <span className="text-gray-400">Owner:</span> {o.ownerName}
                  </div>
                )}
                {o.projectName && (
                  <div>
                    <span className="text-gray-400">Project:</span> {o.projectName}
                  </div>
                )}
                {o.warehouseName && (
                  <div>
                    <span className="text-gray-400">Warehouse:</span> {o.warehouseName}
                  </div>
                )}
                {o.ownerReference && (
                  <div>
                    <span className="text-gray-400">Owner Ref:</span> {o.ownerReference}
                  </div>
                )}
                {o.vendorReference && (
                  <div>
                    <span className="text-gray-400">Vendor Ref:</span> {o.vendorReference}
                  </div>
                )}
              </div>
              {o.backOrder && <p className="text-[11px] text-amber-600 font-medium">⚠ Back order</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
