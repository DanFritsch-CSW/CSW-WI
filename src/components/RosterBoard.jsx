import { useState, useEffect, useCallback, useRef } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import EmployeeTile from './EmployeeTile.jsx'
import AddTempModal from './AddTempModal.jsx'
import { LANES, ACTIVE_LANES, LANES_CAL2, ACTIVE_LANES_CAL2 } from '../lib/constants.js'
import { fetchTodayAssignments, upsertAssignment, replaceEmployees, seedRosterAssignments, deleteAssignment, resetAssignmentsForDate } from '../lib/supabase.js'
import { fetchB2eRoster } from '../lib/omni.js'

const LANE_SETTING_KEYS = {
  shift1: { start: 'shift1_start', hours: 'shift1_hours' },
  mid:    { start: 'mid_start',    hours: 'mid_hours'    },
  shift2: { start: 'shift2_start', hours: 'shift2_hours' },
  shift3: { start: 'shift3_start', hours: 'shift3_hours' },
  side12_shift1: { start: 'shift1_start', hours: 'shift1_hours' },
  side12_mid:    { start: 'mid_start',    hours: 'mid_hours'    },
  side12_shift2: { start: 'shift2_start', hours: 'shift2_hours' },
  side12_shift3: { start: 'shift3_start', hours: 'shift3_hours' },
  side35_shift1: { start: 'shift1_start', hours: 'shift1_hours' },
  side35_mid:    { start: 'mid_start',    hours: 'mid_hours'    },
  side35_shift2: { start: 'shift2_start', hours: 'shift2_hours' },
  side35_shift3: { start: 'shift3_start', hours: 'shift3_hours' },
}
const LANE_DEFAULTS = {
  shift1_start: 5,  shift1_hours: 8,
  mid_start:    9,  mid_hours:    8,
  shift2_start: 13, shift2_hours: 8,
  shift3_start: 22, shift3_hours: 8,
}

const SORT_MODES = [
  { key: 'default', label: 'Sort' },
  { key: 'first',   label: 'A–Z First' },
  { key: 'last',    label: 'A–Z Last' },
]

function getLaneSettings(laneId, settings) {
  const keys = LANE_SETTING_KEYS[laneId]
  if (!keys) return null
  return {
    defaultStart: settings?.[keys.start] ?? LANE_DEFAULTS[keys.start],
    defaultHours: settings?.[keys.hours]  ?? LANE_DEFAULTS[keys.hours],
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function sortEmployees(employees, sortOrder) {
  if (sortOrder === 'default') return employees
  return [...employees].sort((a, b) => {
    const nameA = a.name || ''
    const nameB = b.name || ''
    if (sortOrder === 'first') {
      const fa = nameA.split(' ')[0] || ''
      const fb = nameB.split(' ')[0] || ''
      return fa.localeCompare(fb)
    }
    if (sortOrder === 'last') {
      const partsA = nameA.trim().split(' ')
      const partsB = nameB.trim().split(' ')
      const la = partsA[partsA.length - 1] || ''
      const lb = partsB[partsB.length - 1] || ''
      return la.localeCompare(lb)
    }
    return 0
  })
}

function parseStartHour(shiftStart) {
  if (shiftStart === null || shiftStart === undefined || shiftStart === '') return null
  const val = Number(shiftStart)
  if (!isNaN(val)) {
    const h = Math.floor(val)
    const m = Math.round((val - h) * 60)
    return m >= 30 ? (h + 1) % 24 : h
  }
  const match = String(shiftStart).match(/^(\d{1,2}):(\d{2})/)
  if (match) {
    const h = parseInt(match[1], 10)
    const m = parseInt(match[2], 10)
    return m >= 30 ? (h + 1) % 24 : h
  }
  return null
}

function formatHour(h) {
  if (h === 0)  return '12:00 AM'
  if (h < 12)  return `${h}:00 AM`
  if (h === 12) return '12:00 PM'
  return `${h - 12}:00 PM`
}

function groupByStartHour(employees, assignmentMap) {
  const groups = {}
  for (const emp of employees) {
    const asg  = assignmentMap?.[emp.id]
    const hour = parseStartHour(asg?.shift_start)
    const key  = hour !== null ? hour : 'unknown'
    if (!groups[key]) groups[key] = []
    groups[key].push(emp)
  }
  const keys = Object.keys(groups)
  if (keys.length <= 1) return null
  const sorted = keys
    .filter(k => k !== 'unknown')
    .map(Number)
    .sort((a, b) => a - b)
    .map(h => ({ hour: h, label: formatHour(h), employees: groups[h] }))
  if (groups['unknown']) {
    sorted.push({ hour: null, label: 'No start time', employees: groups['unknown'] })
  }
  return sorted
}

function laneSideClass(laneId) {
  if (laneId.startsWith('side12_')) return 'lane-side12'
  if (laneId.startsWith('side35_')) return 'lane-side35'
  return ''
}

function DroppableLane({ lane, employees, assignmentMap, settings, onDeleteTemp, onShiftChange, sortOrder }) {
  const { setNodeRef, isOver } = useDroppable({ id: lane.id })
  const sorted       = sortEmployees(employees, sortOrder)
  const ids          = sorted.map(e => e.id)
  const groups       = groupByStartHour(sorted, assignmentMap)
  const laneSettings = getLaneSettings(lane.id, settings)
  const sideClass    = laneSideClass(lane.id)

  return (
    <div
      ref={setNodeRef}
      className={`lane${sideClass ? ` ${sideClass}` : ''}${isOver ? ' over' : ''}`}
      style={{ touchAction: 'none' }}
    >
      <div className="lane-header">
        <span className="lane-title">{lane.label}</span>
        <span className="lane-count">{employees.length}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="lane-body">
          {groups ? (
            groups.map(group => (
              <div key={group.hour ?? 'unknown'} className="lane-group">
                <div className="lane-group-header">
                  <span className="lane-group-label">{group.label}</span>
                  <span className="lane-group-count">{group.employees.length}</span>
                </div>
                {group.employees.map(emp => (
                  <EmployeeTile
                    key={emp.id}
                    employee={emp}
                    assignment={assignmentMap?.[emp.id]}
                    laneSettings={laneSettings}
                    onShiftChange={(start, hours) => onShiftChange(emp.id, start, hours)}
                    onDelete={emp.is_temp ? () => onDeleteTemp(emp) : undefined}
                  />
                ))}
              </div>
            ))
          ) : (
            sorted.map(emp => (
              <EmployeeTile
                key={emp.id}
                employee={emp}
                assignment={assignmentMap?.[emp.id]}
                laneSettings={laneSettings}
                onShiftChange={(start, hours) => onShiftChange(emp.id, start, hours)}
                onDelete={emp.is_temp ? () => onDeleteTemp(emp) : undefined}
              />
            ))
          )}
        </div>
      </SortableContext>
    </div>
  )
}

const STUB_EMPLOYEES = [
  { id: 'e1', name: 'Alex Rivera',    role: 'Lead',       default_lane: 'shift1' },
  { id: 'e2', name: 'Sam Torres',     role: 'Associate',  default_lane: 'shift1' },
  { id: 'e3', name: 'Jordan Kim',     role: 'Associate',  default_lane: 'shift1' },
  { id: 'e4', name: 'Morgan Hayes',   role: 'Receiver',   default_lane: 'shift1' },
  { id: 'e5', name: 'Casey Nguyen',   role: 'Associate',  default_lane: 'shift2' },
  { id: 'e6', name: 'Riley Chen',     role: 'Lead',       default_lane: 'shift2' },
  { id: 'e7', name: 'Blake Martin',   role: 'Associate',  default_lane: 'shift2' },
  { id: 'e8', name: 'Drew Johnson',   role: 'Associate',  default_lane: 'pto'    },
  { id: 'e9', name: 'Quinn Adams',    role: 'Associate',  default_lane: 'callin' },
]

const STANDARD_ACTIVE_LANES = new Set(['shift1', 'mid', 'shift2', 'shift3'])
const CAL_ACTIVE_LANES = new Set([
  'side12_shift1','side12_mid','side12_shift2','side12_shift3',
  'side35_shift1','side35_mid','side35_shift2','side35_shift3',
])

export default function RosterBoard({ facility, planDate, settings, onLaborCount, onRosterChange }) {
  // 'cal' is the Caledonia split-view (formerly cal2)
  const isCal         = facility === 'cal'
  const activeLaneSet  = isCal ? LANES_CAL2     : LANES
  const activeLaneIds  = isCal ? ACTIVE_LANES_CAL2 : ACTIVE_LANES
  const activeLaneSet_ = isCal ? CAL_ACTIVE_LANES : STANDARD_ACTIVE_LANES

  const [laneMap, setLaneMap]             = useState({})
  const [assignmentMap, setAssignmentMap] = useState({})
  const [employees, setEmployees]         = useState([])
  const [isLoading, setIsLoading]         = useState(true)
  const [activeId, setActiveId]           = useState(null)
  const [syncState, setSyncState]         = useState(null)
  const [resetState, setResetState]       = useState(null)
  const [showAddTemp, setShowAddTemp]     = useState(false)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [sortOrder, setSortOrder]         = useState('default')
  const loadRef = useRef(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  async function load(facId, date) {
    setIsLoading(true)
    let assignments = await fetchTodayAssignments(facId, date)

    if (assignments.length === 0) {
      const b2eEmployees = await fetchB2eRoster(facId, date)
      if (b2eEmployees.length > 0) {
        const empRows = b2eEmployees.map(({ shift_hours, ...e }) => e)
        await replaceEmployees(facId, empRows)
        await seedRosterAssignments(b2eEmployees, date)
        assignments = await fetchTodayAssignments(facId, date)
      }
    }

    let emps = assignments
      .filter(a => !a.is_temp)
      .map(a => ({
        id:           a.employee_id,
        name:         a.employee_name,
        role:         a.role || null,
        facility:     facId,
        is_temp:      false,
        default_lane: a.lane,
      }))

    const tempEmps = assignments
      .filter(a => a.is_temp)
      .map(a => ({
        id:           a.employee_id,
        name:         a.employee_name,
        role:         a.role || 'Temp',
        facility:     facId,
        is_temp:      true,
        default_lane: a.lane,
      }))

    if (emps.length === 0 && tempEmps.length === 0) {
      emps = STUB_EMPLOYEES.map(e => ({ ...e, facility: facId }))
    }

    const allEmps = [...emps, ...tempEmps]
    setEmployees(allEmps)

    const map = {}
    assignments.forEach(a => { map[a.employee_id] = a.lane })
    setLaneMap(map)

    const asgMap = {}
    assignments.forEach(a => { asgMap[a.employee_id] = a })
    setAssignmentMap(asgMap)

    setIsLoading(false)
  }

  useEffect(() => {
    const date = planDate || todayISO()
    loadRef.current = () => load(facility, date)
    load(facility, date)
  }, [facility, planDate])

  const trackedUpsert = useCallback(async (assignment) => {
    setPendingWrites(n => n + 1)
    try {
      await upsertAssignment(assignment)
    } finally {
      setPendingWrites(n => n - 1)
    }
  }, [])

  const handleB2eSync = useCallback(async () => {
    setSyncState('loading')
    try {
      const date         = planDate || todayISO()
      const b2eEmployees = await fetchB2eRoster(facility, date)
      if (!b2eEmployees.length) { setSyncState('No B2E data found'); return }
      const empRows = b2eEmployees.map(({ shift_hours, ...e }) => e)
      const err = await replaceEmployees(facility, empRows)
      if (err) { setSyncState(err); return }
      const seedErr = await seedRosterAssignments(b2eEmployees, date)
      if (seedErr) { setSyncState(seedErr); return }
      await load(facility, date)
      setSyncState('ok')
      setTimeout(() => setSyncState(null), 3000)
    } catch (e) {
      setSyncState(e.message)
    }
  }, [facility, planDate])

  const handleReset = useCallback(async () => {
    if (!window.confirm('Reset all manual changes for this day and reload from B2E? Temp employees will be preserved.')) return
    setResetState('loading')
    try {
      const date = planDate || todayISO()
      const err = await resetAssignmentsForDate(facility, date)
      if (err) { setResetState(`Delete failed: ${err}`); return }
      const b2eEmployees = await fetchB2eRoster(facility, date)
      if (!b2eEmployees.length) { setResetState('No B2E data found'); return }
      const empRows = b2eEmployees.map(({ shift_hours, ...e }) => e)
      const replErr = await replaceEmployees(facility, empRows)
      if (replErr) { setResetState(`Employee sync failed: ${replErr}`); return }
      const seedErr = await seedRosterAssignments(b2eEmployees, date)
      if (seedErr) { setResetState(`Seed failed: ${seedErr}`); return }
      await load(facility, date)
      setResetState('ok')
      setTimeout(() => setResetState(null), 3000)
    } catch (e) {
      setResetState(e.message)
    }
  }, [facility, planDate])

  const handleAddTemp = useCallback((tempEmp) => {
    setEmployees(prev => [...prev, tempEmp])
    setLaneMap(prev => ({ ...prev, [tempEmp.id]: tempEmp.default_lane || 'shift1' }))
    setShowAddTemp(false)
  }, [])

  const handleDeleteTemp = useCallback(async (emp) => {
    const date = planDate || todayISO()
    await deleteAssignment(facility, emp.id, date)
    setEmployees(prev => prev.filter(e => e.id !== emp.id))
    setLaneMap(prev => { const n = { ...prev }; delete n[emp.id]; return n })
    setAssignmentMap(prev => { const n = { ...prev }; delete n[emp.id]; return n })
  }, [facility, planDate])

  const handleShiftChange = useCallback(async (empId, shiftStart, shiftHours) => {
    const emp  = employees.find(e => e.id === empId)
    if (!emp) return
    const date     = planDate || todayISO()
    const existing = assignmentMap[empId] ?? {}
    const updated  = {
      facility,
      employee_id:   empId,
      employee_name: emp.name,
      role:          emp.role,
      lane:          laneMap[empId] || emp.default_lane || 'shift1',
      plan_date:     date,
      is_temp:       emp.is_temp ?? false,
      ...existing,
      shift_start:   shiftStart,
      shift_hours:   shiftHours,
    }
    await trackedUpsert(updated)
    setAssignmentMap(prev => ({ ...prev, [empId]: updated }))
  }, [employees, assignmentMap, laneMap, facility, planDate, trackedUpsert])

  useEffect(() => {
    const activeEmps = employees.filter(e => activeLaneSet_.has(laneMap[e.id] || e.default_lane))
    onLaborCount?.(activeEmps.length)
  }, [laneMap, assignmentMap, employees, onLaborCount, activeLaneSet_])

  useEffect(() => {
    onRosterChange?.({ employees, laneMap, assignmentMap })
  }, [employees, laneMap, assignmentMap, onRosterChange])

  const handleDragStart = useCallback(({ active }) => setActiveId(active.id), [])

  const handleDragEnd = useCallback(({ active, over }) => {
    setActiveId(null)
    if (!over) return
    const employeeId = active.id
    const overId     = over.id
    const isLane = activeLaneSet.some(l => l.id === overId)
    if (isLane) {
      if (laneMap[employeeId] !== overId) moveTo(employeeId, overId)
      return
    }
    const destLane = laneMap[overId] || employees.find(e => e.id === overId)?.default_lane
    if (destLane && destLane !== laneMap[employeeId]) {
      moveTo(employeeId, destLane)
    }
  }, [laneMap, activeLaneSet, employees])

  function moveTo(employeeId, laneId) {
    setLaneMap(prev => ({ ...prev, [employeeId]: laneId }))
    setAssignmentMap(prev => {
      const existing = prev[employeeId] ?? {}
      return { ...prev, [employeeId]: { ...existing, lane: laneId } }
    })
    const emp      = employees.find(e => e.id === employeeId)
    if (!emp) return
    const date     = planDate || todayISO()
    const existing = assignmentMap[employeeId] ?? {}
    trackedUpsert({
      facility,
      employee_id:   employeeId,
      employee_name: emp.name,
      role:          emp.role,
      lane:          laneId,
      plan_date:     date,
      is_temp:       emp.is_temp ?? false,
      shift_start:   existing.shift_start ?? null,
      shift_hours:   existing.shift_hours ?? null,
    })
  }

  const activeEmployee = activeId ? employees.find(e => e.id === activeId) : null
  const laneEmployees  = (laneId) => employees.filter(e => (laneMap[e.id] || e.default_lane) === laneId)

  const activeCount = activeLaneSet
    .filter(l => activeLaneIds.includes(l.id))
    .reduce((n, l) => n + laneEmployees(l.id).length, 0)
  const ptoCount    = laneEmployees('pto').length
  const callinCount = laneEmployees('callin').length

  const side12Count = isCal
    ? ['side12_shift1','side12_mid','side12_shift2','side12_shift3'].reduce((n, l) => n + laneEmployees(l).length, 0)
    : null
  const side35Count = isCal
    ? ['side35_shift1','side35_mid','side35_shift2','side35_shift3'].reduce((n, l) => n + laneEmployees(l).length, 0)
    : null

  const currentSort = SORT_MODES.find(m => m.key === sortOrder)
  const nextSort    = () => {
    const idx = SORT_MODES.findIndex(m => m.key === sortOrder)
    setSortOrder(SORT_MODES[(idx + 1) % SORT_MODES.length].key)
  }

  const gridCols   = isCal ? 'repeat(10, minmax(0, 1fr))' : 'repeat(6, minmax(0, 1fr))'
  const gridStyle  = { gridTemplateColumns: gridCols }

  if (isLoading) {
    return (
      <div className="roster-section">
        <div className="roster-loading">Loading roster…</div>
      </div>
    )
  }

  return (
    <div className="roster-section">
      <div className="roster-header">
        <span className="section-label">
          {isCal
            ? <>Shift Roster &nbsp;<span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>1-2 side: <strong style={{ color: 'var(--brand)' }}>{side12Count}</strong> &nbsp;·&nbsp; 3.5 side: <strong style={{ color: 'var(--brand)' }}>{side35Count}</strong></span></>
            : 'Shift Roster'
          }
        </span>
        <div className="roster-stats">
          <span className="roster-stat"><strong>{activeCount}</strong> active</span>
          <span className="roster-stat"><strong>{ptoCount}</strong> PTO</span>
          <span className="roster-stat"><strong>{callinCount}</strong> call-in</span>
          {pendingWrites > 0 && <span className="roster-saving">Saving…</span>}
          <button className={`b2e-sync-btn${sortOrder !== 'default' ? ' roster-sort-active' : ''}`} onClick={nextSort} title="Cycle sort">{currentSort.label}</button>
          <button className="b2e-sync-btn" onClick={() => setShowAddTemp(true)}>+ Add Temp</button>
          <button className="b2e-sync-btn" onClick={handleB2eSync} disabled={syncState === 'loading'}>
            {syncState === 'loading' ? 'Syncing…' : syncState === 'ok' ? 'Synced ✓' : 'Sync from B2E'}
          </button>
          {syncState && syncState !== 'loading' && syncState !== 'ok' && <span className="b2e-sync-err">{syncState}</span>}
          <button
            className="b2e-sync-btn b2e-reset-btn"
            onClick={handleReset}
            disabled={resetState === 'loading'}
            title="Discard all manual lane/shift changes for today and reload fresh from B2E. Temp employees are preserved."
          >
            {resetState === 'loading' ? 'Resetting…' : resetState === 'ok' ? 'Reset ✓' : 'Reset to B2E'}
          </button>
          {resetState && resetState !== 'loading' && resetState !== 'ok' && <span className="b2e-sync-err">{resetState}</span>}
        </div>
      </div>

      {isCal && (
        <div className="roster-lanes" style={{ ...gridStyle, marginBottom: 6 }}>
          <div className="cal2-side-label cal2-side-12" style={{ gridColumn: '1 / 5' }}>1-2 Side</div>
          <div className="cal2-side-label cal2-side-35" style={{ gridColumn: '5 / 9' }}>3.5 Side</div>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="roster-lanes" style={gridStyle}>
          {activeLaneSet.map(lane => (
            <DroppableLane
              key={lane.id}
              lane={lane}
              employees={laneEmployees(lane.id)}
              assignmentMap={assignmentMap}
              settings={settings}
              sortOrder={sortOrder}
              onDeleteTemp={handleDeleteTemp}
              onShiftChange={handleShiftChange}
            />
          ))}
        </div>
        <DragOverlay>
          {activeEmployee ? <EmployeeTile employee={activeEmployee} /> : null}
        </DragOverlay>
      </DndContext>

      {showAddTemp && (
        <AddTempModal
          facility={facility}
          planDate={planDate || todayISO()}
          onAdd={handleAddTemp}
          onClose={() => setShowAddTemp(false)}
        />
      )}
    </div>
  )
}
