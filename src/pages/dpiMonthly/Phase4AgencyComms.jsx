import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { colors, cardStyle, buttonPrimary } from './dpiMonthlyStyles.js'

// Phase 4 — Agency comms. Real build, 2026-09-28 (from the JW<>DF DPI
// Monthly Build call): one real Front draft per agency (not per
// facility), via the new netlify/functions/dpi-send-agency-comm.cjs.
//
// Recipients come from dpi_agency_contacts (AgencyContactList.jsx) — an
// agency's Primary + Delivery + Alternate emails, deduplicated, per Jen's
// explicit ask ("email H, H, N, N, W" — all three, not just one). An
// agency with no contact on file at all shows a clear "no contact" state
// here rather than silently sending nowhere or failing invisibly — Jen
// needs to know to go add it in Agency Contacts before it can be sent.
//
// Carrier name (Echo Brook / J&J) is the same facility config already
// established for A15/A16.
//
// 2026-09-25 FIX (A12, kept from the simulated version): the original
// design required clicking "Mark confirmed" on every single agency before
// Phase 5 unlocked — Dan's own words: "unbearable" and "stupid," not
// viable at 70 orders. Real volume is 1-2 reschedule requests a month;
// everything else needs zero action. "Continue to Phase 5" unlocks as
// soon as comms are sent, no per-agency gate. The per-row "Flag
// reschedule" control is purely informational and never blocks advancing.
const CARRIER_NAMES = { 'Eau Claire': 'Echo Brook', Madison: 'J&J' }

export default function Phase4AgencyComms({ cycle, onAdvance }) {
  const [stops, setStops] = useState([])
  const [contactsByAgency, setContactsByAgency] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [sendingAll, setSendingAll] = useState(false)
  const [sendResults, setSendResults] = useState({}) // stopId -> { status, error?, recipients? }

  const loadStops = useCallback(async () => {
    if (!supabase || !cycle) { setLoading(false); return }
    setLoading(true)

    const { data: routeRows, error: routesErr } = await supabase
      .from('dpi_routes')
      .select('id, route_number, delivery_date, deliver_day')
      .eq('cycle_id', cycle.id)
    if (routesErr) console.error('load routes:', routesErr)

    const routeIds = (routeRows || []).map((r) => r.id)
    const routeById = new Map((routeRows || []).map((r) => [r.id, r]))

    if (routeIds.length === 0) { setStops([]); setLoading(false); return }

    const { data: stopRows, error: stopsErr } = await supabase
      .from('dpi_route_stops')
      .select('*')
      .in('route_id', routeIds)
      .order('agency_number')
    if (stopsErr) console.error('load stops:', stopsErr)

    setStops((stopRows || []).map((s) => {
      const route = routeById.get(s.route_id)
      return { ...s, route_number: route?.route_number, delivery_date: route?.delivery_date, deliver_day: route?.deliver_day }
    }))

    const { data: contactRows, error: contactsErr } = await supabase
      .from('dpi_agency_contacts')
      .select('*')
      .eq('facility', cycle.facility)
    if (contactsErr) console.error('load agency contacts:', contactsErr)
    setContactsByAgency(new Map((contactRows || []).map((c) => [c.agency_number, c])))

    setLoading(false)
  }, [cycle])

  useEffect(() => { loadStops() }, [loadStops])

  const recipientsFor = (agencyNumber) => {
    const c = contactsByAgency.get(agencyNumber)
    if (!c) return []
    return [c.primary_email, c.delivery_email, c.alt_email].filter(Boolean)
  }

  const windowStrFor = (stop) => {
    if (!stop.delivery_window_start) return null
    return stop.delivery_window_end ? `${stop.delivery_window_start} - ${stop.delivery_window_end}` : stop.delivery_window_start
  }

  // Sends one agency's real comms draft. Returns true/false so sendAll
  // can decide whether to keep going (it always does — one bad agency
  // shouldn't block the rest).
  const sendOne = async (stop) => {
    const recipients = recipientsFor(stop.agency_number)
    if (recipients.length === 0) {
      setSendResults((prev) => ({ ...prev, [stop.id]: { status: 'failed', error: 'No contact on file — add this agency in Agency Contacts first.' } }))
      return false
    }
    try {
      const res = await fetch('/.netlify/functions/dpi-send-agency-comm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyNumber: stop.agency_number,
          agencyName: stop.agency_name,
          facility: cycle.facility,
          monthKey: cycle.month_key,
          deliverDayLabel: stop.deliver_day,
          windowStr: windowStrFor(stop),
          carrierName: CARRIER_NAMES[cycle.facility] || null,
          recipientEmails: recipients,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setSendResults((prev) => ({ ...prev, [stop.id]: { status: 'failed', error: data.error || 'Unknown error' } }))
        return false
      }
      setSendResults((prev) => ({ ...prev, [stop.id]: { status: 'success', recipients: data.recipients } }))
      if (supabase) {
        await supabase.from('dpi_route_stops').update({ comms_sent_at: new Date().toISOString() }).eq('id', stop.id)
      }
      return true
    } catch (err) {
      setSendResults((prev) => ({ ...prev, [stop.id]: { status: 'failed', error: err.message } }))
      return false
    }
  }

  const sendAll = async () => {
    setSendingAll(true)
    try {
      for (const stop of stops) {
        if (stop.comms_sent_at) continue // already sent — a repeat "Send all" only picks up the rest
        await sendOne(stop) // sequential, not parallel — avoid hammering Front's drafts API across dozens of agencies at once
      }
      await loadStops()
    } finally {
      setSendingAll(false)
    }
  }

  // Purely informational — flips a visible flag for the rare agency that
  // actually requests a reschedule after comms go out. Never gates
  // advancing to Phase 5.
  const toggleRescheduleFlag = async (stopId, current) => {
    const next = current === 'confirmed' ? 'pending' : 'confirmed'
    setStops((prev) => prev.map((s) => (s.id === stopId ? { ...s, confirmation_status: next } : s)))
    if (!supabase) return
    const { error } = await supabase
      .from('dpi_route_stops')
      .update({ confirmation_status: next, updated_at: new Date().toISOString() })
      .eq('id', stopId)
    if (error) console.error('toggle reschedule flag:', error)
  }

  // A stop with no contact on file can never get comms_sent_at (sendOne
  // refuses it outright) -- without this exception, one missing contact
  // would permanently block "Continue to Phase 5" for the whole cycle.
  // The no-contact banner above still makes it visible; this just stops
  // it from being a hard blocker Jen can't work around while chasing down
  // a contact separately.
  const allSent = stops.length > 0 && stops.every((s) => s.comms_sent_at || recipientsFor(s.agency_number).length === 0)
  const rescheduleCount = stops.filter((s) => s.confirmation_status === 'confirmed').length
  const noContactCount = stops.filter((s) => recipientsFor(s.agency_number).length === 0).length

  const advance = async () => {
    if (!supabase || !cycle) return
    const { error } = await supabase
      .from('dpi_monthly_cycles')
      .update({ current_phase: 5, updated_at: new Date().toISOString() })
      .eq('id', cycle.id)
    if (error) { console.error('advance to phase 5:', error); return }
    onAdvance()
  }

  if (loading) return <div style={{ fontSize: 13, color: colors.textFaint }}>Loading agency comms…</div>

  if (stops.length === 0) {
    return <div style={{ fontSize: 13, color: colors.textFaint }}>No routes built yet — go back to Route Build first.</div>
  }

  return (
    <div>
      {noContactCount > 0 && (
        <div style={{ ...cardStyle, marginBottom: 16, border: `1px solid ${colors.warning}`, background: colors.warningBg }}>
          <div style={{ fontSize: 13, color: colors.warning }}>
            {noContactCount} agenc{noContactCount === 1 ? 'y has' : 'ies have'} no contact on file — go to <b>Agency Contacts</b> to add {noContactCount === 1 ? 'it' : 'them'} before sending.
          </div>
        </div>
      )}

      <div style={{ ...cardStyle, padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 80px 1.4fr 130px 140px', padding: '10px 16px', fontSize: 12, color: colors.textFaint, borderBottom: `1px solid ${colors.border}` }}>
          <div>Route</div>
          <div>Agency</div>
          <div>Cases</div>
          <div>Recipients</div>
          <div>Comms</div>
          <div>Reschedule</div>
        </div>
        {stops.map((s) => {
          const recipients = recipientsFor(s.agency_number)
          const result = sendResults[s.id]
          return (
            <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 80px 1.4fr 130px 140px', padding: '11px 16px', fontSize: 13, borderBottom: `1px solid ${colors.border}`, alignItems: 'center' }}>
              <div style={{ color: colors.textFaint }}>{s.route_number}</div>
              <div>{s.agency_name}</div>
              <div style={{ color: colors.textMuted }}>{s.total_cases ?? '—'}</div>
              <div style={{ fontSize: 11, color: recipients.length === 0 ? colors.warning : colors.textMuted }}>
                {recipients.length === 0 ? 'No contact on file' : recipients.join(', ')}
              </div>
              <div style={{ fontSize: 12 }}>
                {s.comms_sent_at && <span style={{ color: colors.success }}>Sent</span>}
                {!s.comms_sent_at && result?.status === 'failed' && <span style={{ color: colors.danger }} title={result.error}>Failed</span>}
                {!s.comms_sent_at && !result && <span style={{ color: colors.textFaint }}>Not sent</span>}
              </div>
              <div>
                <button
                  onClick={() => toggleRescheduleFlag(s.id, s.confirmation_status)}
                  disabled={!s.comms_sent_at}
                  title="Only click this if the agency actually asked to reschedule — everything else needs no action"
                  style={{
                    fontSize: 12, padding: '4px 10px', borderRadius: 5,
                    border: `1px solid ${s.confirmation_status === 'confirmed' ? colors.warning : colors.border}`,
                    background: s.confirmation_status === 'confirmed' ? colors.warningBg : 'transparent',
                    color: s.confirmation_status === 'confirmed' ? colors.warning : colors.textFaint,
                    cursor: s.comms_sent_at ? 'pointer' : 'default',
                    opacity: s.comms_sent_at ? 1 : 0.4,
                  }}
                >
                  {s.confirmation_status === 'confirmed' ? 'Reschedule requested' : 'Flag reschedule'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {!allSent && (
          <button onClick={sendAll} disabled={sendingAll} style={{ ...buttonPrimary, opacity: sendingAll ? 0.5 : 1 }}>
            {sendingAll ? 'Sending…' : 'Send all agency comms'}
          </button>
        )}
        {allSent && (
          <button onClick={advance} style={buttonPrimary}>
            Continue to Phase 5 — Final push
          </button>
        )}
        <span style={{ fontSize: 12, color: colors.textFaint }}>
          {allSent && rescheduleCount > 0 && `${rescheduleCount} agenc${rescheduleCount === 1 ? 'y has' : 'ies have'} requested a reschedule — handle before or after continuing, your call.`}
        </span>
      </div>
      {!allSent && (
        <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 8 }}>
          Creates one Front draft per agency in the DPI Orders inbox — review and send from there. Agencies with no contact on file are skipped; add them in Agency Contacts and click "Send all agency comms" again to pick up just the rest.
        </div>
      )}
    </div>
  )
}
