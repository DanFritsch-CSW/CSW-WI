// src/components/RosterBoardMemory.jsx
//
// In-memory variant of RosterBoard. Fetches roster from Omni B2E on mount and
// then keeps all state local — drag-drop, shift edits, lane changes never hit
// Supabase. This lets us experiment with "what-if" labor scenarios in the
// KEN v2 mirror tab without affecting production data.
//
// Reuses EmployeeTile and the standard LANES/ACTIVE_LANES structure from
// constants. Supports refresh-from-B2E to wipe local state and re-pull.
//
// Props:
//   facility       — 'ken' (or any other ID — works generically)
//   planDate       — ISO date string
//   onRosterChange — callback({ employees, laneMap, assignmentMap })

import { useState, useEffect, useCallback } from 'react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragOverlay, useDroppable,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import EmployeeTile from './EmployeeTile.jsx'
import { LANES, ACTIVE_LANES } from '../lib/constants.js'
import { fetchB2eRoster, fetchB2eTimeOff } from '../lib/omni.js'

const STANDARD_ACTIVE_LANES = new Set(['shift1', 'mid', 'shift2', 'shift3'])
const TIME_OFF_LABEL_DEFAULT = 'PTO'

function todayISO() { return new Date().toISOString().slice(0, 10) }

function applyTimeOffOverrides(employees, timeOffMap) {
  if (!timeOffMap.size) return employees
  return employees.map(emp => {
    const label = timeOffMap.get(String(emp.id))
    if (!label) return emp
    return { ...emp, default_lane: 'pto', role: label || TIME_OFF_LABEL_DEFAULT }
  })
}

function sortEmployees(employees) {
  return [...employees].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
}

function DroppableLane({ lane, employees, assignmentMap, onShiftChange }) {
  const { setNodeRef, isOver } = useDroppable({ id: lane.id })
  const sorted = sortEmployees(employees)
  const ids = sorted.map(e => e.id)
  return (
    <div ref={setNodeRef} className={`lane${isOver ? ' over' : ''}`} style={{ touchAction: 'none' }}>
      <div className="lane-header">
        <span className="lane-title">{lane.label}</span>
        <span className="lane-count">{employees.length}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="lane-body">
          {sorted.map(emp => (
            <EmployeeTile
              key={emp.id}
              employee={emp}
              assignment={assignmentMap?.[emp.id]}
              laneSettings={null}
              onShiftChange={(start, hours) => onShiftChange(emp.id, start, hours)}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  )
}

export default function RosterBoardMemory({ facility, planDate, onRosterChange }) {
  const [employees, setEmployees]         = useState([])
  const [laneMap, setLaneMap]             = useState({})
  const [assignmentMap, setAssignmentMap] = useState({})
  const [isLoading, setIsLoading]         = useState(true)
  const [activeId, setActiveId]           = useState(null)
  const [refreshState, setRefreshState]   = useState(null)
  const [error, setError]                 = useState(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const loadFromB2e = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const date = planDate || todayISO()
      const [b2eEmployees, timeOffMap] = await Promise.all([
        fetchB2eRoster(facility, date),
        fetchB2eTimeOff(facility, date).catch(() => new Map()),
      ])
      const withTimeOff = applyTimeOffOverrides(b2eEmployees, timeOffMap)
      const lm = {}
      const am = {}
      for (const emp of withTimeOff) {
        lm[emp.id] = emp.default_lane || 'shift1'
        am[emp.id] = {
          employee_id:   emp.id,
          employee_name: emp.name,
          role:          emp.role,
          lane:          emp.default_lane || 'shift1',
          shift_start:   emp.shift_start ?? null,
          shift_hours:   emp.shift_hours ?? null,
          on_loan_to:    null,
        }
      }
      setEmployees(withTimeOff)
      setLaneMap(lm)
      setAssignmentMap(am)
    } catch (e) {
      console.error('B2E load failed:', e)
      setError(e.message || 'Failed to load from B2E')
      setEmployees([])
      setLaneMap({})
      setAssignmentMap({})
    } finally {
      setIsLoading(false)
    }
  }, [facility, planDate])

  useEffect(() => { loadFromB2e() }, [loadFromB2e])

  useEffect(() => {
    onRosterChange?.({ employees, laneMap, assignmentMap })
  }, [employees, laneMap, assignmentMap, onRosterChange])

  const handleRefresh = useCallback(async () => {
    setRefreshState('loading')
    await loadFromB2e()
    setRefreshState('ok')
    setTimeout(() => setRefreshState(null), 2000)
  }, [loadFromB2e])

  const handleShiftChange = useCallback((empId, shiftStart, shiftHours) => {
    setAssignmentMap(prev => ({
      ...prev,
      [empId]: { ...(prev[empId] ?? {}), shift_start: shiftStart, shift_hours: shiftHours },
    }))
  }, [])

  const handleDragStart = useCallback(({ active }) => setActiveId(active.id), [])

  const handleDragEnd = useCallback(({ active, over }) => {
    setActiveId(null)
    if (!over) return
    const empId  = active.id
    const overId = String(over.id)
    const isLane = LANES.some(l => l.id === overId)
    let destLane = isLane ? overId : (laneMap[overId] || employees.find(e => e.id === overId)?.default_lane)
    if (!destLane || destLane === laneMap[empId]) return
    setLaneMap(prev => ({ ...prev, [empId]: destLane }))
    setAssignmentMap(prev => ({
      ...prev,
      [empId]: { ...(prev[empId] ?? {}), lane: destLane },
    }))
  }, [laneMap, employees])

  const activeEmployee = activeId ? employees.find(e => e.id === activeId) : null
  const laneEmployees  = (laneId) => employees.filter(e => (laneMap[e.id] || e.default_lane) === laneId)

  const activeCount = [...STANDARD_ACTIVE_LANES].reduce((n, l) => n + laneEmployees(l).length, 0)
  const ptoCount    = laneEmployees('pto').length
  const callinCount = laneEmployees('callin').length

  if (isLoading) {
    return (
      <div className="roster-section">
        <div className="roster-loading">Loading B2E roster…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="roster-section">
        <div className="omni-warning-banner">
          <span className="omni-warning-icon">⚠</span>
          <span className="omni-warning-text">B2E roster load failed: {error}</span>
          <button className="omni-warning-retry" onClick={handleRefresh}>Retry</button>
        </div>
      </div>
    )
  }

  return (
    <div className="roster-section">
      <div className="roster-header">
        <span className="section-label">
          Shift Roster <span style={{ color: 'var(--text-dim)', fontSize: 10, fontWeight: 400, marginLeft: 8 }}>
            (memory only — drag changes don't save)
          </span>
        </span>
        <div className="roster-stats">
          <span className="roster-stat"><strong>{activeCount}</strong> active</span>
          <span className="roster-stat"><strong>{ptoCount}</strong> PTO</span>
          <span className="roster-stat"><strong>{callinCount}</strong> call-in</span>
          <button className="b2e-sync-btn" onClick={handleRefresh} disabled={refreshState === 'loading'}
            title="Re-pull fresh roster from B2E (wipes any local drag-drop changes)">
            {refreshState === 'loading' ? 'Refreshing…' : refreshState === 'ok' ? 'Refreshed ✓' : 'Refresh from B2E'}
          </button>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd}
      >
        <div className="roster-lanes" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}>
          {LANES.map(lane => (
            <DroppableLane key={lane.id} lane={lane}
              employees={laneEmployees(lane.id)}
              assignmentMap={assignmentMap}
              onShiftChange={handleShiftChange}
            />
          ))}
        </div>
        <DragOverlay>{activeEmployee ? <EmployeeTile employee={activeEmployee} /> : null}</DragOverlay>
      </DndContext>
    </div>
  )
}
