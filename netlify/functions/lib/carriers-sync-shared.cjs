'use strict'

/**
 * lib/carriers-sync-shared.cjs — added 2026-08-19 per Kay's long-standing
 * "carriers disappearing" feedback (cnv_1ayy4w9g, first raised June 2026).
 *
 * Root cause of the disappearing behavior (see scheduling_carriers'
 * migration comment for the full story): the plugin's carrier dropdown
 * used to be populated live on every load, ranked by appointment count in
 * a rolling 6-month window, capped at the top 250 — a carrier falls out
 * of that list just by losing ground in recent volume, with no need to be
 * touched in Datex at all.
 *
 * This sync pulls the COMPLETE distinct carrier list from Omni (no date
 * filter, no cap) plus a recent-6-month count per carrier (kept only as a
 * sort hint, never a cutoff), and replaces the full contents of
 * scheduling_carriers in Supabase. scheduling-omni-lookup.cjs then reads
 * from that table instead of hitting Omni live — faster, and nobody ever
 * silently drops off the list again.
 *
 * Dedup convention matches the existing queryTopCarriers/queryOmniPairs
 * logic in scheduling-omni-lookup.cjs exactly: carriers are deduped by
 * lowercased display name, keeping the FIRST Datex ID encountered for
 * that name (not necessarily the highest-count one — this is an existing
 * quirk in how multiple Datex IDs sharing a display name get collapsed,
 * preserved here for consistency rather than silently changed).
 */

const { createClient } = require('@supabase/supabase-js')

const MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const TOPIC = 'gold__truck_appointments'

function baseUrl() {
  return process.env.URL || process.env.DEPLOY_URL || 'https://csw-wi.netlify.app'
}

function omniProxyUrl() {
  return `${baseUrl()}/.netlify/functions/omni-query`
}

async function omniQuery(body) {
  const res = await fetch(omniProxyUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`omni-query HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  return json.rows || []
}

function extractNameAndId(row) {
  let name = null
  let id = null
  for (const v of Object.values(row)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
      if (id === null) id = v
    } else if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
        if (id === null) id = n
      } else if (v.trim()) {
        name = v.trim()
      }
    }
  }
  return { name, id }
}

// Complete distinct carrier list — NO date filter, NO cap. This is the
// piece that actually fixes the disappearing-carrier problem: everyone
// who has ever appeared in Datex stays here until Omni itself stops
// returning them (i.e. genuinely removed/merged in Datex).
async function fetchAllCarriers() {
  const rows = await omniQuery({
    query: {
      modelId: MODEL_ID,
      table: TOPIC,
      fields: [`${TOPIC}.carrier_name`, `${TOPIC}.carrier_id`],
      limit: 20000,
    },
  })
  const byName = new Map()
  for (const row of rows) {
    const { name, id } = extractNameAndId(row)
    if (!name || id === null) continue
    const key = name.toLowerCase()
    if (!byName.has(key)) byName.set(key, { name, id })
  }
  return byName
}

// Recent (6-month) appointment count per carrier — sort hint only, never
// used to exclude anyone. Same window/logic as the old queryTopCarriers.
async function fetchRecentCounts(months = 6) {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const rows = await omniQuery({
    query: {
      modelId: MODEL_ID,
      table: TOPIC,
      fields: [`${TOPIC}.carrier_name`, `${TOPIC}.carrier_id`, `${TOPIC}.count`],
      filters: { [`${TOPIC}.scheduled_arrival`]: { after: cutoffStr } },
      sorts: [{ column_name: `${TOPIC}.count`, sort_descending: true, null_sort: 'OMNI_DEFAULT' }],
      limit: 5000,
    },
  })

  const countByName = new Map()
  for (const row of rows) {
    let name = null
    let count = 0
    for (const [key, val] of Object.entries(row)) {
      if (val === null || val === undefined) continue
      const lk = key.toLowerCase()
      if (lk.includes('count')) {
        count = typeof val === 'number' ? val : Number(val) || 0
      } else if (typeof val === 'string' && !/^\d+$/.test(val.trim()) && val.trim()) {
        name = val.trim()
      }
    }
    if (!name) continue
    const nameKey = name.toLowerCase()
    countByName.set(nameKey, (countByName.get(nameKey) || 0) + count)
  }
  return countByName
}

// Runs the full sync: fetch from Omni, replace scheduling_carriers in
// Supabase. Returns { synced, error } — never throws, so the caller
// (scheduled or manual-test function) can always respond cleanly.
async function runCarriersSync() {
  const SUPA_URL = process.env.VITE_SUPABASE_URL
  const SUPA_KEY = process.env.VITE_SUPABASE_ANON_KEY
  if (!SUPA_URL || !SUPA_KEY) {
    return { synced: 0, error: 'Supabase env vars not configured' }
  }
  if (!process.env.OMNI_API_KEY) {
    return { synced: 0, error: 'OMNI_API_KEY not configured' }
  }

  const supabase = createClient(SUPA_URL, SUPA_KEY)

  try {
    const [allCarriers, recentCounts] = await Promise.all([fetchAllCarriers(), fetchRecentCounts(6)])

    if (allCarriers.size === 0) {
      return { synced: 0, error: 'Omni returned zero distinct carriers — refusing to wipe the table on what looks like an outage' }
    }

    const rows = []
    for (const [key, { name, id }] of allCarriers.entries()) {
      rows.push({
        carrier_name: name,
        carrier_id: id,
        appointment_count: recentCounts.get(key) || 0,
        synced_at: new Date().toISOString(),
      })
    }

    // Full replace: delete then insert. Safe for a weekly batch job with
    // no concurrent writers — scheduling-omni-lookup.cjs only ever reads
    // this table, never writes it.
    const { error: delErr } = await supabase.from('scheduling_carriers').delete().neq('carrier_name', '__never_matches__')
    if (delErr) throw new Error(`delete failed: ${delErr.message}`)

    const { error: insErr } = await supabase.from('scheduling_carriers').insert(rows)
    if (insErr) throw new Error(`insert failed: ${insErr.message}`)

    return { synced: rows.length, error: null }
  } catch (err) {
    return { synced: 0, error: err.message }
  }
}

module.exports = { runCarriersSync }
