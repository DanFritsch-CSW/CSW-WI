import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchNetworkKpis } from '../lib/omni.js'
import { fetchAllFacilitiesEstDrops, fetchAllFacilitiesLaborCounts, fetchAllFacilitiesSettings } from '../lib/supabase.js'
import AllFacilities from './AllFacilities.jsx'
import FacilityPanel from './FacilityPanel.jsx'
import '../styles/view-tabs.css'

function todayISO() { return new Date().toISOString().slice(0, 10) }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

// Monday of the week containing `iso`. Mon=1..Sat=6, Sun=0 → -6 shift.
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00')
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().slice(0, 10)
}
function formatMDD(iso) {
  const d = new Date(iso + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const ALL_TAB = { id: 'all', code: 'ALL', name: 'All Facilities', color: '#8a9899' }
const TABS = [ALL_TAB, ...FACILITY_LIST]

export default function LaborPlanning() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('fac') || 'all'
  const planDate  = searchParams.get('date') || todayISO()
  const view      = searchParams.get('view') === 'weekly' ? 'weekly' : 'daily'

  function setActiveTab(tab) { setSearchParams(prev => { prev.set('fac', tab); return prev }, { replace: true }) }
  function setPlanDate(date) { setSearchParams(prev => { prev.set('date', date); return prev }, { replace: true }) }
  function setView(v) { setSearchParams(prev => { prev.set('view', v); return prev }, { replace: true }) }

  const [networkData, setNetworkData]                 = useState(null)
  const [facilityEstDrops, setFacilityEstDrops]       = useState({})
  const [facilityLaborCounts, setFacilityLaborCounts] = useState({})
  const [facilitySettings, setFacilitySettings]       = useState({})
  const [facilityDeltas, setFacilityDeltas]           = useState({})
  const [facilityKpis, setFacilityKpis]               = useState({})
  const [snapLabel, setSnapLabel]                     = useState('Snapshot')
  const [mountedTabs, setMountedTabs]                 = useState(() => new Set())
  // ── Per-facility "still loading/saving this date" signal (2026-07-16) ──
  // Fed by each FacilityPanel's onBusyChange (which itself combines its own
  // load phases with RosterBoard's busy state). Used below to disable date
  // navigation (week arrows, day tabs, date input) until the ACTIVE
  // facility's currently-viewed date has actually finished loading and any
  // roster writes have landed in Supabase. Added per Dan's report that
  // switching dates before the previous date settled was contributing to
  // both the KPI-flicker and roster "lost changes" complaints.
  const [facilityBusy, setFacilityBusy]                = useState({})

  const pageRef = useRef(null)

  useEffect(() => {
    if (activeTab !== 'all') {
      setMountedTabs(prev => prev.has(activeTab) ? prev : new Set([...prev, activeTab]))
    }
  }, [activeTab])

  useEffect(() => {
    setFacilityDeltas({})
    setFacilityKpis({})
  }, [planDate])

  const handleDeltaComputed = useCallback((facilityId, delta) => {
    setFacilityDeltas(prev => ({ ...prev, [facilityId]: delta }))
  }, [])

  const handleKpiComputed = useCallback((facilityId, kpi) => {
    setFacilityKpis(prev => ({ ...prev, [facilityId]: kpi }))
  }, [])

  const handleBusyChange = useCallback((facilityId, busy) => {
    setFacilityBusy(prev => (prev[facilityId] === busy ? prev : { ...prev, [facilityId]: busy }))
  }, [])

  // Stable per-facility onBusyChange callbacks so FacilityPanel's busy
  // effect doesn't re-fire on every LaborPlanning render (handleBusyChange
  // itself is stable — this just avoids handing each FacilityPanel a new
  // function identity every time).
  const busyHandlers = useMemo(
    () => Object.fromEntries(FACILITY_LIST.map(f => [f.id, (busy) => handleBusyChange(f.id, busy)])),
    [handleBusyChange]
  )

  // Only the currently-active facility tab's busy state gates date
  // navigation — a background-mounted tab still finishing its own load
  // doesn't block the user from moving around on the tab they're
  // actually looking at.
  const isDateNavBusy = activeTab !== 'all' && !!facilityBusy[activeTab]

  function stepDay(n) { if (isDateNavBusy) return; setPlanDate(addDays(planDate, n)) }
  function selectDate(date) { if (isDateNavBusy) return; setPlanDate(date) }

  const handleSnapshot = useCallback(async () => {
    if (!pageRef.current) return
    setSnapLabel('Capturing...')
    try {
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(pageRef.current, {
        useCORS: true, allowTaint: true, scale: 2,
        backgroundColor: '#080e1a', scrollX: 0, scrollY: -window.scrollY,
        windowWidth: document.documentElement.scrollWidth,
        windowHeight: pageRef.current.scrollHeight,
      })
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'))
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setSnapLabel('Copied!') }
      catch { setSnapLabel('Saved!') }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `csw-${activeTab}-${planDate}.png`; a.click()
      URL.revokeObjectURL(url)
    } catch { setSnapLabel('Snapshot') }
    setTimeout(() => setSnapLabel('Snapshot'), 2500)
  }, [activeTab, planDate])

  useEffect(() => {
    fetchNetworkKpis(planDate).then(setNetworkData)
    fetchAllFacilitiesEstDrops(planDate).then(setFacilityEstDrops)
    fetchAllFacilitiesLaborCounts(planDate).then(setFacilityLaborCounts)
    fetchAllFacilitiesSettings().then(setFacilitySettings)
  }, [planDate])

  const today     = todayISO()
  const weekStart = mondayOf(planDate)
  const weekDays  = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  return (
    <div className="page-content" ref={pageRef}>
      <div className="page-header">
        <div>
          <div className="page-title"><span className="page-title-gold">Labor</span> Planning</div>
          <div className="page-subtitle">CSW 3PL · 5 Wisconsin Facilities</div>
        </div>
        <div className="day-selector">
          <button
            className="day-btn"
            onClick={() => stepDay(-7)}
            disabled={isDateNavBusy}
            title={isDateNavBusy ? "Finishing this date's update…" : 'Previous week'}
            style={{ padding: '6px 10px', fontSize: 14, ...(isDateNavBusy ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
          >‹</button>
          <div style={{ display: 'flex', gap: 4 }}>
            {weekDays.map((iso, idx) => {
              const isActive   = iso === planDate
              const isTodayTab = iso === today
              return (
                <button
                  key={iso}
                  className="day-btn"
                  onClick={() => selectDate(iso)}
                  disabled={isDateNavBusy}
                  title={isDateNavBusy ? "Finishing this date's update…" : undefined}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: 1, padding: '4px 10px', minWidth: 50, position: 'relative',
                    ...(isActive ? {
                      borderColor: 'var(--brand)',
                      color: 'var(--brand)',
                      fontWeight: 600,
                    } : { color: 'var(--text-secondary)' }),
                    ...(isDateNavBusy ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
                  }}
                >
                  <span style={{ fontSize: 10, opacity: 0.7 }}>{DAY_LABELS[idx]}</span>
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{formatMDD(iso)}</span>
                  {isTodayTab && (
                    <span
                      style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: 'var(--brand)',
                        position: 'absolute', bottom: 2,
                      }}
                    />
                  )}
                </button>
              )
            })}
          </div>
          <button
            className="day-btn"
            onClick={() => stepDay(7)}
            disabled={isDateNavBusy}
            title={isDateNavBusy ? "Finishing this date's update…" : 'Next week'}
            style={{ padding: '6px 10px', fontSize: 14, ...(isDateNavBusy ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
          >›</button>
          <input
            type="date"
            className="day-input"
            value={planDate}
            onChange={e => selectDate(e.target.value)}
            disabled={isDateNavBusy}
            style={isDateNavBusy ? { opacity: 0.45, cursor: 'not-allowed' } : {}}
          />
          {isDateNavBusy && (
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
              Finishing this date's update…
            </span>
          )}
          {activeTab !== 'all' && (
            <button className="snapshot-btn" onClick={handleSnapshot}>{snapLabel}</button>
          )}
        </div>
      </div>

      {/* Global Daily / Weekly view tabs — applies to all facilities */}
      <div className="view-tab-row">
        <button
          className={`view-tab${view === 'daily' ? ' active' : ''}`}
          onClick={() => setView('daily')}
        >Daily</button>
        <button
          className={`view-tab${view === 'weekly' ? ' active' : ''}`}
          onClick={() => setView('weekly')}
        >Weekly</button>
        <span className="view-hint">Global · applies to all facilities</span>
      </div>

      <div className="facility-tabs">
        {TABS.map(tab => (
          <button key={tab.id}
            className={`fac-tab${activeTab === tab.id ? ' active' : ''}`}
            style={activeTab === tab.id ? { color: tab.color, borderColor: tab.color } : {}}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.id !== 'all' && <span className="dot" style={{ background: tab.color }} />}
            {tab.code}
          </button>
        ))}
      </div>

      {/* ALL tab — Daily shows network summary, Weekly shows a stub */}
      <div style={{ display: activeTab === 'all' ? undefined : 'none' }}>
        {view === 'daily' ? (
          <AllFacilities
            networkData={networkData}
            facilityEstDrops={facilityEstDrops}
            facilityLaborCounts={facilityLaborCounts}
            facilitySettings={facilitySettings}
            facilityDeltas={facilityDeltas}
            facilityKpis={facilityKpis}
            planDate={planDate}
            onFacilityClick={setActiveTab}
          />
        ) : (
          <div className="weekly-stub">
            <div className="weekly-stub-title">Weekly View — All Facilities</div>
            <div className="weekly-stub-sub">Select a facility tab above to see the weekly Projects grid and Customer Snapshot.</div>
          </div>
        )}
      </div>

      {/* Facility panels — mounted once on first visit, hidden via CSS otherwise.
          FacilityPanel internally branches on the `view` prop. */}
      {FACILITY_LIST.map(fac => {
        const isActive = activeTab === fac.id
        if (!mountedTabs.has(fac.id)) return null
        return (
          <div key={fac.id} style={{ display: isActive ? undefined : 'none' }}>
            <FacilityPanel
              facility={fac}
              planDate={planDate}
              view={view}
              networkKpi={networkData?.[fac.id]}
              onDeltaComputed={handleDeltaComputed}
              onKpiComputed={handleKpiComputed}
              onBusyChange={busyHandlers[fac.id]}
            />
          </div>
        )
      })}
    </div>
  )
}
