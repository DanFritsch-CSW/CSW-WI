'use strict'

// Netlify function — live FEFO orders from Datex via MotherDuck.
//
// POST input: { facility, projectIds, dayCount = 5 }
//   - facility:   'cal' | 'mad' | 'ken' | 'wr' | 'ec'
//   - projectIds: string[] of project IDs (one or more of 'faioa5', 'fofwe5',
//                 'riche5', 'golst5', 'birch5', 'palvi9', 'palma9', 'paldsd9',
//                 'jdf1'). Not all facilities in one call — 'facility' is a
//                 single warehouse per request (see src/lib/fefo.js's
//                 fetchLiveFefoOrdersBatch for how the client splits a
//                 mixed-facility batch into per-facility calls to this
//                 function).
//   - dayCount:   optional, 1..7 (default 5)
//
// ── Date formats per project ────────────────────────────────────────────────
//
//   YDDDHHMMSS       — Fair Oaks lot lookup_code (year+DOY+time)
//   MMDDYYYY         — Richelieu lot lookup_code (expiration date)
//   PPW+MMDDYYYY     — Crown lot lookup_code (PPW-prefixed pack date)
//   receiveDate      — Birchwood — no date encoded in lookup_code, and no
//                      real expiration data exists anywhere for these lots
//                      either. Use lot.receive_date TIMESTAMP directly as
//                      an age proxy. Verb changes to "received" on the
//                      client since it's not pack date.
//   vendorLotExpiration — Palermo's Caledonia projects (finished goods,
//                      materials bulk, DSD). Real expiration date, sourced
//                      from datex_slv_vendorlots.expiration_date (joined via
//                      lot.vendor_lot_id) — NOT from lookup_code and NOT
//                      from datex_slv_licenseplatecontents.expiration_date
//                      (that column exists but is ~0% populated here).
//                      Same source PVI Shelf Life already uses for this
//                      project (see pvi-shelf-life.cjs).
//   manDateF         — Jones Dairy Farm (added 2026-07-18). Manufacture
//                      date, parsed straight from lookup_code ('F' + YYMMDD
//                      + 4-digit sequence) — no DB timestamp join needed,
//                      unlike receiveDate/vendorLotExpiration. This project
//                      also uses `closedOrders: true` (see that flag's
//                      handling in loadOrdersForProject below) — it audits
//                      CLOSED orders backward in time rather than open
//                      orders forward, per Dan's request for a "did we
//                      actually ship FEFO" retrospective check.
//
// ── Outbound-only filter (2026-07-18, Dan's screenshot report) ─────────────
//
// CRITICAL BUG FOUND AND FIXED: the order query never filtered on order
// DIRECTION. Datex distinguishes "Inbound ASN" (receiving) from "Sales
// Order" (Outbound/shipping) via orders.order_class_id ->
// datex_slv_orderclasses.order_type_id -> datex_slv_ordertypes.order_type_name.
// Without a filter here, every FEFO project — not just JDF — was pulling
// BOTH directions into what's supposed to be a shipping-only rotation
// check. Confirmed via MotherDuck: Palermo's Caledonia alone had 59 inbound
// orders mixed into 129 outbound in its "Processing" pool. Dan caught this
// on JDF specifically (screenshot showed inbound receipts counted as FEFO
// "violations" — nonsensical, since an inbound receipt was never "shipped
// ahead of" anything). Fixed by joining orderclasses/ordertypes and adding
// `AND ot.order_type_name = 'Outbound'` to orderSql's WHERE clause, applied
// universally (all projects share this query path, both closedOrders and
// open-orders branches) rather than as a JDF-only patch.
//
// ── closedOrders window now includes TODAY (2026-07-18, later) ─────────────
//
// Dan's follow-up on the day-stepper: "allow me to select today's date, not
// just historical." The window previously ran from dayCount days back
// through YESTERDAY only (dateTo = yesterday), so today's already-closed
// (Completed) orders were unreachable no matter how the stepper was paged.
// Fixed by moving dateTo to TODAY. Day-bucket numbering shifts to match the
// open-order convention: 0 = Today (was 0 = Yesterday), 1 = Yesterday, 2 =
// two days ago, etc. — see the day-bucket comment further down and
// src/lib/fefo.js's closedDayLabel/closedDaySubLabel for the client-side
// counterpart. fefo-digest-run.cjs was updated in lockstep so the nightly
// digest (which specifically wants "yesterday", not "today") still resolves
// the right bucket under the new numbering.
//
// ── "today" anchored to Central time, not raw server UTC (2026-07-18, later still)
//
// CRITICAL BUG FOUND AND FIXED: todayUtcMidnight() built "today" from the
// server's raw UTC clock. Central Time is UTC-5/UTC-6, so any time after
// roughly 6-7pm Central, the UTC calendar date has already rolled over to
// TOMORROW while it's still today for the business. Dan caught this live:
// at 8:49pm Central on 7/17, the app showed "0 orders" for JDF's "Today"
// bucket even though 5 outbound orders had shipped that day — because the
// backend's "today" was already 7/18 (confirmed via MotherDuck `now()`),
// and nothing had shipped on 7/18 yet. This silently affected the
// open-order day-stepper too (every other project), just less visibly,
// since a late-evening query would show tomorrow's (still mostly empty)
// bucket as "Today" instead of the actual business day. Fixed by rebuilding
// "today" from America/Chicago calendar components (same pattern
// fefo-digest-run.cjs's centralTodayDateObj already uses correctly) instead
// of the server's UTC date — see todayCentralMidnight below.

// ── Undated lots (2026-07-10, Dean/Bry FEFO feedback) ───────────────────────
//
// parseLotDateKey falls back to { k: 0, kDay: 0, error } when a lot's code
// doesn't parse (e.g. a manual, no-EDI receipt missing/garbled data). k:0 is
// the smallest possible sort key, which used to silently corrupt two
// comparisons: an undated ON-HAND lot looked infinitely OLD and got
// force-picked as the REM candidate; an undated SHIPPING lot made oldKDay=0,
// so nothing could ever compare as "older" — silently suppressing real
// violations on that order line. Fix: every parsed ship/onhand entry now
// carries `dateUnknown: true` on parse failure, undated entries are EXCLUDED
// from both the "oldest shipping lot" calc (done client-side in fefo.js) and
// from REM auto-pick (done here), and undated on-hand lots that got excluded
// from REM are still attached to the line as `undatedOnHand` so ops can see
// there's unverified stock in the bin. Flag-only, per Dan's call — does not
// force a hold/violation verdict.
//
// ── Dismissals (2026-07-08, Sadie's replacement-batch ask) ──────────────────
//
// Users can dismiss individual lots via /.netlify/functions/fefo-dismissals.
// Rows are in Supabase.fefo_dismissals with a dismissed_until timestamp.
// This function pulls active dismissals at request time and filters those
// lots out of REM candidates so violations stop firing for them.
//
// ── Onhand perf (2026-07-08 hotfixes) ───────────────────────────────────────
//
// scope_lots CTE narrows committed_raw + lot_locations to lots RELEVANT to
// this project. Two iterations:
//   v1 (11:47 UTC): scope by material_id — but that still includes every
//       historical lot for those materials. For Birchwood: 41,136 rows.
//   v2 (this fix):  scope to lots with active on-site inventory — joins
//       licenseplatecontents + licenseplates with archived=false + qty>0.
//       For Birchwood: 1,970 rows. 20× reduction.
// Verified against MotherDuck: query completes in <2s for Birchwood scale.
//
// ── License-plate-level hold detection (2026-07-30, Dean's report) ─────────
//
// CRITICAL BUG FOUND AND FIXED: every hold check up to this point (both in
// the REM/onhand query below and in allocSql's shipping-side hold flag)
// only ever looked at l.status_name — the LOT's own status. Dean flagged
// via Front (cnv_1c0ok3dg, screenshot) that a specific PALLET (license
// plate MFG0591957) was on HOLD in Datex while its lot (WC105376) showed
// 'Active', and the app wasn't picking up on it. Confirmed via MotherDuck:
// datex_slv_licenseplates.status_name carries its OWN hold status,
// independent of the lot's status — a lot can have some pallets on hold
// and others not (in this warehouse's live data: 649 QA Hold, 26 Food
// Safety, 2 Pending Hold, 1 HOLD license plates, all with otherwise-normal
// lots). A held pallet with an Active lot was therefore invisible to the
// app — it counted as ordinary available stock, which could both overstate
// cases_available and cause an otherwise-clean order to fire a false FEFO
// violation against stock that was never actually pickable. Fixed in the
// onhand/REM query only this pass (the concrete case Dean reported — an
// unallocated pallet sitting on hold): the onhand SQL now computes
// cases_held (per-LICENSE-PLATE status, same status set as isHoldStatus()
// below) and subtracts it from cases_available, and a lot whose LPs are
// ALL held now surfaces as a proper 'hold' REM candidate instead of either
// vanishing (cases_available hit 0) or reading as ordinary available
// stock. allocSql's shipping-side hold flag still checks lot-level status
// only — a held pallet already allocated to an order isn't covered by this
// pass and remains a known related gap.
//
// ── Picked-but-unshipped inventory counted as available (2026-08-06) ──────
//
// CRITICAL BUG FOUND AND FIXED, live on a Hill/Sam/Dan FEFO review call:
// a pick task moving to 'Completed' does NOT decrement the source license
// plate's on-hand record in licenseplatecontents — confirmed against real
// data (task 51679997/lot 1129928, order 771768 still 'Processing', source
// LP still showing the full pre-pick quantity, not reduced by the 1816
// cases already picked). committed_raw only ever excluded Planned/
// Released/Started/Suspended tasks from "available" — Completed wasn't in
// that list, so cases already picked to a real order, just not yet
// shipped, fell straight through and counted as ordinary available stock.
// Fixed by adding two more committed_raw branches for Completed tasks,
// scoped to the task's own order still being 'Processing' (unlike the
// other four statuses, Completed never changes again, so counting it
// unconditionally would accumulate every historical pick against a lot
// forever — tying it to order status keeps the commitment live only while
// the order is actually still open). See committed_raw below for the full
// writeup.
//
// ── Open-order date filtering removed (2026-08-06) ─────────────────────────
//
// Live Hill/Sam/Dan FEFO review call (Fathom recording 774067255):
// Palermo's/PVI orders don't reliably carry a scheduled dock appointment
// date far enough in advance for the old forward day-stepper to mean
// anything — Hill: "Palermos definitely doesn't have the date dialed in
// enough to rely on the requested date." Richelieu was flagged as equally
// unreliable ("it's all over the board"). Dan's fix, confirmed for ALL
// open-order (non-closedOrders) FEFO projects, not just PVI: stop windowing
// by appointment date at all — review is now simply every order currently
// 'Processing' right now, no day picker, no forward window. Two changes:
//   1. orderSql's date-range filter on the appts CTE is now skipped
//      entirely for non-closedOrders projects (closedOrders/JDF keeps its
//      existing backward window, untouched).
//   2. The appts JOIN is now LEFT (was INNER) for non-closedOrders
//      projects — an INNER JOIN was silently excluding any order with no
//      scheduled appointment yet at all, a related invisibility bug this
//      same fix also resolves.
// day is now always 0 for non-closedOrders orders (no bucket concept left);
// dayOffsetFrom (only used for the old bucketing) was removed as dead code.
// See src/components/customers/FefoRotationTab.jsx and
// lib/fefo-digest-shared.cjs for the matching UI/digest-side changes.

// Set HOME before requiring duckdb — duckdb reads it at load time.
process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const PROJECTS = {
  faioa5: { datexName: 'FAIR OAKS FARMS',         dateFormat: 'YDDDHHMMSS',   dateSemantic: 'pack' },
  fofwe5: { datexName: 'FAIR OAKS FARMS WEST',    dateFormat: 'YDDDHHMMSS',   dateSemantic: 'pack' },
  riche5: { datexName: 'RICHELIEU KENOSHA',       dateFormat: 'MMDDYYYY',     dateSemantic: 'expiration' },
  golst5: { datexName: 'CROWN BAKERIES',          dateFormat: 'PPW+MMDDYYYY', dateSemantic: 'pack' },
  birch5: { datexName: 'BIRCHWOOD FOODS  KENOSHA', dateFormat: 'receiveDate', dateSemantic: 'received' },
  // Added 2026-07-17 — Palermo's Caledonia finished goods (facility CAL,
  // warehouse_id 1). CORRECTED 2026-07-17 (later, same day): initially
  // shipped as dateFormat 'receiveDate' (assumed no real expiration data
  // existed, same as Birchwood) — wrong. There IS a real expiration date
  // for these lots, it's just not on the lot's own lookup_code or on
  // datex_slv_licenseplatecontents.expiration_date (that column exists but
  // is 0% populated for this project). It's on datex_slv_vendorlots,
  // joined via lot.vendor_lot_id — the exact same source PVI Shelf Life
  // already uses for this same facility/project (see pvi-shelf-life.cjs's
  // schema-anchor comment, verified 100% coverage). See "vendorLotExpiration"
  // handling below.
  palvi9: { datexName: 'Palermos CALEDONIA finished', dateFormat: 'vendorLotExpiration', dateSemantic: 'expiration' },
  // Added 2026-07-18 per Dan's request — same CAL facility, same
  // vendorLotExpiration architecture as palvi9 (confirmed via MotherDuck:
  // project_id=8, 100% of sampled lots have a vendorlots join + expiration
  // date, 25 Processing/Outbound orders currently).
  palma9: { datexName: 'Palermos CALEDONIA materials bulk', dateFormat: 'vendorLotExpiration', dateSemantic: 'expiration' },
  // Added 2026-07-18 per Dan's request — same CAL facility, same
  // vendorLotExpiration architecture as palvi9 (confirmed via MotherDuck:
  // project_id=250, project_name "Palermo's Caledonia DSD", 100% vendorlots
  // coverage, 79 Processing/Outbound orders currently).
  paldsd9: { datexName: "Palermo's Caledonia DSD", dateFormat: 'vendorLotExpiration', dateSemantic: 'expiration' },
  // Added 2026-07-18 — Jones Dairy Farm (facility MAD, warehouse_id 4).
  // Retrospective/audit project: reviews CLOSED orders looking BACKWARD,
  // not open orders looking forward (see closedOrders handling throughout
  // this file, and src/lib/fefo.js's project-entry comment for the full
  // rationale). Lot codes encode the manufacture date ('F' + YYMMDD + 4-digit
  // sequence), parsed by parseJDFManDate below.
  jdf1: { datexName: 'Jones Dairy Farm - CSW-Madison', dateFormat: 'manDateF', dateSemantic: 'man', closedOrders: true },
}

const FACILITY_WAREHOUSE_ID = {
  cal: 1, ec: 3, mad: 4, ken: 5, wr: 6,
}

const HOLD_STATUS_NAMES = new Set([
  'HOLD', 'Pending Hold', 'QA Hold', 'Food Safety',
  'NOT RELEASED', 'Damaged / Hold', 'Administrative',
])
function isHoldStatus(s) {
  if (!s) return false
  if (HOLD_STATUS_NAMES.has(s)) return true
  return /hold|not released/i.test(s)
}

const NON_ALLOCATABLE_LOCATION_PATTERNS = [
  /receiving/i, /staging/i, /quarantine/i,
  /\bdock\b/i, /\bdoor\b/i, /desktop/i, /\bscanner\b/i, /inspection/i,
]

function classifyLocations(locationsString) {
  if (!locationsString) return { locations: [], primary: '', locationBlocked: false }
  const parts = String(locationsString).split(' | ').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return { locations: [], primary: '', locationBlocked: false }
  const blocked = parts.map(p => NON_ALLOCATABLE_LOCATION_PATTERNS.some(rx => rx.test(p)))
  return { locations: parts, primary: parts[0], locationBlocked: blocked.every(Boolean) }
}

async function loadActiveDismissals(projectIds) {
  const SUPABASE_URL =
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ''
  const SUPABASE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  if (!SUPABASE_URL || !SUPABASE_KEY || !projectIds?.length) return new Set()
  try {
    const inList = projectIds.map(p => `"${p}"`).join(',')
    const nowIso = new Date().toISOString()
    const params = new URLSearchParams()
    params.set('select', 'project_id,lot_lookup_code')
    params.set('project_id', `in.(${inList})`)
    params.set('dismissed_until', `gt.${nowIso}`)
    const url = `${SUPABASE_URL}/rest/v1/fefo_dismissals?${params.toString()}`
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    })
    if (!res.ok) return new Set()
    const rows = await res.json()
    const set = new Set()
    for (const r of rows) set.add(`${r.project_id}|${r.lot_lookup_code}`)
    return set
  } catch (e) {
    console.warn('loadActiveDismissals failed:', e.message)
    return new Set()
  }
}

// ─── Date parsers ──────────────────────────────────────────────────────────

function parseFairOaksDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const m = lookupCode.match(/^(\d)(\d{3})(\d{2})(\d{2})(\d{2})$/)
  if (!m) return null
  const yDigit = Number(m[1])
  const doy    = Number(m[2])
  const hh     = Number(m[3])
  const mm     = Number(m[4])
  const ss     = Number(m[5])
  if (doy < 1 || doy > 366 || hh > 23 || mm > 59 || ss > 59) return null
  const currentYear = new Date().getUTCFullYear()
  const currentDecade = Math.floor(currentYear / 10) * 10
  let year = currentDecade + yDigit
  if (year > currentYear + 1) year -= 10
  const d = new Date(Date.UTC(year, 0, 1))
  d.setUTCDate(doy)
  const month = d.getUTCMonth() + 1
  const day   = d.getUTCDate()
  const kDay = year * 1000 + doy
  const k    = kDay * 1e6 + hh * 1e4 + mm * 1e2 + ss
  return { k, kDay, display: `${month}/${day}/${String(year).slice(-2)}` }
}

function parseRichelieuDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const m = lookupCode.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (!m) return null
  const month = Number(m[1])
  const day   = Number(m[2])
  const year  = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null
  const kDay = year * 10000 + month * 100 + day
  return { k: kDay, kDay, display: `${month}/${day}/${String(year).slice(-2)}` }
}

function parseCrownDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  return parseRichelieuDate(lookupCode.replace(/^PPW/i, ''))
}

function parseReceiveDate(receiveDate) {
  if (!receiveDate) return null
  const d = receiveDate instanceof Date ? receiveDate : new Date(receiveDate)
  if (Number.isNaN(d.getTime())) return null
  const year  = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day   = d.getUTCDate()
  const hh    = d.getUTCHours()
  const mm    = d.getUTCMinutes()
  const ss    = d.getUTCSeconds()
  const kDay = year * 10000 + month * 100 + day
  const k    = kDay * 1e6 + hh * 1e4 + mm * 1e2 + ss
  return { k, kDay, display: `${month}/${day}/${String(year).slice(-2)}` }
}

// JDF man-date — 'F' + YYMMDD + 4-digit sequence (e.g. F2606269444 =
// manufactured 6/26/26). Verified 100% consistent across 2000+ sampled
// lots. Unlike receiveDate/vendorLotExpiration, this parses straight from
// lookup_code so it's identical logic to the client-side copy in fefo.js.
function parseJDFManDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const m = lookupCode.match(/^F(\d{2})(\d{2})(\d{2})\d{4}$/)
  if (!m) return null
  const year  = 2000 + Number(m[1])
  const month = Number(m[2])
  const day   = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const kDay = year * 10000 + month * 100 + day
  return { k: kDay, kDay, display: `${month}/${day}/${String(year).slice(-2)}` }
}

function parseLotDateKey(lookupCode, dateFormat, extras) {
  let parsed
  if (dateFormat === 'YDDDHHMMSS')        parsed = parseFairOaksDate(lookupCode)
  else if (dateFormat === 'MMDDYYYY')     parsed = parseRichelieuDate(lookupCode)
  else if (dateFormat === 'PPW+MMDDYYYY') parsed = parseCrownDate(lookupCode)
  else if (dateFormat === 'receiveDate')  parsed = parseReceiveDate(extras?.receiveDate)
  // vendorLotExpiration (added 2026-07-17) — real expiration date sourced
  // from datex_slv_vendorlots.expiration_date (see PROJECTS.palvi9 comment
  // for why this is NOT the same as 'receiveDate'). parseReceiveDate is
  // fully generic (any timestamp -> {k, kDay, display}) so it's reused
  // as-is rather than duplicated.
  else if (dateFormat === 'vendorLotExpiration') parsed = parseReceiveDate(extras?.expirationDate)
  else if (dateFormat === 'manDateF') parsed = parseJDFManDate(lookupCode)
  else parsed = null
  if (!parsed) return { k: 0, kDay: 0, display: lookupCode || '?', error: `unparseable ${dateFormat}` }
  return parsed
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function arrivalToDate(scheduledArrival) {
  if (!scheduledArrival) return null
  if (scheduledArrival instanceof Date) return scheduledArrival
  const d = new Date(scheduledArrival)
  return Number.isNaN(d.getTime()) ? null : d
}

function fmtApptTime(scheduledArrival) {
  const arrival = arrivalToDate(scheduledArrival)
  if (!arrival) return '—'
  const h = String(arrival.getUTCHours()).padStart(2, '0')
  const m = String(arrival.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function fmtPack(palletTie, palletHigh, shortName) {
  const t = Number(palletTie) || 0
  const h = Number(palletHigh) || 0
  if (t > 0 && h > 0) return `${t}×${h}`
  const s = String(shortName || '').trim()
  return s
}

// dayOffsetFrom was removed 2026-08-06 — its only call site (open-order
// day-bucketing) went away when the day-stepper was removed for
// non-closedOrders projects (see file header "Open-order date filtering
// removed"). closedOrders (JDF) computes its own backward daysAgo inline
// instead.

// todayCentralMidnight — "today" as a UTC-midnight Date object representing
// the CURRENT CALENDAR DAY IN AMERICA/CHICAGO, not the server's raw UTC
// date. Renamed from todayUtcMidnight (2026-07-18) — see file header
// "'today' anchored to Central time" for why the old UTC-based version was
// a real bug (day boundary silently rolled over ~5-6 hours before the
// Central-time business day actually ended). Same pattern
// fefo-digest-run.cjs's centralTodayDateObj already used correctly; this
// just brings the live-query path in line with it. All Date arithmetic
// downstream (dateFrom/dateTo window, closedOrders
// daysAgo) is unaffected in shape — it still operates on a UTC-midnight
// Date object, just one that's computed from the right wall-clock day.
function todayCentralMidnight() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')))
}

function fmtDateISO(d) { return d.toISOString().slice(0, 10) }

function shortUser(u) {
  if (!u) return ''
  return String(u).replace(/^FOOTPRINT\\(csw-)?/i, '')
}

function fmtDest(name, city, state) {
  const n = (name || '').trim()
  const c = (city || '').trim()
  const s = (state || '').trim()
  if (!n && !c) return ''
  const loc = c && s ? `${c}, ${s}` : c || s
  return loc ? `${n} — ${loc}` : n
}

// ─── Per-project query block ───────────────────────────────────────────────

async function loadOrdersForProject(runQuery, { projectId, project, warehouseId, today, dateFrom, dateTo, dayCount, dismissedSet }) {
  const safeProjectName = project.datexName.replace(/'/g, "''")

  // closedOrders projects (e.g. JDF) look BACKWARD — last dayCount days,
  // ending TODAY (through today's already-closed orders — see file header
  // "closedOrders window now includes TODAY") — instead of the shared
  // forward window the handler computes for open-order projects
  // (today-1 .. today+dayCount-1). Recomputed here per-project rather than
  // in the shared handler since a batch request could in principle mix
  // closed- and open-order projects (it doesn't today — JDF is alone on
  // facility MAD — but this keeps the function correct regardless).
  // Date-window/day-stepper REMOVED for open-order (non-closedOrders)
  // projects (2026-08-06, Hill/Sam/Dan FEFO review call — see file header
  // "Open-order date filtering removed"). closedOrders (JDF) keeps its
  // existing backward dateFrom/dateTo window untouched below; everything
  // else just pulls the live Processing snapshot with no date bound at all.
  if (project.closedOrders) {
    dateTo = fmtDateISO(today)                                              // today
    dateFrom = fmtDateISO(new Date(today.getTime() - (dayCount - 1) * 86400000)) // dayCount days back, inclusive of today
  }

  const orderSql = `
    WITH proj AS (
      SELECT project_id FROM production_db.silver.datex_slv_projects
      WHERE project_name = '${safeProjectName}'
    ),
    appts AS (
      SELECT order_id, scheduled_arrival, appt_lookup, appt_status
      FROM (
        SELECT
          dai.item_entity_id        AS order_id,
          da.scheduled_arrival,
          da.lookup_code            AS appt_lookup,
          ds.dock_appointment_status_name AS appt_status,
          ROW_NUMBER() OVER (
            PARTITION BY dai.item_entity_id
            ORDER BY da.scheduled_arrival ASC
          ) AS rn
        FROM production_db.silver.datex_slv_dockappointmentitems dai
        JOIN production_db.silver.datex_slv_dockappointments da
          ON da.dock_appointment_id = dai.dock_appointment_id
        JOIN production_db.silver.datex_slv_dockappointmentstatuses ds
          ON ds.dock_appointment_status_id = da.status_id
        WHERE dai.item_entity_type = 'Order'
          AND ds.dock_appointment_status_name NOT IN (${project.closedOrders ? `'Cancelled'` : `'Cancelled', 'Completed'`})
          AND da.warehouse_id = ${warehouseId}
          ${project.closedOrders ? `AND DATE(da.scheduled_arrival) BETWEEN '${dateFrom}' AND '${dateTo}'` : ''}
      ) ranked
      WHERE rn = 1
    )
    SELECT
      o.order_id,
      o.lookup_code AS order_lookup,
      o.requested_delivery_date,
      os.status_name,
      o.modified_sys_user,
      a.scheduled_arrival,
      a.appt_lookup,
      a.appt_status,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.Name END)  AS dest_name,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.City END)  AS dest_city,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.State END) AS dest_state
    FROM production_db.silver.datex_slv_orders o
    JOIN proj                                                  ON o.project_id = proj.project_id
    JOIN production_db.silver.datex_slv_orderstatuses os       ON o.order_status_id = os.order_status_id
    -- LEFT JOIN (was INNER JOIN) for open-order projects, 2026-08-06 — an
    -- INNER JOIN here silently excluded any order with no scheduled dock
    -- appointment yet at all, regardless of the date-window question this
    -- same change addresses. closedOrders (JDF) keeps INNER since a closed
    -- order genuinely needs an appointment/ship-date to bucket by.
    ${project.closedOrders ? 'JOIN' : 'LEFT JOIN'} appts a                  ON a.order_id = o.order_id
    LEFT JOIN production_db.silver.datex_slv_orderaddresses oa ON oa.order_id = o.order_id
    -- Outbound-only join (added 2026-07-18 — see file header "Outbound-only
    -- filter"). Without this, Inbound ASN (receiving) orders were mixed
    -- into every FEFO project's shipping-rotation check.
    LEFT JOIN production_db.silver.datex_slv_orderclasses oc   ON o.order_class_id = oc.order_class_id
    LEFT JOIN production_db.silver.datex_slv_ordertypes ot     ON oc.order_type_id = ot.order_type_id
    WHERE os.status_name = '${project.closedOrders ? 'Completed' : 'Processing'}'
      AND ot.order_type_name = 'Outbound'
    GROUP BY o.order_id, o.lookup_code, o.requested_delivery_date,
             os.status_name, o.modified_sys_user,
             a.scheduled_arrival, a.appt_lookup, a.appt_status
    ORDER BY a.scheduled_arrival ASC, o.order_id ASC
  `
  const orderRows = await runQuery(orderSql)

  if (orderRows.length === 0) {
    return { orders: [], rowCounts: { orders: 0, allocations: 0, onhand: 0 } }
  }

  const orderIds = orderRows.map(r => Number(r.order_id))
  const orderIdList = orderIds.join(',')

  const allocSql = `
    SELECT
      t.order_id, t.order_line_number, t.material_id,
      m.lookup_code AS material_code, m.Description AS material_desc,
      mp.pallet_tie, mp.pallet_high,
      iu.short_name AS pack_unit_short,
      t.lot_id, l.lookup_code AS lot_code, l.status_name AS lot_status,
      l.receive_date AS lot_receive_date,
      vl.expiration_date AS lot_expiration_date,
      COUNT(DISTINCT t.task_id) AS lp_count_planned,
      COUNT(DISTINCT t.actual_source_license_plate_id) AS lp_count_actual,
      SUM(t.expected_packaged_amount) AS expected_cases,
      SUM(t.actual_packaged_amount)   AS actual_cases
    FROM production_db.silver.datex_slv_tasks t
    JOIN production_db.silver.datex_slv_lots l ON t.lot_id = l.lot_id
    JOIN production_db.silver.datex_slv_materials m ON t.material_id = m.material_id
    LEFT JOIN production_db.silver.datex_slv_materialspackagingslookup mp
      ON mp.material_id = t.material_id
      AND mp.is_reporting_default = true
      AND mp.deprecated_packaging = false
    LEFT JOIN production_db.silver.datex_slv_inventorymeasurementunits iu
      ON iu.inventory_measurement_unit_id = mp.packaging_id
    -- vendorlots — real expiration date for projects using dateFormat
    -- 'vendorLotExpiration' (added 2026-07-17, e.g. Palermo's Caledonia).
    -- vendor_lot_id is 1:1 in datex_slv_vendorlots (verified), so this
    -- LEFT JOIN can't multiply rows for the other projects that don't use it.
    LEFT JOIN production_db.silver.datex_slv_vendorlots vl
      ON vl.vendor_lot_id = l.vendor_lot_id
    WHERE t.order_id IN (${orderIdList})
      AND t.lot_id IS NOT NULL
      AND t.warehouse_id = ${warehouseId}
    GROUP BY t.order_id, t.order_line_number, t.material_id,
             m.lookup_code, m.Description,
             mp.pallet_tie, mp.pallet_high, iu.short_name,
             t.lot_id, l.lookup_code, l.status_name, l.receive_date, vl.expiration_date
  `
  const allocRows = await runQuery(allocSql)

  const materialIds = [...new Set(allocRows.map(r => Number(r.material_id)))]

  let onhandRows = []
  if (materialIds.length > 0) {
    const matIdList = materialIds.join(',')
    // scope_lots CTE — ONLY lots with active on-site inventory for our
    // in-scope materials. Filters at lot creation source (licenseplatecontents
    // + licenseplates.archived=false + qty>0). Cuts row count by 20× vs the
    // earlier material_id-only scope for high-lot-count projects like
    // Birchwood.
    const onhandSql = `
      WITH scope_lots AS (
        SELECT DISTINCT lpc.lot_id
        FROM production_db.silver.datex_slv_licenseplatecontents lpc
        JOIN production_db.silver.datex_slv_licenseplates lp
          ON lpc.license_plate_id = lp.license_plate_id
        JOIN production_db.silver.datex_slv_lots l
          ON l.lot_id = lpc.lot_id
        WHERE lp.warehouse_id = ${warehouseId}
          AND lp.Archived = false
          AND lpc.packaged_amount > 0
          AND l.material_id IN (${matIdList})
      ),
      committed_raw AS (
        SELECT t.lot_id, t.expected_packaged_amount AS cases_committed
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts
          ON ts.task_status_id = t.status_id
        WHERE t.warehouse_id = ${warehouseId}
          AND t.lot_id IN (SELECT lot_id FROM scope_lots)
          AND ts.status_name IN ('Planned', 'Released', 'Started', 'Suspended')

        UNION ALL

        SELECT lpc.lot_id, t.expected_packaged_amount AS cases_committed
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts
          ON ts.task_status_id = t.status_id
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc
          ON lpc.license_plate_id = t.actual_source_license_plate_id
        WHERE t.warehouse_id = ${warehouseId}
          AND t.lot_id IS NULL
          AND t.actual_source_license_plate_id IS NOT NULL
          AND lpc.lot_id IN (SELECT lot_id FROM scope_lots)
          AND ts.status_name IN ('Planned', 'Released', 'Started', 'Suspended')

        UNION ALL

        -- Completed-but-not-yet-shipped picks (added 2026-08-06, Hill/Sam/
        -- Dan FEFO review call). CONFIRMED LIVE: a pick task moving to
        -- 'Completed' does NOT decrement the source license plate's
        -- on-hand record in licenseplatecontents (task 51679997, lot
        -- 1129928, picked 1816 cases to order 771768 -- still 'Processing'
        -- -- source LP 5928184 still shows the full pre-pick 3634, not
        -- reduced). Cases already picked to an order but not yet shipped
        -- therefore fell through every committed-status check above
        -- (Completed isn't Planned/Released/Started/Suspended) and counted
        -- as ordinary available on-hand stock -- exactly Hill's live
        -- diagnosis on the call ("it thinks it's available because
        -- there's not a release task, but it's already been picked, it's
        -- not closed out").
        --   Scoped to the task's OWN order still being 'Processing' --
        -- unlike the other four statuses, 'Completed' never changes again,
        -- so counting it unconditionally would accumulate every
        -- historical completed pick against a lot forever, including ones
        -- whose orders shipped weeks ago. Tying it to order status keeps
        -- this "committed" amount live only for as long as the order it
        -- belongs to is actually still open. Uses actual_packaged_amount
        -- (falling back to expected) since the pick is done and the real
        -- amount is known, unlike the in-progress statuses above.
        SELECT t.lot_id, COALESCE(t.actual_packaged_amount, t.expected_packaged_amount) AS cases_committed
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts
          ON ts.task_status_id = t.status_id
        JOIN production_db.silver.datex_slv_orders o
          ON o.order_id = t.order_id
        JOIN production_db.silver.datex_slv_orderstatuses os
          ON os.order_status_id = o.order_status_id
        WHERE t.warehouse_id = ${warehouseId}
          AND t.lot_id IN (SELECT lot_id FROM scope_lots)
          AND ts.status_name = 'Completed'
          AND os.status_name = 'Processing'

        UNION ALL

        SELECT lpc.lot_id, COALESCE(t.actual_packaged_amount, t.expected_packaged_amount) AS cases_committed
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts
          ON ts.task_status_id = t.status_id
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc
          ON lpc.license_plate_id = t.actual_source_license_plate_id
        JOIN production_db.silver.datex_slv_orders o
          ON o.order_id = t.order_id
        JOIN production_db.silver.datex_slv_orderstatuses os
          ON os.order_status_id = o.order_status_id
        WHERE t.warehouse_id = ${warehouseId}
          AND t.lot_id IS NULL
          AND t.actual_source_license_plate_id IS NOT NULL
          AND lpc.lot_id IN (SELECT lot_id FROM scope_lots)
          AND ts.status_name = 'Completed'
          AND os.status_name = 'Processing'
      ),
      committed AS (
        SELECT lot_id, SUM(cases_committed) AS cases_committed
        FROM committed_raw
        GROUP BY lot_id
      ),
      lot_locations AS (
        SELECT
          lpc.lot_id,
          STRING_AGG(DISTINCT loc.location_container_name, ' | ') AS locations
        FROM production_db.silver.datex_slv_licenseplatecontents lpc
        JOIN production_db.silver.datex_slv_licenseplates lp
          ON lpc.license_plate_id = lp.license_plate_id
        LEFT JOIN production_db.silver.datex_slv_locationcontainers loc
          ON lp.location_id = loc.location_container_id
        WHERE lp.warehouse_id = ${warehouseId}
          AND lp.Archived = false
          AND lpc.packaged_amount > 0
          AND lpc.lot_id IN (SELECT lot_id FROM scope_lots)
        GROUP BY lpc.lot_id
      )
      SELECT
        l.material_id, l.lot_id,
        l.lookup_code AS lot_code, l.status_name AS lot_status,
        MAX(l.receive_date) AS lot_receive_date,
        MAX(vl.expiration_date) AS lot_expiration_date,
        COUNT(DISTINCT lpc.license_plate_id) AS lp_count,
        SUM(lpc.packaged_amount) AS cases_onhand,
        -- cases_held (added 2026-07-30, Dean's report via Front cnv_1c0ok3dg
        -- — a specific PALLET (LP MFG0591957) was on HOLD while its LOT
        -- (WC105376) showed 'Active'). Confirmed via MotherDuck:
        -- datex_slv_licenseplates.status_name carries its OWN hold status,
        -- independent of the lot's status_name — a lot can have some
        -- pallets on hold and others not. Every hold check up to this point
        -- (both here and in allocSql below) only ever looked at l.status_name
        -- (the LOT), so a held pallet with an otherwise-Active lot was
        -- invisible to the app — it counted as ordinary available stock,
        -- which could both overstate cases_available and cause a REM
        -- candidate to show as a plain violation instead of correctly
        -- surfacing as held. Same status set as isHoldStatus() below,
        -- inlined here since this needs to run in SQL, not JS.
        SUM(CASE WHEN lp.status_name IN (
          'HOLD', 'Pending Hold', 'QA Hold', 'Food Safety',
          'NOT RELEASED', 'Damaged / Hold', 'Administrative'
        ) THEN lpc.packaged_amount ELSE 0 END) AS cases_held,
        COALESCE(MAX(c.cases_committed), 0) AS cases_committed,
        GREATEST(
          SUM(lpc.packaged_amount)
            - COALESCE(MAX(c.cases_committed), 0)
            - SUM(CASE WHEN lp.status_name IN (
                'HOLD', 'Pending Hold', 'QA Hold', 'Food Safety',
                'NOT RELEASED', 'Damaged / Hold', 'Administrative'
              ) THEN lpc.packaged_amount ELSE 0 END),
          0
        ) AS cases_available,
        MAX(ll.locations) AS locations
      FROM production_db.silver.datex_slv_licenseplatecontents lpc
      JOIN production_db.silver.datex_slv_lots l  ON lpc.lot_id = l.lot_id
      JOIN production_db.silver.datex_slv_licenseplates lp ON lpc.license_plate_id = lp.license_plate_id
      LEFT JOIN committed c ON c.lot_id = l.lot_id
      LEFT JOIN lot_locations ll ON ll.lot_id = l.lot_id
      -- vendorlots — same 1:1 real-expiration-date join as allocSql above,
      -- needed here too since REM candidates come from unallocated on-hand
      -- lots (added 2026-07-17).
      LEFT JOIN production_db.silver.datex_slv_vendorlots vl
        ON vl.vendor_lot_id = l.vendor_lot_id
      WHERE l.material_id IN (${matIdList})
        AND lp.warehouse_id = ${warehouseId}
        AND lp.Archived = false
        AND lpc.packaged_amount > 0
      GROUP BY l.material_id, l.lot_id, l.lookup_code, l.status_name
    `
    onhandRows = await runQuery(onhandSql)
  }

  const linesByOrderMaterial = new Map()
  const allocLotsByLine = new Map()

  for (const r of allocRows) {
    const key = `${r.order_id}|${r.material_id}`
    if (!linesByOrderMaterial.has(key)) {
      linesByOrderMaterial.set(key, {
        orderId: Number(r.order_id),
        materialId: Number(r.material_id),
        code: r.material_code || `MAT-${r.material_id}`,
        desc: (r.material_desc || '').trim(),
        pack: fmtPack(r.pallet_tie, r.pallet_high, r.pack_unit_short),
        ship: [],
      })
      allocLotsByLine.set(key, new Set())
    }
    const line = linesByOrderMaterial.get(key)
    const allocLots = allocLotsByLine.get(key)
    allocLots.add(Number(r.lot_id))

    const parsed = parseLotDateKey(r.lot_code, project.dateFormat, { receiveDate: r.lot_receive_date, expirationDate: r.lot_expiration_date })
    const cases = Number(r.actual_cases) > 0 ? Number(r.actual_cases) : Number(r.expected_cases) || 0
    const lps = Number(r.lp_count_actual) > 0
      ? Number(r.lp_count_actual)
      : Number(r.lp_count_planned) || 0
    const shipHeld = isHoldStatus(r.lot_status)
    line.ship.push({
      lot: r.lot_code,
      date: parsed.display,
      k: parsed.k,
      kDay: parsed.kDay,
      lps, cases,
      hold:     shipHeld,
      holdType: shipHeld ? r.lot_status : undefined,
      // 2026-07-10 — see top-of-file undated-lot note. True when this lot's
      // code couldn't be parsed into a real date (manual/no-EDI receipt,
      // garbled batch code, etc). Excluded from the "oldest shipping lot"
      // calc client-side rather than silently defaulting to k:0.
      dateUnknown: !!parsed.error,
    })
  }

  const onhandByMaterial = new Map()
  for (const r of onhandRows) {
    const mid = Number(r.material_id)
    if (!onhandByMaterial.has(mid)) onhandByMaterial.set(mid, [])
    const locInfo = classifyLocations(r.locations)
    onhandByMaterial.get(mid).push({
      lotId:    Number(r.lot_id),
      lotCode:  r.lot_code,
      status:   r.lot_status,
      receiveDate:    r.lot_receive_date,
      expirationDate: r.lot_expiration_date,
      cases:          Number(r.cases_available) || 0,
      casesGross:     Number(r.cases_onhand) || 0,
      casesCommitted: Number(r.cases_committed) || 0,
      // casesHeld — added 2026-07-30 alongside the cases_held SQL column
      // above. Cases sitting on a HELD license plate, already excluded
      // from cases_available. Kept separately (not just folded into
      // casesCommitted) so a fully-held lot can still be surfaced as a
      // REM candidate with hold:true instead of silently vanishing from
      // consideration just because its available count hit zero.
      casesHeld:      Number(r.cases_held) || 0,
      lps:            Number(r.lp_count) || 0,
      location:        locInfo.primary,
      locations:       locInfo.locations,
      locationBlocked: locInfo.locationBlocked,
    })
  }

  for (const [key, line] of linesByOrderMaterial.entries()) {
    const allocLots = allocLotsByLine.get(key)
    const candidates = (onhandByMaterial.get(line.materialId) || [])
      .filter(c => !allocLots.has(c.lotId))
      .filter(c => !dismissedSet || !dismissedSet.has(`${projectId}|${c.lotCode}`))
      .map(c => {
        const parsed = parseLotDateKey(c.lotCode, project.dateFormat, { receiveDate: c.receiveDate, expirationDate: c.expirationDate })
        return { ...c, k: parsed.k, kDay: parsed.kDay, display: parsed.display, dateUnknown: !!parsed.error }
      })
      // 2026-07-30 — was `c.cases > 0`. A lot whose LPs are ALL on hold now
      // has cases_available=0 by design (see cases_held SQL above), which
      // used to make it disappear from candidates entirely — the exact bug
      // Dean reported (a held pallet just vanished instead of being
      // recognized as held). Keeping casesHeld > 0 candidates means a
      // fully-held lot still surfaces below as a proper 'hold' REM
      // candidate instead of silently not existing.
      .filter(c => c.cases > 0 || c.casesHeld > 0)

    // 2026-07-10 — undated on-hand lots are excluded from REM auto-pick so
    // they can't force-win as "the oldest lot" purely by virtue of their
    // k:0 sentinel. They're kept on the line as undatedOnHand instead, so
    // ops still sees there's unverified stock sitting in the bin.
    const datedCandidates = candidates.filter(c => !c.dateUnknown)
    const undatedCandidates = candidates.filter(c => c.dateUnknown)

    if (datedCandidates.length > 0) {
      const oldest = datedCandidates.reduce((a, b) => a.k < b.k ? a : b)
      // fullyHeld — added 2026-07-30 (Dean's report). Every case on this
      // lot's LPs is on hold (cases_available=0 after the SQL-side
      // subtraction), so there's nothing genuinely pickable here even
      // though the lot itself sits on hand. Treat exactly like a
      // lot-level hold (isHoldStatus(oldest.status)) so it produces the
      // same 'hold' verdict — "older stock exists, correctly skipped" —
      // instead of either vanishing (the original bug) or, if it somehow
      // still showed cases=0 with hold=false, reading as "fully cleared."
      const fullyHeld = oldest.cases === 0 && oldest.casesHeld > 0
      const held = fullyHeld || isHoldStatus(oldest.status)
      line.rem = {
        lot:      oldest.lotCode,
        date:     oldest.display,
        k:        oldest.k,
        kDay:     oldest.kDay,
        lps:      oldest.lps,
        cases:    fullyHeld ? oldest.casesHeld : oldest.cases,
        hold:     held,
        holdType: held ? (fullyHeld ? 'HOLD' : oldest.status) : undefined,
        location:        oldest.location || '',
        locations:       oldest.locations || [],
        locationBlocked: !!oldest.locationBlocked,
        dateUnknown: false,
      }
    } else {
      line.rem = {
        lot: '', date: '', k: 0, kDay: 0, lps: 0, cases: 0,
        hold: false,
        location: '', locations: [], locationBlocked: false,
        dateUnknown: false,
      }
    }
    line.undatedOnHand = undatedCandidates.map(c => ({
      lot: c.lotCode, cases: c.cases, lps: c.lps, location: c.location || '',
    }))
  }

  const nowMs = Date.now()
  const orders = []
  for (const oh of orderRows) {
    const orderId = Number(oh.order_id)
    const arrival = arrivalToDate(oh.scheduled_arrival)
    // day-bucket: closedOrders projects (e.g. JDF) still look BACKWARD —
    // unchanged, see below. Open-order (non-closedOrders) projects no
    // longer bucket by day at all (2026-08-06 — see file header
    // "Open-order date filtering removed"): every currently-Processing
    // order is the live snapshot, always day 0. dayOffsetFrom is kept
    // around only for the `past` (stale-appointment) check further down,
    // not for bucketing.
    let day
    if (project.closedOrders) {
      const daysAgo = arrival
        ? Math.round((today.getTime() - Date.UTC(arrival.getUTCFullYear(), arrival.getUTCMonth(), arrival.getUTCDate())) / 86400000)
        : 0
      day = Math.max(0, Math.min(dayCount - 1, daysAgo))
    } else {
      day = 0
    }
    // closedOrders (e.g. JDF) force past:false — the 'stale' verdict means
    // "past appointment, still holding allocated stock," which doesn't
    // apply to an order that has already shipped and closed. Every
    // closedOrders order is in the past by definition, so leaving this
    // computed normally would make every non-violating order show as
    // 'stale' instead of 'clean'.
    const past = project.closedOrders ? false : (arrival ? arrival.getTime() < nowMs : false)

    const orderLines = []
    for (const [, line] of linesByOrderMaterial.entries()) {
      if (line.orderId !== orderId) continue
      line.ship.sort((a, b) => a.k - b.k)
      orderLines.push({
        code: line.code, desc: line.desc, pack: line.pack,
        ship: line.ship, rem: line.rem,
        undatedOnHand: line.undatedOnHand || [],
      })
    }
    if (orderLines.length === 0) continue
    orders.push({
      id:       `SO-${oh.order_lookup || orderId}`,
      day,
      proj:     projectId,
      dest:     fmtDest(oh.dest_name, oh.dest_city, oh.dest_state),
      appt:     fmtApptTime(oh.scheduled_arrival),
      // shipDateDisplay — only set for closedOrders projects, since there's
      // no day-stepper context to convey "which day" an order belongs to.
      // Format matches the rest of the app's M/D/YY convention.
      shipDateDisplay: project.closedOrders && arrival
        ? `${arrival.getUTCMonth() + 1}/${arrival.getUTCDate()}/${String(arrival.getUTCFullYear()).slice(-2)}`
        : undefined,
      past,
      status:   oh.status_name,
      apptStatus: oh.appt_status || null,
      allocBy:  shortUser(oh.modified_sys_user),
      lines:    orderLines,
    })
  }

  return {
    orders,
    rowCounts: { orders: orderRows.length, allocations: allocRows.length, onhand: onhandRows.length },
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return {
      statusCode: 500, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }),
    }
  }

  let facility, projectIds, projectId, dayCount
  try {
    ;({ facility, projectIds, projectId, dayCount } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }
  dayCount = Number(dayCount) || 5
  if (dayCount < 1 || dayCount > 7) dayCount = 5

  if (!projectIds && projectId) projectIds = [projectId]
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    return {
      statusCode: 400, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'projectIds (array) or projectId (string) required' }),
    }
  }
  const unknown = projectIds.filter(pid => !PROJECTS[pid])
  if (unknown.length > 0) {
    return {
      statusCode: 400, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `Unknown projectId(s): ${unknown.join(', ')}` }),
    }
  }
  const warehouseId = FACILITY_WAREHOUSE_ID[facility]
  if (!warehouseId) {
    return {
      statusCode: 400, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `Unknown facility: ${facility}` }),
    }
  }

  const today = todayCentralMidnight()
  const dateFrom = fmtDateISO(new Date(today.getTime() - 86400000))
  const dateTo   = fmtDateISO(new Date(today.getTime() + (dayCount - 1) * 86400000))

  const dismissedSetPromise = loadActiveDismissals(projectIds)

  let conn, db
  const ordersByProject = {}
  const errorsByProject = {}
  const rowCountsByProject = {}
  try {
    process.env.HOME = '/tmp'
    process.env.motherduck_token = TOKEN
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = (sql) => new Promise((resolve, reject) => {
      conn.run(sql, (err) => err ? reject(err) : resolve())
    })
    const runQuery = (sql) => new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows))
    })

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    const dismissedSet = await dismissedSetPromise

    for (const pid of projectIds) {
      try {
        const result = await loadOrdersForProject(runQuery, {
          projectId: pid,
          project: PROJECTS[pid],
          warehouseId, today, dateFrom, dateTo, dayCount,
          dismissedSet,
        })
        ordersByProject[pid] = result.orders
        rowCountsByProject[pid] = result.rowCounts
      } catch (perProjectErr) {
        ordersByProject[pid] = []
        errorsByProject[pid] = perProjectErr.message || 'unknown error'
        rowCountsByProject[pid] = { orders: 0, allocations: 0, onhand: 0 }
      }
    }
  } catch (e) {
    for (const pid of projectIds) {
      ordersByProject[pid] = ordersByProject[pid] || []
      errorsByProject[pid] = e.message || 'connection failed'
      rowCountsByProject[pid] = rowCountsByProject[pid] || { orders: 0, allocations: 0, onhand: 0 }
    }
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        ordersByProject,
        errorsByProject,
        rowCountsByProject,
        error: e.message,
        stack: e.stack?.slice(0, 500),
        elapsedMs: Date.now() - t0,
      }),
    }
  }
  try { conn?.close(); db?.close() } catch (_) {}

  return {
    statusCode: 200, headers: NO_CACHE_HEADERS,
    body: JSON.stringify({
      ordersByProject,
      ...(Object.keys(errorsByProject).length > 0 ? { errorsByProject } : {}),
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      source: 'motherduck',
      rowCounts: rowCountsByProject,
    }),
  }
}
