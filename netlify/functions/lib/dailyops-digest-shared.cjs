'use strict'

// Shared core for the Daily Ops snapshot digest (3 images + Madison Dock
// Counts text comment) — split out 2026-07-31 from dailyops-digest-run.cjs.
//
// WHY THIS SPLIT EXISTS: same root cause and fix pattern already applied
// to fefo-digest-run.cjs (2026-07-30) and prepick-digest-run.cjs /
// wr-cases-digest-run.cjs (2026-07-31): Netlify does not allow direct HTTP
// invocation of any function that carries a `schedule` in netlify.toml,
// which is why "Send test digest now" 403ed here too. The scheduled
// function (dailyops-digest-run.cjs) keeps the schedule and only handles
// the cron tick, looping every configured facility; the manual test
// button now calls the sibling dailyops-digest-test.cjs (single facility,
// required in the POST body, no schedule).
//
// Everything below is otherwise UNCHANGED from the original
// dailyops-digest-run.cjs — see that file's original header (preserved in
// git history) for the fuller feature history: three rendered PNGs (Total
// Appointments card / Projects table / Shift Roster) via @napi-rs/canvas,
// extension to WR + EC (2026-07-29), the double-send race-condition fix
// via an atomic last_sent_date claim (2026-07-30), and Dock Counts folded
// in as a 4th Madison-only text comment (2026-07-30).

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

const FACILITY_CONFIGS = {
  mad: { label: 'Madison', color: '#4d9de0' },
  wr:  { label: 'Wisconsin Rapids', color: '#d4b84a' },
  ec:  { label: 'Eau Claire', color: '#c084fc' },
}

const THEME = {
  bg0: '#f3f5f8', bg1: '#ffffff', bg2: '#f8f9fb',
  textPrimary: '#111827', textSecondary: '#4b5a72', textDim: '#9aaabb',
  border: '#dce2ec', borderSubtle: '#eceff5',
  green: '#3dba7e', red: '#e05a5a',
}

const ACTIVE_LANES = new Set(['shift1', 'mid', 'shift2', 'shift3'])
const SHIFT_DEFAULTS = {
  shift1: { start: 5, hours: 8 }, mid: { start: 9, hours: 8 },
  shift2: { start: 13, hours: 8 }, shift3: { start: 22, hours: 8 },
}
const BREAK_DEFAULTS = [83, 100, 75, 100, 50, 100, 75, 100]
const OP_DAY_START = 5
const OP_DAY_END_LINEAR = 24 + OP_DAY_START

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(t) }
}

async function sbPatchClaim(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : [] } catch { json = [] }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return Array.isArray(json) ? json : []
}

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

function tomorrowCentral() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const y = Number(parts.find(p => p.type === 'year').value)
  const m = Number(parts.find(p => p.type === 'month').value)
  const d = Number(parts.find(p => p.type === 'day').value)
  const todayCentral = new Date(Date.UTC(y, m - 1, d))
  todayCentral.setUTCDate(todayCentral.getUTCDate() + 1)
  return todayCentral
}

function isoWeekday(dateObj) { const dow = dateObj.getUTCDay(); return dow === 0 ? 7 : dow }
function isoDate(dateObj) { return dateObj.toISOString().slice(0, 10) }
function formatHeaderDate(dateObj) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${WEEKDAYS[dateObj.getUTCDay()]} ${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}/${dateObj.getUTCFullYear()}`
}

const CSW_SUFFIXES = [
  ' - CSW-Madison', ' - CSW-Franksville', ' - CSW-Kenosha',
  ' - CSW-Wisconsin Rapids', ' - CSW-Eau Claire', '-CSW-Madison', ' - Madison',
]
function stripSuffix(name) {
  if (!name) return name
  for (const s of CSW_SUFFIXES) if (name.endsWith(s)) return name.slice(0, -s.length)
  return name
}

function classifyApptType(typeName) {
  const t = (typeName || '').toLowerCase()
  if (t.startsWith('inbound')) return 'inbound'
  if (t.startsWith('outbound')) return 'outbound'
  return null
}

function r1(n) { return Math.round(n * 10) / 10 }

function getBreakMultipliers(settings) {
  return BREAK_DEFAULTS.map((def, i) => (settings?.[`break_hour_${i + 1}`] ?? def) / 100)
}

function resolveEmployeeShift(row) {
  if (row.on_loan_to) return null
  const lane = row.lane
  if (!ACTIVE_LANES.has(lane)) return null
  const shiftDefaults = SHIFT_DEFAULTS[lane]
  const rawStart = row.shift_start
  const rawHours = row.shift_hours
  if (rawStart == null && rawHours == null) return null
  const startHour = rawStart != null ? Math.floor(Number(rawStart)) : shiftDefaults.start
  const shiftHours = rawHours != null ? Number(rawHours) : shiftDefaults.hours
  const realStart = isNaN(startHour) ? shiftDefaults.start : startHour
  const realHours = isNaN(shiftHours) || shiftHours <= 0 ? shiftDefaults.hours : shiftHours
  if (realStart < OP_DAY_START) return null
  return { resolvedStart: realStart, resolvedHours: realHours }
}

function computeRosterTotals(rosterRows, settings) {
  const facilityBreakMuls = getBreakMultipliers(settings)
  const hourlyAvail = new Array(24).fill(0)
  let headcount = 0
  for (const row of rosterRows) {
    const shift = resolveEmployeeShift(row)
    if (!shift) continue
    headcount++
    const { resolvedStart, resolvedHours } = shift
    const fullHours = Math.floor(resolvedHours)
    const frac = resolvedHours - fullHours
    for (let i = 0; i < fullHours; i++) {
      const hLinear = resolvedStart + i
      if (hLinear >= OP_DAY_END_LINEAR) break
      const hMod = hLinear % 24
      hourlyAvail[hMod] += facilityBreakMuls[i] ?? 1
    }
    if (frac > 0) {
      const hLinear = resolvedStart + fullHours
      if (hLinear < OP_DAY_END_LINEAR) {
        const hMod = hLinear % 24
        hourlyAvail[hMod] += frac * (facilityBreakMuls[fullHours] ?? 1)
      }
    }
  }
  const roundedHourly = hourlyAvail.map(v => Math.round(v * 10) / 10)
  const totalHours = r1(roundedHourly.reduce((s, v) => s + v, 0))
  return { totalHours, headcount }
}

async function fetchSnapshotData(facilityId, date) {
  const [settingsRows, rosterRows, dropsRows, adjRows, projResp] = await Promise.all([
    sbFetch(`facility_settings?facility=eq.${facilityId}&select=*`),
    sbFetch(`roster_assignments?facility=eq.${facilityId}&plan_date=eq.${date}&select=employee_name,lane,shift_start,shift_hours,on_loan_to,from_facility,is_temp`),
    sbFetch(`project_hourly_drops_forecast?facility=eq.${facilityId}&plan_date=eq.${date}&select=project_name,est_drops`),
    sbFetch(`hourly_labor_adjustments?facility=eq.${facilityId}&plan_date=eq.${date}&select=adjustment`),
    fetch(`${SITE_URL}/.netlify/functions/motherduck-appointments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'projectData', facilityId, date }),
    }).then(async r => {
      const t = await r.text()
      let j; try { j = JSON.parse(t) } catch { j = { raw: t } }
      if (!r.ok) throw new Error(`motherduck-appointments failed: ${JSON.stringify(j)}`)
      return j
    }),
  ])

  const settings = settingsRows?.[0] || {}
  const hoursPerAppt = settings.hours_per_appt ?? 1.5

  const projectDrops = {}
  let totalDrops = 0
  for (const row of dropsRows || []) {
    const v = Number(row.est_drops) || 0
    projectDrops[row.project_name] = (projectDrops[row.project_name] ?? 0) + v
    totalDrops += v
  }
  totalDrops = Math.round(totalDrops)

  const apptRows = (projResp?.projects ?? [])
  const projectRowsMap = new Map()
  for (const row of apptRows) {
    const rawName = row.project_name
    if (!rawName) continue
    const name = stripSuffix(rawName)
    const dir = classifyApptType(row.dock_appointment_type_name)
    const count = Number(row.count) || 0
    if (!projectRowsMap.has(name)) projectRowsMap.set(name, { name, inb: 0, out: 0 })
    const p = projectRowsMap.get(name)
    if (dir === 'inbound') p.inb += count
    if (dir === 'outbound') p.out += count
  }
  const dailyProjectRows = [...projectRowsMap.values()].map(p => {
    const dr = Math.round(projectDrops[p.name] ?? 0)
    return { name: p.name, dr, inb: p.inb, out: p.out, total: dr + p.inb + p.out }
  })
  for (const name of Object.keys(projectDrops)) {
    if (dailyProjectRows.some(r => r.name === name)) continue
    const dr = Math.round(projectDrops[name])
    if (!dr) continue
    dailyProjectRows.push({ name, dr, inb: 0, out: 0, total: dr })
  }
  dailyProjectRows.sort((a, b) => b.total - a.total)

  const totalInb = dailyProjectRows.reduce((s, p) => s + p.inb, 0)
  const totalOut = dailyProjectRows.reduce((s, p) => s + p.out, 0)
  const totalAppts = Math.round(totalInb + totalOut + totalDrops)

  const { totalHours, headcount } = computeRosterTotals(rosterRows || [], settings)
  const totalLaborReq = r1(totalAppts * hoursPerAppt)
  const totalAdj = (adjRows || []).reduce((s, r) => s + (Number(r.adjustment) || 0), 0)
  const laborAfterAdj = r1(totalHours + totalAdj)
  const delta = r1(totalHours - totalLaborReq)

  return {
    date, totalAppts, drops: totalDrops, inb: totalInb, out: totalOut,
    warehousemen: headcount, totalHours, delta, laborReq: totalLaborReq,
    laborAfterAdj, dailyProjectRows, rosterRows: rosterRows || [],
  }
}

const path = require('path')
let createCanvas
let fontsRegistered = false
function loadCanvasLib() {
  const canvasLib = require('@napi-rs/canvas')
  if (!fontsRegistered) {
    const fontsDir = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf')
    canvasLib.GlobalFonts.registerFromPath(path.join(fontsDir, 'DejaVuSans.ttf'), 'DejaVu Sans')
    canvasLib.GlobalFonts.registerFromPath(path.join(fontsDir, 'DejaVuSans-Bold.ttf'), 'DejaVu Sans Bold')
    fontsRegistered = true
  }
  createCanvas = canvasLib.createCanvas
  return createCanvas
}

function FONT(px, bold) {
  return `${px}px "DejaVu Sans${bold ? ' Bold' : ''}"`
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function fmtDelta(v) {
  if (v == null) return '--'
  return v >= 0 ? `+${v}` : `${v}`
}

function renderTotalAppointmentsCard(data, dateObj, cfg) {
  const create = loadCanvasLib()
  const W = 640, H = 470
  const canvas = create(W, H)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = THEME.bg0
  ctx.fillRect(0, 0, W, H)
  roundRect(ctx, 12, 12, W - 24, H - 24, 10)
  ctx.fillStyle = THEME.bg1
  ctx.fill()
  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.fillStyle = THEME.textSecondary
  ctx.font = FONT(15, true)
  ctx.fillText(`${cfg.label} — Daily Ops`, 32, 44)
  ctx.font = FONT(13, false)
  ctx.fillStyle = THEME.textDim
  ctx.fillText(formatHeaderDate(dateObj), 32, 64)

  roundRect(ctx, 32, 82, W - 64, 100, 8)
  ctx.fillStyle = THEME.bg2
  ctx.fill()
  ctx.strokeStyle = cfg.color
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = THEME.textSecondary
  ctx.font = FONT(13, true)
  ctx.fillText('TOTAL APPOINTMENTS', 52, 112)
  ctx.fillStyle = cfg.color
  ctx.font = FONT(48, true)
  ctx.fillText(String(data.totalAppts), 52, 165)

  const pill = (x, y, w, h, label, value, color) => {
    roundRect(ctx, x, y, w, h, 6)
    ctx.fillStyle = THEME.bg2
    ctx.fill()
    ctx.strokeStyle = THEME.border
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = THEME.textDim
    ctx.font = FONT(10, true)
    ctx.fillText(label.toUpperCase(), x + 12, y + 20)
    ctx.fillStyle = color
    ctx.font = FONT(22, true)
    ctx.fillText(String(value), x + 12, y + 46)
  }

  const rowY = [200, 268, 336]
  const gap = 12
  const colW = (W - 64 - gap * 2) / 3

  pill(32, rowY[0], colW, 56, 'Est Drops', data.drops, THEME.textPrimary)
  pill(32 + colW + gap, rowY[0], colW, 56, 'Inbound', data.inb, THEME.textPrimary)
  pill(32 + (colW + gap) * 2, rowY[0], colW, 56, 'Outbound', data.out, THEME.textPrimary)

  const deltaColor = data.delta >= 0 ? THEME.green : THEME.red
  pill(32, rowY[1], colW, 56, 'Warehousemen', data.warehousemen, THEME.textPrimary)
  pill(32 + colW + gap, rowY[1], colW, 56, 'Total Hrs Avail', data.totalHours, THEME.textPrimary)
  pill(32 + (colW + gap) * 2, rowY[1], colW, 56, 'Daily +/-', fmtDelta(data.delta), deltaColor)

  const adjColor = data.laborAfterAdj >= data.laborReq ? THEME.green : THEME.red
  const deltaAfterAdj = fmtDelta(r1(data.laborAfterAdj - data.laborReq))
  const deltaAfterAdjColor = (data.laborAfterAdj - data.laborReq) >= 0 ? THEME.green : THEME.red
  pill(32, rowY[2], colW, 56, 'Labor Req Total', data.laborReq, THEME.textPrimary)
  pill(32 + colW + gap, rowY[2], colW, 56, 'Labor After Adj', data.laborAfterAdj, adjColor)
  pill(32 + (colW + gap) * 2, rowY[2], colW, 56, 'Daily +/- After Adj', deltaAfterAdj, deltaAfterAdjColor)

  return canvas.toBuffer('image/png')
}

function renderProjectsTable(data, dateObj, cfg) {
  const create = loadCanvasLib()
  const rows = data.dailyProjectRows
  const ROW_H = 30
  const HEADER_H = 76
  const W = 640
  const H = HEADER_H + Math.max(rows.length, 1) * ROW_H + 24
  const canvas = create(W, H)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = THEME.bg0
  ctx.fillRect(0, 0, W, H)
  roundRect(ctx, 12, 12, W - 24, H - 24, 10)
  ctx.fillStyle = THEME.bg1
  ctx.fill()
  ctx.strokeStyle = THEME.border
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.fillStyle = THEME.textSecondary
  ctx.font = FONT(15, true)
  ctx.fillText(`${cfg.label} — Projects`, 32, 44)
  ctx.font = FONT(13, false)
  ctx.fillStyle = THEME.textDim
  ctx.fillText(formatHeaderDate(dateObj), 32, 64)

  const colX = { name: 32, dr: W - 300, inb: W - 220, out: W - 140, tot: W - 70 }
  let y = HEADER_H
  ctx.font = FONT(11, true)
  ctx.fillStyle = THEME.textDim
  ctx.fillText('PROJECT', colX.name, y)
  ctx.fillText('DROPS', colX.dr, y)
  ctx.fillText('INB', colX.inb, y)
  ctx.fillText('OUT', colX.out, y)
  ctx.fillText('TOTAL', colX.tot, y)
  y += 10
  ctx.strokeStyle = THEME.border
  ctx.beginPath(); ctx.moveTo(32, y); ctx.lineTo(W - 32, y); ctx.stroke()

  if (!rows.length) {
    ctx.font = FONT(13, false)
    ctx.fillStyle = THEME.textDim
    ctx.fillText('No projects scheduled.', 32, y + 24)
  }

  rows.forEach((r, i) => {
    const rowY = y + 12 + i * ROW_H + ROW_H / 2
    if (i % 2 === 1) {
      ctx.fillStyle = THEME.bg2
      ctx.fillRect(20, y + i * ROW_H, W - 40, ROW_H)
    }
    ctx.font = FONT(13, false)
    ctx.fillStyle = THEME.textPrimary
    const name = r.name.length > 34 ? r.name.slice(0, 34) + '…' : r.name
    ctx.fillText(name, colX.name, rowY + 4)
    ctx.fillStyle = THEME.textSecondary
    ctx.fillText(r.dr || '—', colX.dr, rowY + 4)
    ctx.fillText(r.inb || '—', colX.inb, rowY + 4)
    ctx.fillText(r.out || '—', colX.out, rowY + 4)
    ctx.font = FONT(13, true)
    ctx.fillStyle = cfg.color
    ctx.fillText(String(r.total || '—'), colX.tot, rowY + 4)
  })

  return canvas.toBuffer('image/png')
}

const LANE_COLUMNS = [
  { key: 'shift1', label: '1st Shift' },
  { key: 'mid', label: 'Mid Shift' },
  { key: 'shift2', label: '2nd Shift' },
  { key: 'shift3', label: '3rd Shift' },
  { key: 'pto', label: 'PTO' },
]

const AVATAR_PALETTE = ['#e07b4d', '#4d9de0', '#3dba7e', '#d4b84a', '#c084fc', '#e05c5c', '#4dc9e0']
function avatarColor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length]
}
function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}
function fmtHour(h) {
  const n = ((h % 24) + 24) % 24
  const hr = Math.floor(n)
  const mins = Math.round((n - hr) * 60)
  const disp = hr === 0 || hr === 12 ? 12 : hr % 12
  const suf = hr < 12 ? 'am' : 'pm'
  return `${disp}:${String(mins).padStart(2, '0')}${suf}`
}
function fmtShift(start, hours) {
  if (start == null) return null
  const end = (start + (hours ?? 8)) % 24
  return `${fmtHour(start)} – ${fmtHour(end)}`
}

const FACILITY_CODE_MAP = { cal: 'CAL', mad: 'MAD', ken: 'KEN', wr: 'WR', ec: 'EC' }

function groupRosterByLane(rosterRows) {
  const groups = { shift1: [], mid: [], shift2: [], shift3: [], pto: [] }
  for (const row of rosterRows) {
    if (row.on_loan_to) continue
    if (!groups[row.lane]) continue
    groups[row.lane].push(row)
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => {
      const as = a.shift_start ?? 999
      const bs = b.shift_start ?? 999
      return as - bs
    })
  }
  return groups
}

function renderShiftRoster(rosterRows, dateObj, cfg) {
  const create = loadCanvasLib()
  const groups = groupRosterByLane(rosterRows)

  const COL_W = 246
  const COL_GAP = 12
  const CARD_H = 58
  const CARD_GAP = 8
  const HEADER_H = 96
  const COL_HEADER_H = 40
  const PAD = 20

  const maxRows = Math.max(1, ...LANE_COLUMNS.map(c => groups[c.key].length))
  const W = PAD * 2 + LANE_COLUMNS.length * COL_W + (LANE_COLUMNS.length - 1) * COL_GAP
  const H = HEADER_H + COL_HEADER_H + maxRows * (CARD_H + CARD_GAP) + PAD

  const canvas = create(W, H)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = THEME.bg0
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = THEME.textSecondary
  ctx.font = FONT(15, true)
  ctx.fillText(`${cfg.label} — Shift Roster`, PAD, 32)
  ctx.font = FONT(13, false)
  ctx.fillStyle = THEME.textDim
  ctx.fillText(formatHeaderDate(dateObj), PAD, 52)

  LANE_COLUMNS.forEach((col, colIdx) => {
    const x = PAD + colIdx * (COL_W + COL_GAP)
    const rows = groups[col.key]
    const colTop = HEADER_H
    const colH = COL_HEADER_H + Math.max(rows.length, 1) * (CARD_H + CARD_GAP)

    roundRect(ctx, x, colTop, COL_W, colH, 8)
    ctx.fillStyle = THEME.bg1
    ctx.fill()
    ctx.strokeStyle = THEME.border
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = THEME.textSecondary
    ctx.font = FONT(12, true)
    ctx.fillText(col.label.toUpperCase(), x + 14, colTop + 25)
    ctx.beginPath()
    ctx.arc(x + COL_W - 22, colTop + 20, 12, 0, Math.PI * 2)
    ctx.fillStyle = THEME.bg2
    ctx.fill()
    ctx.strokeStyle = THEME.border
    ctx.stroke()
    ctx.fillStyle = THEME.textPrimary
    ctx.font = FONT(11, true)
    const countStr = String(rows.length)
    const countW = ctx.measureText(countStr).width
    ctx.fillText(countStr, x + COL_W - 22 - countW / 2, colTop + 24)

    if (rows.length === 0) {
      ctx.font = FONT(11, false)
      ctx.fillStyle = THEME.textDim
      ctx.fillText('No one scheduled', x + 14, colTop + COL_HEADER_H + 22)
    }

    rows.forEach((row, i) => {
      const cardY = colTop + COL_HEADER_H + i * (CARD_H + CARD_GAP)
      const cardX = x + 6
      const cardW = COL_W - 12

      let accent = cfg.color
      if (col.key === 'pto') accent = THEME.green
      else if (row.from_facility) accent = '#4d9de0'
      else if (row.is_temp) accent = '#d4b84a'

      roundRect(ctx, cardX, cardY, cardW, CARD_H, 6)
      ctx.fillStyle = THEME.bg2
      ctx.fill()
      ctx.strokeStyle = THEME.borderSubtle
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = accent
      ctx.fillRect(cardX, cardY, 4, CARD_H)

      const name = row.employee_name || '?'
      const avX = cardX + 24
      const avY = cardY + CARD_H / 2
      ctx.beginPath()
      ctx.arc(avX, avY, 14, 0, Math.PI * 2)
      ctx.fillStyle = avatarColor(name)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = FONT(10, true)
      const inits = initials(name)
      const initsW = ctx.measureText(inits).width
      ctx.fillText(inits, avX - initsW / 2, avY + 4)

      const textX = cardX + 48
      ctx.fillStyle = THEME.textPrimary
      ctx.font = FONT(12, true)
      const displayName = name.length > 20 ? name.slice(0, 20) + '…' : name
      ctx.fillText(displayName, textX, cardY + 20)

      let badgeText = null
      let badgeColor = null
      if (col.key === 'pto') { badgeText = 'PTO'; badgeColor = THEME.green }
      else if (row.from_facility) { badgeText = `FROM: ${FACILITY_CODE_MAP[row.from_facility] ?? row.from_facility.toUpperCase()}`; badgeColor = '#4d9de0' }
      else if (row.is_temp) { badgeText = 'TEMP'; badgeColor = '#d4b84a' }

      let lineY = cardY + 36
      if (badgeText) {
        ctx.font = FONT(9, true)
        ctx.fillStyle = badgeColor
        ctx.fillText(badgeText, textX, lineY)
        lineY += 14
      }

      const shiftLabel = fmtShift(row.shift_start, row.shift_hours)
      if (shiftLabel) {
        ctx.font = FONT(10, false)
        ctx.fillStyle = THEME.textSecondary
        ctx.fillText(shiftLabel, textX, lineY)
      }
    })
  })

  return canvas.toBuffer('image/png')
}

async function postImageComment(conversationId, pngBuffer, filename, caption) {
  const form = new FormData()
  form.set('body', caption)
  form.set('attachments[]', new Blob([pngBuffer], { type: 'image/png' }), filename)
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
    body: form,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(`Front API error posting ${filename}: ${JSON.stringify(json)}`)
  return json
}

const DOCK_ROWS = [
  { key: 'dock8', label: 'Dock 8' },
  { key: 'east', label: 'East' },
  { key: 'west', label: 'West' },
]

function padStr(str, len) { return String(str).padEnd(len, ' ') }

function buildDockCountsComment(dockCountsJson) {
  const docks = dockCountsJson.docks || {}
  const lines = []
  lines.push('Dock Counts')
  lines.push('')
  lines.push('```')
  lines.push(`${padStr('', 10)}IN    OUT`)
  for (const row of DOCK_ROWS) {
    const d = docks[row.key] || { in: 0, out: 0 }
    lines.push(`${padStr(row.label, 10)}${padStr(d.in, 6)}${d.out}`)
  }
  lines.push('```')
  if (docks.other && (docks.other.in > 0 || docks.other.out > 0)) {
    lines.push('')
    lines.push(`Note: ${docks.other.in + docks.other.out} load(s) at an unrecognized dock/location.`)
  }
  return lines.join('\n')
}

async function postTextComment(conversationId, body) {
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(`Front API error posting dock counts comment: ${JSON.stringify(json)}`)
  return json
}

async function runDigestForFacility(facilityId, { isManualTest }) {
  const cfg = FACILITY_CONFIGS[facilityId]
  if (!cfg) return { ok: false, reason: `Unknown facility '${facilityId}' — must be one of ${Object.keys(FACILITY_CONFIGS).join(', ')}` }

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.${facilityId}&dashboard_type=eq.daily_ops&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date,skip_to_next_valid_day`
  )
  const settings = settingsRows?.[0]
  const conversationId = settings?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for ${cfg.label} Daily Ops in prepick_notify_settings` }
  }

  let dateObj = tomorrowCentral()
  const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
  const skipToNextValidDay = settings.skip_to_next_valid_day === true

  if (!isManualTest && !notifyDays.includes(isoWeekday(dateObj))) {
    if (!skipToNextValidDay) {
      return { ok: true, skipped: true, reason: `${isoDate(dateObj)} is not a configured notify day` }
    }
    let advanced = 0
    while (!notifyDays.includes(isoWeekday(dateObj)) && advanced < 7) {
      dateObj = new Date(dateObj.getTime() + 24 * 60 * 60 * 1000)
      advanced++
    }
    if (!notifyDays.includes(isoWeekday(dateObj))) {
      return { ok: true, skipped: true, reason: 'No configured notify day found within 7 days' }
    }
  }
  const date = isoDate(dateObj)

  let previousLastSentDate = null
  if (!isManualTest) {
    if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }
    const notifyHour = settings.notify_hour ?? 22
    const notifyMinute = settings.notify_minute ?? 15
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
    }
    previousLastSentDate = settings.last_sent_date ?? null
    const claimed = await sbPatchClaim(
      `prepick_notify_settings?facility=eq.${facilityId}&dashboard_type=eq.daily_ops&or=(last_sent_date.is.null,last_sent_date.neq.${date})`,
      { last_sent_date: date }
    )
    if (!claimed.length) {
      return { ok: true, skipped: true, reason: 'Already sent for this date (claimed by another invocation)' }
    }
  }

  try {
    const data = await fetchSnapshotData(facilityId, date)
    const cardPng = renderTotalAppointmentsCard(data, dateObj, cfg)
    const tablePng = renderProjectsTable(data, dateObj, cfg)
    const rosterPng = renderShiftRoster(data.rosterRows, dateObj, cfg)

    const headerDate = formatHeaderDate(dateObj)
    const cardResult = await postImageComment(
      conversationId, cardPng, 'total-appointments.png',
      `${headerDate}\nhttps://csw-wi.netlify.app/?fac=${facilityId}&date=${date}\nLabor Planning`
    )
    const tableResult = await postImageComment(
      conversationId, tablePng, 'projects.png',
      `Projects - Total Appts`
    )
    const rosterResult = await postImageComment(
      conversationId, rosterPng, 'shift-roster.png',
      `Shift Roster`
    )

    let dockCountsCommentId = null
    let dockCountsError = null
    if (facilityId === 'mad') {
      try {
        const dockRes = await fetch(`${SITE_URL}/.netlify/functions/motherduck-dock-counts`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date }),
        })
        const dockText = await dockRes.text()
        let dockJson
        try { dockJson = JSON.parse(dockText) } catch { dockJson = { raw: dockText } }
        if (!dockRes.ok) throw new Error(`motherduck-dock-counts failed: ${JSON.stringify(dockJson)}`)
        const dockComment = await postTextComment(conversationId, buildDockCountsComment(dockJson))
        dockCountsCommentId = dockComment.id
      } catch (err) {
        dockCountsError = err.message
      }
    }

    return {
      ok: true, date, conversationId,
      cardCommentId: cardResult.id, tableCommentId: tableResult.id, rosterCommentId: rosterResult.id,
      dockCountsCommentId, dockCountsError,
      totalAppts: data.totalAppts, projectCount: data.dailyProjectRows.length,
    }
  } catch (err) {
    if (!isManualTest) {
      await sbPatch(
        `prepick_notify_settings?facility=eq.${facilityId}&dashboard_type=eq.daily_ops`,
        { last_sent_date: previousLastSentDate }
      ).catch(() => {})
    }
    throw err
  }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  FACILITY_CONFIGS,
  sbFetch, sbPatch,
  runDigestForFacility,
}
