import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { colors, cardStyle, buttonPrimary, buttonSuccess } from './dpiMonthlyStyles.js'
import { computeLoadDateStr, formatDateShort, formatTimeDisplay } from './dpiCalendarUtils.js'

// Phase 5 — Final push. Real build, shipped 2026-09-25 (A13-A16):
// send to carrier (Front draft, PDF attached) -> push real Datex load
// containers + dock appointments, one of each per scheduled route ->
// "Start next month" resets the cycle. This is the ONLY place that
// button belongs — see the 2026-09-06 fix that removed it from Phase 1.
//
// A13/A14 (route sheet PDF): reuses the EXACT SAME
// dpi-carrier-route-sheet-pdf.cjs endpoint A1 already built for Phase 2's
// carrier-confirmation PDF. No new PDF code.
//
// 2026-09-25 FIX: the first version of this had a separate, standalone
// "Generate route sheet" step/button as the very first thing this page
// showed — Dan flagged it as unnecessary: the route sheet content is
// already the same document A1 generates back in Route Build, so making
// a person click through a whole extra step to produce it again here,
// before they can even get to sending it, was pure friction with no
// actual decision attached to it. Folded PDF generation directly into
// "Send to carrier" below — one click does both (generate fresh, then
// attach and create the Front draft) — rather than two sequential
// gated steps. The route summary/preview table now shows immediately on
// load too, not gated behind a "generate" click, since it only ever
// read from state that was already loaded anyway.
//
// A15 (send to carrier): a brand-new Front draft (NOT a reply — there's no
// existing conversation this attaches to), via
// netlify/functions/dpi-send-carrier-final.cjs, POSTing to Front's
// POST /channels/{channel_id}/drafts endpoint with the PDF as a multipart
// attachment. Deliberately a DRAFT, never an auto-send, per this app's
// standing rule for anything customer/carrier-facing. Recipient is an
// editable field, pre-filled with Echo Brook's known address for Eau
// Claire — J&J's Madison contact wasn't confirmed as of this build (Front
// search came up empty under every name variation tried), so it starts
// blank there and needs a one-time manual fill until that's sorted out.
//
// A16 (real Datex push): one load container + one dock appointment per
// scheduled ROUTE (one truck departure — not per stop, confirmed with
// Dan), via netlify/functions/dpi-final-push.cjs. Reuses the EXISTING,
// already-hardened scheduling-create-load-container.cjs endpoint for the
// load container step (same ambiguous-timeout tracking already proven out
// for the Scheduling plugin) and calls pushToDatex directly from
// datex-push-shared.cjs for the appointment step. Facility config
// (carrier/owner/project/dock door IDs) confirmed live against
// production_db.gold.truck_appointments' real DPI outbound history —
// Madison's dock door is Dan's explicit choice, which differs from what
// that history actually shows being used — see the DPI Monthly Notion
// page for that discrepancy. Pushed sequentially per route, never in
// parallel, to avoid hammering the load-container endpoint concurrently.
// A route already at final_push_status='success' is skipped on a repeat
// "Push all" click — never re-pushed, since that would create a
// duplicate Datex appointment.
//
// "Start next month" no longer requires a real Datex success on every
// route to unlock — a dry-run result (no DATEX_CLIENT_ID configured, the
// current environment) counts too, since otherwise this button could
// never unlock at all during testing. A genuinely FAILED push still
// blocks it.
export default function Phase5FinalPush({ cycle, onCycleComplete }) {
  const [routes, setRoutes] = useState([])
  const [loading, setLoading] = useState(true)
  const [phaseData, setPhaseData] = useState(cycle?.phase_data || {})
  const [recipientEmail, setRecipientEmail] = useState('')
  const [sendingCarrier, setSendingCarrier] = useState(false)
  const [lastPdfUrl, setLastPdfUrl] = useState(null) // optional convenience download of whatever was last sent
  const [pushingRouteIds, setPushingRouteIds] = useState(new Set())
  const [routePushResults, setRoutePushResults] = useState({}) // routeId -> { status, error?, appointmentId?, loadContainerId? }
  const [pushingAll, setPushingAll] = useState(false)

  // Only known carrier contact so far — Echo Brook (EC). J&J's Madison
  // contact wasn't confirmed as of this build; starts blank there.
  const RECIPIENT_DEFAULTS = { 'Eau Claire': 'echobrk@yahoo.com', Madison: '' }

  const loadRoutes = useCallback(async () => {
    if (!supabase || !cycle) { setLoading(false); return }
    setLoading(true)

    const { data: routeRows, error: routesErr } = await supabase
      .from('dpi_routes')
      .select('*')
      .eq('cycle_id', cycle.id)
      .order('route_number')
    if (routesErr) console.error('load routes:', routesErr)

    const routeIds = (routeRows || []).map((r) => r.id)
    let stopRows = []
    if (routeIds.length > 0) {
      const { data, error } = await supabase
        .from('dpi_route_stops')
        .select('*')
        .in('route_id', routeIds)
        .order('sequence')
      if (error) console.error('load stops:', error)
      stopRows = data || []
    }

    setRoutes((routeRows || []).map((r) => ({
      ...r,
      stops: stopRows.filter((s) => s.route_id === r.id),
    })))
    setPhaseData(cycle.phase_data || {})
    setLoading(false)
  }, [cycle])

  useEffect(() => { loadRoutes() }, [loadRoutes])
  useEffect(() => { setRecipientEmail(RECIPIENT_DEFAULTS[cycle?.facility] || '') }, [cycle?.facility])

  const updatePhaseData = async (patch) => {
    const next = { ...phaseData, ...patch }
    setPhaseData(next)
    if (!supabase || !cycle) return
    const { error } = await supabase
      .from('dpi_monthly_cycles')
      .update({ phase_data: next, updated_at: new Date().toISOString() })
      .eq('id', cycle.id)
    if (error) console.error('update phase_data:', error)
  }

  // Chunked to avoid a call-stack blowup on String.fromCharCode(...bytes)
  // for a PDF of any real size.
  function arrayBufferToBase64(buffer) {
    let binary = ''
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
    }
    return btoa(binary)
  }

  // A13/A14 — builds the same PDF A1 already produces in Phase 2. Called
  // directly from sendToCarrier below, not exposed as its own step/button —
  // per Dan, a standalone "generate" click before sending was pure friction
  // with no decision attached to it, since the document is the same one
  // already generated in Route Build.
  const buildRouteSheetPdfBase64 = async () => {
    const payloadRoutes = routes
      .filter((r) => r.delivery_date)
      .sort((a, b) => a.route_number.localeCompare(b.route_number, undefined, { numeric: true }))
      .map((route) => {
        const stopPayload = route.stops.map((s) => ({
          time: s.delivery_window_end ? `${s.delivery_window_start} - ${s.delivery_window_end}` : (s.delivery_window_start || ''),
          agencyNumber: s.agency_number,
          agencyName: s.agency_name,
          city: s.city,
          grossWeight: Number(s.gross_weight) || 0,
          totalCases: Number(s.total_cases) || 0,
          travelTime: s.travel_time || '',
        }))
        const totalWeight = stopPayload.reduce((sum, s) => sum + s.grossWeight, 0)
        const totalCases = stopPayload.reduce((sum, s) => sum + s.totalCases, 0)
        const notesParts = (route.notes || '').split('|').map((p) => p.trim()).filter(Boolean)
        return {
          routeNumber: route.route_number,
          loadDay: route.load_day,
          loadDateStr: computeLoadDateStr(route.delivery_date, route.deliver_day, route.load_day),
          loadTimeStr: formatTimeDisplay(route.load_time),
          deliverDay: route.deliver_day,
          deliverDateStr: formatDateShort(route.delivery_date),
          departDay: route.depart_day,
          departTimeStr: formatTimeDisplay(route.depart_time),
          highlight: notesParts[0] || null,
          restNotes: notesParts.slice(1),
          stops: stopPayload,
          totalWeight,
          totalCases,
        }
      })

    if (payloadRoutes.length === 0) throw new Error('No scheduled routes to send.')

    const res = await fetch('/.netlify/functions/dpi-carrier-route-sheet-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility: cycle.facility, monthKey: cycle.month_key, routes: payloadRoutes }),
    })
    if (!res.ok) throw new Error(`PDF generation failed (${res.status})`)

    const blob = await res.blob()
    const base64 = arrayBufferToBase64(await blob.arrayBuffer())
    return { base64, blob }
  }

  // A15 — one click: build the PDF fresh, then create the Front draft with
  // it attached. Also keeps a local download link to the exact copy that
  // was sent, purely as a convenience — not a required step.
  const sendToCarrier = async () => {
    if (!recipientEmail.trim()) { alert("Enter the carrier's email address first."); return }
    setSendingCarrier(true)
    try {
      let base64, blob
      try {
        ({ base64, blob } = await buildRouteSheetPdfBase64())
      } catch (err) {
        alert(err.message)
        return
      }

      const res = await fetch('/.netlify/functions/dpi-send-carrier-final', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facility: cycle.facility, monthKey: cycle.month_key, recipientEmail: recipientEmail.trim(), pdfBase64: base64 }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        console.error('send to carrier failed:', data)
        alert(`Could not create the carrier draft: ${data.error || 'unknown error'}`)
        return
      }

      if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl)
      setLastPdfUrl(URL.createObjectURL(blob))

      await updatePhaseData({ carrierSent: true })
      alert('Draft created in Front — review and send it from there.')
    } finally {
      setSendingCarrier(false)
    }
  }

  // A16 — one route's real load container + dock appointment. Refuses
  // (server-side) to re-push a route already at final_push_status =
  // 'success', so a repeat click here is always safe.
  const pushRouteFinal = async (route) => {
    if (!route.delivery_date || !route.depart_day || !route.depart_time) {
      setRoutePushResults((prev) => ({ ...prev, [route.id]: { status: 'failed', error: 'Missing delivery date or Leave Time — set it in Route Build before pushing.' } }))
      return
    }
    setPushingRouteIds((prev) => new Set(prev).add(route.id))
    try {
      const scheduledArrivalIso = new Date(`${route.delivery_date}T${route.depart_time}`).toISOString()
      const totalCases = route.stops.reduce((sum, s) => sum + (Number(s.total_cases) || 0), 0)
      const res = await fetch('/.netlify/functions/dpi-final-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routeId: route.id,
          facility: cycle.facility,
          routeNumber: route.route_number,
          monthKey: cycle.month_key,
          scheduledArrivalIso,
          totalCases,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.dry_run) {
        setRoutePushResults((prev) => ({ ...prev, [route.id]: { status: 'dry_run' } }))
        return
      }
      if (!res.ok || !data.success) {
        setRoutePushResults((prev) => ({ ...prev, [route.id]: { status: 'failed', error: data.error || 'Unknown error' } }))
        return
      }
      setRoutePushResults((prev) => ({ ...prev, [route.id]: { status: 'success', appointmentId: data.appointmentId, loadContainerId: data.loadContainerId } }))
    } catch (err) {
      setRoutePushResults((prev) => ({ ...prev, [route.id]: { status: 'failed', error: err.message } }))
    } finally {
      setPushingRouteIds((prev) => { const next = new Set(prev); next.delete(route.id); return next })
    }
  }

  const scheduledRoutes = routes.filter((r) => r.delivery_date)

  const pushAllFinal = async () => {
    setPushingAll(true)
    try {
      for (const route of scheduledRoutes) {
        if (route.final_push_status === 'success') continue // already pushed for real — never re-push
        await pushRouteFinal(route) // sequential, not parallel — avoid hammering the load-container endpoint concurrently
      }
      await loadRoutes() // refresh final_push_status/datex ids from the DB
    } finally {
      setPushingAll(false)
    }
  }

  const allPushed = scheduledRoutes.length > 0 && scheduledRoutes.every((r) => {
    const local = routePushResults[r.id]?.status
    return r.final_push_status === 'success' || local === 'success' || local === 'dry_run'
  })

  const startNextMonth = async () => {
    if (!supabase || !cycle) return
    const { error } = await supabase
      .from('dpi_monthly_cycles')
      .update({ status: 'complete', updated_at: new Date().toISOString() })
      .eq('id', cycle.id)
    if (error) { console.error('complete cycle:', error); return }
    onCycleComplete()
  }

  if (loading) return <div style={{ fontSize: 13, color: colors.textFaint }}>Loading route sheet…</div>

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
          Final route sheet — {cycle.facility}, {cycle.month_key}
        </div>
        {scheduledRoutes.length === 0 && (
          <div style={{ fontSize: 13, color: colors.textFaint, fontStyle: 'italic' }}>No scheduled routes yet — go back to Route Build first.</div>
        )}
        {scheduledRoutes.map((route) => {
          const cases = route.stops.reduce((sum, s) => sum + (Number(s.total_cases) || 0), 0)
          const weight = route.stops.reduce((sum, s) => sum + (Number(s.gross_weight) || 0), 0)
          const pushResult = routePushResults[route.id]
          const isPushing = pushingRouteIds.has(route.id)
          return (
            <div key={route.id} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: colors.accent }}>
                  Route {route.route_number} — {cases} cases / {Math.round(weight).toLocaleString()} lb
                </div>
                <div style={{ fontSize: 11 }}>
                  {route.final_push_status === 'success' && <span style={{ color: colors.success }}>✓ Pushed — appointment {route.datex_appointment_id ?? '(no ID returned)'}</span>}
                  {route.final_push_status === 'ambiguous' && <span style={{ color: colors.warning }} title={route.final_push_error}>⚠ Ambiguous — verify in Datex</span>}
                  {!route.final_push_status && pushResult?.status === 'success' && <span style={{ color: colors.success }}>✓ Pushed — appointment {pushResult.appointmentId ?? '(no ID returned)'}</span>}
                  {pushResult?.status === 'dry_run' && <span style={{ color: colors.textFaint }}>Dry run (no Datex credentials configured)</span>}
                  {pushResult?.status === 'failed' && <span style={{ color: colors.danger }} title={pushResult.error}>✗ Failed</span>}
                  {isPushing && <span style={{ color: colors.accent, fontStyle: 'italic' }}>Pushing…</span>}
                </div>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <tbody>
                  {route.stops.map((s) => (
                    <tr key={s.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '6px 4px', color: colors.text }}>{s.agency_name}</td>
                      <td style={{ padding: '6px 4px', color: colors.textMuted }}>{s.city}</td>
                      <td style={{ padding: '6px 4px', color: colors.textMuted }}>{s.total_cases} cases</td>
                      <td style={{ padding: '6px 4px', color: s.confirmation_status === 'confirmed' ? colors.warning : colors.textFaint }}>
                        {s.confirmation_status === 'confirmed' ? 'Reschedule requested' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {!phaseData.carrierSent && (
          <>
            <input
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="Carrier email address"
              style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: `1px solid ${colors.borderStrong}`, background: colors.bg, color: colors.text, minWidth: 220 }}
            />
            <button onClick={sendToCarrier} disabled={sendingCarrier || scheduledRoutes.length === 0} style={{ ...buttonPrimary, opacity: sendingCarrier || scheduledRoutes.length === 0 ? 0.5 : 1 }}>
              {sendingCarrier ? 'Sending…' : 'Send to carrier'}
            </button>
          </>
        )}
        {phaseData.carrierSent && !allPushed && (
          <button onClick={pushAllFinal} disabled={pushingAll} style={{ ...buttonPrimary, opacity: pushingAll ? 0.5 : 1 }}>
            {pushingAll ? 'Pushing to Datex…' : 'Push final appointments to Datex'}
          </button>
        )}
        {phaseData.carrierSent && allPushed && (
          <button onClick={startNextMonth} style={buttonSuccess}>
            Start next month
          </button>
        )}
      </div>

      {phaseData.carrierSent && (
        <div style={{ fontSize: 12, color: colors.textFaint, marginBottom: 4 }}>
          Carrier draft created in Front — review and send it from there before or after pushing to Datex.
          {lastPdfUrl && <> <a href={lastPdfUrl} download={`DPI-${cycle.facility.replace(/\s+/g, '')}-${cycle.month_key}-FINAL-carrier-routes.pdf`} style={{ color: colors.accent }}>Download the sheet that was sent</a>.</>}
        </div>
      )}
      {phaseData.carrierSent && !allPushed && (
        <div style={{ fontSize: 12, color: colors.textFaint }}>
          One load container + one dock appointment is created per route. A route already pushed successfully is skipped on a repeat click — never re-pushed.
        </div>
      )}
    </div>
  )
}
