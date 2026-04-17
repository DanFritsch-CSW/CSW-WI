import { useState, useEffect, useCallback } from 'react'
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
import { LANES } from '../lib/constants.js'
import { fetchTodayAssignments, upsertAssignment, fetchEmployees } from '../lib/supabase.js'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function DroppableLane({ lane, employees }) {
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
            <EmployeeTile key={emp.id} employee={emp} />
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

export default function RosterBoard({ facility, planDate, onLaborCount }) {
  const [laneMap, setLaneMap] = useState({})  // { [employeeId]: laneId }
  const [employees, setEmployees] = useState([])
  const [activeId, setActiveId] = useState(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Load employees and assignments
  useEffect(() => {
    async function load() {
      let emps = await fetchEmployees(facility)
      if (!emps.length) emps = STUB_EMPLOYEES.map(e => ({ ...e, facility }))
      setEmployees(emps)

      const date = planDate || todayISO()
      const assignments = await fetchTodayAssignments(facility, date)

      const map = {}
      emps.forEach(e => { map[e.id] = e.default_lane || 'shift1' })
      assignments.forEach(a => { map[a.employee_id] = a.lane })
      setLaneMap(map)
    }
    load()
  }, [facility, planDate])

  // Report labor count upward whenever laneMap changes
  useEffect(() => {
    const active = Object.values(laneMap).filter(l => l === 'shift1' || l === 'shift2').length
    onLaborCount?.(active)
  }, [laneMap, onLaborCount])

  const handleDragStart = useCallback(({ active }) => setActiveId(active.id), [])

  const handleDragEnd = useCallback(({ active, over }) => {
    setActiveId(null)
    if (!over) return
    const employeeId = active.id
    const targetLane = over.id

    // over.id could be a lane id or an employee id (if dropped onto a tile)
    const validLane = LANES.find(l => l.id === targetLane)
    if (!validLane) {
      // dropped onto another employee — find its lane
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
    const date = planDate || todayISO()
    upsertAssignment({
      facility,
      employee_id: employeeId,
      employee_name: emp.name,
      role: emp.role,
      lane: laneId,
      plan_date: date,
    })
  }

  const activeEmployee = activeId ? employees.find(e => e.id === activeId) : null

  const laneEmployees = (laneId) =>
    employees.filter(e => (laneMap[e.id] || e.default_lane) === laneId)

  const activeCount = LANES.filter(l => l.id === 'shift1' || l.id === 'shift2')
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
            />
          ))}
        </div>
        <DragOverlay>
          {activeEmployee ? <EmployeeTile employee={activeEmployee} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
