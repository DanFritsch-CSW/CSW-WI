import React, { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase.js'
import {
  colors, cardStyle, buttonPrimary,
  FALLBACK_LBS_PER_CASE, CAPACITY_LBS_LIMIT, CAPACITY_CASES_LIMIT, agencyTotalCases, agencyTotalWeight,
} from './dpiMonthlyStyles.js'
import RouteMap from './RouteMap.jsx'
import RouteCalendar from './RouteCalendar.jsx'
import { computeAutoDeliveryDate, formatTimeDisplay, formatDateShort, computeLoadDateStr, parseTimeToMinutes, formatMinutesToClock, formatTravelMinutes } from './dpiCalendarUtils.js'

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
// discussion. Also paired with RouteCalendar.jsx for assigning each
// route's actual delivery date — real dock appointment history showed
// the WEEK is predictable (matches the template) but the WEEKDAY isn't,
// so a human can still drag a route to a different day than its
// auto-filled guess if that month's dock/carrier availability calls
// for it.
//
// 2026-09-18: routes used to seed with delivery_date left null — the
// calendar started fully blank, drag-only. Per Dan, seedFromTemplate now
// computes an initial best-guess date for each route (its usual week x
// usual weekday, via computeAutoDeliveryDate) at the moment it's created,
// so the calendar comes pre-populated and a human only needs to move
// what's actually wrong for this month, rather than placing every route
// from scratch. This only runs here, at one-time seeding — a later
// manual re-drag (via RouteCalendar's assignDate) is a completely
// separate write to the same field and is never revisited or overwritten
// by this seeding logic, since seeding never runs twice for one cycle.
//
// 2026-09-18 (Madison fix): every Madison route template has deliver_day
// = NULL — the real delivery weekday is in load_day instead (e.g.
// "Del Date Thur -"). computeAutoDeliveryDate now takes both fields and
// falls back to load_day only when deliver_day doesn't parse, so this
// works for both facilities' differently-shaped real data without a
// facility-specific special case.
//
// 2026-09-23 (load/leave time — data layer): dpi_route_templates and
// dpi_routes both re-parsed live against production_db. Madison's real
// delivery weekday has been moved into deliver_day (was NULL — the old
// load_day text like "Del Date Thur -" actually held it). depart_time
// used to smash a day-of-week and a time together as free text for
// Madison (e.g. "Tue PM") with nowhere else to put the day; that's now
// split into a dedicated depart_day column plus a real `time`-typed
// depart_time (load_time is likewise now `time`-typed, not text).
// Deliberately NOT backfilled with a fabricated hour: most source rows
// only ever recorded a half-day ("AM"/"PM"), never a specific hour — only
// routes 105, 113 (EC) and MADISON/GRANT/JUNEA/OZAUK (Madison) had a real
// hour in the source, so those are the only ones pre-filled; everything
// else shows blank for Jen/Dan to fill in for real, rather than this
// guessing a time that was never actually given. CEMIL is a genuine
// unresolved gap: its old depart_time was bare "PM" with no day at all,
// unlike every other Thursday-delivery Madison route (DELLS, FONDY),
// which explicitly say "Wed PM" — depart_day/depart_time are left null
// rather than assumed.
//
// 2026-09-23 (editing moved to the calendar): load/leave editing
// originally lived as a clickable line right here in each Lane — moved
// to RouteCalendar.jsx's RouteChip per Dan's feedback that editing should
// happen where the calendar actually is, not in a disconnected snippet
// under the lane cards. The line below is now read-only context only,
// labeled "Appt"/"Leave"/"Deliver" to match the calendar chip's editor
// (relabeled from "Load" to "Appt" per Dan: it's really the appointment
// time CSW needs the trailer loaded/ready, as distinct from when the
// carrier's driver actually leaves with it). Edits are per-cycle (this
// month's dpi_routes row, not the template) — this month's actual
// variance, not a change to next month's default. Editing the annual
// template itself is a separate, later item (the template editor).
//
// 2026-09-24 (A7 — real weight): capacity flags below now use real Datex
// gross weight (production_db.silver.datex_slv_materialspackagingslookup,
// via netlify/functions/dpi-material-weights.cjs), not a flat 25 lb/case
// placeholder. Jen's original report (her route showed 41,000 lbs in
// Datex vs 37,575 lbs here) turned out to be a bigger gap than "reading
// the wrong CSV column" — the CSV's own weight field was never used for
// order creation at all (see dpiMonthlyParser.js), so this was always a
// flat placeholder, not a net-vs-gross mixup. Confirmed live: the
// packaging table's `Weight` column is net (product only), `shipping_weight`
// is gross (Weight + tare_weight) — the physical trailer-scale number.
// Weights are fetched once per cycle load, keyed by every distinct
// materialLookupCode across all staged agencies; any material not (yet)
// resolved falls back to the placeholder per line and is counted so the
// capacity display can flag it rather than silently mixing real and
// placeholder numbers with no signal. See agencyTotalWeight in
// dpiMonthlyStyles.js for the actual math.
//
// 2026-09-24 (A1 — carrier confirmation): per Jen, carrier confirmation
// needs to happen BEFORE agency comms (carriers move stops; confirming
// with them first avoids re-scheduling every agency a second time when a
// stop shifts). Per Dan, built directly into this Route Build stage
// rather than as a separate approval phase/screen: "Print carrier route
// sheets" below generates one PDF, one page per scheduled route, matching
// the exact layout of a real printed route sheet Dan shared — that PDF IS
// the carrier-confirmation artifact. Workflow: build/schedule routes here
// -> print/save the PDF -> send it to the carrier outside the app -> any
// requested edits come back here (rename, re-drag a date, move an agency)
// -> regenerate and re-send if needed -> once confirmed, continue to
// Phase 4 as normal. No in-app Front send yet — this only renders the
// PDF. See netlify/functions/dpi-carrier-route-sheet-pdf.cjs and
// printCarrierPdf below.
//
// 2026-09-24 (A4/A5/A6/A11 — stop sequencing, travel time, buffer,
// delivery windows): a route's stop-by-stop ETA chain — travel_minutes/
// travel_time, delivery_window_start/end on dpi_route_stops — is
// recalculated by recalcRouteETA whenever a route's stop LIST or ORDER
// changes: an agency moved onto/off/within a route (moveAgency,
// reorderStopWithinRoute below). It is deliberately NOT recalculated on
// initial template seeding — a freshly seeded route keeps the template's
// own static values exactly as before, matching "recalc only on reorder/
// add/drop" per Dan. The chain is anchored to the route's depart_time
// (Leave Time, RouteCalendar.jsx) — a route with no leave time set yet is
// left alone; recalc has nothing to anchor to.
//
// Chain, per stop in sequence: arrival = running clock + travel time from
// the previous point (CSW itself for the first stop; addresses geocoded
// via the existing dpi-geocode function, same US Census Geocoder
// RouteMap.jsx already uses, cached to dpi_route_stops.latitude/longitude
// the same way) -> delivery_window_start = arrival, delivery_window_end
// = arrival + 60min (fixed width per Dan — the template's own windows
// vary 30/60min with no visible rule, so a new stop needs SOME default)
// -> +15min buffer (A6, dwell/unload time) before continuing to the next
// leg. Travel time itself comes from the new dpi-route-travel-times.cjs
// (OSRM's public demo server, no API key — Dan's choice, matching the
// existing free-Census-Geocoder precedent; may move to OpenRouteService
// later if OSRM's public server proves unreliable, contained to that one
// function).
//
// Manual reorder (A4) — 2026-09-24 FIX: the first version detected a
// reorder by adding onDragOver/onDrop directly to AgencyTile (drop one
// tile onto another within the same lane). That broke ordinary cross-lane
// dragging outright — confirmed live, tiles just stuck faded and stopped
// moving between routes at all. Reverted AgencyTile to its known-good
// pre-A4 shape; reordering now happens via an explicit numbered-stop
// badge plus up/down buttons on each tile instead, which can't interfere
// with the drag surface at all since it doesn't touch drag events, and
// also directly answers Dan's separate feedback that stop order wasn't
// visible/intuitive to begin with.
//
// SIMULATE-ONLY SIMPLIFICATIONS (flagged, not hidden):
//   - Drag-and-drop uses native HTML5 DnD (draggable/onDrop), not @dnd-kit
//     like the Labor Planning roster board — adequate for a test click-
//     through, worth revisiting for polish/consistency later.
//   - Travel time and cubage/bulk capacity are out of scope entirely, per
//     the original Phase 2 design discussion.
//   - Madison route codes are named (MADISON, OSHKO, DODGE...), EC's are
//     numeric (105, 109...) — route_number is stored as text to fit both;
//     "+ Add route" takes a free-text code rather than auto-numbering,
//     since auto-numbering only makes sense for EC's convention.

// 2026-09-24 (A5/A6/A11): CSW's own facility addresses — the anchor point
// for the first leg of every route's travel-time chain. Verified against
// three independent sources (FleetOwner, a public-warehousing directory,
// a company listing) before use, since an error here silently skews
// every single stop's arrival time on the route, not just the first.
// Geocoded via the existing dpi-geocode function (same US Census
// Geocoder every agency stop already uses), not hardcoded coordinates —
// one geocoding source of truth for every point on the map, and one
// fewer number to have gotten wrong by hand.
const FACILITY_ADDRESSES = {
  Madison: '4309 Cottage Grove Rd, Madison, WI 53716',
  'Eau Claire': '2650 Fortune Dr, Eau Claire, WI 54703',
}

export default function Phase2BuildFlag({ cycle, stagedAgencies, onAdvance }) {
  const [routes, setRoutes] = useState([]) // [{ id, route_number, load_day, deliver_day, load_time, depart_day, depart_time, delivery_date, template_week, stops: [agencyNumber,...] }]
  const [unassigned, setUnassigned] = useState([]) // [agencyNumber,...]
  const [loading, setLoading] = useState(true)
  const draggingAgencyRef = useRef(null)
  const [newRouteCode, setNewRouteCode] = useState('')
  const [editingRouteId, setEditingRouteId] = useState(null)
  const [editRouteValue, setEditRouteValue] = useState('')
  const [weightMap, setWeightMap] = useState({}) // lookupCode -> { materialId, netWeight, grossWeight }
  const [weightsUnresolvedCount, setWeightsUnresolvedCount] = useState(0)
  const [printingPdf, setPrintingPdf] = useState(false)
  const [recalculatingRouteIds, setRecalculatingRouteIds] = useState(new Set())
  const facilityCoordsRef = useRef(null) // { lat, lon } once geocoded — never changes within a session

  const agencyByNumber = new Map(stagedAgencies.map((a) => [a.agencyNumber, a]))

  // Real gross-weight lookup (A7). Fetches every distinct material code
  // across all staged agencies in one call, keyed by trimmed lookup_code
  // (see dpi-material-weights.cjs for why the trim matters — at least one
  // real Datex lookup_code has a trailing space). Called from loadRoutes
  // BEFORE the seeding check below, so a first-time seed's dpi_route_stops
  // gross_weight column gets real weight immediately rather than the
  // fallback — moveAgency and routeTotals also use whatever's in state by
  // the time a human can actually interact, which in practice is always
  // after this initial fetch completes.
  const fetchWeights = useCallback(async () => {
    const codes = [...new Set(stagedAgencies.flatMap((a) => (a.lines || []).map((l) => String(l.materialLookupCode || '').trim())).filter(Boolean))]
    if (codes.length === 0) return {}
    try {
      const res = await fetch('/.netlify/functions/dpi-material-weights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facility: cycle.facility, lookupCodes: codes }),
      })
      if (!res.ok) { console.error('dpi-material-weights failed:', res.status, await res.text().catch(() => '')); return {} }
      const data = await res.json()
      if (data.unresolved?.length > 0) {
        console.error(`[dpi-material-weights] ${data.unresolved.length} material(s) not found in ${cycle.facility}'s Datex catalog:`, data.unresolved)
      }
      setWeightMap(data.weights || {})
      setWeightsUnresolvedCount(data.unresolved?.length || 0)
      return data.weights || {}
    } catch (err) {
      console.error('dpi-material-weights fetch error:', err)
      return {}
    }
  }, [cycle, stagedAgencies])

  // Seeds dpi_routes/dpi_route_stops from the master template, matched
  // against this cycle's actual staged agencies. Only runs once, when a
  // cycle first reaches Phase 2 with no routes yet.
  const seedFromTemplate = useCallback(async (weights) => {
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

      // 2026-09-18: pre-fill an initial delivery_date guess (usual week x
      // usual weekday) so the calendar doesn't start blank. deliver_day is
      // tried first; load_day is the fallback for facilities (Madison)
      // where the real weekday text ended up in that column instead. Returns
      // null when neither field parses, there's no template_week, or a
      // template_week has no matching full week this month — the route
      // just starts unscheduled in that case, exactly like before this
      // change.
      const autoDate = computeAutoDeliveryDate(cycle.month_key, template.template_week, template.deliver_day, template.load_day)

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
          depart_day: template.depart_day,
          depart_time: template.depart_time,
          notes: template.notes,
          template_week: template.template_week,
          delivery_date: autoDate,
        })
        .select()
        .single()
      if (routeErr) { console.error('seed route:', template.route_code, routeErr); continue }

      const stopRows = matchingStops.map((s, i) => {
        const agency = agencyByNumber.get(s.agency_number)
        const { weight } = agency ? agencyTotalWeight(agency, weights) : { weight: null }
        return {
          route_id: newRoute.id,
          sequence: i + 1,
          agency_number: s.agency_number,
          agency_name: agency?.agencyName || s.agency_name,
          city: s.city,
          delivery_window_start: s.delivery_window,
          travel_time: s.travel_time,
          total_cases: agency ? agencyTotalCases(agency) : null,
          gross_weight: weight,
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

    // First time Phase 2 is opened for this cycle — fetch real weights,
    // then seed from the template (so the initial dpi_route_stops
    // gross_weight write uses real weight, not the fallback).
    if ((routeRows || []).length === 0) {
      const weights = await fetchWeights()
      await seedFromTemplate(weights)
      const reload = await supabase.from('dpi_routes').select('*').eq('cycle_id', cycle.id).order('route_number')
      routeRows = reload.data
    } else {
      fetchWeights() // not awaited — routes already exist, so this only refreshes the live capacity flag
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
      depart_day: r.depart_day,
      depart_time: r.depart_time,
      delivery_date: r.delivery_date,
      template_week: r.template_week,
      notes: r.notes,
      stops: (stopRows || []).filter((s) => s.route_id === r.id).map((s) => s.agency_number),
    }))

    const assignedNumbers = new Set(routesWithStops.flatMap((r) => r.stops))
    const unassignedNumbers = stagedAgencies.map((a) => a.agencyNumber).filter((n) => !assignedNumbers.has(n))

    setRoutes(routesWithStops)
    setUnassigned(unassignedNumbers)
    setLoading(false)
  }, [cycle, stagedAgencies, seedFromTemplate, fetchWeights])

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
    setRoutes((prev) => [...prev, { id: data.id, route_number: data.route_number, load_day: null, deliver_day: null, load_time: null, depart_day: null, depart_time: null, stops: [] }])
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

    const sourceRoute = routes.find((r) => r.stops.includes(agencyNumber))

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
      // 2026-09-24 (A4 fix): sequence used to be hardcoded to 0 for every
      // manually-added stop — harmless as long as nothing depended on
      // ordering, but A4/A5/A6/A11's ETA chain needs a real stop order.
      // Appends to the end of the target route's current stop list.
      const { data: existingStops } = await supabase
        .from('dpi_route_stops')
        .select('sequence')
        .eq('route_id', targetRouteId)
        .order('sequence', { ascending: false })
        .limit(1)
      const nextSequence = (existingStops?.[0]?.sequence || 0) + 1

      const { error } = await supabase.from('dpi_route_stops').insert({
        route_id: targetRouteId,
        sequence: nextSequence,
        agency_number: agency.agencyNumber,
        agency_name: agency.agencyName,
        city: agency.city,
        total_cases: agencyTotalCases(agency),
        gross_weight: agencyTotalWeight(agency, weightMap).weight,
      })
      if (error) console.error('insert stop:', error)
    }

    // A5/A6/A11: adding/removing a stop shifts every downstream travel
    // time and delivery window on whichever route(s) it touched. Not
    // awaited — the drag interaction itself shouldn't feel blocked by a
    // network round trip to OSRM.
    if (sourceRoute) recalcRouteETA(sourceRoute.id)
    if (targetRouteId != null) recalcRouteETA(targetRouteId)
  }

  const routeTotals = (route) => {
    const cases = route.stops.reduce((sum, n) => sum + agencyTotalCases(agencyByNumber.get(n) || { lines: [] }), 0)
    let weight = 0
    let unresolvedLines = 0
    for (const n of route.stops) {
      const agency = agencyByNumber.get(n)
      if (!agency) continue
      const result = agencyTotalWeight(agency, weightMap)
      weight += result.weight
      unresolvedLines += result.unresolvedLines
    }
    return { cases, weight, unresolvedLines, overCapacity: weight > CAPACITY_LBS_LIMIT || cases > CAPACITY_CASES_LIMIT }
  }

  const allRoutesScheduled = routes.length > 0 && routes.every((r) => r.delivery_date)
  const canAdvance = unassigned.length === 0 && allRoutesScheduled

  // 2026-09-18: seedFromTemplate only ever runs once (see loadRoutes' guard
  // above) — if that first attempt produces an incomplete or wrong result
  // (a template-parsing gap, a fix like the Madison deliver_day issue that
  // only gets caught after the fact, etc.), there was previously no way to
  // retry it short of "Reset test cycle," which is much more destructive
  // than necessary — it deletes the ENTIRE cycle, including the imported
  // orders and staged CSV data from Phase 1. This only clears the derived
  // routes/stops and re-runs seeding against the SAME staged agencies, so
  // Phase 1's work is untouched. Explicitly destructive to anything done
  // IN Phase 2 so far, though — any manual route renames, agency moves,
  // schedule edits, or delivery-date drags are lost, hence the
  // confirmation.
  const regenerateRoutes = async () => {
    if (!supabase || !cycle) return
    if (!window.confirm('Delete all routes for this cycle and rebuild them fresh from the template? Any manual route renames, agency moves, schedule edits, or delivery-date changes made so far will be lost. Imported orders from Phase 1 are not affected.')) {
      return
    }
    const routeIds = routes.map((r) => r.id)
    if (routeIds.length > 0) {
      const { error: stopsDelErr } = await supabase.from('dpi_route_stops').delete().in('route_id', routeIds)
      if (stopsDelErr) { console.error('regenerate routes: delete stops:', stopsDelErr); return }
      const { error: routesDelErr } = await supabase.from('dpi_routes').delete().in('id', routeIds)
      if (routesDelErr) { console.error('regenerate routes: delete routes:', routesDelErr); return }
    }
    await loadRoutes() // finds zero routes, re-seeds from template, reloads
  }

  // Shared geocoding helper (A5/A6/A11) — same endpoint and address-
  // building convention RouteMap.jsx already uses for agency stops, so a
  // stop geocoded here and one geocoded via the map end up identical.
  const geocodeAddress = async (address) => {
    try {
      const res = await fetch('/.netlify/functions/dpi-geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      })
      const data = await res.json()
      return data?.lat != null && data?.lon != null ? { lat: data.lat, lon: data.lon } : null
    } catch (err) {
      console.error('geocode failed:', address, err.message)
      return null
    }
  }

  // Geocodes CSW's own facility address once per session (cached in a
  // ref, not state — this never needs to trigger a re-render on its own).
  const getFacilityCoords = async () => {
    if (facilityCoordsRef.current) return facilityCoordsRef.current
    const address = FACILITY_ADDRESSES[cycle.facility]
    if (!address) { console.error('no facility address configured for', cycle.facility); return null }
    const coords = await geocodeAddress(address)
    facilityCoordsRef.current = coords
    return coords
  }

  // A5/A6/A11 — recalculates one route's full stop-by-stop ETA chain:
  // travel_minutes/travel_time and delivery_window_start/end on every
  // dpi_route_stops row for this route. Called after any change to a
  // route's stop list or order (moveAgency, reorderStopWithinRoute) —
  // never on initial template seeding, which keeps the template's own
  // static values untouched. If the route has no depart_time set yet
  // (RouteCalendar.jsx's Leave Time), there's nothing to anchor the
  // chain to, so this is a no-op — existing values are left exactly as
  // they were rather than guessed at.
  const recalcRouteETA = async (routeId) => {
    if (!supabase) return
    const route = routes.find((r) => r.id === routeId)
    if (!route || !route.depart_time || !route.depart_day) return

    setRecalculatingRouteIds((prev) => new Set(prev).add(routeId))
    try {
      const { data: stopRows, error } = await supabase
        .from('dpi_route_stops')
        .select('*')
        .eq('route_id', routeId)
        .order('sequence')
      if (error) { console.error('recalc ETA: load stops:', error); return }
      if (!stopRows || stopRows.length === 0) return

      // Geocode any stop still missing coordinates — same address-
      // building logic RouteMap.jsx uses, persisted the same way so a
      // stop only ever needs geocoding once across the whole app.
      const stopsWithCoords = await Promise.all(stopRows.map(async (s) => {
        if (s.latitude != null && s.longitude != null) return s
        const agency = agencyByNumber.get(s.agency_number)
        const addressParts = agency ? [agency.line1, agency.city, agency.state, agency.postalCode] : [s.city]
        const address = addressParts.filter(Boolean).join(', ')
        if (!address) return s
        const coords = await geocodeAddress(address)
        if (!coords) return s
        await supabase.from('dpi_route_stops').update({ latitude: coords.lat, longitude: coords.lon }).eq('id', s.id)
        return { ...s, latitude: coords.lat, longitude: coords.lon }
      }))

      const facilityCoords = await getFacilityCoords()
      if (!facilityCoords) { console.error('recalc ETA: could not geocode facility address for', cycle.facility); return }

      const geocodedStops = stopsWithCoords.filter((s) => s.latitude != null && s.longitude != null)
      if (geocodedStops.length === 0) { console.error('recalc ETA: no stops on route', routeId, 'have coordinates'); return }
      if (geocodedStops.length < stopsWithCoords.length) {
        console.error(`recalc ETA: ${stopsWithCoords.length - geocodedStops.length} stop(s) on route ${routeId} couldn't be geocoded — their times were left unchanged`)
      }

      const points = [facilityCoords, ...geocodedStops.map((s) => ({ lat: s.latitude, lon: s.longitude }))]
      const res = await fetch('/.netlify/functions/dpi-route-travel-times', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points }),
      })
      const data = await res.json()
      if (!data.legMinutes) { console.error('recalc ETA: travel time lookup failed for route', routeId, ':', data.error); return }

      // Chain: depart_time anchors the clock. Each stop's window is fixed
      // [arrival, arrival+60min] per Dan; a 15-min buffer (A6, dwell/
      // unload time) is added after each stop before the next leg.
      let currentMinutes = parseTimeToMinutes(route.depart_time)
      const updates = geocodedStops.map((stop, i) => {
        currentMinutes += data.legMinutes[i]
        const update = {
          id: stop.id,
          travel_minutes: data.legMinutes[i],
          travel_time: formatTravelMinutes(data.legMinutes[i]),
          delivery_window_start: formatMinutesToClock(currentMinutes),
          delivery_window_end: formatMinutesToClock(currentMinutes + 60),
        }
        currentMinutes += 15
        return update
      })

      for (const u of updates) {
        const { error: updErr } = await supabase
          .from('dpi_route_stops')
          .update({
            travel_minutes: u.travel_minutes,
            travel_time: u.travel_time,
            delivery_window_start: u.delivery_window_start,
            delivery_window_end: u.delivery_window_end,
          })
          .eq('id', u.id)
        if (updErr) console.error('recalc ETA: save stop', u.id, updErr)
      }
    } finally {
      setRecalculatingRouteIds((prev) => { const next = new Set(prev); next.delete(routeId); return next })
    }
  }

  // A4 — manual reorder within a route's stop list. Reassigns sequence
  // 1..N to match the new order, then recalculates travel times/delivery
  // windows (A5/A6/A11), since reordering shifts every leg from the moved
  // point onward. Deliberately a separate path from moveAgency below —
  // this never touches Unassigned or another route's stops.
  const reorderStopWithinRoute = async (routeId, draggedAgencyNumber, targetAgencyNumber) => {
    if (draggedAgencyNumber === targetAgencyNumber) return
    const route = routes.find((r) => r.id === routeId)
    if (!route) return

    const stops = [...route.stops]
    const fromIdx = stops.indexOf(draggedAgencyNumber)
    const toIdx = stops.indexOf(targetAgencyNumber)
    if (fromIdx === -1 || toIdx === -1) return

    stops.splice(fromIdx, 1)
    stops.splice(toIdx, 0, draggedAgencyNumber)

    setRoutes((prev) => prev.map((r) => (r.id === routeId ? { ...r, stops } : r)))

    if (!supabase) return
    for (let i = 0; i < stops.length; i++) {
      const { error } = await supabase
        .from('dpi_route_stops')
        .update({ sequence: i + 1 })
        .eq('route_id', routeId)
        .eq('agency_number', stops[i])
      if (error) console.error('reorder: save sequence for', stops[i], error)
    }

    recalcRouteETA(routeId)
  }

  // Carrier route sheet PDF (A1). Fetches a fresh copy of every stop
  // (full rows, not just the agency-number list `route.stops` keeps for
  // drag-and-drop) so the PDF has sequence/delivery window/travel time —
  // deliberately a separate query rather than restructuring `route.stops`
  // itself, to avoid touching the drag logic that already depends on its
  // current agency-number-array shape. Weight is recomputed live from
  // weightMap (same real Datex numbers as the on-screen capacity flags),
  // not read back from the stored dpi_route_stops.gross_weight column,
  // which can be stale for any route seeded before A7 shipped. Only
  // scheduled routes (a real delivery_date) are included — an unscheduled
  // route has no Load/Deliver date to print yet.
  const printCarrierPdf = async () => {
    if (!supabase || routes.length === 0) return
    setPrintingPdf(true)
    try {
      const routeIds = routes.map((r) => r.id)
      const { data: stopRows, error } = await supabase
        .from('dpi_route_stops')
        .select('*')
        .in('route_id', routeIds)
        .order('sequence')
      if (error) { console.error('load stops for carrier PDF:', error); alert('Could not load route stops for the PDF — check console.'); return }

      const payloadRoutes = routes
        .filter((r) => r.delivery_date)
        .sort((a, b) => a.route_number.localeCompare(b.route_number, undefined, { numeric: true }))
        .map((route) => {
          const stops = (stopRows || []).filter((s) => s.route_id === route.id)
          const stopPayload = stops.map((s) => {
            const agency = agencyByNumber.get(s.agency_number)
            const weight = agency ? agencyTotalWeight(agency, weightMap).weight : Number(s.gross_weight) || 0
            return {
              // Template-seeded, never-recalculated stops still carry the
              // template's original combined range as one string in
              // delivery_window_start (e.g. "6:30 AM - 7:00 AM") with
              // delivery_window_end left null. A recalculated stop (A5/
              // A6/A11) has genuinely separate start/end clock times —
              // combine them here so the PDF's Time column reads the same
              // either way.
              time: s.delivery_window_end ? `${s.delivery_window_start} - ${s.delivery_window_end}` : (s.delivery_window_start || ''),
              agencyNumber: s.agency_number,
              agencyName: s.agency_name,
              city: s.city,
              grossWeight: weight,
              totalCases: Number(s.total_cases) || 0,
              travelTime: s.travel_time || '',
            }
          })
          const totalWeight = stopPayload.reduce((sum, s) => sum + s.grossWeight, 0)
          const totalCases = stopPayload.reduce((sum, s) => sum + s.totalCases, 0)

          // Route notes are one pipe-delimited field (e.g. "Load 1st Mon PM |
          // Eau Claire can be a return reload | Mon or Tue Del ok") — the
          // first segment is the routing-timing note that gets the yellow
          // highlight on the printed sheet; the rest print as plain notes
          // below it. There's no dedicated per-stop notes column, so a
          // note like "if over 40,000 lbs move to route X's last stop"
          // lives here at the route level, not attached to a specific stop.
          const notesParts = (route.notes || '').split('|').map((p) => p.trim()).filter(Boolean)

          return {
            routeNumber: route.route_number,
            // 2026-09-24 FIX: this payload never actually included the
            // real Appointment/Leave TIMES at all, or a Leave line — it
            // predates load_time/depart_day/depart_time existing as a
            // real, edited feature (built against the original reference
            // sheet, which only had Load/Deliver Date). Confirmed live:
            // Dan set an Appt/Leave time on a route and the printed PDF
            // still only showed bare day labels with no times and no
            // Leave line at all. loadTimeStr/departTimeStr are formatted
            // client-side (formatTimeDisplay, already imported here) so
            // the PDF function itself stays free of time-parsing logic.
            loadDay: route.load_day,
            loadDateStr: computeLoadDateStr(route.delivery_date, route.deliver_day, route.load_day),
            loadTimeStr: formatTimeDisplay(route.load_time),
            deliverDay: route.deliver_day,
            deliverDateStr: formatDateShort(route.delivery_date),
            // No derived calendar date for Leave: depart_day isn't always
            // guaranteed to fall before deliver_day within the short
            // window computeLoadDateStr assumes (a route can have its
            // leave day manually set to something unusual while testing,
            // e.g. after the deliver day) — showing the day label + time
            // without a possibly-wrong derived date is safer than a
            // calendar date computed in the wrong direction.
            departDay: route.depart_day,
            departTimeStr: formatTimeDisplay(route.depart_time),
            highlight: notesParts[0] || null,
            restNotes: notesParts.slice(1),
            stops: stopPayload,
            totalWeight,
            totalCases,
          }
        })

      if (payloadRoutes.length === 0) { alert('No scheduled routes yet — assign delivery dates in the calendar above before printing.'); return }

      const res = await fetch('/.netlify/functions/dpi-carrier-route-sheet-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facility: cycle.facility, monthKey: cycle.month_key, routes: payloadRoutes }),
      })
      if (!res.ok) { console.error('carrier PDF generation failed:', res.status, await res.text().catch(() => '')); alert('PDF generation failed — check console.'); return }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `DPI-${cycle.facility.replace(/\s+/g, '')}-${cycle.month_key}-carrier-routes.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setPrintingPdf(false)
    }
  }

  const advance = async () => {
    if (!supabase || !cycle) return
    const { error } = await supabase
      .from('dpi_monthly_cycles')
      .update({ current_phase: 4, updated_at: new Date().toISOString() })
      .eq('id', cycle.id)
    if (error) { console.error('advance to phase 4:', error); return }
    onAdvance()
  }

  // 2026-09-24 FIX (real regression): the first version of this added
  // onDragOver/onDrop directly to AgencyTile so dropping one tile onto
  // another within the same lane could reorder in place. That broke
  // ordinary cross-lane dragging outright — confirmed live: agencies
  // stopped moving between routes at all, tiles just stuck at the faded
  // (opacity 0.4) drag-start state. Reverted to the exact pre-A4 shape
  // below (draggable/onDragStart/onDragEnd only, no onDragOver/onDrop on
  // the tile itself) — this is the known-good implementation that was
  // never broken. A4 (manual reorder) now happens via explicit numbered
  // stops + up/down buttons instead of drop-onto-a-tile detection, which
  // also directly answers Dan's separate feedback that stop order wasn't
  // visible/intuitive in the first place — a small number next to each
  // stop is a more discoverable fix than a hidden drag gesture would ever
  // have been anyway.
  const AgencyTile = ({ agencyNumber, sequenceNumber, onMoveUp, onMoveDown }) => {
    const agency = agencyByNumber.get(agencyNumber)
    if (!agency) return null
    return (
      <div
        draggable
        onDragStart={(e) => {
          draggingAgencyRef.current = agencyNumber
          e.currentTarget.style.opacity = '0.4' // direct DOM write, not React state — avoids a mid-drag
        }}                                       // re-render that was breaking the native drag session
        onDragEnd={(e) => {
          draggingAgencyRef.current = null
          e.currentTarget.style.opacity = '1'
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', borderRadius: 6, background: colors.panelAlt,
          border: `1px solid ${colors.border}`, fontSize: 13, marginBottom: 6,
          cursor: 'grab',
        }}
      >
        {sequenceNumber != null && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, flexShrink: 0 }}>
            <button
              draggable={false}
              disabled={!onMoveUp}
              onClick={(e) => { e.stopPropagation(); onMoveUp?.() }}
              title="Move earlier in the route"
              style={{ fontSize: 9, lineHeight: 1, padding: '2px 4px', border: 'none', background: 'none', color: onMoveUp ? colors.accent : colors.border, cursor: onMoveUp ? 'pointer' : 'default' }}
            >
              ▲
            </button>
            <div style={{ fontSize: 11, fontWeight: 700, color: colors.textMuted, minWidth: 14, textAlign: 'center' }}>{sequenceNumber}</div>
            <button
              draggable={false}
              disabled={!onMoveDown}
              onClick={(e) => { e.stopPropagation(); onMoveDown?.() }}
              title="Move later in the route"
              style={{ fontSize: 9, lineHeight: 1, padding: '2px 4px', border: 'none', background: 'none', color: onMoveDown ? colors.accent : colors.border, cursor: onMoveDown ? 'pointer' : 'default' }}
            >
              ▼
            </button>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: colors.text }}>{agency.firstName}</div>
          <div style={{ fontSize: 11, color: colors.textFaint }}>
            #{agency.agencyNumber} · {agency.city} · {agencyTotalCases(agency)} cases
          </div>
        </div>
      </div>
    )
  }

  const Lane = ({ route, title, agencyNumbers, onDropHere, totals }) => (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (draggingAgencyRef.current) onDropHere(draggingAgencyRef.current) }}
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
            <div
              style={{ fontSize: 11, color: totals.overCapacity ? colors.danger : colors.textFaint }}
              title={totals.unresolvedLines > 0 ? `${totals.unresolvedLines} line item(s) on this route used a fallback weight — material not found in Datex's catalog` : undefined}
            >
              {totals.cases} cases / {Math.round(totals.weight).toLocaleString()} lb
              {totals.overCapacity && ' ⚠'}
              {totals.unresolvedLines > 0 && ' *'}
            </div>
          )}
        </div>
        {route && (route.load_day || route.deliver_day || route.depart_day) && (
          <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 2 }}>
            Appt {route.load_day || '—'}{route.load_time ? ` ${formatTimeDisplay(route.load_time)}` : ''}
            {' · '}Leave {route.depart_day || '—'}{route.depart_time ? ` ${formatTimeDisplay(route.depart_time)}` : ''}
            {' · '}Deliver {route.deliver_day || '—'}
          </div>
        )}
        {route && recalculatingRouteIds.has(route.id) && (
          <div style={{ fontSize: 11, color: colors.accent, marginTop: 2, fontStyle: 'italic' }}>
            Recalculating travel times…
          </div>
        )}
      </div>
      {agencyNumbers.length === 0 && (
        <div style={{ fontSize: 12, color: colors.textFaint, fontStyle: 'italic' }}>Drop agencies here</div>
      )}
      {agencyNumbers.map((n, idx) => (
        <AgencyTile
          key={n}
          agencyNumber={n}
          sequenceNumber={route ? idx + 1 : null}
          onMoveUp={route && idx > 0 ? () => reorderStopWithinRoute(route.id, n, agencyNumbers[idx - 1]) : null}
          onMoveDown={route && idx < agencyNumbers.length - 1 ? () => reorderStopWithinRoute(route.id, n, agencyNumbers[idx + 1]) : null}
        />
      ))}
    </div>
  )

  if (loading) return <div style={{ fontSize: 13, color: colors.textFaint }}>Loading routes…</div>

  return (
    <div>
      <RouteCalendar cycle={cycle} routes={routes} onRoutesChanged={loadRoutes} />

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
        <button
          onClick={regenerateRoutes}
          title="Delete all routes and rebuild from the template — Phase 1's imported orders are not affected"
          style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: `1px solid ${colors.warning}`, background: 'transparent', color: colors.warning, cursor: 'pointer' }}
        >
          ↺ Regenerate routes
        </button>
        <button
          onClick={printCarrierPdf}
          disabled={printingPdf}
          title="Generate one PDF, one page per scheduled route — this is the carrier confirmation artifact (A1): print/save it, send it to the carrier, make any requested edits back here, then continue to Agency Comms"
          style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: `1px solid ${colors.accent}`, background: 'transparent', color: colors.accent, cursor: printingPdf ? 'default' : 'pointer', opacity: printingPdf ? 0.5 : 1 }}
        >
          {printingPdf ? 'Generating PDF…' : '🖨 Print carrier route sheets'}
        </button>
      </div>

      <RouteMap routes={routes} agencyByNumber={agencyByNumber} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={advance} disabled={!canAdvance} style={{ ...buttonPrimary, opacity: canAdvance ? 1 : 0.4, cursor: canAdvance ? 'pointer' : 'default' }}>
          Continue to Phase 4 — Agency comms
        </button>
        {!canAdvance && (
          <span style={{ fontSize: 12, color: colors.textFaint }}>
            {routes.length === 0
              ? 'No template routes matched — add routes manually.'
              : unassigned.length > 0
                ? `${unassigned.length} agenc${unassigned.length === 1 ? 'y' : 'ies'} still unassigned.`
                : `${routes.filter((r) => !r.delivery_date).length} route${routes.filter((r) => !r.delivery_date).length === 1 ? '' : 's'} still need a delivery date.`}
          </span>
        )}
      </div>

      <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 16 }}>
        Routes seeded from the master template (last month's assignments), pre-filled onto their usual week/weekday — new agencies not in the template land in Unassigned, and any route needing a different date this month can be dragged. Each stop's number shows its order in the route — use the ▲▼ buttons to reorder; travel times and delivery windows recalculate automatically (set a Leave Time on the route first, in the calendar above, or there's nothing to anchor the chain to). Weight shown here is real Datex gross weight (material + packaging) pulled live per line item{weightsUnresolvedCount > 0 ? `; ${weightsUnresolvedCount} material code(s) in this cycle weren't found in ${cycle.facility}'s Datex catalog and are using a ${FALLBACK_LBS_PER_CASE} lb/case fallback (routes carrying one are marked *)` : ''}. To edit this month's appointment and leave day/time, click a route in the calendar above.
      </div>
    </div>
  )
}
