'use strict'

// Read-only balances + new-threshold-crossing flag endpoint for the HR
// tab's Attendance Points sub-tab. Added 2026-08-02. Does NOT post to
// Front or write attendance_points_actions — that only happens via
// attendance-points-digest-run.cjs / attendance-points-digest-test.cjs.
// This is purely what renders the on-screen balances table.

const {
  FACILITY_LOCATION, THRESHOLDS, CATEGORY_BY_POINTS,
  sbFetch, queryPointsBalance, queryLatestTransactions,
} = require('./lib/attendance-points-shared.cjs')

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  let facility
  try {
    ;({ facility } = JSON.parse(event.body || '{}'))
    if (!FACILITY_LOCATION[facility]) throw new Error('unsupported facility')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Body must be { facility: 'cal'|'ken'|'mad'|'wr'|'ec' } — ${e.message}` }) }
  }

  try {
    const balances = await queryPointsBalance(facility)
    const employeeIds = balances.map(b => Number(b.employee_id))
    const [latestTx, existingRows] = await Promise.all([
      queryLatestTransactions(employeeIds),
      employeeIds.length
        ? sbFetch(`attendance_points_actions?employee_id=in.(${employeeIds.join(',')})&facility=eq.${facility}&select=employee_id,threshold_hit`)
        : Promise.resolve([]),
    ])
    const existingSet = new Set((existingRows || []).map(r => `${r.employee_id}:${r.threshold_hit}`))

    const employees = balances.map(b => {
      const points = Number(b.points)
      const highestThreshold = [...THRESHOLDS].reverse().find(t => points >= t.points) || null
      const newCrossings = THRESHOLDS.filter(t => points >= t.points && !existingSet.has(`${b.employee_id}:${t.points}`))
      const tx = latestTx.get(Number(b.employee_id))
      const category = tx ? CATEGORY_BY_POINTS[Number(tx.points)] : null
      return {
        employeeId: b.employee_id,
        name: [b.first_name, b.last_name].filter(Boolean).join(' '),
        points,
        updatedToDate: b.updated_to_date,
        currentTier: highestThreshold?.action || null,
        newCrossings: newCrossings.map(t => t.points),
        latestCategory: category?.label || null,
      }
    })

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ facility, employees, fetchedAt: new Date().toISOString() }),
    }
  } catch (e) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message, facility }) }
  }
}
