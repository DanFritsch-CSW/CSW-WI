import { useState, useEffect, useRef, useMemo } from 'react'
import { getLookupOptionsWithIds, getOwnerProjectMap, getSettings } from '../../lib/schedulingApi.js'
import ComboBox from './ComboBox.jsx'

// Ported from front_netlify_datex/src/components/RecurringForm.jsx
// (2026-08-03). Changes: import paths updated, and the raw fetch to
// create-recurring updated to scheduling-create-recurring.
//
// UPDATED 2026-08-19 per Kay/Anne's "disappearing dock door in Recurring"
// report — see the dock-door-loading effect below for the root cause and
// fix (a missing stale-request guard).

const WAREHOUSES = ['CSW-Eau Claire', 'CSW-Franksville', 'CSW-Kenosha', 'CSW-Madison', 'CSW-Wisconsin Rapids']

const TYPES = [
  'Inbound',
  'Inbound/Drop',
  'Inbound/Lump',
  'Inbound/Reload',
  'Inbound/Work-In',
  'Outbound',
  'Outbound/Drop',
  'Outbound/Lump',
  'Outbound/Reload',
  'Outbound/Work-In',
]

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTE_OPTIONS = ['00', '15', '30', '45']

// Max appointments per recurring batch
const MAX_OCCURRENCES = 15

function parseTime24(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return { h24: '', min: '' }
  const [h, m] = timeStr.split(':').map(Number)
  return { h24: String(h).padStart(2, '0'), min: String(m).padStart(2, '0') }
}

function buildTime24(h24Str, minStr) {
  if (!h24Str || !minStr) return null
  return `${String(h24Str).padStart(2, '0')}:${minStr}`
}

// Returns the abbreviation for a project name, or null if none matches.
function findAbbreviation(projectName, abbreviations) {
  if (!projectName || !abbreviations?.length) return null
  const lower = projectName.toLowerCase()
  for (const { keyword, abbr } of abbreviations) {
    if (keyword && abbr && lower.includes(keyword.toLowerCase())) return abbr
  }
  return null
}

// Normalizes the response from getLookupOptionsWithIds into a consistent
// {name, id} array regardless of whether the backend returned objects or
// plain strings (legacy fallback).
function normalizePairs(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return []
  if (typeof raw[0] === 'object' && raw[0] !== null) return raw
  return raw.map((n) => ({ name: String(n), id: null }))
}

// ── Date helpers ─────────────────────────────────────────────────────────

function addMonths(date, months) {
  const d = new Date(date)
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  if (d.getDate() < day) d.setDate(0)
  return d
}

function generateDates(startIso, frequency, occurrences) {
  const start = new Date(startIso)
  const dates = []
  if (frequency === 'daily') {
    let d = new Date(start)
    while (dates.length < occurrences) {
      const day = d.getDay()
      if (day !== 0 && day !== 6) dates.push(d.toISOString())
      d = new Date(d)
      d.setDate(d.getDate() + 1)
    }
  } else {
    for (let i = 0; i < occurrences; i++) {
      let d
      if (frequency === 'weekly') {
        d = new Date(start)
        d.setDate(d.getDate() + i * 7)
      } else {
        d = addMonths(start, i)
      }
      dates.push(d.toISOString())
    }
  }
  return dates
}

function formatDatetime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// ── Sub-components ──────────────────────────────────────────────────────

function EditableField({ label, fieldKey, value, onChange }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        className="w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5
          hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400
          bg-transparent focus:bg-white transition-colors"
      />
    </div>
  )
}

const inlineCls =
  'w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5 ' +
  'hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 ' +
  'bg-transparent focus:bg-white transition-colors cursor-pointer'

const inlineLabelCls = 'block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5'

const RECURRING_REQUIRED = [
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'type', label: 'Type' },
  { key: 'owner', label: 'Owner' },
  { key: 'project', label: 'Project' },
  { key: 'scheduled_dock_door', label: 'Dock Door' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'reference_number', label: 'Reference #' },
  { key: 'appointment_lookup_code', label: 'Appointment Code' },
]

function validateForRecurring(fields) {
  const missing = RECURRING_REQUIRED.filter(({ key }) => !fields[key] || !String(fields[key]).trim()).map(({ label }) => label)
  if (fields.scheduled_dock_door && !fields.dock_door_datex_id) {
    missing.push("Dock Door (ID not resolved \u2014 please re-select from the list)")
  }
  if (fields.owner && fields.owner_datex_id == null) {
    missing.push("Owner (ID not resolved \u2014 please re-select from the list)")
  }
  if (fields.project && fields.project_datex_id == null) {
    missing.push("Project (ID not resolved \u2014 please re-select from the list)")
  }
  return missing
}

// ── Main component ──────────────────────────────────────────────────────

export default function RecurringForm({ compact = false }) {
  const [fields, setFields] = useState({
    warehouse: WAREHOUSES[0],
    carrier: '',
    carrier_datex_id: null,
    type: TYPES[0],
    owner: '',
    owner_datex_id: null,
    project: '',
    project_datex_id: null,
    scheduled_dock_door: '',
    dock_door_datex_id: null,
    reference_number: '',
    appointment_lookup_code: '',
    notes: '',
    appt_duration: '30',
  })

  const [startDatetime, setStartDatetime] = useState('')
  const [frequency, setFrequency] = useState('weekly')
  const [occurrences, setOccurrences] = useState(4)

  const [carriers, setCarriers] = useState([])
  const [owners, setOwners] = useState([])
  const [projects, setProjects] = useState([])
  const [dockDoors, setDockDoors] = useState([])
  const [dockDoorsLoading, setDockDoorsLoading] = useState(false)
  const [ownerProjectMap, setOwnerProjectMap] = useState({})
  const [projectOwnerMap, setProjectOwnerMap] = useState({})
  const projectOwnerMapRef = useRef({})
  projectOwnerMapRef.current = projectOwnerMap
  const startDatetimeRef = useRef('')
  startDatetimeRef.current = startDatetime
  const [abbreviations, setAbbreviations] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getLookupOptionsWithIds('carriers', undefined, { topUsed: true })
      .then((raw) => setCarriers(normalizePairs(raw)))
      .catch(() => {})
    getLookupOptionsWithIds('owners')
      .then((raw) => setOwners(normalizePairs(raw)))
      .catch(() => {})
    getLookupOptionsWithIds('projects')
      .then((raw) => setProjects(normalizePairs(raw)))
      .catch(() => {})
    getSettings('abbreviations')
      .then((v) => {
        if (v) setAbbreviations(v)
      })
      .catch(() => {})
    getOwnerProjectMap()
      .then((pairs) => {
        const ownerMap = {}
        const projectMap = {}
        for (const { owner_name, project_name } of pairs) {
          if (!owner_name || !project_name) continue
          const ownerKey = owner_name.toLowerCase()
          if (!ownerMap[ownerKey]) ownerMap[ownerKey] = new Set()
          ownerMap[ownerKey].add(project_name)
          const projKey = project_name.toLowerCase()
          if (!(projKey in projectMap)) {
            projectMap[projKey] = owner_name
          } else if (projectMap[projKey] !== owner_name) {
            projectMap[projKey] = null
          }
        }
        for (const key of Object.keys(ownerMap)) {
          ownerMap[key] = [...ownerMap[key]].sort((a, b) => a.localeCompare(b))
        }
        setOwnerProjectMap(ownerMap)
        setProjectOwnerMap(projectMap)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!fields.warehouse) {
      setDockDoors([])
      return
    }
    // Stale-request guard — added 2026-08-19 per Kay/Anne's "disappearing
    // dock door in Recurring" report. Without this, switching warehouses
    // quickly (or just landing on the form while a slow dock-door fetch
    // is still in flight) let an OLD warehouse's fetch resolve AFTER the
    // user had already picked a valid dock door for the NEW warehouse.
    // That old fetch's own cleanup check ("is the currently selected door
    // in MY list?") would then see the new door isn't in its stale list
    // and wipe the selection back to blank — matching the exact report:
    // dock door disappears, works again on a second click (by then the
    // stale fetch has already resolved and can no longer interfere).
    let cancelled = false
    setDockDoorsLoading(true)
    getLookupOptionsWithIds('dock_doors', fields.warehouse)
      .then((raw) => {
        if (cancelled) return
        const normalized = normalizePairs(raw)
        setDockDoors(normalized)
        setFields((prev) => {
          if (!prev.scheduled_dock_door) return prev
          const names = normalized.map((d) => d.name)
          if (names.length > 0 && !names.includes(prev.scheduled_dock_door)) {
            return { ...prev, scheduled_dock_door: '', dock_door_datex_id: null }
          }
          return prev
        })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDockDoorsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fields.warehouse])

  useEffect(() => {
    if (!fields.project || !fields.reference_number) return
    const abbr = findAbbreviation(fields.project, abbreviations)
    const prefix = abbr ? `(${abbr})` : fields.project
    setFields((prev) => ({ ...prev, appointment_lookup_code: `${prefix} - ${prev.reference_number.trim()}` }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.project, fields.reference_number, abbreviations])

  const setField = (name, value, datexId) => {
    setResults(null)
    setFields((prev) => {
      const next = { ...prev, [name]: value }
      if (datexId !== undefined) {
        const idKey = name === 'scheduled_dock_door' ? 'dock_door_datex_id' : `${name}_datex_id`
        next[idKey] = datexId
      }
      if (name === 'warehouse') {
        next.scheduled_dock_door = ''
        next.dock_door_datex_id = null
      }
      if (name === 'owner' && next.project) {
        const names = ownerProjectMap[value?.toLowerCase()]
        if (names?.length > 0 && !names.includes(next.project)) {
          next.project = ''
          next.project_datex_id = null
        }
      }
      if (name === 'project' && value && !prev.owner) {
        const ownerName = projectOwnerMapRef.current[value.toLowerCase()]
        if (ownerName) {
          const ownerOpt = owners.find((o) => o.name === ownerName)
          next.owner = ownerName
          next.owner_datex_id = ownerOpt?.id ?? null
        }
      }
      return next
    })
  }

  const filteredProjectOptions = useMemo(() => {
    if (fields.owner && Object.keys(ownerProjectMap).length > 0) {
      const names = ownerProjectMap[fields.owner.toLowerCase()]
      if (names?.length > 0) return names
    }
    return projects.map((p) => p.name)
  }, [fields.owner, ownerProjectMap, projects])

  const previewDates = startDatetime && occurrences >= 1 ? generateDates(startDatetime, frequency, Math.min(occurrences, MAX_OCCURRENCES)) : []

  const handleSubmit = async () => {
    const missing = validateForRecurring(fields)
    if (missing.length > 0) {
      setError(`Missing required fields: ${missing.join(', ')}`)
      return
    }
    if (!startDatetime || !startDatetime.includes('T') || !startDatetime.split('T')[1]) {
      setError('Please set a start date and time.')
      return
    }
    setSubmitting(true)
    setError(null)
    setResults(null)
    try {
      const res = await fetch('/.netlify/functions/scheduling-create-recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, start_datetime: startDatetime, recurrence: { frequency, occurrences } }),
      })
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`Server error (HTTP ${res.status}) \u2014 the function may still be deploying. Please try again in a moment.`)
      }
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      setResults(data.results)
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const successCount = results ? results.filter((r) => r.success).length : 0
  const failCount = results ? results.filter((r) => !r.success).length : 0

  const inner = (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <ComboBox small label="Warehouse" fieldKey="warehouse" value={fields.warehouse} options={WAREHOUSES} onChange={(_, v) => setField('warehouse', v)} />
        <ComboBox small label="Type" fieldKey="type" value={fields.type} options={TYPES} onChange={(_, v) => setField('type', v)} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <ComboBox
          small
          label="Project"
          fieldKey="project"
          value={fields.project}
          options={filteredProjectOptions}
          onChange={(_, v) => {
            const opt = projects.find((p) => p.name === v) ?? projects.find((p) => p.name?.toLowerCase() === v?.toLowerCase())
            setField('project', v, opt?.id ?? null)
          }}
        />
        <ComboBox
          small
          label="Owner"
          fieldKey="owner"
          value={fields.owner}
          options={owners.map((o) => o.name)}
          onChange={(_, v) => {
            const opt = owners.find((o) => o.name === v) ?? owners.find((o) => o.name?.toLowerCase() === v?.toLowerCase())
            setField('owner', v, opt?.id ?? null)
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <ComboBox
          small
          label="Dock Door"
          fieldKey="scheduled_dock_door"
          value={fields.scheduled_dock_door}
          options={dockDoors.map((d) => d.name)}
          loading={dockDoorsLoading}
          onChange={(_, v) => {
            const opt = dockDoors.find((d) => d.name === v) ?? dockDoors.find((d) => d.name?.toLowerCase() === v?.toLowerCase())
            setField('scheduled_dock_door', v, opt?.id ?? null)
          }}
        />
        <ComboBox
          small
          label="Carrier"
          fieldKey="carrier"
          value={fields.carrier}
          options={carriers.map((c) => c.name)}
          onChange={(_, v) => {
            const opt = carriers.find((c) => c.name === v) ?? carriers.find((c) => c.name?.toLowerCase() === v?.toLowerCase())
            setField('carrier', v, opt?.id ?? null)
          }}
        />
      </div>

      <EditableField label="Reference #" fieldKey="reference_number" value={fields.reference_number} onChange={(k, v) => setField(k, v)} />

      <EditableField label="Appointment Code" fieldKey="appointment_lookup_code" value={fields.appointment_lookup_code} onChange={(k, v) => setField(k, v)} />

      <EditableField label="Notes" fieldKey="notes" value={fields.notes} onChange={(k, v) => setField(k, v)} />

      <div className="grid grid-cols-[5fr_4fr_3fr] gap-1.5 pt-1">
        <div>
          <label className={inlineLabelCls}>Start Date</label>
          <input
            type="date"
            value={startDatetime.split('T')[0] || ''}
            onChange={(e) => {
              const time = startDatetime.includes('T') ? startDatetime.split('T')[1] : ''
              setStartDatetime(time ? `${e.target.value}T${time}` : e.target.value)
              setResults(null)
            }}
            className={inlineCls}
          />
        </div>
        <div>
          <label className={inlineLabelCls}>Start Time</label>
          <div className="flex items-center border border-transparent rounded px-1.5 py-1 -mx-1.5 hover:border-gray-300 focus-within:border-indigo-400 focus-within:ring-1 focus-within:ring-indigo-400 bg-transparent focus-within:bg-white transition-colors">
            {(() => {
              const timePart = startDatetime.includes('T') ? startDatetime.split('T')[1] : ''
              const { h24, min } = parseTime24(timePart)
              const date = startDatetime.split('T')[0] || ''
              return (
                <>
                  <select
                    value={h24}
                    onChange={(e) => {
                      const t = buildTime24(e.target.value, '00')
                      if (t) {
                        setStartDatetime(date ? `${date}T${t}` : t)
                        setResults(null)
                      }
                    }}
                    className="flex-1 min-w-0 text-xs text-gray-900 bg-transparent focus:outline-none cursor-pointer"
                  >
                    <option value="">HH</option>
                    {HOUR_OPTIONS.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs font-semibold text-gray-400 select-none px-0.5">:</span>
                  <select
                    value={min}
                    onChange={(e) => {
                      const cur = startDatetimeRef.current
                      const curH = parseTime24(cur.includes('T') ? cur.split('T')[1] : '').h24 || '00'
                      const curDate = cur.split('T')[0] || ''
                      const t = buildTime24(curH, e.target.value)
                      if (t) {
                        setStartDatetime(curDate ? `${curDate}T${t}` : t)
                        setResults(null)
                      }
                    }}
                    className="w-12 text-xs text-gray-900 bg-transparent focus:outline-none cursor-pointer"
                  >
                    <option value="">MM</option>
                    {MINUTE_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </>
              )
            })()}
          </div>
        </div>
        <div>
          <label className={inlineLabelCls}>Frequency</label>
          <select
            value={frequency}
            onChange={(e) => {
              setFrequency(e.target.value)
              setResults(null)
            }}
            className={inlineCls}
          >
            <option value="daily">Daily (weekdays)</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={inlineLabelCls}># Times</label>
          <input
            type="number"
            min={1}
            max={MAX_OCCURRENCES}
            value={occurrences}
            onChange={(e) => {
              setOccurrences(Math.max(1, Math.min(MAX_OCCURRENCES, parseInt(e.target.value, 10) || 1)))
              setResults(null)
            }}
            className={inlineCls}
          />
          <p className="text-xs text-gray-400 mt-0.5">Max {MAX_OCCURRENCES} per batch</p>
        </div>
        <div>
          <label className={inlineLabelCls}>Dur.</label>
          <select value={fields.appt_duration || '30'} onChange={(e) => setField('appt_duration', e.target.value)} className={inlineCls}>
            <option value="30">30 min</option>
            <option value="60">60 min</option>
          </select>
        </div>
      </div>

      {previewDates.length > 0 && !results && (
        <div className="pt-1">
          <p className="text-xs font-medium text-gray-500 mb-2">
            Preview — {previewDates.length} appointment{previewDates.length !== 1 ? 's' : ''} will be created:
          </p>
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {previewDates.map((d, i) => (
              <li key={i} className="text-xs text-gray-700 bg-gray-50 rounded px-3 py-1.5 flex gap-2">
                <span className="text-gray-400 shrink-0">{i + 1}.</span>
                {formatDatetime(d)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs">{error}</div>}

      {!results && (
        <button
          onClick={handleSubmit}
          disabled={submitting || !startDatetime || !startDatetime.includes('T') || !startDatetime.split('T')[1]}
          className="w-full py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {submitting ? `Creating ${occurrences} appointment${occurrences !== 1 ? 's' : ''}…` : `Create ${occurrences} Appointment${occurrences !== 1 ? 's' : ''}`}
        </button>
      )}

      {results && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-800">Results</h3>
            {successCount > 0 && <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full font-medium">{successCount} created</span>}
            {failCount > 0 && <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-medium">{failCount} failed</span>}
          </div>
          <ul className="divide-y divide-gray-50">
            {results.map((r, i) => (
              <li key={i} className="px-5 py-3 flex items-start gap-3">
                <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${r.success ? 'bg-green-400' : 'bg-red-400'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800">{formatDatetime(r.scheduled_arrival)}</p>
                  {r.success && r.datex_appointment_id && <p className="text-xs text-gray-400 mt-0.5">Datex ID: {r.datex_appointment_id}</p>}
                  {r.warning && <p className="text-xs text-amber-600 mt-0.5">{r.warning}</p>}
                  {r.dry_run && <p className="text-xs text-amber-600 mt-0.5">Dry run — no Datex API key configured</p>}
                  {r.error && <p className="text-xs text-red-500 mt-0.5">{r.error}</p>}
                </div>
              </li>
            ))}
          </ul>
          <div className="px-5 py-3 border-t border-gray-100">
            <button onClick={() => setResults(null)} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors">
              Create another series
            </button>
          </div>
        </div>
      )}
    </div>
  )

  if (compact) return inner

  return (
    <div className="flex-1 overflow-auto px-5 py-4">
      <div className="max-w-2xl mx-auto">{inner}</div>
    </div>
  )
}
