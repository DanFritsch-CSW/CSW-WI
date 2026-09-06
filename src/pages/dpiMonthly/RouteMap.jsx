import React, { useEffect, useRef, useState, useCallback } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '../../lib/supabase.js'
import { colors as themeColors, cardStyle } from './dpiMonthlyStyles.js'

// Phase 2 route map — read-only visual, the route board (drag-and-drop
// lists) is the single source of truth; this never accepts input, only
// re-renders from whatever the lists currently say. Per the original
// design discussion: map for context, list for actual reassignment.
//
// Geocodes lazily (on-demand, cached to dpi_route_stops.latitude/longitude
// so it only happens once per stop) via the dpi-geocode Netlify function
// (US Census Geocoder — free, no API key, per the earlier
// build-vs-buy discussion favoring it over a paid Google/Mapbox key).
//
// A distinct color is assigned per route_id (stable hash into a fixed
// palette) so a reshuffle's geographic effect is visually obvious.

const PALETTE = ['#4d8dff', '#3ecf8e', '#e0a83e', '#e05a4e', '#a855f7', '#22d3ee', '#f472b6', '#84cc16', '#fb923c', '#818cf8']

function colorForRoute(routeId) {
  return PALETTE[routeId % PALETTE.length]
}

// Leaflet's default marker icon paths break under Vite bundling — point
// at CDN images directly rather than fighting the bundler over asset URLs.
const markerIcon = (color) => L.divIcon({
  className: 'dpi-route-marker',
  html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #0f1115;box-shadow:0 0 0 1px ${color}"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
})

export default function RouteMap({ routes, agencyByNumber }) {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const markersLayerRef = useRef(null)
  const [stops, setStops] = useState([]) // dpi_route_stops rows, enriched with route_id color
  const [geocoding, setGeocoding] = useState(false)

  const loadAndGeocodeStops = useCallback(async () => {
    if (!supabase || routes.length === 0) { setStops([]); return }

    const routeIds = routes.map((r) => r.id)
    const { data: stopRows, error } = await supabase
      .from('dpi_route_stops')
      .select('*')
      .in('route_id', routeIds)
    if (error) { console.error('load stops for map:', error); return }

    setStops(stopRows || [])

    const missingCoords = (stopRows || []).filter((s) => s.latitude == null || s.longitude == null)
    if (missingCoords.length === 0) return

    setGeocoding(true)
    const updates = await Promise.all(missingCoords.map(async (stop) => {
      const agency = agencyByNumber.get(stop.agency_number)
      const addressParts = agency
        ? [agency.line1, agency.city, agency.state, agency.postalCode]
        : [stop.city]
      const address = addressParts.filter(Boolean).join(', ')
      if (!address) return null

      try {
        const res = await fetch('/.netlify/functions/dpi-geocode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        })
        const { lat, lon } = await res.json()
        if (lat == null || lon == null) return null
        await supabase.from('dpi_route_stops').update({ latitude: lat, longitude: lon }).eq('id', stop.id)
        return { ...stop, latitude: lat, longitude: lon }
      } catch (err) {
        console.error('geocode failed for stop', stop.id, err.message)
        return null
      }
    }))
    setGeocoding(false)

    const successfulUpdates = updates.filter(Boolean)
    if (successfulUpdates.length > 0) {
      setStops((prev) => prev.map((s) => successfulUpdates.find((u) => u.id === s.id) || s))
    }
  }, [routes, agencyByNumber])

  useEffect(() => { loadAndGeocodeStops() }, [loadAndGeocodeStops])

  // Init the map once.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return
    mapRef.current = L.map(mapContainerRef.current, { attributionControl: true }).setView([44.6, -90.5], 6) // WI center fallback
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(mapRef.current)
    markersLayerRef.current = L.layerGroup().addTo(mapRef.current)
    return () => { mapRef.current?.remove(); mapRef.current = null }
  }, [])

  // Redraw markers whenever stops change.
  useEffect(() => {
    if (!mapRef.current || !markersLayerRef.current) return
    markersLayerRef.current.clearLayers()

    const plottable = stops.filter((s) => s.latitude != null && s.longitude != null)
    for (const stop of plottable) {
      const route = routes.find((r) => r.id === stop.route_id)
      const color = colorForRoute(stop.route_id)
      L.marker([stop.latitude, stop.longitude], { icon: markerIcon(color) })
        .bindPopup(`<strong>${stop.agency_name}</strong><br/>Route ${route?.route_number ?? '?'}<br/>${stop.city || ''}`)
        .addTo(markersLayerRef.current)
    }

    if (plottable.length > 0) {
      const bounds = L.latLngBounds(plottable.map((s) => [s.latitude, s.longitude]))
      mapRef.current.fitBounds(bounds, { padding: [30, 30] })
    }
  }, [stops, routes])

  return (
    <div style={{ ...cardStyle, padding: 0, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ padding: '10px 16px', fontSize: 12, color: themeColors.textFaint, borderBottom: `1px solid ${themeColors.border}`, display: 'flex', justifyContent: 'space-between' }}>
        <span>Route map — read-only, reflects the lists above</span>
        {geocoding && <span>Geocoding new stops…</span>}
      </div>
      <div ref={mapContainerRef} style={{ height: 360, width: '100%', background: '#1a1d24' }} />
    </div>
  )
}
