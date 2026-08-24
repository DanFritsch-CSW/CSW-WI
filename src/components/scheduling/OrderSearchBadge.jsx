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
// PHASE 2 added 2026-08-22 (later still): displays date/notes info in the
// found badge, and calls the new onOrderFound(order) prop once per
// distinct match (tracked via notifiedOrderIdRef) — PluginView.jsx uses
// this to auto-fill the appointment's Notes field. This component itself
// never touches the Notes field directly; it only reports what it found
// and lets the parent decide whether/how to use it (e.g. not clobbering
// notes the user already typed).
//
// FIXED 2026-08-24 (two issues, found together after Dan/Kay reported a
// real submission with an empty Notes field despite a "Found in Datex"
// badge showing real data):
//   1. Field shape: requestedShipDate was actually a DELIVERY date, not a
//      ship date — Datex tracks these as two genuinely separate things
//      (Order vs. Shipment). Now shows requestedDeliveryDate AND
//      shipExpectedDate separately, matching scheduling-order-search.cjs's
//      corrected response shape. See that file's header for the full
//      story (confirmed against live data: order 778492 had a Sep 2
//      delivery date and a completely separate Aug 29 ship date).
//   2. Stale-ref bug: notifiedOrderIdRef never reset between different
//      Front conversations. Since the plugin panel likely stays mounted
//      as a CSR switches between emails (Front.contextUpdates just fires
//      a new conversationId, not a fresh page load), a ref that only
//      ever gets SET and never CLEARED means a second, unrelated
//      conversation that happens to reference the SAME Datex order would
//      silently skip onOrderFound — exactly the kind of gap that could
//      explain a real submission ending up with no auto-filled Notes.
//      Now resets to null whenever reference goes empty (which happens
//      on every conversation switch, per PluginView.jsx's setDraft({})
//      reset), so each new conversation gets a fresh chance.
//
// The old PluginOrderSearchTab.jsx file is left in place (no file-delete
// tool) but is no longer imported or rendered anywhere — dead code, same
// convention as other superseded files in this app (see netlify.toml's
// dockcounts-digest-run.cjs note for a prior example of this pattern).

const DEBOUNCE_MS = 600

function formatDateLabel(iso) {
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
      // Reset on every "field went blank" — this happens on every
      // conversation switch (PluginView.jsx clears draft between
      // conversations), so a stale orderId from a PREVIOUS, unrelated
      // conversation never blocks onOrderFound firing for a new one.
      notifiedOrderIdRef.current = null
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
  const deliveryDateLabel = formatDateLabel(result.requestedDeliveryDate)
  const shipDateLabel = formatDateLabel(result.shipExpectedDate || result.shipPickupDate)
  return (
    <div className="mt-1 px-2 py-1.5 rounded-lg text-[11px] border bg-green-50 border-green-200 text-green-800">
      <div>
        ✓ Found in Datex{parts.length ? ` — ${parts.join(' / ')}` : ''}
        {result.statusName ? ` (${result.statusName})` : ''}
        {result.backOrder && <span className="ml-1 font-semibold text-amber-700">⚠ Back order</span>}
      </div>
      {shipDateLabel && <div className="mt-0.5 text-green-700">Ship Date: {shipDateLabel}</div>}
      {deliveryDateLabel && <div className="mt-0.5 text-green-700">Requested Delivery Date: {deliveryDateLabel}</div>}
      {result.notes && <div className="mt-0.5 text-green-700 break-words">Order Notes: {result.notes}</div>}
    </div>
  )
}
