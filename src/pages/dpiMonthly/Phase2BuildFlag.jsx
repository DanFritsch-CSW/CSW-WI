import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import {
  colors, cardStyle, buttonPrimary,
  PLACEHOLDER_LBS_PER_CASE, CAPACITY_LBS_LIMIT, CAPACITY_CASES_LIMIT, agencyTotalCases,
} from './dpiMonthlyStyles.js'

// Phase 2 — Build & flag. Route board: drag agency tiles from "Unassigned"
// into route lanes, weight/case totals recompute live, over-capacity routes
// flag red. Phase 3 (carrier approval) has no screen of its own — the
// capacity flag here IS that gate, cleared by eye per the original design
// discussion, not a generated document.
//
// SIMULATE-ONLY SIMPLIFICATIONS (flagged, not hidden):
//   - Weight = cases x PLACEHOLDER_LBS_PER_CASE (25 lbs), NOT a real Datex
//     materials/packaging weight lookup. Must be replaced before this phase
//     handles real capacity decisions.
//   - Drag-and-drop uses native HTML5 DnD (draggable/onDrop), not @dnd-kit
//     like the Labor Planning roster board — adequate for a test click-
//     through, worth revisiting for polish/consistency later.
//   - Travel time and cubage/bulk capacity are out of scope entirely, per
//     the original Phase 2 design discussion.

function agencyKey(a) { return a.agencyNumber }

export default function Phase2BuildFlag({ cycle, stagedAgencies, onAdvance }) {
  const [routes, setRoutes] = useState([]) // [{ id, route_number, stops: [agencyNumber,...] }]
  const [unassigned, setUnassigned] = useState([]) // [agencyNumber,...]
  const [loading, setLoading] = useState(true)
  const [draggingAgency, setDraggingAgency] = useState(null)

  const agencyByNumber = new Map(stagedAgencies.map((a) => [a.agencyNumber, a]))

  const loadRoutes = useCallback(async () => {
    if (!supabase || !cycle) { setLoading(false); return }
    setLoading(true)

    const { data: routeRows, error: routesErr } = await supabase
      .from('dpi_routes')
      .select('*')
      .eq('cycle_id', cycle.id)
      .order('route_number')
    if (routesErr) console.error('load dpi_routes:', routesErr)

    const { data: stopRows, error: stopsErr } = await supabase
      .from('dpi_route_stops')
      .select('*')
      .in('route_id', (routeRows || []).map((r) => r.id).length ? (routeRows || []).map((r) => r.id) : [-1])
      .order('sequence')
    if (stopsErr) console.error('load dpi_route_stops:', stopsErr)

    const routesWithStops = (routeRows || []).map((r) => ({
      id: r.id,
      route_number: r.route_number,
      stops: (stopRows || []).filter((s) => s.route_id === r.id).map((s) => s.agency_number),
    }))

    const assignedNumbers = new Set(routesWithStops.flatMap((r) => r.stops))
    const unassignedNumbers = stagedAgencies.map((a) => a.agencyNumber).filter((n) => !assignedNumbers.has(n))

    setRoutes(routesWithStops)
    setUnassigned(unassignedNumbers)
    setLoading(false)
  }, [cycle, stagedAgencies])

  useEffect(() => { loadRoutes() }, [loadRoutes])

  const addRoute = async () => {
    if (!supabase || !cycle) return
    const nextNumber = routes.length > 0 ? Math.max(...routes.map((r) => r.route_number)) + 1 : 101
    const { data, error } = await supabase
      .from('dpi_routes')
      .insert({
        cycle_id: cycle.id,
        facility: cycle.facility,
        month_key: cycle.month_key,
        route_number: nextNumber,
      })
      .select()
      .single()
    if (error) { console.error('add route:', error); return }
    setRoutes((prev) => [...prev, { id: data.id, route_number: data.route_number, stops: [] }])
  }

  // Moves an agency into targetRouteId (null = Unassigned), persisting the
  // move to Supabase. Removes it from wherever it currently sits first.
  const moveAgency = async (agencyNumber, targetRouteId) => {
    const agency = agencyByNumber.get(agencyNumber)
    if (!agency) return

    // Optimistic local update
    setUnassigned((prev) => prev.filter((n) => n !== agencyNumber))
    setRoutes((prev) => prev.map((r) => ({ ...r, stops: r.stops.filter((n) => n !== agencyNumber) })))
    if (targetRouteId == null) {
      setUnassigned((prev) => [...prev, agencyNumber])
    } else {
      setRoutes((prev) => prev.map((r) => (r.id === targetRouteId ? { ...r, stops: [...r.stops, agencyNumber] } : r)))
    }

    if (!supabase) return

    // Remove any existing stop row for this agency across all routes in this cycle
    const routeIds = routes.map((r) => r.id)
    if (routeIds.length > 0) {
      await supabase
        .from('dpi_route_stops')
        .delete()
        .in('route_id', routeIds)
        .eq('agency_number', agencyNumber)
        .then(({ error }) => { if (error) console.error('remove old stop:', error) })
    }

    if (targetRouteId != null) {
      const { error } = await supabase.from('dpi_route_stops').insert({
        route_id: targetRouteId,
        sequence: 0,
        agency_number: agency.agencyNumber,
        agency_name: agency.agencyName,
        city: agency.city,
        total_cases: agencyTotalCases(agency),
        gross_weight: agencyTotalCases(agency) * PLACEHOLDER_LBS_PER_CASE,
      })
      if (error) console.error('insert stop:', error)
    }
  }

  const routeTotals = (route) => {
    const cases = route.stops.reduce((sum, n) => sum + agencyTotalCases(agencyByNumber.get(n) || { lines: [] }), 0)
    const weight = cases * PLACEHOLDER_LBS_PER_CASE
    return { cases, weight, overCapacity: weight > CAPACITY_LBS_LIMIT || cases > CAPACITY_CASES_LIMIT }
  }

  const canAdvance = unassigned.length === 0 && routes.length > 0

  const advance = async () => {
    if (!supabase || !cycle) return
    const { error } = await supabase
      .from('dpi_monthly_cycles')
      .update({ current_phase: 4, updated_at: new Date().toISOString() })
      .eq('id', cycle.id)
    if (error) { console.error('advance to phase 4:', error); return }
    onAdvance()
  }

  const AgencyTile = ({ agencyNumber }) => {
    const agency = agencyByNumber.get(agencyNumber)
    if (!agency) return null
    return (
      <div
        draggable
        onDragStart={() => setDraggingAgency(agencyNumber)}
        onDragEnd={() => setDraggingAgency(null)}
        style={{
          padding: '8px 10px', borderRadius: 6, background: colors.panelAlt,
          border: `1px solid ${colors.border}`, fontSize: 13, marginBottom: 6,
          cursor: 'grab', opacity: draggingAgency === agencyNumber ? 0.4 : 1,
        }}
      >
        <div style={{ color: colors.text }}>{agency.firstName}</div>
        <div style={{ fontSize: 11, color: colors.textFaint }}>
          {agency.city} · {agencyTotalCases(agency)} cases
        </div>
      </div>
    )
  }

  const Lane = ({ title, agencyNumbers, onDropHere, totals }) => (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (draggingAgency) onDropHere(draggingAgency) }}
      style={{
        ...cardStyle, minWidth: 220, minHeight: 160, flex: '0 0 auto',
        border: `1px solid ${totals?.overCapacity ? colors.danger : colors.border}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{title}</div>
        {totals && (
          <div style={{ fontSize: 11, color: totals.overCapacity ? colors.danger : colors.textFaint }}>
            {totals.cases} cases / {totals.weight.toLocaleString()} lb
            {totals.overCapacity && ' ⚠'}
          </div>
        )}
      </div>
      {agencyNumbers.length === 0 && (
        <div style={{ fontSize: 12, color: colors.textFaint, fontStyle: 'italic' }}>Drop agencies here</div>
      )}
      {agencyNumbers.map((n) => <AgencyTile key={n} agencyNumber={n} />)}
    </div>
  )

  if (loading) return <div style={{ fontSize: 13, color: colors.textFaint }}>Loading routes…</div>

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, overflowX: 'auto', paddingBottom: 8 }}>
        <Lane title="Unassigned" agencyNumbers={unassigned} onDropHere={(n) => moveAgency(n, null)} />
        {routes.map((route) => (
          <Lane
            key={route.id}
            title={`Route ${route.route_number}`}
            agencyNumbers={route.stops}
            onDropHere={(n) => moveAgency(n, route.id)}
            totals={routeTotals(route)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={addRoute}
          style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.textMuted, cursor: 'pointer' }}
        >
          + Add route
        </button>
        <button onClick={advance} disabled={!canAdvance} style={{ ...buttonPrimary, opacity: canAdvance ? 1 : 0.4, cursor: canAdvance ? 'pointer' : 'default' }}>
          Continue to Phase 4 — Agency comms
        </button>
        {!canAdvance && (
          <span style={{ fontSize: 12, color: colors.textFaint }}>
            {routes.length === 0 ? 'Add at least one route.' : `${unassigned.length} agenc${unassigned.length === 1 ? 'y' : 'ies'} still unassigned.`}
          </span>
        )}
      </div>

      <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 16 }}>
        Weight shown here uses a placeholder {PLACEHOLDER_LBS_PER_CASE} lb/case — not a real Datex material weight lookup. Fine for this test run, not for real capacity decisions.
      </div>
    </div>
  )
}
