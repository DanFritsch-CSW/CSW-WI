import { useEffect, useRef, useCallback, useReducer } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchNetworkKpis } from '../lib/omni.js'
import { fetchAllFacilitiesEstDrops, fetchAllFacilitiesLaborCounts } from '../lib/supabase.js'
import AllFacilities from './AllFacilities.jsx'
import FacilityPanel from './FacilityPanel.jsx'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

const ALL_TAB = { id: 'all', code: 'ALL', name: 'All Facilities', color: '#8a9899' }
const TABS = [ALL_TAB, ...FACILITY_LIST]

export default function LaborPlanning() {
  const [searchParams, setSearchParams] = useSearchParams()

  // Read state from URL; fall back to sensible defaults
  const activeTab = searchParams.get('fac') || 'all'
  const planDate  = searchParams.get('date') || todayISO()

  function setActiveTab(tab) {
    setSearchParams(prev => { prev.set('fac', tab); return prev }, { replace: true })
  }

  function setPlanDate(date) {
    setSearchParams(prev => { prev.set('date', date); return prev }, { replace: true })
  }

  // Refs for async data — avoids stale state on navigation return
  const networkDataRef      = useRef(null)
  const facilityEstDropsRef = useRef({})
  const facilityLaborRef    = useRef({})
  const [, forceUpdate]     = useReducer(x => x + 1, 0)

  const snapLabelRef = useRef('Snapshot')
  const pageRef      = useRef(null)

  const handleSnapshot = useCallback(async () => {
    if (!pageRef.current) return
    snapLabelRef.current = 'Capturing…'
    forceUpdate()
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
        snapLabelRef.current = 'Copied!'
      } catch {
        snapLabelRef.current = 'Saved!'
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `csw-${activeTab}-${planDate}.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      snapLabelRef.current = 'Snapshot'
    }
    forceUpdate()
    setTimeout(() => { snapLabelRef.current = 'Snapshot'; forceUpdate() }, 2500)
  }, [activeTab, planDate])

  useEffect(() => {
    fetchNetworkKpis(planDate).then(d => { networkDataRef.current = d; forceUpdate() })
    fetchAllFacilitiesEstDrops(planDate).then(d => { facilityEstDropsRef.current = d; forceUpdate() })
    fetchAllFacilitiesLaborCounts(planDate).then(d => { facilityLaborRef.current = d; forceUpdate() })
  }, [planDate])

  const activeFac = FACILITY_LIST.find(f => f.id === activeTab) || null

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
            className={`day-btn${planDate === todayISO() ? ' today' : ''}`}
            onClick={() => setPlanDate(todayISO())}
          >
            Today
          </button>
          <input
            type="date"
            className="day-input"
            value={planDate}
            onChange={e => setPlanDate(e.target.value)}
          />
          {activeTab !== 'all' && (
            <button className="snapshot-btn" onClick={handleSnapshot}>
              {snapLabelRef.current}
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
          networkData={networkDataRef.current}
          facilityEstDrops={facilityEstDropsRef.current}
          facilityLaborCounts={facilityLaborRef.current}
          planDate={planDate}
        />
      ) : activeFac ? (
        <FacilityPanel
          key={activeFac.id}
          facility={activeFac}
          planDate={planDate}
          networkKpi={networkDataRef.current?.[activeFac.id]}
        />
      ) : null}
    </div>
  )
}
