import { createClient } from '@supabase/supabase-js'

const url  = import.meta.env.VITE_SUPABASE_URL  || ''
const key  = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

export const supabase = url && key ? createClient(url, key) : null

export async function fetchTodayAssignments(facility, planDate) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('roster_assignments')
    .select('*')
    .eq('facility', facility)
    .eq('plan_date', planDate)
  if (error) { console.error('fetchTodayAssignments:', error); return [] }
  return data ?? []
}

// upsertAssignment — by default stamps manually_edited=true with a timestamp
// so the row is protected from B2E auto-sync / seedRosterAssignments overwrites.
// Pass { automatic: true } when the write is NOT a human action (e.g. auto-PTO
// override in RosterBoard.load()) so the protection flag is NOT set.
export async function upsertAssignment(assignment, opts = {}) {
  if (!supabase) return
  const row = { ...assignment }
  if (opts.automatic !== true) {
    row.manually_edited = true
    row.manually_edited_at = new Date().toISOString()
  }
  const { error } = await supabase
    .from('roster_assignments')
    .upsert(row, { onConflict: 'facility,employee_id,plan_date' })
  if (error) console.error('upsertAssignment:', error)
}

export async function fetchEmployees(facility) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('facility', facility)
    .eq('job_code', '205')
  if (error) { console.error('fetchEmployees:', error); return [] }
  return data ?? []
}

export async function fetchCal2Employees() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('employees')
    .select('id, name, default_lane')
    .eq('facility', 'cal')
    .order('name')
  if (error) { console.error('fetchCal2Employees:', error); return [] }
  return data ?? []
}

export async function upsertEmployeeDockSide(employeeId, side, currentLane) {
  if (!supabase) return
  const shiftSuffix = (currentLane || '').replace(/^side(12|35)_/, '') || 'shift1'
  const newLane = `${side}_${shiftSuffix}`
  const { error } = await supabase
    .from('employees')
    .update({ default_lane: newLane })
    .eq('id', employeeId)
  if (error) console.error('upsertEmployeeDockSide:', error)
  return newLane
}

export async function replaceEmployees(facilityId, employees) {
  if (!supabase) return 'Supabase not configured'
  if (employees.length) {
    const { error } = await supabase
      .from('employees')
      .upsert(employees, { onConflict: 'id' })
    if (error) { console.error('replaceEmployees upsert:', error); return error.message }
  }
  const { data: current, error: fetchErr } = await supabase
    .from('employees').select('id').eq('facility', facilityId)
  if (fetchErr) { console.error('replaceEmployees fetch:', fetchErr); return fetchErr.message }
  const activeIds = new Set(employees.map(e => String(e.id)))
  const staleIds  = (current ?? []).filter(e => !activeIds.has(String(e.id))).map(e => e.id)
  if (!staleIds.length) return null
  const { error: delErr } = await supabase
    .from('employees').delete().in('id', staleIds)
  if (delErr) { console.error('replaceEmployees prune:', delErr); return delErr.message }
  return null
}

export async function upsertEmployees(employees) {
  if (!supabase) return 'Supabase not configured'
  const { error } = await supabase
    .from('employees')
    .upsert(employees, { onConflict: 'id' })
  if (error) { console.error('upsertEmployees:', error); return error.message }
  return null
}

// seedRosterAssignments — writes B2E roster data to Supabase as the baseline.
//
// Splits employees into two cohorts based on manually_edited flag of any
// existing row on this date:
//   1. Non-manual: full upsert. B2E owns the entire row.
//   2. Manual:     PARTIAL update of shift_start, shift_hours, employee_name,
//                  last_b2e_sync_at. lane, role, manually_edited, and
//                  manually_edited_at are preserved.
//
// The partial path fixes the "wrong shift on manually-moved employee" bug
// where a row marked manually_edited=true (e.g. dragged to specialProject or
// a different CAL side) kept stale shift_start/shift_hours forever, even
// after B2E published a new schedule for that employee on that date.
//
// What the new policy enforces:
//   - B2E always owns shift_start, shift_hours, employee_name.
//   - Managers always own lane and role.
// Trade-off: per-tile shift edits (handleShiftChange in RosterBoard) DO get
// overwritten by B2E on next sync. If a manager intentionally adjusts a
// specific day's hours, they should use the Adj column on HourlyTable for
// labor adjustments instead, or edit B2E directly.
export async function seedRosterAssignments(employees, planDate) {
  if (!supabase || !employees.length) return null
  const facility = employees[0]?.facility
  // Fetch existing manual rows so we can route them through the partial-update path.
  let manualIds = new Set()
  if (facility) {
    const { data: manualRows, error: mErr } = await supabase
      .from('roster_assignments')
      .select('employee_id')
      .eq('facility', facility)
      .eq('plan_date', planDate)
      .eq('manually_edited', true)
    if (mErr) { console.error('seedRosterAssignments fetch manual:', mErr); return mErr.message }
    manualIds = new Set((manualRows ?? []).map(r => String(r.employee_id)))
  }
  const nowIso = new Date().toISOString()

  // Path 1 — non-manual employees: full upsert (existing behavior).
  const fullRows = employees
    .filter(e => !manualIds.has(String(e.id)))
    .map(e => ({
      facility:          e.facility,
      employee_id:       e.id,
      employee_name:     e.name,
      role:              e.role ?? null,
      lane:              e.default_lane || 'shift1',
      plan_date:         planDate,
      shift_start:       e.shift_start ?? null,
      shift_hours:       e.shift_hours ?? null,
      is_temp:           false,
      from_facility:     null,
      on_loan_to:        null,
      last_b2e_sync_at:  nowIso,
      manually_edited:   false,
      manually_edited_at: null,
    }))

  if (fullRows.length) {
    const { error } = await supabase
      .from('roster_assignments')
      .upsert(fullRows, { onConflict: 'facility,employee_id,plan_date', ignoreDuplicates: false })
    if (error) { console.error('seedRosterAssignments full upsert:', error); return error.message }
  }

  // Path 2 — manually-edited employees: partial update so B2E owns shift
  // times and name, but lane/role/manually_edited stay protected.
  const partialEmployees = employees.filter(e => manualIds.has(String(e.id)))
  if (partialEmployees.length) {
    await Promise.all(partialEmployees.map(e =>
      supabase
        .from('roster_assignments')
        .update({
          shift_start:      e.shift_start ?? null,
          shift_hours:      e.shift_hours ?? null,
          employee_name:    e.name,
          last_b2e_sync_at: nowIso,
        })
        .eq('facility', e.facility)
        .eq('employee_id', e.id)
        .eq('plan_date', planDate)
        .then(({ error }) => { if (error) console.error('seedRosterAssignments partial update:', error) })
    ))
  }

  return null
}

// purgeStaleAssignments — removes future rows for employees at facilities
// they no longer belong to (e.g. after a B2E transfer). The .eq('manually_edited',
// false) guard protects manual cross-facility placements (loans, manual moves)
// from being purged.
export async function purgeStaleAssignments(employeeIds, correctFacility, fromDate) {
  if (!supabase || !employeeIds.length) return null
  const { error } = await supabase
    .from('roster_assignments')
    .delete()
    .in('employee_id', employeeIds)
    .neq('facility', correctFacility)
    .is('from_facility', null)
    .eq('manually_edited', false)
    .gte('plan_date', fromDate)
  if (error) { console.error('purgeStaleAssignments:', error); return error.message }
  return null
}

// purgeTerminatedAssignments — deletes roster_assignments rows for a facility
// where the employee_id is no longer in the latest B2E pull. Called by every
// B2E sync (manual + silent auto-resync). Closes the loop where terminated
// employees previously persisted forever because seedRosterAssignments only
// upserts — it has no DELETE step.
//
// Protections (rows that are preserved):
//   - is_temp = true         → manual temps live independent of B2E
//   - from_facility != null  → incoming loans; the home facility's B2E owns
//                              the active/terminated status of that employee
//
// PROTECTED by manually_edited=true. Fixed 2026-07-07 after Dean reported
// that dragging employees to PTO / specialProject / callin was silently
// resetting to their original shift lane on the next sync (or the nightly
// auto-sync at 5am). Reason: this DELETE was silently RLS-blocked before
// 2026-07-06; after adding the anon_delete_roster policy, its long-standing
// design decision to "ignore manually_edited" started actually destroying
// manager overrides. New policy: managers own manually_edited=true rows,
// full stop. If HR terms someone who has manual callin/PTO/specialProject
// rows, those rows stay until a manager explicitly removes them.
//
// Scope: current plan_date only. For broader cleanup across all future dates
// (catches stale rows on dates the manager hasn't visited+synced), use
// purgeTerminatedAcrossFuture below.
export async function purgeTerminatedAssignments(facility, planDate, currentB2eEmpIds) {
  if (!supabase) return null
  const { data, error: fetchErr } = await supabase
    .from('roster_assignments')
    .select('employee_id')
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
    .is('from_facility', null)
  if (fetchErr) { console.error('purgeTerminatedAssignments fetch:', fetchErr); return fetchErr.message }
  if (!data || !data.length) return null
  const activeSet = new Set((currentB2eEmpIds ?? []).map(String))
  const staleIds = data
    .map(r => String(r.employee_id))
    .filter(id => !activeSet.has(id))
  if (!staleIds.length) return null
  const { error: delErr } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
    .is('from_facility', null)
    .eq('manually_edited', false)
    .in('employee_id', staleIds)
  if (delErr) { console.error('purgeTerminatedAssignments delete:', delErr); return delErr.message }
  return null
}

// purgeTerminatedAcrossFuture — broader-scope cleanup that runs on every B2E
// sync alongside the per-date purgeTerminatedAssignments. Scans ALL future-dated
// rows (>= fromDate) at the facility and deletes any whose employee_id is not
// in the supplied active set.
//
// Why this exists: the per-date purge only cleans the plan_date the manager is
// looking at. Terminated/transferred employees keep rows on every other future
// date until the manager visits each one and clicks Sync from B2E. Dean reported
// hitting this exact pattern — Hykeem/Marquise/Edward had rows scattered across
// 6/24 through 7/27 and only the visited date got cleaned. Cross-facility
// transfers (Chris Turpin KEN→CAL) had the same problem at his old facility.
//
// activeEmpIdSet should come from the B2E master roster (employee_status=Active
// at the facility location), NOT from a per-date schedule query. A person can
// be Active but legitimately off-schedule for some date (weekend, PTO) — purging
// them globally because they don't have a schedule entry today would be a bug.
// Use fetchActiveB2eEmployees in omni.js to get the right set.
//
// Safety: if activeEmpIdSet is empty (Omni outage), the function NO-OPS rather
// than risk wiping a facility's roster on a transient failure.
//
// Same row-level protections as the per-date variant: preserves is_temp=true
// (manual temps), from_facility!=null (incoming loans), and
// manually_edited=true (manager overrides). Post-2026-07-07: the third guard
// is critical. When RLS was silently blocking deletes it was harmless to
// omit; once deletes actually landed, terminated-employee purges were
// destroying manager placements (Dean-reported "reset to original column"
// bug). Managers own manually_edited=true rows even for termed employees;
// they can wipe leftover callin/PTO rows themselves when ready.
export async function purgeTerminatedAcrossFuture(facility, activeEmpIdSet, fromDate) {
  if (!supabase) return null
  if (!activeEmpIdSet || activeEmpIdSet.size === 0) {
    console.warn('purgeTerminatedAcrossFuture skipped: empty activeEmpIdSet')
    return null
  }
  const { data, error: fetchErr } = await supabase
    .from('roster_assignments')
    .select('employee_id')
    .eq('facility', facility)
    .gte('plan_date', fromDate)
    .eq('is_temp', false)
    .is('from_facility', null)
  if (fetchErr) { console.error('purgeTerminatedAcrossFuture fetch:', fetchErr); return fetchErr.message }
  if (!data || !data.length) return null
  const staleIds = [...new Set(
    data.map(r => String(r.employee_id)).filter(id => !activeEmpIdSet.has(id))
  )]
  if (!staleIds.length) return null
  const { error: delErr } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', facility)
    .gte('plan_date', fromDate)
    .eq('is_temp', false)
    .is('from_facility', null)
    .eq('manually_edited', false)
    .in('employee_id', staleIds)
  if (delErr) { console.error('purgeTerminatedAcrossFuture delete:', delErr); return delErr.message }
  return null
}

// seedForwardHorizon — bidirectional reconciliation of roster_assignments
// against B2E truth across the next N plan_dates at a facility.
//
// `b2eRosterByDate`: { [iso_date]: Employee[] } — what B2E actually has
// scheduled for each forward date. Built by fetchB2eRosterForRange in omni.js.
// One Omni roundtrip covers the whole window so this is cheap.
//
// Four things happen, all in parallel:
//   1. INSERT: (employee, date) pair in B2E but missing from Supabase
//      → new row written. Closes the new-hire gap that this function was
//      originally built for.
//   2. DELETE: any Supabase row whose (employee, date) is NOT in B2E for
//      that date → deleted, UNLESS manually_edited=true. Manager overrides
//      (PTO / callin / specialProject placements) persist even on days B2E
//      doesn't have the employee scheduled — that's often the whole point
//      of the override ("John's on PTO Saturday even though he wasn't
//      scheduled"). is_temp/loan rows still preserved.
//      Post-2026-07-07: previously deleted regardless of manually_edited.
//      Was silently blocked by missing RLS DELETE policy so the design flaw
//      never surfaced until 2026-07-06 when the RLS policy was added. Dean
//      reported the resulting reset-to-original-column bug within a day.
//   3. REFRESH: existing rows that ARE in B2E but whose shift_start or
//      shift_hours differ from B2E truth → partial update of shift fields
//      and last_b2e_sync_at. Lane/role/manually_edited preserved. Fixes the
//      "stale shift on manually-moved employee" bug.
//   4. PROTECT: is_temp=true, on_loan_to set, from_facility set rows are
//      NEVER touched.
//
// Policy: B2E always owns shift times and existence-on-date. Managers always
// own lane and role labels. This separates the two concerns cleanly so a
// manager moving an employee to specialProject doesn't freeze their shift
// times forever, and a stale row from a removed off-day can be cleaned up.
//
// Safety: if b2eRosterByDate is empty (Omni outage), the function NO-OPS.
// We never delete on a no-data signal — same defensive posture as
// purgeTerminatedAcrossFuture.
//
// Scope: dates strictly AFTER fromDate, daysForward in count (default 14).
// fromDate itself is not touched — seedRosterAssignments owns that.
export async function seedForwardHorizon(facility, b2eRosterByDate, fromDate, daysForward = 14) {
  if (!supabase) return null
  if (!b2eRosterByDate || Object.keys(b2eRosterByDate).length === 0) {
    // Empty payload could mean Omni outage. Don't reconcile against nothing.
    console.warn('seedForwardHorizon: empty b2eRosterByDate, skipping (likely Omni outage)')
    return null
  }
  // Build the list of forward plan_dates (skip fromDate itself).
  const dates = []
  const base = new Date(fromDate + 'T00:00:00')
  for (let i = 1; i <= daysForward; i++) {
    const d = new Date(base)
    d.setDate(d.getDate() + i)
    dates.push(d.toISOString().slice(0, 10))
  }
  const dateSet = new Set(dates)

  // Build validKeys = the (employee, date) pairs B2E says SHOULD exist.
  // Also stash the employee object per key for the insert path.
  const validKeys = new Set()
  const employeeByKey = new Map()
  for (const [date, employees] of Object.entries(b2eRosterByDate)) {
    if (!dateSet.has(date)) continue
    if (!Array.isArray(employees)) continue
    for (const e of employees) {
      if (!e?.id) continue
      const key = `${e.id}|${date}`
      validKeys.add(key)
      employeeByKey.set(key, { ...e, _date: date })
    }
  }

  // Fetch existing rows in window — shift_start/shift_hours included so we
  // can diff against B2E truth in the refresh path; protection flags included
  // so we can make per-row keep/delete decisions client-side.
  const { data: existing, error: fErr } = await supabase
    .from('roster_assignments')
    .select('employee_id, plan_date, manually_edited, is_temp, from_facility, on_loan_to, shift_start, shift_hours')
    .eq('facility', facility)
    .in('plan_date', dates)
  if (fErr) { console.error('seedForwardHorizon fetch:', fErr); return fErr.message }

  // Walk existing rows: build existingKeys (for insert dedup), refreshRows
  // (matched rows whose shifts diverge from B2E), and deletion candidates.
  const existingKeys = new Set()
  const deleteByDate = {} // plan_date -> [employee_id, ...]
  const refreshRows  = [] // existing-row updates to apply (shift fields only)
  for (const r of (existing ?? [])) {
    const key = `${r.employee_id}|${r.plan_date}`
    existingKeys.add(key)
    if (validKeys.has(key)) {
      // Row exists AND B2E says employee is working this date.
      // Refresh shift_start/shift_hours if they don't match B2E. lane and
      // role are NOT touched — manual lane moves stay sticky.
      const e = employeeByKey.get(key)
      if (e) {
        const dbStart  = r.shift_start == null ? null : Number(r.shift_start)
        const dbHours  = r.shift_hours == null ? null : Number(r.shift_hours)
        const b2eStart = e.shift_start == null ? null : Number(e.shift_start)
        const b2eHours = e.shift_hours == null ? null : Number(e.shift_hours)
        if (dbStart !== b2eStart || dbHours !== b2eHours) {
          refreshRows.push({
            employee_id:   r.employee_id,
            plan_date:     r.plan_date,
            shift_start:   b2eStart,
            shift_hours:   b2eHours,
            employee_name: e.name,
          })
        }
      }
      continue
    }
    // B2E does NOT have this employee scheduled on this date. Off-day row.
    // Delete only if the manager hasn't touched the row. is_temp, loan, and
    // manually_edited=true rows are all preserved.
    if (r.is_temp) continue
    if (r.from_facility !== null) continue
    if (r.on_loan_to) continue
    if (r.manually_edited) continue
    if (!deleteByDate[r.plan_date]) deleteByDate[r.plan_date] = []
    deleteByDate[r.plan_date].push(r.employee_id)
  }

  // Build rows to INSERT: validKeys not already in DB.
  const nowIso = new Date().toISOString()
  const rowsToInsert = []
  for (const key of validKeys) {
    if (existingKeys.has(key)) continue
    const e = employeeByKey.get(key)
    if (!e) continue
    rowsToInsert.push({
      facility:           e.facility ?? facility,
      employee_id:        e.id,
      employee_name:      e.name,
      role:               e.role ?? null,
      lane:               e.default_lane || 'shift1',
      plan_date:          e._date,
      shift_start:        e.shift_start ?? null,
      shift_hours:        e.shift_hours ?? null,
      is_temp:            false,
      from_facility:      null,
      on_loan_to:         null,
      last_b2e_sync_at:   nowIso,
      manually_edited:    false,
      manually_edited_at: null,
    })
  }

  // Run delete (batched per plan_date) + insert + refresh updates in parallel.
  const tasks = []
  for (const [planDate, empIds] of Object.entries(deleteByDate)) {
    if (!empIds.length) continue
    tasks.push(
      supabase
        .from('roster_assignments')
        .delete()
        .eq('facility', facility)
        .eq('plan_date', planDate)
        .in('employee_id', empIds)
        .eq('is_temp', false)
        .is('from_facility', null)
        .is('on_loan_to', null)
        .eq('manually_edited', false)
        .then(({ error }) => { if (error) console.error('seedForwardHorizon delete:', error) })
    )
  }
  if (rowsToInsert.length) {
    tasks.push(
      supabase
        .from('roster_assignments')
        .upsert(rowsToInsert, { onConflict: 'facility,employee_id,plan_date', ignoreDuplicates: true })
        .then(({ error }) => { if (error) console.error('seedForwardHorizon insert:', error) })
    )
  }
  for (const u of refreshRows) {
    tasks.push(
      supabase
        .from('roster_assignments')
        .update({
          shift_start:      u.shift_start,
          shift_hours:      u.shift_hours,
          employee_name:    u.employee_name,
          last_b2e_sync_at: nowIso,
        })
        .eq('facility', facility)
        .eq('employee_id', u.employee_id)
        .eq('plan_date', u.plan_date)
        .then(({ error }) => { if (error) console.error('seedForwardHorizon refresh:', error) })
    )
  }
  await Promise.all(tasks)
  return null
}

export async function deleteAssignment(facility, employeeId, planDate) {
  if (!supabase) return
  const { error } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', facility)
    .eq('employee_id', employeeId)
    .eq('plan_date', planDate)
  if (error) console.error('deleteAssignment:', error)
}

export async function resetAssignmentsForDate(facility, planDate) {
  if (!supabase) return 'Supabase not configured'
  const { error } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
  if (error) { console.error('resetAssignmentsForDate:', error); return error.message }
  return null
}

export async function sendEmployeeOnLoan({ employeeId, employeeName, role, sourceFacility, destFacility, destLane, planDate, shiftStart, shiftHours }) {
  if (!supabase) return 'Supabase not configured'
  const nowIso = new Date().toISOString()
  const { error: srcErr } = await supabase
    .from('roster_assignments')
    .update({ on_loan_to: destFacility, manually_edited: true, manually_edited_at: nowIso })
    .eq('facility', sourceFacility)
    .eq('employee_id', employeeId)
    .eq('plan_date', planDate)
  if (srcErr) { console.error('sendEmployeeOnLoan src:', srcErr); return srcErr.message }
  const { error: dstErr } = await supabase
    .from('roster_assignments')
    .upsert({
      facility:      destFacility,
      employee_id:   employeeId,
      employee_name: employeeName,
      role:          role ?? null,
      lane:          destLane,
      plan_date:     planDate,
      shift_start:   shiftStart ?? null,
      shift_hours:   shiftHours ?? null,
      is_temp:       false,
      from_facility: sourceFacility,
      on_loan_to:    null,
      manually_edited: true,
      manually_edited_at: nowIso,
    }, { onConflict: 'facility,employee_id,plan_date' })
  if (dstErr) { console.error('sendEmployeeOnLoan dst:', dstErr); return dstErr.message }
  return null
}

export async function recallLoan({ employeeId, sourceFacility, destFacility, planDate }) {
  if (!supabase) return 'Supabase not configured'
  const nowIso = new Date().toISOString()
  const { error: srcErr } = await supabase
    .from('roster_assignments')
    .update({ on_loan_to: null, manually_edited: true, manually_edited_at: nowIso })
    .eq('facility', sourceFacility)
    .eq('employee_id', employeeId)
    .eq('plan_date', planDate)
  if (srcErr) { console.error('recallLoan src:', srcErr); return srcErr.message }
  const { error: dstErr } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', destFacility)
    .eq('employee_id', employeeId)
    .eq('plan_date', planDate)
  if (dstErr) { console.error('recallLoan dst:', dstErr); return dstErr.message }
  return null
}

const SETTINGS_DEFAULTS = {
  hours_per_appt: 1.5,
  break_hour_1: 83, break_hour_2: 100, break_hour_3: 75,  break_hour_4: 100,
  break_hour_5: 50, break_hour_6: 100, break_hour_7: 75,  break_hour_8: 100,
}

export async function fetchFacilitySettings(facilityId) {
  if (!supabase) return SETTINGS_DEFAULTS
  const { data, error } = await supabase
    .from('facility_settings')
    .select('*')
    .eq('facility', facilityId)
    .single()
  if (error || !data) return { ...SETTINGS_DEFAULTS, facility: facilityId }
  return data
}

export async function upsertFacilitySettings(facilityId, values) {
  if (!supabase) return
  const { error } = await supabase
    .from('facility_settings')
    .upsert({ facility: facilityId, ...values }, { onConflict: 'facility' })
  if (error) console.error('upsertFacilitySettings:', error)
}

// ─── Project-level Hours-Per-Appointment Overrides ──────────────────────────
// Falls back to facility_settings.hours_per_appt when no row exists for a project.

export async function fetchProjectLaborAssumptions(facility) {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('project_labor_assumptions')
    .select('project_name, hours_per_appt')
    .eq('facility', facility)
  if (error) {
    console.error('fetchProjectLaborAssumptions', error)
    return new Map()
  }
  const map = new Map()
  for (const row of data || []) {
    map.set(row.project_name, Number(row.hours_per_appt))
  }
  return map
}

export async function upsertProjectLaborAssumption(facility, projectName, hoursPerAppt) {
  if (!supabase) return
  const { error } = await supabase
    .from('project_labor_assumptions')
    .upsert(
      {
        facility,
        project_name: projectName,
        hours_per_appt: hoursPerAppt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'facility,project_name', ignoreDuplicates: false }
    )
  if (error) {
    console.error('upsertProjectLaborAssumption', error)
    throw error
  }
}

export async function deleteProjectLaborAssumption(facility, projectName) {
  if (!supabase) return
  const { error } = await supabase
    .from('project_labor_assumptions')
    .delete()
    .eq('facility', facility)
    .eq('project_name', projectName)
  if (error) {
    console.error('deleteProjectLaborAssumption', error)
    throw error
  }
}

// Union of project names known for this facility from DB sources only.
// Code-constant sources (PROJECT_DROP_RULES, KEN_GUARANTEED_PROJECTS) are added
// in the consumer (Settings.jsx) since they live in omni.js.
export async function fetchAllFacilityProjectNames(facility) {
  if (!supabase) return []
  const [dropsRes, customRes] = await Promise.all([
    supabase
      .from('project_hourly_drops_forecast')
      .select('project_name')
      .eq('facility', facility),
    supabase
      .from('facility_custom_drop_projects')
      .select('project_name')
      .eq('facility', facility),
  ])
  if (dropsRes.error) console.warn('fetchAllFacilityProjectNames drops', dropsRes.error)
  if (customRes.error) console.warn('fetchAllFacilityProjectNames custom', customRes.error)
  const names = new Set()
  for (const row of dropsRes.data || []) names.add(row.project_name)
  for (const row of customRes.data || []) names.add(row.project_name)
  return Array.from(names)
}

export async function fetchAllFacilitiesSettings() {
  const defaults = {}
  for (const key of ['cal', 'ken', 'mad', 'wr', 'ec']) {
    defaults[key] = SETTINGS_DEFAULTS.hours_per_appt
  }
  if (!supabase) return defaults
  const { data, error } = await supabase
    .from('facility_settings')
    .select('facility, hours_per_appt')
  if (error || !data) return defaults
  for (const row of data) {
    defaults[row.facility] = Number(row.hours_per_appt) || SETTINGS_DEFAULTS.hours_per_appt
  }
  return defaults
}

export async function fetchEstDrops(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('hourly_drops_forecast')
    .select('hour, est_drops')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  return Object.fromEntries(data.map(r => [r.hour, r.est_drops]))
}

export async function upsertEstDrops(facilityId, planDate, hourlyValues) {
  if (!supabase) return
  const rows = hourlyValues.map(({ h, est }) => ({
    facility:  facilityId,
    plan_date: planDate,
    hour:      h,
    est_drops: est ?? 0,
  }))
  const { error } = await supabase
    .from('hourly_drops_forecast')
    .upsert(rows, { onConflict: 'facility,plan_date,hour' })
  if (error) console.error('upsertEstDrops:', error)
}

export async function fetchProjectDrops(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_drops_forecast')
    .select('project_name, est_drops')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  return Object.fromEntries(data.map(r => [r.project_name, r.est_drops]))
}

export async function upsertProjectDrops(facilityId, planDate, rows) {
  if (!supabase) return
  const records = rows.map(({ project_name, est_drops }) => ({
    facility:     facilityId,
    plan_date:    planDate,
    project_name,
    est_drops:    est_drops ?? 0,
  }))
  const { error } = await supabase
    .from('project_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name' })
  if (error) console.error('upsertProjectDrops:', error)
}

const BREAK_MULS = [0.83, 1.00, 0.75, 1.00, 0.50, 1.00, 0.75, 1.00]

function breakAdjustedHours(rawHours) {
  const h         = rawHours != null ? Number(rawHours) : 8
  const fullHours = Math.floor(h)
  const frac      = h - fullHours
  let total = 0
  for (let i = 0; i < fullHours; i++) {
    total += BREAK_MULS[i] ?? 1
  }
  if (frac > 0) {
    total += frac * (BREAK_MULS[fullHours] ?? 1)
  }
  return total
}

export async function fetchAllFacilitiesLaborCounts(planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('roster_assignments')
    .select('facility, lane, shift_hours, on_loan_to')
    .eq('plan_date', planDate)
    .in('lane', ['shift1', 'mid', 'shift2', 'shift3',
                 'side12_shift1','side12_mid','side12_shift2','side12_shift3',
                 'side35_shift1','side35_mid','side35_shift2','side35_shift3'])
  if (error || !data) return {}
  const result = {}
  for (const r of data) {
    if (r.on_loan_to) continue
    const fac = r.facility
    if (!result[fac]) result[fac] = { headcount: 0, totalHours: 0 }
    result[fac].headcount  += 1
    result[fac].totalHours += breakAdjustedHours(r.shift_hours)
  }
  for (const fac of Object.keys(result)) {
    result[fac].totalHours = Math.round(result[fac].totalHours * 10) / 10
  }
  return result
}

export async function fetchProjectHourlyDrops(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('project_name, hour, est_drops, manually_edited')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  const result = {}
  for (const r of data) {
    if (!result[r.project_name]) result[r.project_name] = {}
    result[r.project_name][r.hour] = { est_drops: Number(r.est_drops), manually_edited: r.manually_edited ?? false }
  }
  return result
}

/**
 * Fetch the entire week's EST drops in a single query, returning a
 * per-day per-project total. Powers the weekly projects table.
 *
 * Shape: { [planDate]: { [projectName]: totalEstDrops } }
 *
 * Single SELECT with date range filter; client-side groups + sums across hours
 * to produce one number per project per day. Returns {} on failure (caller
 * should treat absence as zero so the rest of the table still renders).
 */
export async function fetchWeeklyProjectDrops(facilityId, fromDate, toDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('project_name, plan_date, est_drops')
    .eq('facility', facilityId)
    .gte('plan_date', fromDate)
    .lte('plan_date', toDate)
  if (error) { console.error('fetchWeeklyProjectDrops:', error); return {} }
  const result = {}
  for (const r of (data || [])) {
    const d = r.plan_date
    const n = r.project_name
    if (!result[d]) result[d] = {}
    result[d][n] = (result[d][n] ?? 0) + Number(r.est_drops)
  }
  return result
}

export async function fetchHourlyAdjustments(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('hourly_labor_adjustments')
    .select('hour, adjustment')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  return Object.fromEntries(data.map(r => [r.hour, r.adjustment]))
}

export async function upsertHourlyAdjustment(facilityId, planDate, hour, adjustment) {
  if (!supabase) return
  const { error } = await supabase
    .from('hourly_labor_adjustments')
    .upsert({ facility: facilityId, plan_date: planDate, hour, adjustment },
            { onConflict: 'facility,plan_date,hour' })
  if (error) console.error('upsertHourlyAdjustment:', error)
}

export async function fetchAllFacilitiesEstDrops(planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('facility, est_drops')
    .eq('plan_date', planDate)
  if (error || !data) return {}
  const result = {}
  for (const r of data) {
    result[r.facility] = (result[r.facility] ?? 0) + Number(r.est_drops)
  }
  return result
}

export async function upsertProjectHourlyDrops(facilityId, planDate, rows) {
  if (!supabase) return
  const records = rows.map(({ project_name, h, est_drops }) => ({
    facility:        facilityId,
    plan_date:       planDate,
    project_name,
    hour:            h,
    est_drops:       est_drops ?? 0,
    manually_edited: true,
  }))
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name,hour' })
  if (error) console.error('upsertProjectHourlyDrops:', error)
}

export async function upsertProjectHourlyDropsSeed(facilityId, planDate, rows) {
  if (!supabase || !rows.length) return
  const records = rows.map(({ project_name, h, est_drops }) => ({
    facility:        facilityId,
    plan_date:       planDate,
    project_name,
    hour:            h,
    est_drops:       est_drops ?? 0,
    manually_edited: false,
  }))
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name,hour', ignoreDuplicates: false })
  if (error) console.error('upsertProjectHourlyDropsSeed:', error)
}

export async function deleteProjectHourlyDropsForProject(facilityId, planDate, projectName) {
  if (!supabase) return
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .delete()
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
    .eq('project_name', projectName)
  if (error) console.error('deleteProjectHourlyDropsForProject:', error)
}

export async function deleteOrphanSeedRows(facilityId, planDate, validKeys) {
  if (!supabase) return
  const validSet = new Set(validKeys)
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('project_name, hour')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
    .eq('manually_edited', false)
  if (error) { console.error('deleteOrphanSeedRows fetch:', error); return }
  if (!data || !data.length) return
  const orphans = data.filter(r => !validSet.has(`${r.project_name}|${r.hour}`))
  if (!orphans.length) return
  const byProject = {}
  for (const r of orphans) {
    if (!byProject[r.project_name]) byProject[r.project_name] = []
    byProject[r.project_name].push(r.hour)
  }
  for (const [project_name, hours] of Object.entries(byProject)) {
    const { error: delErr } = await supabase
      .from('project_hourly_drops_forecast')
      .delete()
      .eq('facility', facilityId)
      .eq('plan_date', planDate)
      .eq('project_name', project_name)
      .eq('manually_edited', false)
      .in('hour', hours)
    if (delErr) console.error('deleteOrphanSeedRows delete:', delErr)
  }
}

export async function clearExpiredManualEdits(facilityId, beforeDate) {
  if (!supabase) return
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .delete()
    .eq('facility', facilityId)
    .eq('manually_edited', true)
    .lt('plan_date', beforeDate)
  if (error) console.error('clearExpiredManualEdits:', error)
}

export async function fetchCustomDropProjects(facilityId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('facility_custom_drop_projects')
    .select('id, facility, project_name, omni_name')
    .eq('facility', facilityId)
    .order('project_name')
  if (error) { console.error('fetchCustomDropProjects:', error); return [] }
  return data ?? []
}

export async function addCustomDropProject(facilityId, projectName, omniName) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('facility_custom_drop_projects')
    .insert({ facility: facilityId, project_name: projectName.trim(), omni_name: omniName.trim() })
    .select()
    .single()
  if (error) { console.error('addCustomDropProject:', error); return null }
  return data
}

export async function deleteCustomDropProject(id) {
  if (!supabase) return
  const { error } = await supabase
    .from('facility_custom_drop_projects')
    .delete()
    .eq('id', id)
  if (error) console.error('deleteCustomDropProject:', error)
}

// ─── Historical EST Drops Cache ────────────────────────────────────────────

export async function fetchHistoricalDropsCache(facilityId, planDate, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('est_drops_historical_cache')
    .select('project_name, hour, est_drops, computed_at')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error) { console.error('fetchHistoricalDropsCache:', error); return null }
  if (!data || data.length === 0) return null
  let newest = 0
  for (const r of data) {
    const ts = new Date(r.computed_at).getTime()
    if (ts > newest) newest = ts
  }
  if (Date.now() - newest > maxAgeMs) return null
  const result = {}
  for (const r of data) {
    if (!result[r.project_name]) result[r.project_name] = {}
    result[r.project_name][r.hour] = Number(r.est_drops)
  }
  return result
}

export async function writeHistoricalDropsCache(facilityId, planDate, historicalDrops) {
  if (!supabase) return
  const { error: delErr } = await supabase
    .from('est_drops_historical_cache')
    .delete()
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (delErr) { console.error('writeHistoricalDropsCache delete:', delErr); return }
  const rows = []
  const computedAt = new Date().toISOString()
  for (const [project_name, hourMap] of Object.entries(historicalDrops || {})) {
    for (const [h, est_drops] of Object.entries(hourMap)) {
      rows.push({ facility: facilityId, plan_date: planDate, project_name, hour: Number(h), est_drops: Number(est_drops) || 0, computed_at: computedAt })
    }
  }
  if (!rows.length) return
  const { error: insErr } = await supabase
    .from('est_drops_historical_cache')
    .insert(rows)
  if (insErr) console.error('writeHistoricalDropsCache insert:', insErr)
}

export async function invalidateHistoricalDropsCache(facilityId, planDate) {
  if (!supabase) return
  const { error } = await supabase
    .from('est_drops_historical_cache')
    .delete()
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error) console.error('invalidateHistoricalDropsCache:', error)
}

// ─── WR Pick Schedule ─────────────────────────────────────────────────────

export async function fetchPickSchedule() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('wr_pick_schedule')
    .select('*')
    .order('day_of_week')
    .order('pick_seq')
  if (error) { console.error('fetchPickSchedule:', error); return [] }
  return data ?? []
}

export async function upsertPickScheduleRow(row) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('wr_pick_schedule')
    .upsert(row, { onConflict: 'day_of_week,route_number' })
    .select()
    .single()
  if (error) { console.error('upsertPickScheduleRow:', error); return null }
  return data
}

export async function insertPickScheduleRow(row) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('wr_pick_schedule')
    .insert(row)
    .select()
    .single()
  if (error) { console.error('insertPickScheduleRow:', error); return null }
  return data
}

export async function deletePickScheduleRow(id) {
  if (!supabase) return
  const { error } = await supabase
    .from('wr_pick_schedule')
    .delete()
    .eq('id', id)
  if (error) console.error('deletePickScheduleRow:', error)
}

// ─── WR Picker Assignments (job code 206) ───────────────────────────────────

export async function fetchPickerAssignments() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('wr_picker_assignments')
    .select('*')
    .order('employee_name')
  if (error) { console.error('fetchPickerAssignments:', error); return [] }
  return data ?? []
}

export async function upsertPickerAssignment(employeeId, employeeName, zone) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('wr_picker_assignments')
    .upsert(
      { employee_id: employeeId, employee_name: employeeName, zone, updated_at: new Date().toISOString() },
      { onConflict: 'employee_id' }
    )
    .select()
    .single()
  if (error) { console.error('upsertPickerAssignment:', error); return null }
  return data
}

export async function deletePickerAssignment(employeeId) {
  if (!supabase) return
  const { error } = await supabase
    .from('wr_picker_assignments')
    .delete()
    .eq('employee_id', employeeId)
  if (error) console.error('deletePickerAssignment:', error)
}

// ─── Roster staleness / auto-sync helpers ─────────────────────────────────

export async function checkRosterStaleness(facility, planDate, staleHours = 24) {
  if (!supabase) return false
  const { data, error } = await supabase
    .from('roster_assignments')
    .select('last_b2e_sync_at')
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
    .not('last_b2e_sync_at', 'is', null)
    .limit(1)
  if (error || !data || data.length === 0) return true
  const syncedAt = new Date(data[0].last_b2e_sync_at).getTime()
  return Date.now() - syncedAt > staleHours * 60 * 60 * 1000
}

export async function markRosterRowsAsSynced(facility, planDate, syncedEmployeeIds = null) {
  if (!supabase) return
  let query = supabase
    .from('roster_assignments')
    .update({ last_b2e_sync_at: new Date().toISOString() })
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
  if (syncedEmployeeIds && syncedEmployeeIds.length > 0) {
    query = query.in('employee_id', syncedEmployeeIds)
  }
  const { error } = await query
  if (error) console.error('markRosterRowsAsSynced:', error)
}

// ─── Inventory Discrepancies ───────────────────────────────────────────────
//
// Persists flagged location discrepancies from the Inventory tab to Supabase
// so they survive page refreshes and accumulate across a full count session.
// Each row is keyed on (facility, location_id) with a 24h expiry.

export async function fetchInventoryDiscrepancies(facilityId) {
  if (!supabase) return new Map()
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('inventory_discrepancies')
    .select('location_id, flag_data')
    .eq('facility', facilityId)
    .gt('expires_at', now)
  if (error) { console.error('fetchInventoryDiscrepancies:', error); return new Map() }
  return new Map((data ?? []).map(r => [r.location_id, r.flag_data]))
}

export async function upsertInventoryDiscrepancy(facilityId, locationId, flagData) {
  if (!supabase) return
  const now = new Date()
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const { error } = await supabase
    .from('inventory_discrepancies')
    .upsert(
      { facility: facilityId, location_id: locationId, flag_data: flagData, flagged_at: now.toISOString(), expires_at: expires },
      { onConflict: 'facility,location_id' }
    )
  if (error) console.error('upsertInventoryDiscrepancy:', error)
}

export async function deleteInventoryDiscrepancy(facilityId, locationId) {
  if (!supabase) return
  const { error } = await supabase
    .from('inventory_discrepancies')
    .delete()
    .eq('facility', facilityId)
    .eq('location_id', locationId)
  if (error) console.error('deleteInventoryDiscrepancy:', error)
}

export async function purgeExpiredInventoryDiscrepancies() {
  if (!supabase) return
  const { error } = await supabase
    .from('inventory_discrepancies')
    .delete()
    .lt('expires_at', new Date().toISOString())
  if (error) console.error('purgeExpiredInventoryDiscrepancies:', error)
}

// ─── Employee Break Schedule Overrides ──────────────────────────────────────
// Per-employee clock-time break schedule. When a row exists, it replaces the
// facility's BREAK_DEFAULTS multipliers for that employee in labor calc.
// All three break times are REQUIRED (NOT NULL in DB) — atomic override.

export async function fetchEmployeeBreaks(facility) {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('employee_breaks')
    .select('*')
    .eq('facility', facility)
  if (error) {
    console.error('fetchEmployeeBreaks:', error)
    return new Map()
  }
  const map = new Map()
  for (const row of data || []) {
    map.set(String(row.employee_id), {
      facility:              row.facility,
      first_break_at:        Number(row.first_break_at),
      first_break_minutes:   Number(row.first_break_minutes),
      lunch_at:              Number(row.lunch_at),
      lunch_minutes:         Number(row.lunch_minutes),
      second_break_at:       Number(row.second_break_at),
      second_break_minutes:  Number(row.second_break_minutes),
    })
  }
  return map
}

export async function upsertEmployeeBreak({ employeeId, facility, firstBreakAt, firstBreakMinutes, lunchAt, lunchMinutes, secondBreakAt, secondBreakMinutes }) {
  if (!supabase) return
  const { error } = await supabase
    .from('employee_breaks')
    .upsert({
      employee_id:           String(employeeId),
      facility,
      first_break_at:        firstBreakAt,
      first_break_minutes:   firstBreakMinutes,
      lunch_at:              lunchAt,
      lunch_minutes:         lunchMinutes,
      second_break_at:       secondBreakAt,
      second_break_minutes:  secondBreakMinutes,
      updated_at:            new Date().toISOString(),
    }, { onConflict: 'employee_id', ignoreDuplicates: false })
  if (error) {
    console.error('upsertEmployeeBreak:', error)
    throw error
  }
}

export async function deleteEmployeeBreak(employeeId) {
  if (!supabase) return
  const { error } = await supabase
    .from('employee_breaks')
    .delete()
    .eq('employee_id', String(employeeId))
  if (error) {
    console.error('deleteEmployeeBreak:', error)
    throw error
  }
}


// ─── WR Pickline Snapshot (persisted across refreshes/devices) ────────────
//
// Before this section existed, PicklinePanel's snapshot + hour overrides lived
// only in FacilityPanel React state — refresh wiped them, and opening the app
// on another computer showed the upload screen and required a fresh Pull from
// Omni (which returned different data than the original pull if orders had
// changed in Datex since). Now the initial Pull-from-Omni or Excel-upload is
// written to Supabase, all subsequent loads read the persisted snapshot, and
// only an explicit re-pull or "Load new file" click replaces it.
//
// Table: pickline_snapshots(facility, plan_date, snapshot jsonb, hour_overrides
// jsonb, source, pulled_at, updated_at). One row per WR day.

export async function fetchPicklineSnapshot(facility, planDate) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('pickline_snapshots')
    .select('snapshot, hour_overrides, source, pulled_at, updated_at')
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .maybeSingle()
  if (error) { console.error('fetchPicklineSnapshot:', error); return null }
  if (!data) return null
  return {
    snapshot:      data.snapshot ?? null,
    hourOverrides: data.hour_overrides ?? {},
    source:        data.source ?? null,
    pulledAt:      data.pulled_at ?? null,
    updatedAt:     data.updated_at ?? null,
  }
}

// upsertPicklineSnapshot — full replace. Called when Pull from Omni or Excel
// upload produces a new brief. hour_overrides is reset to {} because the new
// snapshot invalidates any prior manual per-hour tweaks (they were tied to
// specific route case counts that just changed).
export async function upsertPicklineSnapshot(facility, planDate, snapshot, source) {
  if (!supabase) return
  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from('pickline_snapshots')
    .upsert({
      facility,
      plan_date:      planDate,
      snapshot,
      hour_overrides: {},
      source:         source ?? (snapshot?.source ?? null),
      pulled_at:      nowIso,
      updated_at:     nowIso,
    }, { onConflict: 'facility,plan_date' })
  if (error) console.error('upsertPicklineSnapshot:', error)
}

// updatePicklineOverrides — hour_overrides only. Fires on every +/- click in
// the PickTable, so it's cheap: single-row update, no snapshot rewrite. If
// no snapshot exists (e.g. race with clear), the update no-ops silently since
// there's nothing to attach overrides to.
export async function updatePicklineOverrides(facility, planDate, hourOverrides) {
  if (!supabase) return
  const { error } = await supabase
    .from('pickline_snapshots')
    .update({ hour_overrides: hourOverrides ?? {}, updated_at: new Date().toISOString() })
    .eq('facility', facility)
    .eq('plan_date', planDate)
  if (error) console.error('updatePicklineOverrides:', error)
}

export async function deletePicklineSnapshot(facility, planDate) {
  if (!supabase) return
  const { error } = await supabase
    .from('pickline_snapshots')
    .delete()
    .eq('facility', facility)
    .eq('plan_date', planDate)
  if (error) console.error('deletePicklineSnapshot:', error)
}
// ─── PVI Shelf Life ─────────────────────────────────────────────────────────
//
// Three tables back the PVI Shelf Life feature (Palermo's expiration
// predictor):
//   pvi_canonical_accounts    — Costco/Walmart/Target/etc + shelf-life days.
//                               account_type = 'end_customer' | 'internal_transfer'.
//                               override_days is nullable; when null, the UI
//                               shows derived_days from shipment history.
//   pvi_account_name_map      — raw Datex ship-to names → canonical_id.
//                               Multiple raw names (e.g. "COSTCO Atlanta",
//                               "COSTCO Mira Loma") fold into one canonical.
//   pvi_shelf_notes           — free-text notes + status tag per lot. Shared
//                               across users. No auth — author is free-text.
//
// The Settings tab uses these five helpers plus applyPviAccountSeed to bulk-
// insert reviewed suggestions from the derive Netlify function.

export async function fetchPviCanonicalAccounts() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('pvi_canonical_accounts')
    .select('*')
    .order('canonical_name')
  if (error) { console.error('fetchPviCanonicalAccounts:', error); return [] }
  return data ?? []
}

export async function upsertPviCanonicalAccount({ id, canonical_name, account_type, override_days }) {
  if (!supabase) return null
  const payload = {
    canonical_name: (canonical_name || '').trim(),
    account_type:   account_type === 'internal_transfer' ? 'internal_transfer' : 'end_customer',
    override_days:  override_days == null || override_days === '' ? null : Number(override_days),
  }
  if (!payload.canonical_name) throw new Error('canonical_name required')
  let q
  if (id) {
    q = supabase.from('pvi_canonical_accounts').update(payload).eq('id', id).select().single()
  } else {
    q = supabase.from('pvi_canonical_accounts').insert(payload).select().single()
  }
  const { data, error } = await q
  if (error) { console.error('upsertPviCanonicalAccount:', error); throw error }
  return data
}

export async function deletePviCanonicalAccount(id) {
  if (!supabase) return
  // CASCADE on pvi_account_name_map handles the raw-name rows.
  const { error } = await supabase.from('pvi_canonical_accounts').delete().eq('id', id)
  if (error) { console.error('deletePviCanonicalAccount:', error); throw error }
}

export async function fetchPviAccountNameMap() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('pvi_account_name_map')
    .select('id, raw_account_name, canonical_id')
    .order('raw_account_name')
  if (error) { console.error('fetchPviAccountNameMap:', error); return [] }
  return data ?? []
}

export async function upsertPviAccountNameMap({ id, raw_account_name, canonical_id }) {
  if (!supabase) return null
  const payload = {
    raw_account_name: (raw_account_name || '').trim(),
    canonical_id:     Number(canonical_id),
  }
  if (!payload.raw_account_name) throw new Error('raw_account_name required')
  if (!payload.canonical_id) throw new Error('canonical_id required')
  let q
  if (id) {
    q = supabase.from('pvi_account_name_map').update(payload).eq('id', id).select().single()
  } else {
    // ON CONFLICT (raw_account_name) — user re-mapping an existing raw name
    // updates the existing row instead of erroring on the UNIQUE constraint.
    q = supabase.from('pvi_account_name_map')
      .upsert(payload, { onConflict: 'raw_account_name', ignoreDuplicates: false })
      .select().single()
  }
  const { data, error } = await q
  if (error) { console.error('upsertPviAccountNameMap:', error); throw error }
  return data
}

export async function deletePviAccountNameMap(id) {
  if (!supabase) return
  const { error } = await supabase.from('pvi_account_name_map').delete().eq('id', id)
  if (error) { console.error('deletePviAccountNameMap:', error); throw error }
}

// applyPviAccountSeed — bulk-insert the reviewed suggestion set from the
// pvi-derive-accounts Netlify function. Each suggestion is a canonical +
// its raw-name mappings. Uses upsert on canonical_name so re-running the
// seed after adjustments doesn't duplicate rows; existing canonicals get
// their account_type/override_days updated, and new raw-names get added
// without touching existing mappings.
export async function applyPviAccountSeed(suggestions) {
  if (!supabase) return { canonicals: 0, mappings: 0 }
  let canonicalCount = 0
  let mappingCount = 0
  for (const s of (suggestions ?? [])) {
    if (!s?.canonical_name) continue
    const canonPayload = {
      canonical_name: s.canonical_name.trim(),
      account_type:   s.account_type === 'internal_transfer' ? 'internal_transfer' : 'end_customer',
      override_days:  s.override_days == null || s.override_days === '' ? null : Number(s.override_days),
    }
    const { data: canonRow, error: canonErr } = await supabase
      .from('pvi_canonical_accounts')
      .upsert(canonPayload, { onConflict: 'canonical_name', ignoreDuplicates: false })
      .select()
      .single()
    if (canonErr) { console.error('applyPviAccountSeed canonical:', canonErr); continue }
    canonicalCount += 1
    const rawNames = (s.raw_names ?? [])
      .map(n => (n || '').trim())
      .filter(Boolean)
    if (!rawNames.length) continue
    const mapPayload = rawNames.map(n => ({
      raw_account_name: n,
      canonical_id:     canonRow.id,
    }))
    const { error: mapErr } = await supabase
      .from('pvi_account_name_map')
      .upsert(mapPayload, { onConflict: 'raw_account_name', ignoreDuplicates: false })
    if (mapErr) { console.error('applyPviAccountSeed mappings:', mapErr); continue }
    mappingCount += rawNames.length
  }
  return { canonicals: canonicalCount, mappings: mappingCount }
}

// fetchPviShelfNotes — fetches note rows.
//
// Fixed 2026-07-07 (Hill): this previously REQUIRED a non-empty
// itemLotPairs array and returned [] otherwise. Every call site in
// PviShelfLife.jsx calls it with NO arguments (fetchPviShelfNotes()),
// so the notes drawer was silently always empty — including the 113
// Palermo's + 42 CSW comments already ingested into pvi_shelf_notes
// from the 7/6 workbook. Now: no argument (or empty array) fetches ALL
// notes, matching the same pattern already used by
// fetchPviLotDispositions. Filtering by item/lot still works if a
// caller ever wants a scoped query — it's just no longer required.
export async function fetchPviShelfNotes(itemLotPairs) {
  if (!supabase) return []
  let query = supabase
    .from('pvi_shelf_notes')
    .select('*')
    .order('created_at', { ascending: false })
  if (itemLotPairs && itemLotPairs.length) {
    const items = [...new Set(itemLotPairs.map(p => p.item))]
    const lots  = [...new Set(itemLotPairs.map(p => p.lot_code))]
    query = query.in('item', items).in('lot_code', lots)
  }
  const { data, error } = await query
  if (error) { console.error('fetchPviShelfNotes:', error); return [] }
  return data ?? []
}

export async function insertPviShelfNote({ item, lot_code, note, status, author }) {
  if (!supabase) return null
  const payload = {
    item:     (item || '').trim(),
    lot_code: (lot_code || '').trim(),
    note:     (note || '').trim(),
    status:   status || 'open',
    author:   (author || '').trim() || null,
  }
  if (!payload.item || !payload.lot_code || !payload.note) throw new Error('item, lot_code, note required')
  const { data, error } = await supabase
    .from('pvi_shelf_notes')
    .insert(payload)
    .select()
    .single()
  if (error) { console.error('insertPviShelfNote:', error); throw error }
  return data
}

export async function updatePviShelfNoteStatus(id, status) {
  if (!supabase) return
  const { error } = await supabase
    .from('pvi_shelf_notes')
    .update({ status })
    .eq('id', id)
  if (error) { console.error('updatePviShelfNoteStatus:', error); throw error }
}

export async function deletePviShelfNote(id) {
  if (!supabase) return
  const { error } = await supabase.from('pvi_shelf_notes').delete().eq('id', id)
  if (error) { console.error('deletePviShelfNote:', error); throw error }
}

// ─── PVI Material Specs (per-material shelf-life ops overrides) ────────────
//
// pvi_material_specs — one row per PVI material. Ops-curated shelf-life-days
// requirement. Wins over allocation and history in the engine's spec priority
// (see src/lib/pviShelfLife.js). Seeded 2026-07-06 from 365-day history via
// the strictest-mapped-customer across each material's recipients; per-row
// edits from the Settings UI mark spec_source='ops_edited'.
//
// Schema: material_id (PK), material_code, material_desc,
//         shelf_life_days_required INT > 0, spec_source, notes,
//         updated_at, updated_by.

export async function fetchPviMaterialSpecs() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('pvi_material_specs')
    .select('*')
    .order('material_code')
  if (error) { console.error('fetchPviMaterialSpecs:', error); return [] }
  return data ?? []
}

export async function upsertPviMaterialSpec({ material_id, material_code, material_desc, shelf_life_days_required, notes, updated_by }) {
  if (!supabase) return null
  const payload = {
    material_id:              Number(material_id),
    material_code:            String(material_code || '').trim(),
    material_desc:            (material_desc || '').trim() || null,
    shelf_life_days_required: Number(shelf_life_days_required),
    spec_source:              'ops_edited',
    notes:                    (notes || '').trim() || null,
    updated_by:               (updated_by || '').trim() || null,
    updated_at:               new Date().toISOString(),
  }
  if (!Number.isFinite(payload.material_id) || payload.material_id <= 0) {
    throw new Error('material_id required')
  }
  if (!payload.material_code) throw new Error('material_code required')
  if (!Number.isFinite(payload.shelf_life_days_required) || payload.shelf_life_days_required <= 0) {
    throw new Error('shelf_life_days_required must be a positive number')
  }
  const { data, error } = await supabase
    .from('pvi_material_specs')
    .upsert(payload, { onConflict: 'material_id', ignoreDuplicates: false })
    .select()
    .single()
  if (error) { console.error('upsertPviMaterialSpec:', error); throw error }
  return data
}

export async function deletePviMaterialSpec(materialId) {
  if (!supabase) return
  const { error } = await supabase
    .from('pvi_material_specs')
    .delete()
    .eq('material_id', Number(materialId))
  if (error) { console.error('deletePviMaterialSpec:', error); throw error }
}

// ─── PVI Lot Dispositions (per-lot Tag + Owner) ─────────────────────────────
//
// pvi_lot_dispositions — one row per (material_code, lot_code) tracking
// Hill's disposition Tag + Owner (Palermo's team member). Formalizes what
// they currently track in a bi-weekly Excel workbook. Disposition sticks
// with the lot until explicitly changed. RLS: all four CRUD policies open
// to anon (learned the hard way that missing DELETE policy silently
// turns delete queries into no-ops).
//
// Schema (see migration create_pvi_lot_dispositions):
//   material_code TEXT NOT NULL
//   lot_code      TEXT NOT NULL
//   disposition   TEXT  (one of DISPOSITION_OPTIONS or NULL)
//   owner         TEXT  (free text — no master list)
//   updated_at    TIMESTAMPTZ
//   updated_by    TEXT
//   PRIMARY KEY (material_code, lot_code)

export async function fetchPviLotDispositions() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('pvi_lot_dispositions')
    .select('*')
  if (error) { console.error('fetchPviLotDispositions:', error); return [] }
  return data ?? []
}

// upsertPviLotDisposition — writes/updates the disposition + owner for a
// specific lot. Pass empty string / null to clear individual fields; pass
// nulls for both and the row still exists (use deletePviLotDisposition to
// wipe entirely). updated_at is refreshed on every write; updated_by is
// captured for audit.
export async function upsertPviLotDisposition({ material_code, lot_code, disposition, owner, updated_by }) {
  if (!supabase) return null
  const payload = {
    material_code: String(material_code || '').trim(),
    lot_code:      String(lot_code || '').trim(),
    disposition:   (disposition == null || disposition === '') ? null : String(disposition).trim(),
    owner:         (owner == null || owner === '') ? null : String(owner).trim(),
    updated_by:    (updated_by || '').trim() || null,
    updated_at:    new Date().toISOString(),
  }
  if (!payload.material_code) throw new Error('material_code required')
  if (!payload.lot_code) throw new Error('lot_code required')
  const { data, error } = await supabase
    .from('pvi_lot_dispositions')
    .upsert(payload, { onConflict: 'material_code,lot_code', ignoreDuplicates: false })
    .select()
    .single()
  if (error) { console.error('upsertPviLotDisposition:', error); throw error }
  return data
}

export async function deletePviLotDisposition(material_code, lot_code) {
  if (!supabase) return
  const { error } = await supabase
    .from('pvi_lot_dispositions')
    .delete()
    .eq('material_code', String(material_code))
    .eq('lot_code', String(lot_code))
  if (error) { console.error('deletePviLotDisposition:', error); throw error }
}

// ─── Notification Recipients (Front email / discussion notifications) ─────
//
// Generic recipient list backing outbound notifications sent via Front
// (email digests via front-send-email.cjs, and later @mention-based internal
// discussions via a future front-post-discussion.cjs). One table serves
// multiple features via list_name scoping (e.g. 'fefo_ken_digest',
// 'onboarding_ken') instead of a separate table per feature.
//
// front_teammate_id is nullable — only populated for people with a Front
// seat, which is required to @mention them in a discussion (internal-only,
// per Front's API — comments never leave Front and have no concept of an
// external recipient). Email-only rows (including external contacts like
// Palermo's) just need `email` populated and work fine with
// front-send-email.cjs regardless of this field.

export async function fetchNotificationRecipients(listName) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notification_recipients')
    .select('*')
    .eq('list_name', listName)
    .eq('active', true)
    .order('name')
  if (error) { console.error('fetchNotificationRecipients:', error); return [] }
  return data ?? []
}

// ─── Daily Front Discussions (per-facility automated check-in threads) ────
//
// front_daily_discussion_configs — one row per facility. active=true means
// front-daily-discussion-run.cjs (scheduled nightly at 23:00 UTC / 6pm CDT)
// creates a new Front discussion for the NEXT calendar day, named
// "{display_name} {Weekday} {M/D}". Seeded 2026-07-09 with ken + cal active,
// mad/wr/ec present but inactive — flip the toggle in Settings once a
// facility's recipient list is populated.
//
// Recipients reuse the existing notification_recipients table via the
// established list_name-scoping convention (list_name = 'daily_discussion_'
// + facility) instead of a new join table. front_teammate_id must be set —
// resolved from the front_teammates table (synced nightly from Front) —
// since Front discussions can only add real teammate IDs, not raw emails.

export async function fetchDailyDiscussionConfigs() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('front_daily_discussion_configs')
    .select('*')
    .order('facility')
  if (error) { console.error('fetchDailyDiscussionConfigs:', error); return [] }
  return data ?? []
}

export async function upsertDailyDiscussionConfigActive(facility, active) {
  if (!supabase) return
  const { error } = await supabase
    .from('front_daily_discussion_configs')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('facility', facility)
  if (error) console.error('upsertDailyDiscussionConfigActive:', error)
}

// front_teammates is synced nightly from Front (front-teammates-nightly-sync.cjs).
// Filters out rows with no email since notification_recipients.email is NOT NULL
// and is the upsert conflict target.
export async function fetchFrontTeammates() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('front_teammates')
    .select('teammate_id, email, username, first_name, last_name')
    .order('first_name')
  if (error) { console.error('fetchFrontTeammates:', error); return [] }
  return (data ?? []).filter(t => t.email)
}

export async function fetchDiscussionRecipients(facility) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notification_recipients')
    .select('*')
    .eq('list_name', `daily_discussion_${facility}`)
    .order('name')
  if (error) { console.error('fetchDiscussionRecipients:', error); return [] }
  return data ?? []
}

// saveDiscussionRecipients — full replace-set for one facility's list.
// Upserts every chosen teammate (onConflict list_name+email, matching the
// table's unique constraint), then deletes any existing row for this
// list_name whose email isn't in the new selection. Two-step rather than
// delete-then-insert so a failed upsert never leaves the list empty.
export async function saveDiscussionRecipients(facility, chosenTeammates) {
  if (!supabase) return
  const listName = `daily_discussion_${facility}`
  const rows = (chosenTeammates ?? []).map(t => ({
    list_name: listName,
    name: [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email,
    email: t.email,
    front_teammate_id: t.teammate_id,
    active: true,
    updated_at: new Date().toISOString(),
  }))
  if (rows.length) {
    const { error: upErr } = await supabase
      .from('notification_recipients')
      .upsert(rows, { onConflict: 'list_name,email', ignoreDuplicates: false })
    if (upErr) { console.error('saveDiscussionRecipients upsert:', upErr); throw upErr }
  }
  const { data: existing, error: fetchErr } = await supabase
    .from('notification_recipients')
    .select('id, email')
    .eq('list_name', listName)
  if (fetchErr) { console.error('saveDiscussionRecipients fetch:', fetchErr); throw fetchErr }
  const keepEmails = new Set(rows.map(r => r.email))
  const removeIds = (existing ?? []).filter(r => !keepEmails.has(r.email)).map(r => r.id)
  if (removeIds.length) {
    const { error: delErr } = await supabase
      .from('notification_recipients')
      .delete()
      .in('id', removeIds)
    if (delErr) { console.error('saveDiscussionRecipients delete:', delErr); throw delErr }
  }
}

// triggerDailyDiscussionTest — calls the scheduled function's manual-test
// path (single facility, no secret required — see front-daily-discussion-run.cjs
// top comment for why that's safe: recipients and content are always
// server-resolved, the client can only pick which already-configured
// facility fires).
export async function triggerDailyDiscussionTest(facility) {
  const res = await fetch('/.netlify/functions/front-daily-discussion-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}

// ─── Digest notify settings (Pre-Pick Status + Cases To Pick) ──────────────
//
// prepick_notify_settings — one row per (facility, dashboard_type). Stores
// which Front conversation the nightly digest posts a summary COMMENT to,
// plus the configurable send time. Originally Madison-only
// (facility='mad', implicit dashboard_type via column default 'prepick');
// extended 2026-07-14 to a composite key so the same table backs WR's
// Cases To Pick digest too (facility='wr', dashboard_type='cases_to_pick').
//
// notify_hour/notify_minute (0-23 / 0-59, interpreted as America/Chicago
// local time) replace what used to be a fixed cron time — see
// prepick-digest-run.cjs's file header for why the schedule check moved
// inside the function instead of netlify.toml. `active` lets a digest be
// paused without clearing its conversation ID or configured time.
// `notify_days` (SMALLINT[], ISO weekday numbers 1=Mon..7=Sun, added
// 2026-07-14, default Mon-Fri) restricts which content-date weekdays the
// digest fires for — see prepick-digest-run.cjs's "Weekday filter" note
// for why this checks the day being summarized, not the day the digest
// actually sends on. `skip_to_next_valid_day` (boolean, default false,
// added 2026-07-14 later same day) opts a facility into looking ahead to
// the next configured day instead of skipping when the content date isn't
// valid — e.g. a Mon-Fri facility's Friday-night run sends Monday's
// numbers instead of nothing. Off by default; per-row so 7-day-a-week
// facilities are unaffected. See prepick-digest-run.cjs's
// "Skip-to-next-valid-day lookahead" note for the full mechanism.

export async function fetchNotifySettings(facility, dashboardType) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('prepick_notify_settings')
    .select('front_conversation_id, notify_hour, notify_minute, notify_days, active, skip_to_next_valid_day')
    .eq('facility', facility)
    .eq('dashboard_type', dashboardType)
    .maybeSingle()
  if (error) { console.error('fetchNotifySettings:', error); return null }
  return data
}

export async function upsertNotifySettings(facility, dashboardType, { frontConversationId, notifyHour, notifyMinute, notifyDays, active, skipToNextValidDay }) {
  if (!supabase) return
  const { error } = await supabase
    .from('prepick_notify_settings')
    .upsert(
      {
        facility, dashboard_type: dashboardType,
        front_conversation_id: frontConversationId,
        notify_hour: notifyHour, notify_minute: notifyMinute, notify_days: notifyDays, active,
        skip_to_next_valid_day: skipToNextValidDay,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'facility,dashboard_type' }
    )
  if (error) { console.error('upsertNotifySettings:', error); throw error }
}

// triggerDigestTest — calls a digest function's manual-test path (always
// targets tomorrow's date — see the function's own header for why this is
// safe to leave open, same reasoning as triggerDailyDiscussionTest above).
// functionName is 'prepick-digest-run' or 'wr-cases-digest-run'.
export async function triggerDigestTest(functionName) {
  const res = await fetch(`/.netlify/functions/${functionName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}
