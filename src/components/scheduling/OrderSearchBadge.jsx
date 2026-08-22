import { useState, useEffect, useRef } from 'react'
import { searchOrder } from '../../lib/schedulingApi.js'

// OrderSearchBadge — added 2026-08-22, replacing the standalone "Order
// Search" tab per Dan's direct feedback: Kay shouldn't have to switch
// tabs and re-type a reference to check Datex — the check belongs right
// on the Reference # field she's already filling in for the appointment.
//
// Debounces on the current reference_number value and silently checks
// Datex in the background (same scheduling-order-search.cjs /
// searchOrder() this replaces the tab UI for), showing a compact
// found/not-found badge directly under the field. No manual "Search"
// button, no separate screen — it just tells you as you type.
//
// The old PluginOrderSearchTab.jsx file is left in place (no file-delete
// tool) but is no longer imported or rendered anywhere — dead code, same
// convention as other superseded files in this app (see netlify.toml's
// dockcounts-digest-run.cjs note for a prior example of this pattern).

const DEBOUNCE_MS = 600

export default function OrderSearchBadge({ reference }) {
  const [status, setStatus] = useState('idle') // idle | loading | found | notfound | error
  const [result, setResult] = useState(null)
  const debounceRef = useRef(null)
  const requestRef = useRef(0)

  useEffect(() => {
    const trimmed = (reference || '').trim()
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!trimmed) {
      setStatus('idle')
      setResult(null)
      return
    }

    setStatus('loading')
    debounceRef.current = setTimeout(() => {
      const token = ++requestRef.current
      searchOrder(trimmed)
        .then((data) => {
          if (requestRef.current !== token) return // a newer keystroke superseded this search
          if (data.found && data.orders?.length) {
            setStatus('found')
            setResult(data.orders[0])
          } else {
            setStatus('notfound')
            setResult(null)
          }
        })
        .catch(() => {
          if (requestRef.current !== token) return
          // Stay quiet on transient errors (network hiccup, MotherDuck
          // cold start) rather than blocking the form with a scary
          // message for something that isn't the user's problem.
          setStatus('error')
          setResult(null)
        })
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [reference])

  if (status === 'idle' || status === 'error') return null

  if (status === 'loading') {
    return <p className="text-[11px] text-gray-400 mt-1">Checking Datex…</p>
  }

  if (status === 'notfound') {
    return (
      <div className="mt-1 px-2 py-1.5 rounded-lg text-[11px] border bg-amber-50 border-amber-200 text-amber-800">
        ⚠ No matching order found in Datex for this reference.
      </div>
    )
  }

  // found
  const parts = [result.ownerName, result.projectName, result.warehouseName].filter(Boolean)
  return (
    <div className="mt-1 px-2 py-1.5 rounded-lg text-[11px] border bg-green-50 border-green-200 text-green-800">
      ✓ Found in Datex{parts.length ? ` — ${parts.join(' / ')}` : ''}
      {result.statusName ? ` (${result.statusName})` : ''}
      {result.backOrder && <span className="ml-1 font-semibold text-amber-700">⚠ Back order</span>}
    </div>
  )
}
