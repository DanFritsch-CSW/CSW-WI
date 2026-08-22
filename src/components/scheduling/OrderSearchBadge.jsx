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
// UPDATED 2026-08-22 (later) after Kay hit a false positive: a reference
// number coincidentally matched an unrelated, long-Completed order for a
// different customer. Now passes owner/project (the draft's currently
// selected values) through to searchOrder(), so the backend can scope the
// match to the specific customer/project being worked on and exclude
// closed orders — see scheduling-order-search.cjs's header for the full
// story. owner/project are also in the debounce effect's dependency
// array, so changing either after typing a reference re-checks
// automatically rather than leaving a stale result on screen.
//
// PHASE 2 added 2026-08-22 (later still): displays requestedShipDate and
// notes in the found badge, and calls the new onOrderFound(order) prop
// once per distinct match (tracked via notifiedOrderIdRef, so it fires
// exactly once even though the debounce effect can re-run for unrelated
// reasons) — PluginView.jsx uses this to auto-fill the appointment's
// Notes field with the ship date + order notes pulled from Datex. This
// component itself never touches the Notes field directly; it only
// reports what it found and lets the parent decide whether/how to use it
// (e.g. not clobbering notes the user already typed).
//
// The old PluginOrderSearchTab.jsx file is left in place (no file-delete
// tool) but is no longer imported or rendered anywhere — dead code, same
// convention as other superseded files in this app (see netlify.toml's
// dockcounts-digest-run.cjs note for a prior example of this pattern).

const DEBOUNCE_MS = 600

function formatShipDate(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthName = months[parseInt(m, 10) - 1] || m
  return `${monthName} ${parseInt(d, 10)}, ${y}`
}

export default function OrderSearchBadge({ reference, owner, project, onOrderFound }) {
  const [status, setStatus] = useState('idle') // idle | loading | found | notfound | error
  const [result, setResult] = useState(null)
  const debounceRef = useRef(null)
  const requestRef = useRef(0)
  const notifiedOrderIdRef = useRef(null)

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
      searchOrder(trimmed, owner, project)
        .then((data) => {
          if (requestRef.current !== token) return // a newer keystroke superseded this search
          if (data.found && data.orders?.length) {
            const order = data.orders[0]
            setStatus('found')
            setResult(order)
            if (onOrderFound && notifiedOrderIdRef.current !== order.orderId) {
              notifiedOrderIdRef.current = order.orderId
              onOrderFound(order)
            }
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
  }, [reference, owner, project])

  if (status === 'idle' || status === 'error') return null

  if (status === 'loading') {
    return <p className="text-[11px] text-gray-400 mt-1">Checking Datex…</p>
  }

  if (status === 'notfound') {
    return (
      <div className="mt-1 px-2 py-1.5 rounded-lg text-[11px] border bg-amber-50 border-amber-200 text-amber-800">
        ⚠ No matching active order found in Datex{owner ? ` for ${owner}` : ''}
        {project && project !== owner ? ` / ${project}` : ''}.
      </div>
    )
  }

  // found
  const parts = [result.ownerName, result.projectName, result.warehouseName].filter(Boolean)
  const shipDateLabel = formatShipDate(result.requestedShipDate)
  return (
    <div className="mt-1 px-2 py-1.5 rounded-lg text-[11px] border bg-green-50 border-green-200 text-green-800">
      <div>
        ✓ Found in Datex{parts.length ? ` — ${parts.join(' / ')}` : ''}
        {result.statusName ? ` (${result.statusName})` : ''}
        {result.backOrder && <span className="ml-1 font-semibold text-amber-700">⚠ Back order</span>}
      </div>
      {shipDateLabel && <div className="mt-0.5 text-green-700">Requested Ship Date: {shipDateLabel}</div>}
      {result.notes && <div className="mt-0.5 text-green-700 break-words">Order Notes: {result.notes}</div>}
    </div>
  )
}
