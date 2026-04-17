const DEFAULTS = { hours_per_appt: 1.5, break_pct: 10 }

// Override req/avail in hourly data using facility settings.
// req  = appts * hours_per_appt  (recalculated from raw appointment count)
// avail = avail * (1 - break_pct/100)  (capacity reduced by breaks)
export function applySettings(hourlyData, settings) {
  const hpa      = settings?.hours_per_appt ?? DEFAULTS.hours_per_appt
  const breakPct = settings?.break_pct      ?? DEFAULTS.break_pct
  const breakMul = 1 - breakPct / 100
  return hourlyData.map(row => ({
    ...row,
    req:   row.appts * hpa,
    avail: row.avail * breakMul,
  }))
}

// Compute daily util% and delta from transformed hourly rows.
export function computeDailyKpis(hourly) {
  if (!hourly?.length) return { util: null, delta: null }
  const totalReq   = hourly.reduce((s, r) => s + (r.req   ?? 0), 0)
  const totalAvail = hourly.reduce((s, r) => s + (r.avail ?? 0), 0)
  const util  = totalAvail > 0 ? totalReq / totalAvail : null
  const delta = totalAvail > 0 ? totalAvail - totalReq  : null
  return { util, delta }
}
