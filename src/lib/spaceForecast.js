import { supabase } from './supabase.js'

// Data layer for /spaceforecast. Tables: space_forecast_zones / _customers /
// _scenarios (see supabase/migrations/20261010_space_forecast.sql).
//
// Forecast storage: jsonb map { 'YYYY-MM': pallets }. A month with no key
// inherits the previous explicit month, else current_pallets. The UI works with
// a derived 12-element array `fc` (index 0 = current calendar month).
//
// positions = pallets / stack. All of this is independent of lib/spacePlanning.js
// (the Customers > Space Planning tab's current-footprint code).

export const WINDOW = 12

export function monthKeys(now = new Date()) {
  return Array.from({ length: WINDOW }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
}

export function monthLabel(key, i) {
  const [y, m] = key.split('-').map(Number)
  const mo = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' })
  return mo + (m === 1 || i === 0 ? ` '${String(y).slice(2)}` : '')
}

// fcMap + current -> 12 effective values
export function deriveFc(fcMap, current, keys) {
  let last = null
  return keys.map((k) => {
    if (fcMap && fcMap[k] != null) last = Number(fcMap[k])
    return last != null ? last : Number(current) || 0
  })
}

export function normalizeCustomer(row, keys) {
  const fcMap = row.forecast || {}
  return {
    id: row.id, zone: row.zone_id, name: row.name, stack: Number(row.stack) || 1,
    current: Number(row.current_pallets) || 0, fcMap,
    fc: deriveFc(fcMap, row.current_pallets, keys),
    up: Number(row.up_pct), down: Number(row.down_pct), gap: Number(row.min_gap),
  }
}

const idxOf = (keys, k) => {
  const i = keys.indexOf(k)
  if (i >= 0) return i
  return k < keys[0] ? 0 : WINDOW - 1
}

export async function loadFacility(facility, keys) {
  if (!supabase) return null
  const [z, c, s] = await Promise.all([
    supabase.from('space_forecast_zones').select('*').eq('facility', facility).order('sort_order').order('name'),
    supabase.from('space_forecast_customers').select('*').eq('facility', facility).order('name'),
    supabase.from('space_forecast_scenarios').select('*').eq('facility', facility).order('name'),
  ])
  const err = z.error || c.error || s.error
  if (err) throw err
  return {
    zones: z.data.map((r) => ({ id: r.id, name: r.name, note: r.note, capacity: Number(r.capacity) || 0 })),
    customers: c.data.map((r) => normalizeCustomer(r, keys)),
    scen: s.data.map((r) => ({
      id: r.id, name: r.name, zone: r.zone_id, pallets: Number(r.pallets) || 0, stack: Number(r.stack) || 1,
      from: idxOf(keys, r.from_month), to: idxOf(keys, r.to_month), on: r.active,
    })),
  }
}

const stamp = () => new Date().toISOString()

export async function saveZone(facility, z, sortOrder = 0) {
  if (!supabase) return
  const { error } = await supabase.from('space_forecast_zones').upsert({
    id: z.id, facility, name: z.name, note: z.note || '', capacity: z.capacity || 0, sort_order: sortOrder, updated_at: stamp(),
  })
  if (error) throw error
}

export async function saveCustomer(facility, c, { currentChanged = false } = {}) {
  if (!supabase) return
  const row = {
    id: c.id, facility, zone_id: c.zone, name: c.name, stack: c.stack || 1, current_pallets: c.current || 0,
    forecast: c.fcMap || {}, up_pct: c.up, down_pct: c.down, min_gap: c.gap, updated_at: stamp(),
  }
  if (currentChanged) row.current_updated_at = stamp()
  const { error } = await supabase.from('space_forecast_customers').upsert(row)
  if (error) throw error
}

export async function saveScenario(facility, s, keys) {
  if (!supabase) return
  const { error } = await supabase.from('space_forecast_scenarios').upsert({
    id: s.id, facility, zone_id: s.zone, name: s.name, pallets: s.pallets || 0, stack: s.stack || 1,
    from_month: keys[s.from] || keys[0], to_month: keys[s.to] || keys[WINDOW - 1], active: s.on, updated_at: stamp(),
  })
  if (error) throw error
}

export async function deleteRow(table, id) {
  if (!supabase) return
  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) throw error
}

export const TABLES = { zone: 'space_forecast_zones', customer: 'space_forecast_customers', scenario: 'space_forecast_scenarios' }

// Madison starter data: SharePoint Executive > "Space projections & sales check ins"
// > Madison "Storage Utilization" sheet. OLDER SNAPSHOT, not live — replace the
// "Now" column with current counts after importing.
export const MADISON_STARTER = [
  { zone: ['Frozen racked', 'F7/F5/F8', 5200], rows: [
    ['DPI', 1, 408], ['Firestone', 1, 669], ['Nortera finished', 1, 292], ['O&H', 2, 1792],
    ['Grassland WM frozen', 1.75, 1620], ['Colony Brands', 2, 1119], ['Ocean Spray', 1.8, 485],
    ["Palermo's", 1, 228], ['Kenover/Kayco', 1, 65], ['DDR Meat', 1, 30], ['Vans Kitchen', 1, 13], ["Bernatello's", 1, 3] ] },
  { zone: ['Frozen bulk', 'F5/F8 floor', 4000], rows: [
    ['Nortera bulk', 6, 4853], ['Lakeside bulk', 6, 704], ['Kraft butter', 4, 946], ['Darigold frozen', 4, 871],
    ['Novonesis frozen', 4, 199], ['Bayer', 3, 120], ['C.H. Robinson', 2, 8] ] },
  { zone: ['Cooler', 'F1/F2/F3/Dock 8/Mezz/F6', 6000], rows: [
    ['Grassland WM cooler', 1, 3554], ['Saputo finished', 1, 1465], ["Grassland Sam's", 1, 376], ['DD Williamson', 1, 262],
    ['Darigold cooler', 1, 154], ['DPI cooler', 1, 108], ["Mom's Meals", 1, 10] ] },
  { zone: ['Dry', 'Dry 1 & 2', 1350], rows: [
    ['Novonesis dry', 1.5, 648], ['DPI dry', 1.5, 542], ['Kraft dry', 2, 477], ['Colony dry', 1, 116],
    ['Lactalis', 2, 72], ['Dairy Products Inc.', 1, 4] ] },
]

export async function seedMadisonStarter() {
  if (!supabase) throw new Error('Supabase is not configured')
  let order = 0
  for (const { zone, rows } of MADISON_STARTER) {
    const { data: z, error } = await supabase.from('space_forecast_zones')
      .insert({ facility: 'mad', name: zone[0], note: zone[1], capacity: zone[2], sort_order: order++ })
      .select('id').single()
    if (error) throw error
    const { error: e2 } = await supabase.from('space_forecast_customers').insert(
      rows.map(([name, stack, cur]) => ({ facility: 'mad', zone_id: z.id, name, stack, current_pallets: cur })),
    )
    if (e2) throw e2
  }
}
