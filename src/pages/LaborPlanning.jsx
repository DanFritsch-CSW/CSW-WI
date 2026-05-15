import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FACILITY_LIST, DIAGNOSTIC_TABS } from '../lib/constants.js'
import { fetchNetworkKpis } from '../lib/omni.js'
import { fetchAllFacilitiesEstDrops, fetchAllFacilitiesLaborCounts, fetchAllFacilitiesSettings } from '../lib/supabase.js'
import AllFacilities from './AllFacilities.jsx'
import FacilityPanel from './FacilityPanel.jsx'
import KenV2Panel from './KenV2Panel.jsx'

function todayISO() { return new Date().toISOString().slice(0, 10) }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10) }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

const ALL_TAB = { id: 'all', code: 'ALL', name: 'All Facilities', color: '#8a9899' }
const TABS = [ALL_TAB, ...FACILITY_LIST, ...DIAGNOSTIC_TABS]

// Map of diagnostic tab id → component renderer. Add new diagnostic mirrors here.
const DIAGNOSTIC_RENDERERS = {
  ken_v2: KenV2Panel,
}

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
  // Track which tabs (regular + diagnostic) have been visited so we only mount them on first visit
  const [mountedTabs, setMountedTabs]                 = useState(() => new Set())

  const pageRef = useRef(null)

  // Mount any non-all tab the first time it's visited
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

  const isToday    = planDate === todayISO()
  const isTomorrow = planDate === tomorrowISO()

  return (
    <div className="page-content" ref={pageRef}>
      <div className="page-header">
        <div>
          <div className="page-title"><span className="page-title-gold">Labor</span> Planning</div>
          <div className="page-subtitle">CSW 3PL · 5 Wisconsin Facilities</div>
        </div>
        <div className="day-selector">
          <button className={`day-btn${isToday ? ' today' : ''}`} onClick={() => setPlanDate(todayISO())}>Today</button>
          <button className={`day-btn${isTomorrow ? ' today' : ''}`} onClick={() => setPlanDate(tomorrowISO())}>Tomorrow</button>
          <button className="day-btn day-btn--next" onClick={() => stepDay(1)} title="Advance one day">Next Day &rarr;</button>
          <input type="date" className="day-input" value={planDate} onChange={e => setPlanDate(e.target.value)} />
          {activeTab !== 'all' && (
            <button className="snapshot-btn" onClick={handleSnapshot}>{snapLabel}</button>
          )}
        </div>
      </div>

      <div className="facility-tabs">
        {TABS.map(tab => {
          const isDiag = DIAGNOSTIC_TABS.some(t => t.id === tab.id)
          return (
            <button key={tab.id}
              className={`fac-tab${activeTab === tab.id ? ' active' : ''}${isDiag ? ' fac-tab--diagnostic' : ''}`}
              style={activeTab === tab.id ? { color: tab.color, borderColor: tab.color } : {}}
              onClick={() => setActiveTab(tab.id)}
              title={isDiag ? tab.name : undefined}
            >
              {tab.id !== 'all' && <span className="dot" style={{ background: tab.color }} />}
              {tab.code}
            </button>
          )
        })}
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

      {/* Regular facility panels — mounted once on first visit, hidden via CSS otherwise.
          Preserves component state (WR pickline snapshot etc.) across tab switches. */}
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

      {/* Diagnostic mirror tabs (KEN v2, future mirrors) — same mount-once pattern */}
      {DIAGNOSTIC_TABS.map(tab => {
        const isActive = activeTab === tab.id
        if (!mountedTabs.has(tab.id)) return null
        const Renderer = DIAGNOSTIC_RENDERERS[tab.id]
        if (!Renderer) return null
        return (
          <div key={tab.id} style={{ display: isActive ? undefined : 'none' }}>
            <Renderer
              planDate={planDate}
              facility={tab}
              networkKpi={networkData?.[tab.mirrors]}
              onDeltaComputed={handleDeltaComputed}
              onKpiComputed={handleKpiComputed}
            />
          </div>
        )
      })}
    </div>
  )
}
