import { useState, useEffect, useRef } from 'react'
import { getAppointmentInsights, getLaborInsights, getOwnerInsights, getHourAppointmentList } from '../../lib/schedulingApi.js'

// Ported from front_netlify_datex/src/components/AppointmentInsights.jsx
// (2026-08-03). UPDATED 2026-08-18 per Dan's request to tie this panel's
// labor numbers to the real Labor Planning tab instead of a lookalike Omni
// topic — see scheduling-labor-planning-insights.cjs. UPDATED AGAIN
// 2026-08-19 after Dan reported the numbers still didn't match: this
// component was silently folding EST Drops into the "Inbound" stat
// (totalInbound = inbound + totalDrops), which is why Inbound showed 45
// instead of 9 — Labor Planning shows Drops as its OWN separate stat, not
// merged into Inbound. Fixed: now shows Total / Inbound / Outbound / Drops
// as four separate numbers, matching Labor Planning's card layout exactly.
//
// Changes across both passes:
//   1. New day-level labor summary row (Available/Required/Delta hrs),
//      mirroring the appointment summary row above it.
//   2. Per-hour rows now show the actual surplus/deficit number
//      (e.g. "-2.3") instead of only a red/green dot.
//   3. NOT built this pass: flagging in the arrival-time PICKER itself
//      whether adding this appointment would push an hour into deficit.
//      That needs the picker to know hours_per_appt, which lives in
//      facility_settings and isn't plumbed into PluginView today — real
//      next step, scoped out for now rather than half-built.
//   4. "Est." badge (in place of "LIVE") when the labor data came from the
//      Omni-topic fallback rather than the real roster — see `source` on
//      the getLaborInsights response.
//   5. (2026-08-19) Drops is its own stat card now, not folded into Inbound.

const COLOR_INBOUND = '#378ADD'
const COLOR_DROPS = '#A78BFA'
const COLOR_OUTBOUND = '#D85A30'
const COLOR_SHORT = '#E24B4A'
const COLOR_STAFFED = '#1D9E75'

// Full 5am-5am shift window in display order
const HOURS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4]

function formatHour(h) {
  if (h === 0) return '12a'
  if (h === 12) return '12p'
  if (h < 12) return `${h}a`
  return `${h - 12}p`
}

function fmtHrs(n) {
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}`
}

/**
 * AppointmentInsights — Day Insights panel for the Front sidebar plugin.
 *
 * Props:
 *   warehouse     — e.g. "CSW-Caledonia"
 *   date          — ISO date string "2026-04-13"
 *   selectedHour  — 24-hour integer from the arrival time picker, or null
 *   selectedOwner — owner name string from the owner dropdown, or null
 *   project       — project name string from the project field, or null
 */
export default function AppointmentInsights({ warehouse, date, selectedHour, selectedOwner, project }) {
  const [open, setOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const [hourlyData, setHourlyData] = useState([])
  const [laborData, setLaborData] = useState([])
  const [laborDaily, setLaborDaily] = useState(null)
  const [laborSource, setLaborSource] = useState(null) // 'roster' | 'omni_fallback' | null
  const [ownerData, setOwnerData] = useState(null)
  const [ownerLoading, setOwnerLoading] = useState(false)
  const [hasLiveData, setHasLiveData] = useState(false)
  const [fetchError, setFetchError] = useState(null)

  const [expandedHours, setExpandedHours] = useState(new Set())
  const [apptList, setApptList] = useState({ status: 'idle', data: [] })
  const apptListStatusRef = useRef('idle')

  const apptLaborCacheRef = useRef({})

  useEffect(() => {
    setExpandedHours(new Set())
    setApptList({ status: 'idle', data: [] })
    apptListStatusRef.current = 'idle'
  }, [warehouse, date])

  useEffect(() => {
    if (!warehouse || !date) {
      setHourlyData([])
      setLaborData([])
      setLaborDaily(null)
      setLaborSource(null)
      setHasLiveData(false)
      return
    }

    const cacheKey = `${warehouse}|${date}`
    const cached = apptLaborCacheRef.current[cacheKey]
    if (cached) {
      setHourlyData(cached.hourlyData)
      setLaborData(cached.laborData)
      setLaborDaily(cached.laborDaily)
      setLaborSource(cached.laborSource)
      setHasLiveData(true)
      return
    }

    setLoading(true)
    setHasLiveData(false)
    setFetchError(null)

    Promise.all([getAppointmentInsights(warehouse, date), getLaborInsights(warehouse, date)])
      .then(([apptRes, laborRes]) => {
        const hourly = apptRes.hours || []
        const labor = laborRes.hours || []
        const daily = laborRes.daily || null
        const source = laborRes.source || null
        setHourlyData(hourly)
        setLaborData(labor)
        setLaborDaily(daily)
        setLaborSource(source)
        setHasLiveData(true)
        const err = apptRes.error || laborRes.error || null
        setFetchError(err)
        apptLaborCacheRef.current[cacheKey] = { hourlyData: hourly, laborData: labor, laborDaily: daily, laborSource: source }
      })
      .catch((err) => {
        console.warn('[AppointmentInsights] fetch failed:', err.message)
        setHasLiveData(false)
        setFetchError(err.message)
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouse, date])

  useEffect(() => {
    if (!selectedOwner || !warehouse || !date) {
      setOwnerData(null)
      return
    }
    setOwnerLoading(true)
    setOwnerData(null)
    getOwnerInsights(warehouse, date, selectedOwner, project)
      .then((data) => setOwnerData(data))
      .catch(() => setOwnerData(null))
      .finally(() => setOwnerLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOwner, project, warehouse, date])

  if (!warehouse || !date) return null

  const totalDrops = laborData.reduce((s, l) => s + (l.drops || 0), 0)
  const totalInbound = hourlyData.reduce((s, h) => s + h.inbound, 0)
  const totalOutbound = hourlyData.reduce((s, h) => s + h.outbound, 0)
  const totalAppts = totalInbound + totalOutbound + totalDrops

  const maxTotal = Math.max(
    1,
    ...HOURS.map((h) => {
      const a = hourlyData.find((x) => x.hour === h)
      const l = laborData.find((x) => x.hour === h)
      return (a ? a.inbound + a.outbound : 0) + (l ? l.drops || 0 : 0)
    })
  )

  const dateHeader = (() => {
    if (!date) return 'DAY INSIGHTS'
    const [y, m, d] = date.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    const day = dt.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
    const mon = dt.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()
    return `DAY INSIGHTS — ${day}, ${mon} ${dt.getDate()}`
  })()

  function toggleHour(h) {
    setExpandedHours((prev) => {
      const next = new Set(prev)
      if (next.has(h)) {
        next.delete(h)
      } else {
        next.add(h)
      }
      return next
    })

    if (apptListStatusRef.current === 'idle') {
      apptListStatusRef.current = 'loading'
      setApptList({ status: 'loading', data: [] })
      getHourAppointmentList(warehouse, date)
        .then((res) => {
          apptListStatusRef.current = 'loaded'
          setApptList({ status: 'loaded', data: res.appts || [] })
        })
        .catch(() => {
          apptListStatusRef.current = 'error'
          setApptList({ status: 'error', data: [] })
        })
    }
  }

  return (
    <>
      {selectedOwner && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="mb-1.5">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider leading-none">
              {selectedOwner.length > 32 ? selectedOwner.slice(0, 32) + '…' : selectedOwner}
            </p>
            {project && <p className="text-[10px] text-gray-400 mt-0.5 leading-snug">{project}</p>}
          </div>

          {ownerLoading && <p className="text-[11px] text-gray-400">Loading…</p>}

          {!ownerLoading &&
            ownerData &&
            (() => {
              const todayList = ownerData.today || []
              const avgDow = ownerData.avgDow || null
              const todayIn = todayList.reduce((s, h) => s + h.inbound, 0)
              const todayOut = todayList.reduce((s, h) => s + h.outbound, 0)
              const todayTotal = todayIn + todayOut
              return (
                <>
                  {todayTotal === 0 ? (
                    <p className="text-[11px] text-gray-400 mb-0.5">No appointments today.</p>
                  ) : (
                    <p className="text-[11px] text-gray-600 mb-0.5">
                      Today:{' '}
                      <span className="font-medium" style={{ color: COLOR_INBOUND }}>
                        {todayIn} in
                      </span>
                      {' · '}
                      <span className="font-medium" style={{ color: COLOR_OUTBOUND }}>
                        {todayOut} out
                      </span>{' '}
                      <span className="text-gray-400">({todayTotal} total)</span>
                    </p>
                  )}
                  {avgDow && (
                    <p className="text-[10px] text-gray-400">
                      {avgDow.dayName} avg (120d):{' '}
                      <span style={{ color: COLOR_INBOUND }}>{avgDow.inbound} in</span>
                      {' · '}
                      <span style={{ color: COLOR_OUTBOUND }}>{avgDow.outbound} out</span>
                      {' · '}
                      <span>{avgDow.total} total</span>
                    </p>
                  )}
                </>
              )
            })()}
        </div>
      )}

      <div className="mt-4 border-t border-gray-100 pt-3">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center justify-between w-full text-left">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{dateHeader}</span>
          <div className="flex items-center gap-1.5">
            {hasLiveData && laborSource === 'omni_fallback' && (
              <span
                className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full leading-none"
                title="No roster synced for this date yet — labor numbers are an Omni estimate, not the real roster."
              >
                EST.
              </span>
            )}
            {hasLiveData && (
              <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full leading-none">
                LIVE
              </span>
            )}
            <span className="text-gray-400 text-[10px]">{open ? '▾' : '▸'}</span>
          </div>
        </button>

        {open && (
          <div className="mt-2">
            {loading && <p className="text-[11px] text-gray-400 py-1">Loading insights…</p>}

            {!loading && fetchError && <p className="text-[11px] text-red-500 py-1 break-words">⚠ {fetchError}</p>}

            {!loading && hasLiveData && (
              <>
                <div className="flex gap-1 mb-1.5">
                  <div className="flex-1 bg-gray-50 rounded-lg px-1.5 py-1.5 text-center">
                    <div className="text-[9px] font-medium text-gray-400 leading-none mb-0.5">Total</div>
                    <div className="text-sm font-bold text-gray-800 leading-none">{totalAppts}</div>
                  </div>
                  <div className="flex-1 rounded-lg px-1.5 py-1.5 text-center" style={{ backgroundColor: '#EBF3FB' }}>
                    <div className="text-[9px] font-medium leading-none mb-0.5" style={{ color: COLOR_INBOUND }}>
                      Inbound
                    </div>
                    <div className="text-sm font-bold leading-none" style={{ color: COLOR_INBOUND }}>
                      {totalInbound}
                    </div>
                  </div>
                  <div className="flex-1 rounded-lg px-1.5 py-1.5 text-center" style={{ backgroundColor: '#FBF0EB' }}>
                    <div className="text-[9px] font-medium leading-none mb-0.5" style={{ color: COLOR_OUTBOUND }}>
                      Outbound
                    </div>
                    <div className="text-sm font-bold leading-none" style={{ color: COLOR_OUTBOUND }}>
                      {totalOutbound}
                    </div>
                  </div>
                  <div className="flex-1 rounded-lg px-1.5 py-1.5 text-center" style={{ backgroundColor: '#F2EFFB' }}>
                    <div className="text-[9px] font-medium leading-none mb-0.5" style={{ color: COLOR_DROPS }}>
                      Drops
                    </div>
                    <div className="text-sm font-bold leading-none" style={{ color: COLOR_DROPS }}>
                      {totalDrops}
                    </div>
                  </div>
                </div>

                {/* Day-level labor summary — mirrors the appointment summary above,
                    added 2026-08-18. Available/Required come straight from the real
                    Labor Planning roster calc (or the Omni-estimate fallback — see
                    the EST. badge above if so). */}
                {laborDaily && (
                  <div className="flex gap-1.5 mb-2.5">
                    <div className="flex-1 bg-gray-50 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-[10px] font-medium text-gray-400 leading-none mb-0.5">Avail Hrs</div>
                      <div className="text-sm font-bold text-gray-800 leading-none">{laborDaily.totalAvailable.toFixed(1)}</div>
                    </div>
                    <div className="flex-1 bg-gray-50 rounded-lg px-2 py-1.5 text-center">
                      <div className="text-[10px] font-medium text-gray-400 leading-none mb-0.5">Req Hrs</div>
                      <div className="text-sm font-bold text-gray-800 leading-none">{laborDaily.totalRequired.toFixed(1)}</div>
                    </div>
                    <div
                      className="flex-1 rounded-lg px-2 py-1.5 text-center"
                      style={{ backgroundColor: laborDaily.delta < 0 ? '#FBEBEB' : '#EBFBF2' }}
                    >
                      <div className="text-[10px] font-medium leading-none mb-0.5" style={{ color: laborDaily.delta < 0 ? COLOR_SHORT : COLOR_STAFFED }}>
                        Delta
                      </div>
                      <div className="text-sm font-bold leading-none" style={{ color: laborDaily.delta < 0 ? COLOR_SHORT : COLOR_STAFFED }}>
                        {fmtHrs(laborDaily.delta)}
                      </div>
                    </div>
                  </div>
                )}

                {selectedHour != null &&
                  (() => {
                    const appts = hourlyData.find((h) => h.hour === selectedHour)
                    const labor = laborData.find((l) => l.hour === selectedHour)
                    const drops = labor ? labor.drops || 0 : 0
                    const total = (appts ? appts.inbound + appts.outbound : 0) + drops
                    const density = total === 0 ? 'no appointments' : total <= 3 ? 'light traffic' : total <= 8 ? 'moderate traffic' : 'heavy traffic'
                    const isShort = labor && labor.final < 0
                    return (
                      <div className={`mb-2 px-2 py-1.5 rounded-lg text-[11px] border ${isShort ? 'bg-red-50 border-red-100 text-red-800' : 'bg-indigo-50 border-indigo-100 text-indigo-800'}`}>
                        <span className="font-semibold">{formatHour(selectedHour)}</span> has {density} — {total} appt
                        {total !== 1 ? 's' : ''}
                        {isShort && <span className="text-red-600 font-medium"> · ⚠ Short {Math.abs(labor.final).toFixed(1)} staff</span>}
                      </div>
                    )
                  })()}

                <div className="space-y-0.5">
                  {HOURS.map((h) => {
                    const appts = hourlyData.find((a) => a.hour === h) || { inbound: 0, outbound: 0 }
                    const labor = laborData.find((l) => l.hour === h)
                    const drops = labor ? labor.drops || 0 : 0
                    const isShort = labor && labor.final < 0
                    const hasLabor = !!labor
                    const total = appts.inbound + appts.outbound + drops
                    const barPct = total > 0 ? Math.max(4, (total / maxTotal) * 100) : 0
                    const isSelected = selectedHour === h
                    const isExpanded = expandedHours.has(h)
                    const hasAppts = total > 0

                    return (
                      <div key={h} className="rounded">
                        <div
                          role={hasAppts ? 'button' : undefined}
                          tabIndex={hasAppts ? 0 : undefined}
                          onClick={hasAppts ? () => toggleHour(h) : undefined}
                          onKeyDown={
                            hasAppts
                              ? (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') toggleHour(h)
                                }
                              : undefined
                          }
                          className={`flex items-center gap-1.5 px-1 py-0.5 rounded ${
                            isExpanded ? 'bg-gray-100' : isSelected ? 'bg-indigo-50' : hasAppts ? 'hover:bg-gray-50 cursor-pointer' : ''
                          }`}
                        >
                          <div className="flex items-center gap-0.5 w-9 shrink-0">
                            {hasLabor ? (
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: isShort ? COLOR_SHORT : COLOR_STAFFED }} />
                            ) : (
                              <span className="w-1.5 h-1.5 shrink-0" />
                            )}
                            <span className="text-[11px] text-gray-500 font-mono">{formatHour(h)}</span>
                          </div>

                          <div className="flex-1 flex items-center gap-1 min-w-0">
                            <div className="flex-1 relative h-2">
                              {total > 0 && (
                                <div className="absolute left-0 top-0 h-full flex rounded-sm overflow-hidden" style={{ width: `${barPct}%` }}>
                                  {appts.inbound > 0 && <div style={{ width: `${(appts.inbound / total) * 100}%`, backgroundColor: COLOR_INBOUND }} />}
                                  {drops > 0 && <div style={{ width: `${(drops / total) * 100}%`, backgroundColor: COLOR_DROPS }} />}
                                  {appts.outbound > 0 && <div style={{ width: `${(appts.outbound / total) * 100}%`, backgroundColor: COLOR_OUTBOUND }} />}
                                </div>
                              )}
                            </div>
                            <span className="text-[10px] text-gray-400 w-4 text-right shrink-0">{total > 0 ? total : ''}</span>
                          </div>

                          {/* Per-hour labor surplus/deficit — added 2026-08-18. Was a
                              dot-only indicator before; now shows the actual number
                              so a CSR can see how short/staffed an hour is at a glance
                              instead of inferring it from a color. */}
                          {hasLabor ? (
                            <span
                              className="text-[10px] font-mono font-semibold w-9 text-right shrink-0"
                              style={{ color: isShort ? COLOR_SHORT : COLOR_STAFFED }}
                              title={`Available ${labor.labor_available.toFixed(1)} hrs — Required ${labor.labor_required.toFixed(1)} hrs`}
                            >
                              {fmtHrs(labor.final)}
                            </span>
                          ) : (
                            <span className="w-9 shrink-0" />
                          )}

                          {hasAppts ? (
                            <span className="text-[9px] text-gray-300 shrink-0 w-2.5 text-center">{isExpanded ? '▾' : '▸'}</span>
                          ) : (
                            <span className="w-2.5 shrink-0" />
                          )}
                        </div>

                        {isExpanded && (
                          <div className="ml-9 mr-1 mb-1 mt-0.5">
                            {apptList.status === 'loading' && <p className="text-[10px] text-gray-400 py-1 px-1.5">Loading…</p>}
                            {apptList.status === 'error' && <p className="text-[10px] text-red-400 py-1 px-1.5">Failed to load appointments</p>}
                            {apptList.status === 'loaded' &&
                              (() => {
                                const hourAppts = apptList.data.filter((a) => a.hour === h).sort((a, b) => (a.time || '').localeCompare(b.time || ''))
                                if (hourAppts.length === 0) {
                                  return <p className="text-[10px] text-gray-400 py-1 px-1.5 italic">No individual records found</p>
                                }
                                return (
                                  <div className="rounded border border-gray-100 overflow-hidden">
                                    <table className="w-full text-[10px] border-collapse">
                                      <thead>
                                        <tr className="bg-gray-50">
                                          <th className="text-left px-1.5 py-0.5 text-[9px] font-semibold text-gray-400 uppercase tracking-wide">Owner</th>
                                          <th className="text-left px-1.5 py-0.5 text-[9px] font-semibold text-gray-400 uppercase tracking-wide">Time</th>
                                          <th className="text-left px-1.5 py-0.5 text-[9px] font-semibold text-gray-400 uppercase tracking-wide">Door</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {hourAppts.map((appt, i) => {
                                          const isIn = appt.type && appt.type.includes('Inbound')
                                          return (
                                            <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                              <td className="px-1.5 py-0.5 text-gray-700 max-w-[72px] truncate" title={appt.code || undefined}>
                                                {appt.code || '—'}
                                              </td>
                                              <td className="px-1.5 py-0.5 text-gray-600 whitespace-nowrap">
                                                <span className="inline-block w-1 h-1 rounded-full mr-1 align-middle" style={{ backgroundColor: isIn ? COLOR_INBOUND : COLOR_OUTBOUND }} />
                                                {appt.time || '—'}
                                              </td>
                                              <td className="px-1.5 py-0.5 text-gray-600 truncate max-w-[64px]" title={appt.dock_door || undefined}>
                                                {appt.dock_door || '—'}
                                              </td>
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                )
                              })()}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
