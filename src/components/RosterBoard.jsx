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
import { LANES, ACTIVE_LANES, LANES_CAL2, ACTIVE_LANES_CAL2, FACILITIES, FACILITY_LIST } from '../lib/constants.js'
import {
  fetchTodayAssignments, upsertAssignment, replaceEmployees,
  seedRosterAssignments, deleteAssignment,
  sendEmployeeOnLoan, recallLoan, purgeStaleAssignments,
  checkRosterStaleness, markRosterRowsAsSynced,
} from '../lib/supabase.js'
import { fetchB2eRoster, fetchB2eTimeOff } from '../lib/omni.js'

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

// Droppable ID for the send-to-facility zone — encodes source lane
const SEND_ZONE_PREFIX = '__send__'
function sendZoneId(laneId) { return `${SEND_ZONE_PREFIX}${laneId}` }
function isSendZone(id)     { return String(id).startsWith(SEND_ZONE_PREFIX) }
function laneFromSendZone(id) { return String(id).slice(SEND_ZONE_PREFIX.length) }

// Active (labor-counting) lanes — PTO/callin/specialProject excluded
const STANDARD_ACTIVE_LANES = new Set(['shift1', 'mid', 'shift2', 'shift3'])
const CAL_ACTIVE_LANES = new Set([
  'side12_shift1','side12_mid','side12_shift2','side12_shift3',
  'side35_shift1','side35_mid','side35_shift2','side35_shift3',
])

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
  if (laneId === 'specialProject') return 'lane-special-project'
  return ''
}

/**
 * Filter carryovers out before any DB write — they are NOT persisted.
 */
function withoutCarryovers(employees) {
  return employees.filter(e => !e.is_carryover)
}

/**
 * Apply time-off overrides to a list of B2E employees before seeding.
 * Employees found in the timeOffMap get their default_lane set to 'pto'
 * and their role set to the time-off label (e.g. 'FMLA', 'PTO') so the
 * tile badge survives a page refresh.
 */
function applyTimeOffOverrides(employees, timeOffMap) {
  if (!timeOffMap.size) return employees
  return employees.map(emp => {
    const label = timeOffMap.get(String(emp.id))
    if (!label) return emp
    return { ...emp, default_lane: 'pto', role: label }
  })
}

// ── Send-to-Facility Drop Zone ───────────────────────────────────
function SendZone({ laneId }) {
  const { setNodeRef, isOver } = useDroppable({ id: sendZoneId(laneId) })
  return (
    <div
      ref={setNodeRef}
      className={`send-zone${isOver ? ' send-zone--over' : ''}`}
      title="Drop here to send employee to another facility"
    >
      ✈ Send to facility
    </div>
  )
}

// ── Loan Modal ───────────────────────────────────────────────────
function LoanModal({ employee, sourceFacility, onConfirm, onCancel }) {
  const otherFacilities = FACILITY_LIST.filter(f => f.id !== sourceFacility)
  const [destFacility, setDestFacility] = useState(otherFacilities[0]?.id ?? '')
  const [destLane, setDestLane]         = useState('shift1')

  const destLanes = destFacility === 'cal'
    ? [
        { id: 'side12_shift1', label: '1-2 · 1st' }, { id: 'side12_mid', label: '1-2 · Mid' },
        { id: 'side12_shift2', label: '1-2 · 2nd' }, { id: 'side12_shift3', label: '1-2 · 3rd' },
        { id: 'side35_shift1', label: '3.5 · 1st' }, { id: 'side35_mid', label: '3.5 · Mid' },
        { id: 'side35_shift2', label: '3.5 · 2nd' }, { id: 'side35_shift3', label: '3.5 · 3rd' },
      ]
    : [
        { id: 'shift1', label: '1st Shift' }, { id: 'mid', label: 'Mid Shift' },
        { id: 'shift2', label: '2nd Shift' }, { id: 'shift3', label: '3rd Shift' },
      ]

  function handleFacilityChange(fac) {
    setDestFacility(fac)
    setDestLane(fac === 'cal' ? 'side12_shift1' : 'shift1')
  }

  return (
    <div className="modal-overlay" onPointerDown={e => e.stopPropagation()}>
      <div className="modal-box">
        <div className="modal-header">
          <span className="modal-title">Send to Facility</span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
          Sending: <strong style={{ color: 'var(--text-primary)' }}>{employee.name}</strong>
        </div>
        <div className="modal-form">
          <label className="modal-label">
            Destination Facility
            <select className="modal-select" value={destFacility} onChange={e => handleFacilityChange(e.target.value)}>
              {otherFacilities.map(f => (
                <option key={f.id} value={f.id}>{f.code} — {f.name}</option>
              ))}
            </select>
          </label>
          <label className="modal-label">
            Assign to Lane
            <select className="modal-select" value={destLane} onChange={e => setDestLane(e.target.value)}>
              {destLanes.map(l => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="modal-btn-submit" onClick={() => onConfirm(destFacility, destLane)}>
            Send ✈
          </button>
        </div>
      </div>
    </div>
  )
}

// ── DroppableLane ────────────────────────────────────────────────
function DroppableLane({ lane, employees, assignmentMap, carryoverMap, settings, onDeleteTemp, onShiftChange, onRecall, onSpecialProjectLabelChange, autoEditLabelId, onAutoEditConsumed, sortOrder, isActiveLane }) {
  const { setNodeRef, isOver } = useDroppable({ id: lane.id })
  const sorted       = sortEmployees(employees, sortOrder)
  const ids          = sorted.map(e => e.id)
  const groups       = groupByStartHour(sorted, assignmentMap)
  const laneSettings = getLaneSettings(lane.id, settings)
  const sideClass    = laneSideClass(lane.id)

  // Lane header headcount excludes carryovers (already counted on prior day).
  const headcount = employees.filter(e => !carryoverMap?.[e.id]).length

  return (
    <div
      ref={setNodeRef}
      className={`lane${sideClass ? ` ${sideClass}` : ''}${isOver ? ' over' : ''}`}
      style={{ touchAction: 'none' }}
    >
      <div className="lane-header">
        <span className="lane-title">{lane.label}</span>
        <span className="lane-count">{headcount}</span>
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
                    onRecall={assignmentMap?.[emp.id]?.on_loan_to ? () => onRecall(emp) : undefined}
                    onSpecialProjectLabelChange={onSpecialProjectLabelChange}
                    autoEditLabel={autoEditLabelId === emp.id}
                    onAutoEditConsumed={onAutoEditConsumed}
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
                onRecall={assignmentMap?.[emp.id]?.on_loan_to ? () => onRecall(emp) : undefined}
                onSpecialProjectLabelChange={onSpecialProjectLabelChange}
                autoEditLabel={autoEditLabelId === emp.id}
                onAutoEditConsumed={onAutoEditConsumed}
              />
            ))
          )}
          {/* Send zone — only shown on active (labor-counting) lanes */}
          {isActiveLane && <SendZone laneId={lane.id} />}
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

export default function RosterBoard({ facility, planDate, settings, onLaborCount, onRosterChange }) {
  const isCal          = facility === 'cal'
  const activeLaneSet  = isCal ? LANES_CAL2     : LANES
  const activeLaneIds  = isCal ? ACTIVE_LANES_CAL2 : ACTIVE_LANES
  const activeLaneSet_ = isCal ? CAL_ACTIVE_LANES : STANDARD_ACTIVE_LANES
  const activeLaneIdSet = new Set(activeLaneIds)

  const [laneMap, setLaneMap]             = useState({})
  const [assignmentMap, setAssignmentMap] = useState({})
  const [carryoverMap, setCarryoverMap]   = useState({})
  const [employees, setEmployees]         = useState([])
  const [isLoading, setIsLoading]         = useState(true)
  const [activeId, setActiveId]           = useState(null)
  const [syncState, setSyncState]         = useState(null)
  const [showAddTemp, setShowAddTemp]     = useState(false)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [sortOrder, setSortOrder]         = useState('default')
  // Loan modal state
  const [loanEmployee, setLoanEmployee]   = useState(null) // emp being sent
  // Special Project auto-edit: tracks which employee just landed in
  // specialProject so EmployeeTile can auto-open the label input.
  const [autoEditLabelId, setAutoEditLabelId] = useState(null)
  const [syncToast, setSyncToast]             = useState(null) // null | 'visible' | 'leaving'
  const loadRef            = useRef(null)
  const autoSyncCheckedRef = useRef(new Set())

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  async function load(facId, date) {
    setIsLoading(true)

    // Fetch B2E roster ALWAYS (for live carryover data) in parallel with
    // assignments and time-off so PTO is applied on every load.
    const [assignments, timeOffMap, b2eRosterFull] = await Promise.all([
      fetchTodayAssignments(facId, date),
      fetchB2eTimeOff(facId, date).catch(() => new Map()),
      fetchB2eRoster(facId, date).catch(() => []),
    ])

    const carryovers = b2eRosterFull.filter(e => e.is_carryover)

    if (assignments.length === 0) {
      // First-time seed — persist non-carryover entries only
      const persistable = withoutCarryovers(b2eRosterFull)
      if (persistable.length > 0) {
        const withTimeOff = applyTimeOffOverrides(persistable, timeOffMap)
        const empRows = withTimeOff.map(({ shift_hours, ...e }) => e)
        await replaceEmployees(facId, empRows)
        await seedRosterAssignments(withTimeOff, date)
        const empIds = withTimeOff.map(e => e.id)
        await purgeStaleAssignments(empIds, facId, date)
        const seeded = await fetchTodayAssignments(facId, date)
        _buildState(facId, seeded, timeOffMap, carryovers)
        // First-visit seed: mark as checked so auto-resync doesn't fire on this load.
        // The freshly-seeded rows already carry last_b2e_sync_at from seedRosterAssignments.
        autoSyncCheckedRef.current.add(`${facId}:${date}`)
        return
      }
    } else {
      // Roster already seeded — apply any time-off overrides that aren't
      // already in the PTO lane. PTO wins over Special Project too —
      // they're not in the building, so PTO is the stronger constraint.
      if (timeOffMap.size > 0) {
        const toUpdate = []
        for (const asg of assignments) {
          const label = timeOffMap.get(String(asg.employee_id))
          if (label && asg.lane !== 'pto') {
            toUpdate.push({ ...asg, lane: 'pto', role: label })
          }
        }
        if (toUpdate.length > 0) {
          for (const row of toUpdate) {
            // automatic:true — auto-PTO is NOT a manual edit; don't set the
            // manually_edited protection flag so future B2E syncs can still
            // correct this employee's lane if they return from PTO.
            upsertAssignment(row, { automatic: true }).catch(e => console.warn('time-off upsert:', e))
          }
          const overrideMap = new Map(toUpdate.map(r => [r.employee_id, r]))
          const merged = assignments.map(a => overrideMap.get(a.employee_id) ?? a)
          _buildState(facId, merged, timeOffMap, carryovers)
          maybeAutoResync(facId, date)
          return
        }
      }
    }

    _buildState(facId, assignments, timeOffMap, carryovers)
    maybeAutoResync(facId, date)
  }

  function _buildState(facId, assignments, _timeOffMap, carryovers = []) {
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

    // Carryovers come from B2E with synthetic IDs (e.g. '549__carryover')
    // so they coexist with the employee's normal today's-shift entry.
    const carryoverEmps = carryovers.map(c => ({
      id:           c.id,           // already has CARRYOVER_ID_SUFFIX
      originalId:   c.originalId,   // real employee ID, for reference
      name:         c.name,
      role:         c.role,
      facility:     facId,
      is_temp:      false,
      is_carryover: true,
      default_lane: c.default_lane,
      shift_start:  c.shift_start,
      shift_hours:  c.shift_hours,
    }))

    const allEmps = [...emps, ...tempEmps, ...carryoverEmps]
    setEmployees(allEmps)

    const cMap = {}
    for (const c of carryoverEmps) cMap[c.id] = true
    setCarryoverMap(cMap)

    const map = {}
    assignments.forEach(a => { map[a.employee_id] = a.lane })
    for (const c of carryoverEmps) map[c.id] = c.default_lane
    setLaneMap(map)

    // Synthetic assignments for carryovers — ephemeral, never upserted.
    const asgMap = {}
    assignments.forEach(a => { asgMap[a.employee_id] = a })
    for (const c of carryoverEmps) {
      asgMap[c.id] = {
        facility:      facId,
        employee_id:   c.id,
        employee_name: c.name,
        role:          c.role,
        lane:          c.default_lane,
        plan_date:     null,
        is_temp:       false,
        shift_start:   c.shift_start,
        shift_hours:   c.shift_hours,
        is_carryover:  true,
      }
    }
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

  // ── Toast helper — 1.6s visible + 0.25s fade ──────────────────────────────
  const showSyncToast = useCallback(() => {
    setSyncToast('visible')
    setTimeout(() => setSyncToast('leaving'), 1600)
    setTimeout(() => setSyncToast(null), 1850)
  }, [])

  // ── Core B2E sync logic (shared by button + auto-resync) ───────────────────
  const performB2eSync = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setSyncState('loading')
    try {
      const date = planDate || todayISO()
      const [b2eRosterFull, timeOffMap] = await Promise.all([
        fetchB2eRoster(facility, date),
        fetchB2eTimeOff(facility, date),
      ])
      const persistable = withoutCarryovers(b2eRosterFull)
      if (!persistable.length) {
        if (!silent) setSyncState('No B2E data found')
        return
      }
      const withTimeOff = applyTimeOffOverrides(persistable, timeOffMap)
      const empRows = withTimeOff.map(({ shift_hours, ...e }) => e)
      const err = await replaceEmployees(facility, empRows)
      if (err) { if (!silent) setSyncState(err); return }
      // seedRosterAssignments now skips rows where manually_edited=true,
      // so manual moves / PTO / temp assignments survive every sync.
      const seedErr = await seedRosterAssignments(withTimeOff, date)
      if (seedErr) { if (!silent) setSyncState(seedErr); return }
      const empIds = withTimeOff.map(e => e.id)
      await purgeStaleAssignments(empIds, facility, date)
      await load(facility, date)
      if (!silent) {
        setSyncState('ok')
        setTimeout(() => setSyncState(null), 3000)
      }
    } catch (e) {
      if (!silent) setSyncState(e.message)
      else console.warn('Auto-sync failed (non-fatal):', e.message)
    }
  }, [facility, planDate])

  // ── Button handler — thin wrapper ──────────────────────────────────────────
  const handleB2eSync = useCallback(() => performB2eSync({ silent: false }), [performB2eSync])

  // ── Auto-resync: fires once per (facility, date) pair per session ──────────
  // Checks last_b2e_sync_at staleness; if stale, shows toast and silently syncs.
  // Manually edited rows are protected at the seedRosterAssignments layer.
  const maybeAutoResync = useCallback(async (facId, date) => {
    const key = `${facId}:${date}`
    if (autoSyncCheckedRef.current.has(key)) return
    autoSyncCheckedRef.current.add(key)
    try {
      const stale = await checkRosterStaleness(facId, date)
      if (!stale) return
      showSyncToast()
      await performB2eSync({ silent: true })
    } catch (e) {
      console.warn('maybeAutoResync failed (non-fatal):', e.message)
    }
  }, [showSyncToast, performB2eSync])

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
    if (emp.is_carryover) return
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

  // ── Special Project label change: persist the user-typed note into role.
  // Reuses the `role` column on roster_assignments — no schema change needed.
  const handleSpecialProjectLabelChange = useCallback(async (empId, label) => {
    const emp = employees.find(e => e.id === empId)
    if (!emp || emp.is_carryover) return
    const date     = planDate || todayISO()
    const existing = assignmentMap[empId] ?? {}
    const trimmed  = (label || '').trim() || null
    const updated  = {
      facility,
      employee_id:   empId,
      employee_name: emp.name,
      lane:          laneMap[empId] || 'specialProject',
      plan_date:     date,
      is_temp:       emp.is_temp ?? false,
      shift_start:   existing.shift_start ?? null,
      shift_hours:   existing.shift_hours ?? null,
      ...existing,
      role:          trimmed,
    }
    // Optimistic: update local state immediately so the tile reflects the new label.
    setAssignmentMap(prev => ({ ...prev, [empId]: updated }))
    setEmployees(prev => prev.map(e => e.id === empId ? { ...e, role: trimmed } : e))
    await trackedUpsert(updated)
  }, [employees, assignmentMap, laneMap, facility, planDate, trackedUpsert])

  const handleAutoEditConsumed = useCallback(() => setAutoEditLabelId(null), [])

  // ── Loan: drop on send zone → open modal
  const handleSendConfirm = useCallback(async (destFacility, destLane) => {
    if (!loanEmployee) return
    const date     = planDate || todayISO()
    const emp      = loanEmployee
    const existing = assignmentMap[emp.id] ?? {}
    setPendingWrites(n => n + 1)
    try {
      const err = await sendEmployeeOnLoan({
        employeeId:     emp.id,
        employeeName:   emp.name,
        role:           emp.role,
        sourceFacility: facility,
        destFacility,
        destLane,
        planDate:       date,
        shiftStart:     existing.shift_start ?? null,
        shiftHours:     existing.shift_hours ?? null,
      })
      if (!err) {
        setAssignmentMap(prev => ({
          ...prev,
          [emp.id]: { ...(prev[emp.id] ?? {}), on_loan_to: destFacility },
        }))
      }
    } finally {
      setPendingWrites(n => n - 1)
    }
    setLoanEmployee(null)
  }, [loanEmployee, assignmentMap, facility, planDate])

  // ── Recall: ↩ button on ON LOAN tile
  const handleRecall = useCallback(async (emp) => {
    const date       = planDate || todayISO()
    const assignment = assignmentMap[emp.id]
    if (!assignment?.on_loan_to) return
    const destFacility = assignment.on_loan_to
    setPendingWrites(n => n + 1)
    try {
      const err = await recallLoan({
        employeeId:     emp.id,
        sourceFacility: facility,
        destFacility,
        planDate:       date,
      })
      if (!err) {
        setAssignmentMap(prev => ({
          ...prev,
          [emp.id]: { ...(prev[emp.id] ?? {}), on_loan_to: null },
        }))
      }
    } finally {
      setPendingWrites(n => n - 1)
    }
  }, [assignmentMap, facility, planDate])

  useEffect(() => {
    const activeEmps = employees.filter(e => {
      if (e.is_carryover) return false
      if (!activeLaneSet_.has(laneMap[e.id] || e.default_lane)) return false
      if (assignmentMap[e.id]?.on_loan_to) return false
      return true
    })
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
    const overId     = String(over.id)

    const emp = employees.find(e => e.id === employeeId)
    if (emp?.is_carryover) return

    // Dropped on the send zone → open loan modal
    if (isSendZone(overId)) {
      const emp = employees.find(e => e.id === employeeId)
      if (emp && !assignmentMap[emp.id]?.on_loan_to) {
        setLoanEmployee(emp)
      }
      return
    }

    const isLane = activeLaneSet.some(l => l.id === overId)
    if (isLane) {
      if (laneMap[employeeId] !== overId) moveTo(employeeId, overId)
      return
    }
    const destLane = laneMap[overId] || employees.find(e => e.id === overId)?.default_lane
    if (destLane && destLane !== laneMap[employeeId]) {
      moveTo(employeeId, destLane)
    }
  }, [laneMap, activeLaneSet, employees, assignmentMap])

  function moveTo(employeeId, laneId) {
    const previousLane = laneMap[employeeId]
    setLaneMap(prev => ({ ...prev, [employeeId]: laneId }))
    setAssignmentMap(prev => {
      const existing = prev[employeeId] ?? {}
      // When moving INTO specialProject, clear any prior role so the tile
      // starts with an empty label (user will type or skip).
      // When moving OUT of specialProject, also clear role so the previous
      // note doesn't bleed into the new lane's role display.
      const isEnteringSP = laneId === 'specialProject'
      const isLeavingSP  = previousLane === 'specialProject' && laneId !== 'specialProject'
      const nextRole     = (isEnteringSP || isLeavingSP) ? null : existing.role
      return { ...prev, [employeeId]: { ...existing, lane: laneId, role: nextRole } }
    })
    const emp = employees.find(e => e.id === employeeId)
    if (!emp) return
    if (emp.is_carryover) return

    // Clear role on the in-memory employee record too, so the tile picks
    // up the cleared value immediately (EmployeeTile falls back to
    // employee.role when assignment.role is undefined).
    if (laneId === 'specialProject' || previousLane === 'specialProject') {
      setEmployees(prev => prev.map(e => e.id === employeeId ? { ...e, role: null } : e))
    }

    // Trigger auto-prompt when entering Special Project lane
    if (laneId === 'specialProject') {
      setAutoEditLabelId(employeeId)
    }

    const date     = planDate || todayISO()
    const existing = assignmentMap[employeeId] ?? {}
    const isEnteringSP = laneId === 'specialProject'
    const isLeavingSP  = previousLane === 'specialProject' && laneId !== 'specialProject'
    const nextRole     = (isEnteringSP || isLeavingSP) ? null : (existing.role ?? emp.role)
    trackedUpsert({
      facility,
      employee_id:   employeeId,
      employee_name: emp.name,
      role:          nextRole,
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
    .reduce((n, l) => n + laneEmployees(l.id).filter(e => !assignmentMap[e.id]?.on_loan_to && !e.is_carryover).length, 0)
  const ptoCount    = laneEmployees('pto').length
  const callinCount = laneEmployees('callin').length
  const specialProjectCount = laneEmployees('specialProject').length

  const side12Count = isCal
    ? ['side12_shift1','side12_mid','side12_shift2','side12_shift3']
        .reduce((n, l) => n + laneEmployees(l).filter(e => !assignmentMap[e.id]?.on_loan_to && !e.is_carryover).length, 0)
    : null
  const side35Count = isCal
    ? ['side35_shift1','side35_mid','side35_shift2','side35_shift3']
        .reduce((n, l) => n + laneEmployees(l).filter(e => !assignmentMap[e.id]?.on_loan_to && !e.is_carryover).length, 0)
    : null

  const currentSort = SORT_MODES.find(m => m.key === sortOrder)
  const nextSort    = () => {
    const idx = SORT_MODES.findIndex(m => m.key === sortOrder)
    setSortOrder(SORT_MODES[(idx + 1) % SORT_MODES.length].key)
  }

  // Grid: standard = 7 lanes (4 active + pto + callin + specialProject)
  //       CAL      = 11 lanes (8 active + pto + callin + specialProject)
  const gridCols  = isCal ? 'repeat(11, minmax(0, 1fr))' : 'repeat(7, minmax(0, 1fr))'
  const gridStyle = { gridTemplateColumns: gridCols }

  if (isLoading) {
    return (
      <div className="roster-section">
        <div className="roster-loading">Loading roster…</div>
      </div>
    )
  }

  return (
    <div className="roster-section">
      {/* ── Auto-sync toast — fixed, centered, appears when stale roster detected ── */}
      {syncToast && (
        <div className={`b2e-sync-toast${syncToast === 'leaving' ? ' b2e-sync-toast--leaving' : ''}`}>
          <span className="b2e-sync-toast-icon">⟳</span>
          Syncing latest schedules…
        </div>
      )}

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
          <span className="roster-stat"><strong>{specialProjectCount}</strong> special project</span>
          {pendingWrites > 0 && <span className="roster-saving">Saving…</span>}
          <button className={`b2e-sync-btn${sortOrder !== 'default' ? ' roster-sort-active' : ''}`} onClick={nextSort} title="Cycle sort">{currentSort.label}</button>
          <button className="b2e-sync-btn" onClick={() => setShowAddTemp(true)}>+ Add Temp</button>
          <button className="b2e-sync-btn" onClick={handleB2eSync} disabled={syncState === 'loading'} title="Pull latest shift schedules from B2E. Manual lane/shift changes you've made are preserved.">
            {syncState === 'loading' ? 'Syncing…' : syncState === 'ok' ? 'Synced ✓' : 'Sync from B2E'}
          </button>
          {syncState && syncState !== 'loading' && syncState !== 'ok' && <span className="b2e-sync-err">{syncState}</span>}
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
              carryoverMap={carryoverMap}
              settings={settings}
              sortOrder={sortOrder}
              isActiveLane={activeLaneIdSet.has(lane.id)}
              onDeleteTemp={handleDeleteTemp}
              onShiftChange={handleShiftChange}
              onRecall={handleRecall}
              onSpecialProjectLabelChange={handleSpecialProjectLabelChange}
              autoEditLabelId={autoEditLabelId}
              onAutoEditConsumed={handleAutoEditConsumed}
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

      {loanEmployee && (
        <LoanModal
          employee={loanEmployee}
          sourceFacility={facility}
          onConfirm={handleSendConfirm}
          onCancel={() => setLoanEmployee(null)}
        />
      )}
    </div>
  )
}
