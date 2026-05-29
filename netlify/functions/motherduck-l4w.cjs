'use strict'

// MotherDuck L4W (Last 4 Weeks) historical project hourly drops query.
//
// This function replaces the Omni-based fetchHistoricalProjectHourlyDrops with
// a single SQL query against MotherDuck (~28 Omni queries collapse into 1).
//
// Input  (POST JSON):  { facilityId, validDates: [yyyy-mm-dd, ...] }
//   - facilityId is 'cal' | 'mad' | 'ken' | 'wr' | 'ec'
//   - validDates is the holiday/future-filtered same-weekday samples computed
//     by buildValidPastDates in omni.js, so the SQL doesn't need to know
//     anything about which dates are holidays — it just gets the date list.
// Output (JSON):       { result: { [projectName]: { [hour]: est_drops_int } } }
//
// Token is set via env var MOTHERDUCK_TOKEN (Netlify dashboard).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const CSW_WAREHOUSE = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

// Mirrors KEN_OMNI_NAME_MAP + the merged-name PROJECT_DROP_RULES from omni.js.
// Keep in sync with the frontend. When the user adds custom drop projects via
// facility_custom_drop_projects in Supabase, this function does NOT know
// about them — but those rules use method='inbound_all_merged' too, so we
// extend via the customRules payload from the caller.
const KEN_DISPLAY_NAME_REMAP_SQL = `
  CASE
    WHEN project_name IN ('FAIR OAKS FARMS', 'FAIR OAKS FARMS WEST') THEN 'Fair Oaks Farms'
    WHEN project_name = 'BIRCHWOOD FOODS  KENOSHA' THEN 'Birchwood Foods Kenosha'
    WHEN project_name = 'BOSSB5' THEN 'BossBites'
    ELSE project_name
  END
`

// KEN guaranteed projects — same list as KEN_GUARANTEED_PROJECTS in omni.js.
// Projects with 0 historical appointments still get a seed row at hour 17 so
// the editable column appears in the UI.
const KEN_GUARANTEED = [
  'CROWN BAKERIES',
  'Pretzilla Kenosha',
  'Birchwood Foods Kenosha',
  'Fair Oaks Farms',
  'RICHELIEU KENOSHA',
  'RICHELIEU RAW MATERIALS KENOSHA',
  'BossBites',
]

// PROJECT_DROP_RULES filter SQL fragment, by display_name.
// Mirrors omni.js fetchProjectHourlyDropsByRule:
//   - inbound_all / inbound_all_merged: all inbound rows
//   - inbound_include_lookup: code matches any of patterns
//   - inbound_exclude_lookup: code does NOT match ALL patterns of any group
function buildRuleClause(facilityId, customRules) {
  // CAL: Palermos CALEDONIA finished — exclude when (PUR AND CMM) or (PUR AND PETER BROTHERS)
  // KEN: Crown/Pretzilla/Birchwood/Fair Oaks/BossBites — all inbounds
  // KEN: Richelieu (both variants) — include only TOP or PSH
  const clauses = []
  if (facilityId === 'cal') {
    clauses.push(`(
      display_name = 'Palermos CALEDONIA finished'
      AND NOT (
        (code LIKE '%PUR%' AND code LIKE '%CMM%')
        OR (code LIKE '%PUR%' AND code LIKE '%PETER BROTHERS%')
      )
    )`)
  }
  if (facilityId === 'ken') {
    clauses.push(`display_name IN ('CROWN BAKERIES','Pretzilla Kenosha','Birchwood Foods Kenosha','Fair Oaks Farms','BossBites')`)
    clauses.push(`(display_name IN ('RICHELIEU KENOSHA','RICHELIEU RAW MATERIALS KENOSHA') AND (code LIKE '%TOP%' OR code LIKE '%PSH%'))`)
  }
  // Custom rules from facility_custom_drop_projects (always inbound_all_merged).
  // Display name is what the user typed; omni_name is the raw project_name
  // in Datex.
  for (const r of (customRules || [])) {
    if (!r.omni_name || !r.project_name) continue
    const safeOmni = String(r.omni_name).replace(/'/g, "''")
    const safeDisplay = String(r.project_name).replace(/'/g, "''")
    clauses.push(`(raw_name = '${safeOmni}')`)
    // Display name remap below will project raw_name → display name for custom rules
  }
  return clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE'
}

// Build the display name remap CASE statement, including any custom rules
// that map a raw Omni project name to a different display name.
function buildDisplayRemapSQL(customRules) {
  const customCases = []
  for (const r of (customRules || [])) {
    if (!r.omni_name || !r.project_name) continue
    const safeOmni = String(r.omni_name).replace(/'/g, "''")
    const safeDisplay = String(r.project_name).replace(/'/g, "''")
    customCases.push(`    WHEN project_name = '${safeOmni}' THEN '${safeDisplay}'`)
  }
  return `
    CASE
${customCases.join('\n')}
      WHEN project_name IN ('FAIR OAKS FARMS', 'FAIR OAKS FARMS WEST') THEN 'Fair Oaks Farms'
      WHEN project_name = 'BIRCHWOOD FOODS  KENOSHA' THEN 'Birchwood Foods Kenosha'
      WHEN project_name = 'BOSSB5' THEN 'BossBites'
      ELSE project_name
    END
  `
}

// Largest-remainder rounding to integers, mirrors redistributeToIntegers in omni.js.
// Input: { [hour]: decimal } → Output: { [hour]: int } with same total (rounded).
function redistributeToIntegers(hourMap) {
  const entries = Object.entries(hourMap)
    .map(([h, v]) => ({ hour: Number(h), raw: Number(v) || 0 }))
    .filter(e => e.raw > 0)
  if (!entries.length) return {}
  const targetTotal = Math.round(entries.reduce((s, e) => s + e.raw, 0))
  if (targetTotal === 0) return {}
  entries.forEach(e => { e.floor = Math.floor(e.raw); e.frac = e.raw - e.floor })
  const floorSum = entries.reduce((s, e) => s + e.floor, 0)
  let remainder = targetTotal - floorSum
  const ranked = [...entries].sort((a, b) => b.frac - a.frac || a.hour - b.hour)
  const result = {}
  for (const e of entries) result[e.hour] = e.floor
  for (const e of ranked) {
    if (remainder <= 0) break
    result[e.hour] += 1
    remainder -= 1
  }
  return Object.fromEntries(Object.entries(result).filter(([, v]) => v > 0))
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }),
    }
  }

  let facilityId, validDates, customRules
  try {
    ;({ facilityId, validDates, customRules } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const warehouse = CSW_WAREHOUSE[facilityId]
  if (!warehouse) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Unknown facilityId: ' + facilityId }) }
  }
  if (!Array.isArray(validDates) || validDates.length === 0) {
    // No valid past dates (e.g. all weeks blocked by holidays). Return empty
    // result; the caller will fall back to seeding guaranteed projects with
    // hour-17 zeros.
    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ result: {}, elapsedMs: Date.now() - t0, source: 'motherduck', rowCount: 0 }),
    }
  }
  // Sanity check on date strings (ISO yyyy-mm-dd)
  for (const d of validDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Bad date format: ' + d }) }
    }
  }
  const effectiveWeeks = validDates.length
  const dateList = validDates.map(d => `'${d}'`).join(',')
  const safeWarehouse = warehouse.replace(/'/g, "''")
  const displayRemap = buildDisplayRemapSQL(customRules)
  const ruleClause = buildRuleClause(facilityId, customRules)

  const sql = `
    WITH samples AS (
      SELECT
        ${displayRemap} AS display_name,
        project_name AS raw_name,
        UPPER(COALESCE(lookup_code, '')) AS code,
        EXTRACT(hour FROM scheduled_arrival)::INTEGER AS h,
        DATE(scheduled_arrival) AS d
      FROM production_db.gold.truck_appointments
      WHERE warehouse_name = '${safeWarehouse}'
        AND DATE(scheduled_arrival) IN (${dateList})
        AND dock_status_name != 'Cancelled'
        AND dock_appointment_type_name ILIKE 'Inbound%'
    ),
    filtered AS (
      SELECT display_name, d, h, COUNT(*) AS appt_count
      FROM samples
      WHERE ${ruleClause}
      GROUP BY display_name, d, h
    ),
    daily_totals AS (
      SELECT display_name, d, SUM(appt_count) AS daily_count
      FROM filtered GROUP BY display_name, d
    ),
    project_daily_avg AS (
      SELECT display_name, SUM(daily_count) / ${effectiveWeeks}.0 AS daily_forecast_raw
      FROM daily_totals GROUP BY display_name
    ),
    hour_freq AS (
      SELECT display_name, h, SUM(appt_count) AS freq
      FROM filtered GROUP BY display_name, h
    ),
    hour_total AS (
      SELECT display_name, SUM(freq) AS total_freq
      FROM hour_freq GROUP BY display_name
    )
    SELECT
      hf.display_name,
      hf.h,
      hf.freq::DOUBLE / ht.total_freq AS proportion,
      ROUND(pda.daily_forecast_raw) AS daily_forecast
    FROM hour_freq hf
    JOIN hour_total ht ON hf.display_name = ht.display_name
    JOIN project_daily_avg pda ON hf.display_name = pda.display_name
    WHERE ROUND(pda.daily_forecast_raw) > 0
    ORDER BY hf.display_name, hf.h
  `

  try {
    process.env.motherduck_token = TOKEN
    const duckdb = require('duckdb')
    const db = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
    const conn = db.connect()

    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', err => err ? reject(err) : resolve())
    })

    const rows = await new Promise((resolve, reject) => {
      conn.all(sql, (err, result) => err ? reject(err) : resolve(result))
    })
    conn.close()
    db.close()

    // Build decimalMap per project, then redistribute to integers.
    // Matches the largest-remainder logic in omni.js fetchHistoricalProjectHourlyDrops.
    const decimalsByProject = {}
    for (const r of rows) {
      const project = r.display_name
      const hour = Number(r.h)
      const decimal = Number(r.daily_forecast) * Number(r.proportion)
      if (!decimalsByProject[project]) decimalsByProject[project] = {}
      if (decimal > 0) decimalsByProject[project][hour] = decimal
    }

    const result = {}
    for (const [project, decimalMap] of Object.entries(decimalsByProject)) {
      const ints = redistributeToIntegers(decimalMap)
      if (Object.keys(ints).length) result[project] = ints
    }

    // KEN guaranteed projects: if missing from result (no historical data
    // matching the rules), seed with hour-17 zero so the editable column
    // appears in the UI.
    if (facilityId === 'ken') {
      for (const p of KEN_GUARANTEED) {
        if (!(p in result)) result[p] = { 17: 0 }
      }
    }
    // Same for custom drop projects: ensure they always appear.
    for (const r of (customRules || [])) {
      if (r.project_name && !(r.project_name in result)) {
        result[r.project_name] = { 17: 0 }
      }
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        result,
        elapsedMs: Date.now() - t0,
        source: 'motherduck',
        rowCount: rows.length,
      }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: e.message,
        stack: e.stack?.slice(0, 500),
        elapsedMs: Date.now() - t0,
      }),
    }
  }
}
