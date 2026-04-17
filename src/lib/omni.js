// Omni Analytics API helpers
// Base URL: https://csw.omniapp.co
// Auth header: x-api-key: VITE_OMNI_API_KEY
// All calls are stubbed until real query IDs are provided.

const BASE_URL = 'https://csw.omniapp.co'
const API_KEY  = import.meta.env.VITE_OMNI_API_KEY || ''

async function omniGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'x-api-key': API_KEY },
  })
  if (!res.ok) throw new Error(`Omni ${path} → ${res.status}`)
  return res.json()
}

// ── Stub data ────────────────────────────────────────────────────

const STUB_HOURS = Array.from({ length: 10 }, (_, i) => ({
  h:     i + 7,
  req:   Math.floor(18 + Math.random() * 12),
  avail: Math.floor(14 + Math.random() * 10),
  appts: Math.floor(30 + Math.random() * 40),
  inb:   Math.floor(10 + Math.random() * 20),
  out:   Math.floor(8  + Math.random() * 15),
}))

const STUB_PROJECTS = [
  { name: 'Kohl\'s Inbound',       inb: 142, out: 0,   tot: 142 },
  { name: 'Target Replenishment',  inb: 0,   out: 89,  tot: 89  },
  { name: 'Amazon Returns',        inb: 67,  out: 55,  tot: 122 },
  { name: 'Nike Outbound',         inb: 0,   out: 203, tot: 203 },
  { name: 'TJX Crossdock',         inb: 98,  out: 98,  tot: 196 },
]

// ── Public API ───────────────────────────────────────────────────

/**
 * Hourly labor+appointment data for a facility on a given date.
 * Returns array of { h, req, avail, appts, inb, out }
 * Swap body for real Omni query when queryId is known.
 */
export async function fetchHourlyData(facility, date) {
  // TODO: replace stub with omniGet(`/api/queries/${QUERY_IDS.hourly[facility]}?date=${date}`)
  return Promise.resolve(STUB_HOURS.map(r => ({ ...r })))
}

/**
 * Project-level throughput for a facility on a given date.
 * Returns array of { name, inb, out, tot }
 */
export async function fetchProjectData(facility, date) {
  // TODO: replace stub with real Omni query
  return Promise.resolve(STUB_PROJECTS.map(r => ({ ...r })))
}

/**
 * Network-level daily KPIs across all facilities.
 * Returns object keyed by facility id.
 */
export async function fetchNetworkKpis(date) {
  // TODO: replace stub with real Omni query
  const facs = ['cal', 'mad', 'ken', 'wr', 'ec']
  return Object.fromEntries(facs.map(f => [f, {
    appts:    Math.floor(80  + Math.random() * 60),
    inb:      Math.floor(200 + Math.random() * 200),
    out:      Math.floor(150 + Math.random() * 200),
    labor:    Math.floor(20  + Math.random() * 30),
    util:     Math.floor(70  + Math.random() * 25),
  }]))
}
