import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { colors, cardStyle, buttonPrimary } from './dpiMonthlyStyles.js'

// Phase 4 — Agency comms. One simulated "send" per agency (matches the real
// design: one Front draft per agency, not one per facility), followed by a
// reschedule-confirmation loop — real volume is 1-2 reschedules/month, so
// this stays a manual per-row toggle rather than anything automated.
//
// SIMULATE-ONLY: no real Front drafts/sends happen here. "Send all" just
// stamps comms_sent_at on every stop; "Mark confirmed" flips
// confirmation_status locally + in Supabase. No Front API calls at all.

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

  const toggleConfirmed = async (stopId, current) => {
    const next = current === 'confirmed' ? 'pending' : 'confirmed'
    setStops((prev) => prev.map((s) => (s.id === stopId ? { ...s, confirmation_status: next } : s)))
    if (!supabase) return
    const { error } = await supabase
      .from('dpi_route_stops')
      .update({ confirmation_status: next, updated_at: new Date().toISOString() })
      .eq('id', stopId)
    if (error) console.error('toggle confirmed:', error)
  }

  const allSent = stops.length > 0 && stops.every((s) => s.comms_sent_at)
  const allConfirmed = stops.length > 0 && stops.every((s) => s.confirmation_status === 'confirmed')

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
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 140px 140px', padding: '10px 16px', fontSize: 12, color: colors.textFaint, borderBottom: `1px solid ${colors.border}` }}>
          <div>Route</div>
          <div>Agency</div>
          <div>Cases</div>
          <div>Comms</div>
          <div>Reschedule</div>
        </div>
        {stops.map((s) => (
          <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 140px 140px', padding: '11px 16px', fontSize: 13, borderBottom: `1px solid ${colors.border}`, alignItems: 'center' }}>
            <div style={{ color: colors.textFaint }}>{s.route_number}</div>
            <div>{s.agency_name}</div>
            <div style={{ color: colors.textMuted }}>{s.total_cases ?? '—'}</div>
            <div style={{ color: s.comms_sent_at ? colors.success : colors.textFaint, fontSize: 12 }}>
              {s.comms_sent_at ? 'Sent (simulated)' : 'Not sent'}
            </div>
            <div>
              <button
                onClick={() => toggleConfirmed(s.id, s.confirmation_status)}
                disabled={!s.comms_sent_at}
                style={{
                  fontSize: 12, padding: '4px 10px', borderRadius: 5,
                  border: `1px solid ${s.confirmation_status === 'confirmed' ? colors.success : colors.border}`,
                  background: s.confirmation_status === 'confirmed' ? colors.successBg : 'transparent',
                  color: s.confirmation_status === 'confirmed' ? colors.success : colors.textMuted,
                  cursor: s.comms_sent_at ? 'pointer' : 'default',
                  opacity: s.comms_sent_at ? 1 : 0.4,
                }}
              >
                {s.confirmation_status === 'confirmed' ? 'Confirmed' : 'Mark confirmed'}
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
          <button onClick={advance} disabled={!allConfirmed} style={{ ...buttonPrimary, opacity: allConfirmed ? 1 : 0.4, cursor: allConfirmed ? 'pointer' : 'default' }}>
            Continue to Phase 5 — Final push
          </button>
        )}
        <span style={{ fontSize: 12, color: colors.textFaint }}>
          {allSent && !allConfirmed && `${stops.filter((s) => s.confirmation_status !== 'confirmed').length} agenc${stops.filter((s) => s.confirmation_status !== 'confirmed').length === 1 ? 'y' : 'ies'} still awaiting confirmation.`}
        </span>
      </div>
    </div>
  )
}
