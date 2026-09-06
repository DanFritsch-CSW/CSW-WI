import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { colors, cardStyle, buttonPrimary, buttonSuccess, PLACEHOLDER_LBS_PER_CASE } from './dpiMonthlyStyles.js'

// Phase 5 — Final push. Route sheet preview (matches the printed
// driver/carrier document format Dan shared) -> one carrier send -> final
// Datex appointment push (real build reuses the FootPrint API via
// datex-push-shared.cjs, same as every other appointment in this app) ->
// "Start next month" resets the cycle. This is the ONLY place that button
// belongs — see the 2026-09-06 fix that removed it from Phase 1.
//
// SIMULATE-ONLY: no PDF is generated, no Front send happens, no FootPrint
// API call is made. Each step just stamps a flag in
// dpi_monthly_cycles.phase_data so the UI can walk through the sequence.

export default function Phase5FinalPush({ cycle, onCycleComplete }) {
  const [routes, setRoutes] = useState([])
  const [loading, setLoading] = useState(true)
  const [phaseData, setPhaseData] = useState(cycle?.phase_data || {})

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
      {phaseData.routeSheetGenerated && (
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Route sheet — {cycle.facility}, {cycle.month_key}
          </div>
          {routes.map((route) => {
            const cases = route.stops.reduce((sum, s) => sum + (Number(s.total_cases) || 0), 0)
            const weight = cases * PLACEHOLDER_LBS_PER_CASE
            return (
              <div key={route.id} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: colors.accent, marginBottom: 6 }}>
                  Route {route.route_number} — {cases} cases / {weight.toLocaleString()} lb
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {route.stops.map((s) => (
                      <tr key={s.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={{ padding: '6px 4px', color: colors.text }}>{s.agency_name}</td>
                        <td style={{ padding: '6px 4px', color: colors.textMuted }}>{s.city}</td>
                        <td style={{ padding: '6px 4px', color: colors.textMuted }}>{s.total_cases} cases</td>
                        <td style={{ padding: '6px 4px', color: s.confirmation_status === 'confirmed' ? colors.success : colors.warning }}>
                          {s.confirmation_status === 'confirmed' ? 'Confirmed' : 'Pending'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {!phaseData.routeSheetGenerated && (
          <button onClick={() => updatePhaseData({ routeSheetGenerated: true })} style={buttonPrimary}>
            Generate route sheet (simulated)
          </button>
        )}
        {phaseData.routeSheetGenerated && !phaseData.carrierSent && (
          <button onClick={() => updatePhaseData({ carrierSent: true })} style={buttonPrimary}>
            Send to carrier (simulated)
          </button>
        )}
        {phaseData.carrierSent && !phaseData.finalPushed && (
          <button onClick={() => updatePhaseData({ finalPushed: true })} style={buttonPrimary}>
            Push final appointments to Datex (simulated)
          </button>
        )}
        {phaseData.finalPushed && (
          <button onClick={startNextMonth} style={buttonSuccess}>
            Start next month
          </button>
        )}
      </div>

      {phaseData.carrierSent && (
        <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 12 }}>
          Carrier sent (simulated) — real build sends one Front message to Echobrook (EC) or J&J (Madison), once, after reschedules settle.
        </div>
      )}
      {phaseData.finalPushed && (
        <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 4 }}>
          Final push (simulated) — real build calls the FootPrint API (datex-push-shared.cjs), same appointment endpoint the Scheduling Plugin already uses.
        </div>
      )}
    </div>
  )
}
