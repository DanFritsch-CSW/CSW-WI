import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import {
  colors, cardStyle, buttonPrimary,
  PLACEHOLDER_LBS_PER_CASE, CAPACITY_LBS_LIMIT, CAPACITY_CASES_LIMIT, agencyTotalCases,
} from './dpiMonthlyStyles.js'
import RouteMap from './RouteMap.jsx'

// Phase 2 — Build & flag. Route board seeded from the real master route
// template (dpi_route_templates/dpi_route_template_stops — parsed
// 2026-09-06 from the actual "Eau Claire template"/"Madison template"
// workbook tabs: 13 EC routes/84 stops, 16 Madison routes/73 stops).
// Matches Dan's described process: an annual template copied forward each
// month, not rebuilt from scratch — an agency present in this month's
// staged list AND in the template auto-lands on its usual route; an
// agency in the template but NOT ordering this month is simply skipped;
// an agency ordering this month but NOT in any template (new agency) shows
// in Unassigned for manual placement.
//
// Then: drag agency tiles between route lanes, weight/case totals
// recompute live, over-capacity routes flag red. Phase 3 (carrier
// approval) has no screen of its own — the capacity flag here IS that
// gate, cleared by eye, not a generated document.
//
// Paired with a read-only route map (RouteMap.jsx) below the board —
// list drives the map, never the reverse, per the original design
// discussion.
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
//   - Madison route codes are named (MADISON, OSHKO, DODGE...), EC's are
//     numeric (105, 109...) — route_number is stored as text to fit both;
//     "+ Add route" takes a free-text code rather than auto-numbering,
//     since auto-numbering only makes sense for EC's convention.

export default function Phase2BuildFlag({ cycle, stagedAgencies, onAdvance }) {
  const [routes, setRoutes] = useState([]) // [{ id, route_number, load_day, deliver_day, stops: [agencyNumber,...] }]
  const [unassigned, setUnassigned] = useState([]) // [agencyNumber,...]
  const [loading, setLoading] = useState(true)
  const [draggingAgency, setDraggingAgency] = useState(null)
  const [newRouteCode, setNewRouteCode] = useState('')
  const [editingRouteId, setEditingRouteId] = useState(null)
  const [editRouteValue, setEditRouteValue] = useState('')

  const agencyByNumber = new Map(stagedAgencies.map((a) => [a.agencyNumber, a]))

  // Seeds dpi_routes/dpi_route_stops from the master template, matched
  // against this cycle's actual staged agencies. Only runs once, when a
  // cycle first reaches Phase 2 with no routes yet.
  const seedFromTemplate = useCallback(async () => {
    const { data: templates, error: tErr } = await supabase
      .from('dpi_route_templates')
      .select('*, dpi_route_template_stops(*)')
      .eq('facility', cycle.facility)
    if (tErr) { console.error('load templates:', tErr); return false }
    if (!templates || templates.length === 0) return false

    const stagedNumbers = new Set(stagedAgencies.map((a) => a.agencyNumber))

    for (const template of templates) {
      const matchingStops = (template.dpi_route_template_stops || [])
        .filter((s) => stagedNumbers.has(s.agency_number))
        .sort((a, b) => a.sequence - b.sequence)
      if (matchingStops.length === 0) continue // nobody on this route ordered this month

      const { data: newRoute, error: routeErr } = await supabase
        .from('dpi_routes')
        .insert({
          cycle_id: cycle.id,
          facility: cycle.facility,
          month_key: cycle.month_key,
          route_number: template.route_code,
          load_day: template.load_day,
          deliver_day: template.deliver_day,
          load_time: template.load_time,
          depart_time: template.depart_time,
          notes: template.notes,
        })
        .select()
        .single()
      if (routeErr) { console.error('seed route:', template.route_code, routeErr); continue }

      const stopRows = matchingStops.map((s, i) => {
        const agency = agencyByNumber.get(s.agency_number)
        return {
          route_id: newRoute.id,
          sequence: i + 1,
          agency_number: s.agency_number,
          agency_name: agency?.agencyName || s.agency_name,
          city: s.city,
          delivery_window_start: s.delivery_window,
          travel_time: s.travel_time,
          total_cases: agency ? agencyTotalCases(agency) : null,
          gross_weight: agency ? agencyTotalCases(agency) * PLACEHOLDER_LBS_PER_CASE : null,
        }
      })
      const { error: stopsErr } = await supabase.from('dpi_route_stops').insert(stopRows)
      if (stopsErr) console.error('seed stops for route:', template.route_code, stopsErr)
    }
    return true
  }, [cycle, stagedAgencies])

  const loadRoutes = useCallback(async () => {
    if (!supabase || !cycle) { setLoading(false); return }
    setLoading(true)

    let { data: routeRows, error: routesErr } = await supabase
      .from('dpi_routes')
      .select('*')
      .eq('cycle_id', cycle.id)
      .order('route_number')
    if (routesErr) console.error('load dpi_routes:', routesErr)

    // First time Phase 2 is opened for this cycle — seed from the template.
    if ((routeRows || []).length === 0) {
      await seedFromTemplate()
      const reload = await supabase.from('dpi_routes').select('*').eq('cycle_id', cycle.id).order('route_number')
      routeRows = reload.data
    }

    const { data: stopRows, error: stopsErr } = await supabase
      .from('dpi_route_stops')
      .select('*')
      .in('route_id', (routeRows || []).map((r) => r.id).length ? (routeRows || []).map((r) => r.id) : [-1])
      .order('sequence')
    if (stopsErr) console.error('load dpi_route_stops:', stopsErr)

    const routesWithStops = (routeRows || []).map((r) => ({
      id: r.id,
      route_number: r.route_number,
      load_day: r.load_day,
      deliver_day: r.deliver_day,
      load_time: r.load_time,
      depart_time: r.depart_time,
      stops: (stopRows || []).filter((s) => s.route_id === r.id).map((s) => s.agency_number),
    }))

    const assignedNumbers = new Set(routesWithStops.flatMap((r) => r.stops))
    const unassignedNumbers = stagedAgencies.map((a) => a.agencyNumber).filter((n) => !assignedNumbers.has(n))

    setRoutes(routesWithStops)
    setUnassigned(unassignedNumbers)
    setLoading(false)
  }, [cycle, stagedAgencies, seedFromTemplate])

  useEffect(() => { loadRoutes() }, [loadRoutes])

  const addRoute = async () => {
    if (!supabase || !cycle || !newRouteCode.trim()) return
    const { data, error } = await supabase
      .from('dpi_routes')
      .insert({
        cycle_id: cycle.id,
        facility: cycle.facility,
        month_key: cycle.month_key,
        route_number: newRouteCode.trim(),
      })
      .select()
      .single()
    if (error) { console.error('add route:', error); return }
    setRoutes((prev) => [...prev, { id: data.id, route_number: data.route_number, load_day: null, deliver_day: null, load_time: null, depart_time: null, stops: [] }])
    setNewRouteCode('')
  }

  const startEditRoute = (route) => {
    setEditingRouteId(route.id)
    setEditRouteValue(route.route_number)
  }

  const saveRouteRename = async (routeId) => {
    const trimmed = editRouteValue.trim()
    if (!trimmed) { setEditingRouteId(null); return }
    setRoutes((prev) => prev.map((r) => (r.id === routeId ? { ...r, route_number: trimmed } : r)))
    setEditingRouteId(null)
    if (!supabase) return
    const { error } = await supabase
      .from('dpi_routes')
      .update({ route_number: trimmed, updated_at: new Date().toISOString() })
      .eq('id', routeId)
    if (error) console.error('rename route:', error)
  }

  // Moves an agency into targetRouteId (null = Unassigned), persisting the
  // move to Supabase. Removes it from wherever it currently sits first.
  const moveAgency = async (agencyNumber, targetRouteId) => {
    const agency = agencyByNumber.get(agencyNumber)
    if (!agency) return

    setUnassigned((prev) => prev.filter((n) => n !== agencyNumber))
    setRoutes((prev) => prev.map((r) => ({ ...r, stops: r.stops.filter((n) => n !== agencyNumber) })))
    if (targetRouteId == null) {
      setUnassigned((prev) => [...prev, agencyNumber])
    } else {
      setRoutes((prev) => prev.map((r) => (r.id === targetRouteId ? { ...r, stops: [...r.stops, agencyNumber] } : r)))
    }

    if (!supabase) return

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
          #{agency.agencyNumber} · {agency.city} · {agencyTotalCases(agency)} cases
        </div>
      </div>
    )
  }

  const Lane = ({ route, title, agencyNumbers, onDropHere, totals }) => (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (draggingAgency) onDropHere(draggingAgency) }}
      style={{
        ...cardStyle, minWidth: 220, minHeight: 160, flex: '0 0 auto',
        border: `1px solid ${totals?.overCapacity ? colors.danger : colors.border}`,
      }}
    >
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          {editingRouteId === route?.id ? (
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                autoFocus
                value={editRouteValue}
                onChange={(e) => setEditRouteValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveRouteRename(route.id) }}
                style={{ fontSize: 13, padding: '2px 6px', borderRadius: 4, border: `1px solid ${colors.accent}`, background: colors.bg, color: colors.text, width: 90 }}
              />
              <button onClick={() => saveRouteRename(route.id)} style={{ fontSize: 11, color: colors.accent, background: 'none', border: 'none', cursor: 'pointer' }}>Save</button>
            </div>
          ) : (
            <div
              style={{ fontSize: 13, fontWeight: 600, color: colors.text, cursor: route ? 'pointer' : 'default' }}
              onClick={() => route && startEditRoute(route)}
              title={route ? 'Click to rename' : undefined}
            >
              {title} {route && <span style={{ color: colors.textFaint, fontSize: 11 }}>✎</span>}
            </div>
          )}
          {totals && (
            <div style={{ fontSize: 11, color: totals.overCapacity ? colors.danger : colors.textFaint }}>
              {totals.cases} cases / {totals.weight.toLocaleString()} lb
              {totals.overCapacity && ' ⚠'}
            </div>
          )}
        </div>
        {route && (route.load_day || route.deliver_day) && (
          <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 2 }}>
            {route.load_day || ''}{route.load_day && route.deliver_day ? ' → ' : ''}{route.deliver_day || ''}
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
            route={route}
            title={`Route ${route.route_number}`}
            agencyNumbers={route.stops}
            onDropHere={(n) => moveAgency(n, route.id)}
            totals={routeTotals(route)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <input
          value={newRouteCode}
          onChange={(e) => setNewRouteCode(e.target.value)}
          placeholder="New route code (e.g. 121 or GREEN)"
          style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.borderStrong}`, background: colors.bg, color: colors.text }}
        />
        <button
          onClick={addRoute}
          disabled={!newRouteCode.trim()}
          style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.textMuted, cursor: newRouteCode.trim() ? 'pointer' : 'default', opacity: newRouteCode.trim() ? 1 : 0.5 }}
        >
          + Add route
        </button>
      </div>

      <RouteMap routes={routes} agencyByNumber={agencyByNumber} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={advance} disabled={!canAdvance} style={{ ...buttonPrimary, opacity: canAdvance ? 1 : 0.4, cursor: canAdvance ? 'pointer' : 'default' }}>
          Continue to Phase 4 — Agency comms
        </button>
        {!canAdvance && (
          <span style={{ fontSize: 12, color: colors.textFaint }}>
            {routes.length === 0 ? 'No template routes matched — add routes manually.' : `${unassigned.length} agenc${unassigned.length === 1 ? 'y' : 'ies'} still unassigned.`}
          </span>
        )}
      </div>

      <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 16 }}>
        Routes seeded from the master template (last month's assignments) — new agencies not in the template land in Unassigned. Weight shown here uses a placeholder {PLACEHOLDER_LBS_PER_CASE} lb/case — not a real Datex material weight lookup. Fine for this test run, not for real capacity decisions.
      </div>
    </div>
  )
}
