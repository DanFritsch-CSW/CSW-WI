import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { colors, cardStyle, buttonPrimary } from './dpiMonthlyStyles.js'

// Phase 4 — Agency comms. One simulated "send" per agency (matches the real
// design: one Front draft per agency, not one per facility).
//
// SIMULATE-ONLY: no real Front drafts/sends happen here. "Send all" just
// stamps comms_sent_at on every stop; the reschedule flag flips
// confirmation_status locally + in Supabase. No Front API calls at all.
//
// 2026-09-25 FIX (A12): the original design required clicking "Mark
// confirmed" on every single agency before Phase 5 unlocked — Dan's own
// words: "unbearable" and "stupid," not viable at 70 orders. Per Dan,
// real volume is maybe 1-2 reschedule requests a month; everything else
// needs zero action after sending. The old design had that backwards —
// it demanded an action for the common no-change case and only rewarded
// silence for the rare exception. Flipped: "Continue to Phase 5" is now
// available as soon as comms are sent, full stop — no per-agency gate at
// all. The per-row control changed from "Mark confirmed" (an action
// required for every agency) to "Flag reschedule requested" (an action
// only taken for the rare agency that actually asks for a change) —
// visible on the row, but purely informational; it has never blocked
// advancing and still doesn't. Reuses the existing confirmation_status
// column/values rather than adding a new one — 'confirmed' now carries
// the meaning "reschedule requested," which reads a little oddly in the
// column name but avoids a migration for what's just a UI framing change.

export default function Phase4AgencyComms({ cycle, onAdvance }) {
  const [stops, setStops] = useState([])
  const [loading, setLoading] = useState(true)

  const loadStops = useCallback(async () => {
    if (!supabase || !cycle) { setLoading(false); return }
    setLoading(true)

    const { data: routeRows, error: routesErr } = await supabase
      .from('dpi_routes')
      .select('id, route_number')
      .eq('cycle_id', cycle.id)
    if (routesErr) console.error('load routes:', routesErr)

    const routeIds = (routeRows || []).map((r) => r.id)
    const routeNumberById = new Map((routeRows || []).map((r) => [r.id, r.route_number]))

    if (routeIds.length === 0) { setStops([]); setLoading(false); return }

    const { data: stopRows, error: stopsErr } = await supabase
      .from('dpi_route_stops')
      .select('*')
      .in('route_id', routeIds)
      .order('agency_number')
    if (stopsErr) console.error('load stops:', stopsErr)

    setStops((stopRows || []).map((s) => ({ ...s, route_number: routeNumberById.get(s.route_id) })))
    setLoading(false)
  }, [cycle])

  useEffect(() => { loadStops() }, [loadStops])

  const sendAll = async () => {
    if (!supabase) return
    const now = new Date().toISOString()
    setStops((prev) => prev.map((s) => ({ ...s, comms_sent_at: now })))
    const { error } = await supabase
      .from('dpi_route_stops')
      .update({ comms_sent_at: now })
      .in('id', stops.map((s) => s.id))
    if (error) console.error('send all comms:', error)
  }

  // 2026-09-25 (A12): renamed from toggleConfirmed. Purely informational
  // now — flips a visible flag for the rare agency that actually requests
  // a reschedule after comms go out. Never gates advancing to Phase 5.
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

  const allSent = stops.length > 0 && stops.every((s) => s.comms_sent_at)
  const rescheduleCount = stops.filter((s) => s.confirmation_status === 'confirmed').length

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
    return <div style={{ fontSize: 13, color: colors.textFaint }}>No routes built yet — go back to Phase 2 first.</div>
  }

  return (
    <div>
      <div style={{ ...cardStyle, padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 140px 160px', padding: '10px 16px', fontSize: 12, color: colors.textFaint, borderBottom: `1px solid ${colors.border}` }}>
          <div>Route</div>
          <div>Agency</div>
          <div>Cases</div>
          <div>Comms</div>
          <div>Reschedule</div>
        </div>
        {stops.map((s) => (
          <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 140px 160px', padding: '11px 16px', fontSize: 13, borderBottom: `1px solid ${colors.border}`, alignItems: 'center' }}>
            <div style={{ color: colors.textFaint }}>{s.route_number}</div>
            <div>{s.agency_name}</div>
            <div style={{ color: colors.textMuted }}>{s.total_cases ?? '—'}</div>
            <div style={{ color: s.comms_sent_at ? colors.success : colors.textFaint, fontSize: 12 }}>
              {s.comms_sent_at ? 'Sent (simulated)' : 'Not sent'}
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
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {!allSent && (
          <button onClick={sendAll} style={buttonPrimary}>
            Send all agency comms (simulated)
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
    </div>
  )
}
