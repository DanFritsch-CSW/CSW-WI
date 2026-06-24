import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchNetworkKpis } from '../lib/omni.js'
import { fetchAllFacilitiesEstDrops, fetchAllFacilitiesLaborCounts, fetchAllFacilitiesSettings } from '../lib/supabase.js'
import AllFacilities from './AllFacilities.jsx'
import FacilityPanel from './FacilityPanel.jsx'

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

  function setActiveTab(tab) { setSearchParams(prev => { prev.set('fac', tab); return prev }, { replace: true }) }
  function setPlanDate(date) { setSearchParams(prev => { prev.set('date', date); return prev }, { replace: true }) }
  function stepDay(n) { setPlanDate(addDays(planDate, n)) }

  const [networkData, setNetworkData]                 = useState(null)
  const [facilityEstDrops, setFacilityEstDrops]       = useState({})
  const [facilityLaborCounts, setFacilityLaborCounts] = useState({})
  const [facilitySettings, setFacilitySettings]       = useState({})
  const [facilityDeltas, setFacilityDeltas]           = useState({})
  const [facilityKpis, setFacilityKpis]               = useState({})
  const [snapLabel, setSnapLabel]                     = useState('Snapshot')
  const [mountedTabs, setMountedTabs]                 = useState(() => new Set())

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
            title="Previous week"
            style={{ padding: '6px 10px', fontSize: 14 }}
          >‹</button>
          <div style={{ display: 'flex', gap: 4 }}>
            {weekDays.map((iso, idx) => {
              const isActive   = iso === planDate
              const isTodayTab = iso === today
              return (
                <button
                  key={iso}
                  className="day-btn"
                  onClick={() => setPlanDate(iso)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: 1, padding: '4px 10px', minWidth: 50, position: 'relative',
                    ...(isActive ? {
                      borderColor: 'var(--brand)',
                      color: 'var(--brand)',
                      fontWeight: 600,
                    } : { color: 'var(--text-secondary)' }),
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
            title="Next week"
            style={{ padding: '6px 10px', fontSize: 14 }}
          >›</button>
          <input type="date" className="day-input" value={planDate} onChange={e => setPlanDate(e.target.value)} />
          {activeTab !== 'all' && (
            <button className="snapshot-btn" onClick={handleSnapshot}>{snapLabel}</button>
          )}
        </div>
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

      {/* ALL tab */}
      <div style={{ display: activeTab === 'all' ? undefined : 'none' }}>
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
      </div>

      {/* Facility panels — mounted once on first visit, hidden via CSS otherwise */}
      {FACILITY_LIST.map(fac => {
        const isActive = activeTab === fac.id
        if (!mountedTabs.has(fac.id)) return null
        return (
          <div key={fac.id} style={{ display: isActive ? undefined : 'none' }}>
            <FacilityPanel
              facility={fac}
              planDate={planDate}
              networkKpi={networkData?.[fac.id]}
              onDeltaComputed={handleDeltaComputed}
              onKpiComputed={handleKpiComputed}
            />
          </div>
        )
      })}
    </div>
  )
}
