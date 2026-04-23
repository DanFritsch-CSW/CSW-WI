import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchNetworkKpis } from '../lib/omni.js'
import { fetchAllFacilitiesEstDrops, fetchAllFacilitiesLaborCounts } from '../lib/supabase.js'
import AllFacilities from './AllFacilities.jsx'
import FacilityPanel from './FacilityPanel.jsx'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function tomorrowISO() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

const ALL_TAB = { id: 'all', code: 'ALL', name: 'All Facilities', color: '#8a9899' }
const TABS = [ALL_TAB, ...FACILITY_LIST]

export default function LaborPlanning() {
  const [searchParams, setSearchParams] = useSearchParams()

  const activeTab = searchParams.get('fac') || 'all'
  const planDate  = searchParams.get('date') || todayISO()

  function setActiveTab(tab) {
    setSearchParams(prev => { prev.set('fac', tab); return prev }, { replace: true })
  }

  function setPlanDate(date) {
    setSearchParams(prev => { prev.set('date', date); return prev }, { replace: true })
  }

  function stepDay(n) {
    setPlanDate(addDays(planDate, n))
  }

  const [networkData, setNetworkData]                 = useState(null)
  const [facilityEstDrops, setFacilityEstDrops]       = useState({})
  const [facilityLaborCounts, setFacilityLaborCounts] = useState({})
  // Facility-computed deltas (break-adjusted hourly avail - req) bubbled up from FacilityPanel
  const [facilityDeltas, setFacilityDeltas]           = useState({})
  const [snapLabel, setSnapLabel]                     = useState('Snapshot')
  const pageRef = useRef(null)

  // Reset deltas when date changes so stale values don’t linger
  useEffect(() => {
    setFacilityDeltas({})
  }, [planDate])

  const handleDeltaComputed = useCallback((facilityId, delta) => {
    setFacilityDeltas(prev => ({ ...prev, [facilityId]: delta }))
  }, [])

  const handleSnapshot = useCallback(async () => {
    if (!pageRef.current) return
    setSnapLabel('Capturing…')
    try {
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(pageRef.current, {
        useCORS: true,
        allowTaint: true,
        scale: 2,
        backgroundColor: '#080e1a',
        scrollX: 0,
        scrollY: -window.scrollY,
        windowWidth: document.documentElement.scrollWidth,
        windowHeight: pageRef.current.scrollHeight,
      })
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'))
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setSnapLabel('Copied!')
      } catch {
        setSnapLabel('Saved!')
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `csw-${activeTab}-${planDate}.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setSnapLabel('Snapshot')
    }
    setTimeout(() => setSnapLabel('Snapshot'), 2500)
  }, [activeTab, planDate])

  useEffect(() => {
    fetchNetworkKpis(planDate).then(setNetworkData)
    fetchAllFacilitiesEstDrops(planDate).then(setFacilityEstDrops)
    fetchAllFacilitiesLaborCounts(planDate).then(setFacilityLaborCounts)
  }, [planDate])

  const activeFac = FACILITY_LIST.find(f => f.id === activeTab) || null

  const isToday    = planDate === todayISO()
  const isTomorrow = planDate === tomorrowISO()

  return (
    <div className="page-content" ref={pageRef}>
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="page-title">
            <span className="page-title-gold">Labor</span> Planning
          </div>
          <div className="page-subtitle">CSW 3PL · 5 Wisconsin Facilities</div>
        </div>
        <div className="day-selector">
          <button
            className={`day-btn${isToday ? ' today' : ''}`}
            onClick={() => setPlanDate(todayISO())}
          >
            Today
          </button>
          <button
            className={`day-btn${isTomorrow ? ' today' : ''}`}
            onClick={() => setPlanDate(tomorrowISO())}
          >
            Tomorrow
          </button>
          <button
            className="day-btn day-btn--next"
            onClick={() => stepDay(1)}
            title="Advance one day"
          >
            Next Day →
          </button>
          <input
            type="date"
            className="day-input"
            value={planDate}
            onChange={e => setPlanDate(e.target.value)}
          />
          {activeTab !== 'all' && (
            <button className="snapshot-btn" onClick={handleSnapshot}>
              {snapLabel}
            </button>
          )}
        </div>
      </div>

      {/* Facility Tabs */}
      <div className="facility-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`fac-tab${activeTab === tab.id ? ' active' : ''}`}
            style={activeTab === tab.id ? { color: tab.color, borderColor: tab.color } : {}}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.id !== 'all' && (
              <span className="dot" style={{ background: tab.color }} />
            )}
            {tab.code}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'all' ? (
        <AllFacilities
          networkData={networkData}
          facilityEstDrops={facilityEstDrops}
          facilityLaborCounts={facilityLaborCounts}
          facilityDeltas={facilityDeltas}
          planDate={planDate}
          onFacilityClick={setActiveTab}
        />
      ) : activeFac ? (
        <FacilityPanel
          key={activeFac.id}
          facility={activeFac}
          planDate={planDate}
          networkKpi={networkData?.[activeFac.id]}
          onDeltaComputed={handleDeltaComputed}
        />
      ) : null}
    </div>
  )
}
