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
import { LANES, ACTIVE_LANES } from '../lib/constants.js'
import { fetchTodayAssignments, upsertAssignment, fetchEmployees, replaceEmployees, seedRosterAssignments, deleteAssignment, resetAssignmentsForDate } from '../lib/supabase.js'
import { fetchB2eRoster } from '../lib/omni.js'

const LANE_SETTING_KEYS = {
  shift1: { start: 'shift1_start', hours: 'shift1_hours' },
  mid:    { start: 'mid_start',    hours: 'mid_hours'    },
  shift2: { start: 'shift2_start', hours: 'shift2_hours' },
  shift3: { start: 'shift3_start', hours: 'shift3_hours' },
}
const LANE_DEFAULTS = {
  shift1_start: 5,  shift1_hours: 8,
  mid_start:    9,  mid_hours:    8,
  shift2_start: 13, shift2_hours: 8,
  shift3_start: 22, shift3_hours: 8,
}

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

function DroppableLane({ lane, employees, assignmentMap, settings, onDeleteTemp, onShiftChange }) {
  const { setNodeRef, isOver } = useDroppable({ id: lane.id })
  const ids = employees.map(e => e.id)

  return (
    <div ref={setNodeRef} className={`lane${isOver ? ' over' : ''}`}>
      <div className="lane-header">
        <span className="lane-title">{lane.label}</span>
        <span className="lane-count">{employees.length}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="lane-body">
          {employees.map(emp => (
            <EmployeeTile
              key={emp.id}
              employee={emp}
              assignment={assignmentMap?.[emp.id]}
              laneSettings={getLaneSettings(lane.id, settings)}
              onShiftChange={(start, hours) => onShiftChange(emp.id, start, hours)}
              onDelete={emp.is_temp ? () => onDeleteTemp(emp) : undefined}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  )
}

// Stub employees used when Supabase is not configured
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

export default function RosterBoard({ facility, planDate, settings, onLaborCount, onRosterChange }) {
  const [laneMap, setLaneMap]           = useState({})
  const [assignmentMap, setAssignmentMap] = useState({})
  const [employees, setEmployees]       = useState([])
  const [activeId, setActiveId]         = useState(null)
  const [syncState, setSyncState]       = useState(null)
  const [resetState, setResetState]     = useState(null)
  const [showAddTemp, setShowAddTemp]   = useState(false)
  const loadRef = useRef(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useEffect(() => {
    async function load() {
      let emps = await fetchEmployees(facility)
      if (!emps.length) emps = STUB_EMPLOYEES.map(e => ({ ...e, facility }))

      const date = planDate || todayISO()
      const assignments = await fetchTodayAssignments(facility, date)

      // Synthesize temp employee objects from roster_assignments rows
      const tempEmps = assignments
        .filter(a => a.is_temp)
        .map(a => ({
          id:           a.employee_id,
          name:         a.employee_name,
          role:         a.role || 'Temp',
          facility,
          is_temp:      true,
          default_lane: a.lane,
        }))

      const allEmps = [...emps, ...tempEmps]
      setEmployees(allEmps)

      const map = {}
      emps.forEach(e => { map[e.id] = e.default_lane || 'shift1' })
      assignments.forEach(a => { map[a.employee_id] = a.lane })
      setLaneMap(map)

      const asgMap = {}
      assignments.forEach(a => { asgMap[a.employee_id] = a })
      setAssignmentMap(asgMap)
    }
    loadRef.current = load
    load()
  }, [facility, planDate])

  const handleB2eSync = useCallback(async () => {
    setSyncState('loading')
    try {
      const date         = planDate || todayISO()
      const b2eEmployees = await fetchB2eRoster(facility, date)
      if (!b2eEmployees.length) { setSyncState('No B2E data found'); return }
      // Strip shift_hours — employees table doesn't have that column
      const empRows = b2eEmployees.map(({ shift_hours, ...e }) => e)
      const err = await replaceEmployees(facility, empRows)
      if (err) { setSyncState(err); return }
      // Seed assignments with B2E shift times; ignoreDuplicates preserves manual edits
      const seedErr = await seedRosterAssignments(b2eEmployees, date)
      if (seedErr) { setSyncState(seedErr); return }
      await loadRef.current?.()
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
      if (err) { setResetState(err); return }
      const b2eEmployees = await fetchB2eRoster(facility, date)
      if (!b2eEmployees.length) { setResetState('No B2E data found'); return }
      const empRows = b2eEmployees.map(({ shift_hours, ...e }) => e)
      const replErr = await replaceEmployees(facility, empRows)
      if (replErr) { setResetState(replErr); return }
      const seedErr = await seedRosterAssignments(b2eEmployees, date)
      if (seedErr) { setResetState(seedErr); return }
      await loadRef.current?.()
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
    const date = planDate || todayISO()
    const existing = assignmentMap[empId] ?? {}
    const updated = {
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
    await upsertAssignment(updated)
    setAssignmentMap(prev => ({ ...prev, [empId]: updated }))
  }, [employees, assignmentMap, laneMap, facility, planDate])

  useEffect(() => {
    const active = Object.values(laneMap).filter(l => ACTIVE_LANES.includes(l)).length
    onLaborCount?.(active)
  }, [laneMap, onLaborCount])

  useEffect(() => {
    onRosterChange?.({ employees, laneMap, assignmentMap })
  }, [employees, laneMap, assignmentMap, onRosterChange])

  const handleDragStart = useCallback(({ active }) => setActiveId(active.id), [])

  const handleDragEnd = useCallback(({ active, over }) => {
    setActiveId(null)
    if (!over) return
    const employeeId = active.id
    const targetLane = over.id

    const validLane = LANES.find(l => l.id === targetLane)
    if (!validLane) {
      const destLane = laneMap[targetLane]
      if (!destLane || destLane === laneMap[employeeId]) return
      moveTo(employeeId, destLane)
    } else {
      if (laneMap[employeeId] === targetLane) return
      moveTo(employeeId, targetLane)
    }
  }, [laneMap])

  function moveTo(employeeId, laneId) {
    setLaneMap(prev => ({ ...prev, [employeeId]: laneId }))
    const emp = employees.find(e => e.id === employeeId)
    if (!emp) return
    const date    = planDate || todayISO()
    const existing = assignmentMap[employeeId] ?? {}
    upsertAssignment({
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

  const laneEmployees = (laneId) =>
    employees.filter(e => (laneMap[e.id] || e.default_lane) === laneId)

  const activeCount = LANES.filter(l => ACTIVE_LANES.includes(l.id))
    .reduce((n, l) => n + laneEmployees(l.id).length, 0)
  const ptoCount    = laneEmployees('pto').length
  const callinCount = laneEmployees('callin').length

  return (
    <div className="roster-section">
      <div className="roster-header">
        <span className="section-label">Shift Roster</span>
        <div className="roster-stats">
          <span className="roster-stat"><strong>{activeCount}</strong> active</span>
          <span className="roster-stat"><strong>{ptoCount}</strong> PTO</span>
          <span className="roster-stat"><strong>{callinCount}</strong> call-in</span>
          <button
            className="b2e-sync-btn"
            onClick={() => setShowAddTemp(true)}
            title="Add a temporary employee for this day"
          >
            + Add Temp
          </button>
          <button
            className="b2e-sync-btn"
            onClick={handleB2eSync}
            disabled={syncState === 'loading'}
            title="Pull latest employee roster from B2E via Omni"
          >
            {syncState === 'loading' ? 'Syncing…' : syncState === 'ok' ? 'Synced ✓' : 'Sync from B2E'}
          </button>
          {syncState && syncState !== 'loading' && syncState !== 'ok' && (
            <span className="b2e-sync-err">{syncState}</span>
          )}
          <button
            className="b2e-sync-btn b2e-reset-btn"
            onClick={handleReset}
            disabled={resetState === 'loading'}
            title="Clear all manual changes for this day and reload from B2E (keeps temp employees)"
          >
            {resetState === 'loading' ? 'Resetting…' : resetState === 'ok' ? 'Reset ✓' : 'Reset to B2E'}
          </button>
          {resetState && resetState !== 'loading' && resetState !== 'ok' && (
            <span className="b2e-sync-err">{resetState}</span>
          )}
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="roster-lanes">
          {LANES.map(lane => (
            <DroppableLane
              key={lane.id}
              lane={lane}
              employees={laneEmployees(lane.id)}
              assignmentMap={assignmentMap}
              settings={settings}
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
