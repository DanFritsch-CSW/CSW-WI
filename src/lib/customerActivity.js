// ── Shared Omni appointment classification ──────────────────────────────
// Single source of truth for which inbound appointments count as a "Drop"
// vs plain Inbound, per customer, per facility. Originally lived inline in
// CustomerSnapshot.jsx; extracted 2026-10-13 so the new All Customers
// weekly rollup (FacilityWeeklyActivity.jsx) uses the EXACT same
// classification instead of drifting from it. If DROP_RULES changes, both
// views change together.
//
// Drops are only modeled for KEN and CAL (see DROP_RULES) — matches how
// the Cal/Ken Labor Planning Front thread actually uses the term. Every
// other facility's inbound rows classify as plain Inbound.

export const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
export const VIEW_APPT = 'gold__truck_appointments'

export const CSW_WAREHOUSE = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

export const KEN_OMNI_NAME_MAP = new Map([
  ['FAIR OAKS FARMS', 'Fair Oaks Farms'],
  ['FAIR OAKS FARMS WEST', 'Fair Oaks Farms'],
  ['BIRCHWOOD FOODS  KENOSHA', 'Birchwood Foods Kenosha'],
  ['BOSSB5', 'BossBites'],
])

export const DROP_RULES = {
  ken: new Map([
    ['CROWN BAKERIES',                  { method: 'all' }],
    ['Pretzilla Kenosha',               { method: 'all' }],
    ['Fair Oaks Farms',                 { method: 'all' }],
    ['Birchwood Foods Kenosha',         { method: 'all' }],
    ['BossBites',                       { method: 'all' }],
    ['RICHELIEU KENOSHA',               { method: 'include', patterns: ['TOP', 'PSH'] }],
    ['RICHELIEU RAW MATERIALS KENOSHA', { method: 'include', patterns: ['TOP', 'PSH'] }],
  ]),
  cal: new Map([
    ["Palermo's CALEDONIA finished", { method: 'exclude', excludeWhenAll: [['PUR', 'CMM'], ['PUR', 'PETER BROTHERS']] }],
    ['Palermos CALEDONIA finished',  { method: 'exclude', excludeWhenAll: [['PUR', 'CMM'], ['PUR', 'PETER BROTHERS']] }],
  ]),
}

export function classifyType(typeName) {
  const t = (typeName || '').toLowerCase()
  if (t.startsWith('inbound'))  return 'inbound'
  if (t.startsWith('outbound')) return 'outbound'
  return null
}

export function isDrop(facilityId, projectName, lookupCode, type) {
  if (type !== 'inbound') return false
  const rule = DROP_RULES[facilityId]?.get(projectName)
  if (!rule) return false
  const code = (lookupCode || '').toUpperCase()
  if (rule.method === 'all') return true
  if (rule.method === 'include') return rule.patterns.some(p => code.includes(p))
  if (rule.method === 'exclude') return !rule.excludeWhenAll.some(group => group.every(p => code.includes(p)))
  return false
}

export function normalizeProjectName(facilityId, rawName) {
  if (facilityId === 'ken' && KEN_OMNI_NAME_MAP.has(rawName)) {
    return KEN_OMNI_NAME_MAP.get(rawName)
  }
  return rawName
}

export async function omniQuery(query) {
  const res = await fetch('/.netlify/functions/omni-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { version: 5, ...query } }),
  })
  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new Error(body.error || `omni-query ${res.status}`)
  }
  const { rows } = await res.json()
  return rows || []
}

// Fetch and classify one day's appointments for a facility. Returns an
// array of { name, bucket } where bucket is 'dr' | 'in' | 'out'.
//
// appointment_id is requested but never read client-side — it exists
// purely to stop Omni from collapsing two appointments that share the same
// (project_name, type, lookup_code) tuple into a single row (verified
// against MotherDuck 2026-06-30, see CustomerSnapshot.jsx history).
export async function fetchDayActivity(facilityId, dateIso) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return []
  const dayRows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: VIEW_APPT,
    fields: [
      `${VIEW_APPT}.appointment_id`,
      `${VIEW_APPT}.project_name`,
      `${VIEW_APPT}.dock_appointment_type_name`,
      `${VIEW_APPT}.lookup_code`,
    ],
    filters: {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      [`${VIEW_APPT}.scheduled_arrival`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: dateIso, is_negative: false,
        offset_interval_string: '0 days',
      },
      [`${VIEW_APPT}.dock_status_name`]: {
        kind: 'EQUALS', type: 'string', values: ['Cancelled'], is_negative: true,
      },
    },
    sorts: [],
    limit: 500,
  }).catch(() => [])

  const out = []
  for (const r of dayRows) {
    const rawName = r[`${VIEW_APPT}.project_name`] || ''
    if (!rawName) continue
    const name = normalizeProjectName(facilityId, rawName)
    const typeName = r[`${VIEW_APPT}.dock_appointment_type_name`]
    const lookupCode = r[`${VIEW_APPT}.lookup_code`]
    const type = classifyType(typeName)
    if (!type) continue
    const bucket = isDrop(facilityId, name, lookupCode, type) ? 'dr' : (type === 'inbound' ? 'in' : 'out')
    out.push({ name, bucket })
  }
  return out
}

// Fetch a week (any set of ISO dates, typically Mon–Sun) of classified
// activity for a facility, grouped by project then date.
// Returns { [projectName]: { [isoDate]: { dr, in, out } } }
export async function fetchWeekActivity(facilityId, weekDays) {
  const perDay = await Promise.all(
    weekDays.map(d => fetchDayActivity(facilityId, d).then(rows => ({ date: d, rows })))
  )
  const byProject = {}
  for (const { date, rows } of perDay) {
    for (const { name, bucket } of rows) {
      if (!byProject[name]) byProject[name] = {}
      if (!byProject[name][date]) byProject[name][date] = { dr: 0, in: 0, out: 0 }
      byProject[name][date][bucket] += 1
    }
  }
  return byProject
}
