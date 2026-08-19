import { useState, useEffect, useRef, useMemo } from 'react'
import {
  getSubmissions,
  createSubmission,
  saveSubmission,
  approveSubmission,
  pushToDatexBackground,
  createLoadContainer,
  triggerFrontDraft,
  triggerMultiFrontDraft,
  getLookupOptions,
  getLookupOptionsWithIds,
  getOwnerProjectMap,
  getSettings,
  saveSettings,
} from '../../lib/schedulingApi.js'
import StatusBadge from '../../components/scheduling/StatusBadge.jsx'
import ComboBox from '../../components/scheduling/ComboBox.jsx'
import RecurringForm from '../../components/scheduling/RecurringForm.jsx'
import AppointmentInsights from '../../components/scheduling/AppointmentInsights.jsx'
import PluginSettingsPanel from '../../components/scheduling/PluginSettingsPanel.jsx'
import PluginLoadContainerTab from '../../components/scheduling/PluginLoadContainerTab.jsx'
import PluginMultiApptTab from '../../components/scheduling/PluginMultiApptTab.jsx'
import { CSW_BEAR_LOGO } from '../../lib/csw-logo.js'
import {
  WAREHOUSE_FALLBACK,
  TYPE_FALLBACK,
  DEFAULT_DRAFT_TEMPLATE,
  DEFAULT_MULTI_DRAFT_TEMPLATE,
  DEFAULT_ABBREVIATIONS,
  DEFAULT_DOCK_DOOR_RULES,
  HOUR_OPTIONS,
  MINUTE_OPTIONS,
  EDITABLE_FIELDS,
  parseTime24,
  buildTime24,
  findAbbreviation,
  findDockDoorRule,
  normalizeWarehouse,
  validateForPush,
  deriveOrderTypeId,
  validateForLCPush,
  computeIdEdits,
  computeEdits,
  buildEmptyDraft,
  buildEmptySlot,
  buildDraft,
  buildMergedSlot,
} from '../../lib/pluginUtils.js'

/**
 * PluginView — the Front sidebar scheduling plugin, ported from
 * front_netlify_datex/src/views/PluginView.jsx (2026-08-03).
 *
 * This file was split from a single 125KB source file into companion files:
 *   - pluginUtils.js — pure constants/helpers (shared, no state)
 *   - PluginSettingsPanel.jsx — the Settings tab (self-contained)
 *   - PluginLoadContainerTab.jsx — the Load Container tab (presentational)
 *   - PluginMultiApptTab.jsx — the Multi APPT tab (presentational)
 *   - This file — owns ALL state, refs, effects, and handlers, and renders
 *     the tab switcher + the Single APPT tab directly.
 *
 * The split moves ONLY JSX for the other three tabs into their own files;
 * state and handler ownership did not change, to keep behavior identical
 * to the original and avoid the higher risk of splitting stateful logic
 * across files without a live test environment.
 *
 * Verified live in Front's sidebar 2026-08-18 (real MAD Appointments
 * conversation). Per Dan's follow-up that day: App.jsx now skips TopNav on
 * this route entirely (see NO_TOPNAV_ROUTES there), and this file renders
 * its own compact CSW brand header below instead — the full bear mark +
 * wordmark, without the utility bar or the other pages' nav links, which
 * don't apply inside Front's narrow sidebar.
 */

function CswBrandHeader() {
  return (
    <div className="flex items-center gap-2.5 mb-3 pb-3 border-b border-gray-100">
      <div className="w-9 h-9 rounded flex items-center justify-center bg-[#a07818] shrink-0">
        <img src={CSW_BEAR_LOGO} alt="Central Storage & Warehouse" className="w-6 h-6 object-contain" />
      </div>
      <div className="flex flex-col leading-none">
        <span className="font-bold text-[15px] tracking-wide text-[#a07818]">CSW</span>
        <span className="text-[8px] font-mono tracking-widest text-gray-400 uppercase mt-0.5">Ops Hub</span>
      </div>
    </div>
  )
}

function SelectField({ label, fieldKey, value, options, onChange }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        className="w-full text-sm text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5
          hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400
          bg-transparent focus:bg-white transition-colors cursor-pointer"
      >
        {!options.includes(value) && value && <option value={value}>{value}</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  )
}

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

function ReadOnlyField({ label, value }) {
  if (!value) return null
  return (
    <div>
      <dt className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</dt>
      <dd className="mt-0.5 text-xs text-gray-900 break-words">{value}</dd>
    </div>
  )
}

export default function PluginView() {
  const [pluginView, setPluginView] = useState('appointment') // 'appointment' | 'loadContainer' | 'multi' | 'recurring' | 'settings'
  const [contextType, setContextType] = useState('noConversation')
  const [conversationId, setConversationId] = useState(null)
  const [submission, setSubmission] = useState(null)
  const [draft, setDraft] = useState({})
  const [loadingRecord, setLoadingRecord] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [approving, setApproving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [confirmingApprove, setConfirmingApprove] = useState(false)
  const [approveError, setApproveError] = useState(null)
  const [approveWarning, setApproveWarning] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [approved, setApproved] = useState(false)
  const [saved, setSaved] = useState(false)
  const [draftCreating, setDraftCreating] = useState(false)
  const [draftCreated, setDraftCreated] = useState(false)
  const [draftError, setDraftError] = useState(null)
  const [dryRunPayload, setDryRunPayload] = useState(null)
  const [autoEmail, setAutoEmail] = useState(false)
  const [datexProcessing, setDatexProcessing] = useState(false)
  const [datexAppointmentId, setDatexAppointmentId] = useState(null)
  const [lookups, setLookups] = useState({
    warehouses: WAREHOUSE_FALLBACK,
    types: TYPE_FALLBACK,
    owners: [],
    projects: [],
    dock_doors: [],
    carriers: [],
  })
  const [lookupsLoading, setLookupsLoading] = useState(true)
  const [dockDoorsLoading, setDockDoorsLoading] = useState(false)
  const [ownerProjectMap, setOwnerProjectMap] = useState({})
  const [projectOwnerMap, setProjectOwnerMap] = useState({})
  const [abbreviations, setAbbreviations] = useState(DEFAULT_ABBREVIATIONS)
  const [draftTemplate, setDraftTemplate] = useState(DEFAULT_DRAFT_TEMPLATE)
  const [multiDraftTemplate, setMultiDraftTemplate] = useState(DEFAULT_MULTI_DRAFT_TEMPLATE)
  const [dockDoorRules, setDockDoorRules] = useState(DEFAULT_DOCK_DOOR_RULES)
  const [nameToId, setNameToId] = useState({ owners: {}, projects: {}, dock_doors: {}, carriers: {} })
  const nameToIdRef = useRef(nameToId)
  nameToIdRef.current = nameToId
  const ownerProjectMapRef = useRef(ownerProjectMap)
  ownerProjectMapRef.current = ownerProjectMap
  const projectOwnerMapRef = useRef(projectOwnerMap)
  projectOwnerMapRef.current = projectOwnerMap

  // ── Multiple APPT tab state ──────────────────────────────────────────────
  const [multiDrafts, setMultiDrafts] = useState([])
  const [multiApproving, setMultiApproving] = useState(false)
  const [multiResults, setMultiResults] = useState(null)
  const [multiDraftCreated, setMultiDraftCreated] = useState(false)
  const [multiApproveError, setMultiApproveError] = useState(null)
  const [multiConfirming, setMultiConfirming] = useState(false)
  const [multiShared, setMultiShared] = useState({ warehouse: '', type: '', owner: '', project: '' })
  const multiSharedRef = useRef(multiShared)
  multiSharedRef.current = multiShared
  const [multiDockDoors, setMultiDockDoors] = useState([])
  const [multiDockDoorsLoading, setMultiDockDoorsLoading] = useState(false)

  // ── Load Container tab state ─────────────────────────────────────────────
  const [lcDraft, setLcDraft] = useState({})
  const [lcApproving, setLcApproving] = useState(false)
  const [lcConfirming, setLcConfirming] = useState(false)
  const [lcApproveError, setLcApproveError] = useState(null)
  const [lcApproveWarning, setLcApproveWarning] = useState(null)
  const [lcApproved, setLcApproved] = useState(false)
  const [lcDraftCreated, setLcDraftCreated] = useState(false)
  const [lcDockDoors, setLcDockDoors] = useState([])
  const [lcDockDoorsLoading, setLcDockDoorsLoading] = useState(false)
  const [lcCreatedId, setLcCreatedId] = useState(null)

  useEffect(() => {
    async function fetchWithIdsFallback(type, opts = {}) {
      try {
        const pairs = await getLookupOptionsWithIds(type, undefined, opts)
        if (pairs.length > 0 && typeof pairs[0] !== 'object') {
          return pairs.map((n) => ({ name: n, id: null }))
        }
        if (pairs.length > 0) return pairs
      } catch {
        /* fall through */
      }
      const names = await getLookupOptions(type).catch(() => [])
      return names.map((n) => ({ name: n, id: null }))
    }

    Promise.allSettled([
      getLookupOptions('warehouses'),
      getLookupOptions('types'),
      fetchWithIdsFallback('owners'),
      fetchWithIdsFallback('projects'),
      fetchWithIdsFallback('carriers', { topUsed: true }),
    ])
      .then(([wh, ty, ow, pr, ca]) => {
        const ownerPairs = ow.status === 'fulfilled' ? ow.value : []
        const projectPairs = pr.status === 'fulfilled' ? pr.value : []
        const carrierPairs = ca.status === 'fulfilled' ? ca.value : []

        const resolved = {
          warehouses: wh.status === 'fulfilled' && wh.value.length ? wh.value : WAREHOUSE_FALLBACK,
          types: ty.status === 'fulfilled' && ty.value.length ? ty.value : TYPE_FALLBACK,
          owners: ownerPairs.map((p) => p.name),
          projects: projectPairs.map((p) => p.name),
          carriers: carrierPairs.map((p) => p.name),
          dock_doors: [],
        }
        setLookups(resolved)

        setNameToId((prev) => ({
          ...prev,
          owners: Object.fromEntries(ownerPairs.map((p) => [p.name.toLowerCase(), p.id])),
          projects: Object.fromEntries(projectPairs.map((p) => [p.name.toLowerCase(), p.id])),
          carriers: Object.fromEntries(carrierPairs.map((p) => [p.name.toLowerCase(), p.id])),
        }))

        setDraft((prev) => {
          if (!prev.owner && !prev.project) return prev
          const ownerNames = resolved.owners
          const projectNames = resolved.projects
          const ownerValid = !prev.owner || ownerNames.length === 0 || ownerNames.includes(prev.owner)
          const projectValid = !prev.project || projectNames.length === 0 || projectNames.includes(prev.project)
          if (ownerValid && projectValid) return prev
          return { ...prev, owner: ownerValid ? prev.owner : '', project: projectValid ? prev.project : '' }
        })
      })
      .finally(() => setLookupsLoading(false))
  }, [])

  useEffect(() => {
    getSettings('abbreviations')
      .then((value) => {
        if (value) setAbbreviations(value)
      })
      .catch(() => {})
    getSettings('draft_template')
      .then((value) => {
        if (value) setDraftTemplate(value)
      })
      .catch(() => {})
    getSettings('multi_draft_template')
      .then((value) => {
        if (value) setMultiDraftTemplate(value)
      })
      .catch(() => {})
    getSettings('dock_door_rules')
      .then((value) => {
        if (value) setDockDoorRules(value)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
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
    if (!draft.warehouse) return
    setDockDoorsLoading(true)
    getLookupOptionsWithIds('dock_doors', draft.warehouse)
      .then(async (pairs) => {
        if (pairs.length === 0) {
          const names = await getLookupOptions('dock_doors').catch(() => [])
          return names.map((n) => ({ name: n, id: null }))
        }
        if (typeof pairs[0] !== 'object') return pairs.map((n) => ({ name: n, id: null }))
        return pairs
      })
      .then((normalized) => {
        setLookups((prev) => ({ ...prev, dock_doors: normalized.map((p) => p.name) }))
        setNameToId((prev) => ({
          ...prev,
          dock_doors: Object.fromEntries(normalized.map((p) => [p.name.toLowerCase(), p.id])),
        }))
        setDraft((prev) => {
          if (!prev.scheduled_dock_door) return prev
          const names = normalized.map((p) => p.name)
          if (names.length > 0 && !names.includes(prev.scheduled_dock_door)) {
            return { ...prev, scheduled_dock_door: '' }
          }
          return prev
        })
      })
      .catch(() => {})
      .finally(() => setDockDoorsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.warehouse])

  const filteredProjects = useMemo(() => {
    if (!draft.owner || Object.keys(ownerProjectMap).length === 0) return lookups.projects
    const ownerProjects = ownerProjectMap[draft.owner.toLowerCase()]
    if (!ownerProjects || ownerProjects.length === 0) return lookups.projects
    return ownerProjects
  }, [draft.owner, ownerProjectMap, lookups.projects])

  const lcFilteredProjects = useMemo(() => {
    if (!lcDraft.owner || Object.keys(ownerProjectMap).length === 0) return lookups.projects
    const ownerProjects = ownerProjectMap[lcDraft.owner.toLowerCase()]
    if (!ownerProjects || ownerProjects.length === 0) return lookups.projects
    return ownerProjects
  }, [lcDraft.owner, ownerProjectMap, lookups.projects])

  useEffect(() => {
    setDraft((prev) => {
      if (!prev.project) return prev
      const map = ownerProjectMapRef.current
      if (Object.keys(map).length === 0) return prev
      const ownerProjects = map[prev.owner?.toLowerCase()]
      if (!ownerProjects || ownerProjects.length === 0) return prev
      if (ownerProjects.includes(prev.project)) return prev
      return { ...prev, project: '' }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.owner])

  useEffect(() => {
    setLcDraft((prev) => {
      if (!prev.project) return prev
      const map = ownerProjectMapRef.current
      if (Object.keys(map).length === 0) return prev
      const ownerProjects = map[prev.owner?.toLowerCase()]
      if (!ownerProjects || ownerProjects.length === 0) return prev
      if (ownerProjects.includes(prev.project)) return prev
      return { ...prev, project: '' }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lcDraft.owner])

  useEffect(() => {
    if (!draft.project || !draft.reference_number) return
    const abbr = findAbbreviation(draft.project, abbreviations)
    const prefix = abbr ? `(${abbr})` : draft.project
    setDraft((prev) => ({ ...prev, appointment_lookup_code: `${prefix} - ${prev.reference_number.trim()}` }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.project, draft.reference_number, abbreviations])

  useEffect(() => {
    if (!lcDraft.project || !lcDraft.reference_number) return
    const abbr = findAbbreviation(lcDraft.project, abbreviations)
    const prefix = abbr ? `(${abbr})` : lcDraft.project
    const code = `${prefix} - ${lcDraft.reference_number.trim()}`
    setLcDraft((prev) => ({ ...prev, container_lookup_code: code, appointment_lookup_code: code }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lcDraft.project, lcDraft.reference_number, abbreviations])

  useEffect(() => {
    if (!draft.project || !draft.type || !dockDoorRules.length) return
    const door = findDockDoorRule(draft.warehouse, draft.project, draft.type, dockDoorRules)
    if (!door) return
    setDraft((prev) => ({ ...prev, scheduled_dock_door: door }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.warehouse, draft.project, draft.type, dockDoorRules])

  useEffect(() => {
    if (!multiShared.project || !multiShared.type || !dockDoorRules.length) return
    const door = findDockDoorRule(multiShared.warehouse, multiShared.project, multiShared.type, dockDoorRules)
    if (!door) return
    setMultiDrafts((prev) => prev.map((slot) => ({ ...slot, scheduled_dock_door: door })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiShared.warehouse, multiShared.project, multiShared.type, dockDoorRules])

  useEffect(() => {
    if (!lcDraft.project || !lcDraft.type || !dockDoorRules.length) return
    const door = findDockDoorRule(lcDraft.warehouse, lcDraft.project, lcDraft.type, dockDoorRules)
    if (!door) return
    setLcDraft((prev) => ({ ...prev, scheduled_dock_door: door }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lcDraft.warehouse, lcDraft.project, lcDraft.type, dockDoorRules])

  useEffect(() => {
    if (!lcDraft.warehouse) return
    fetchLcDockDoors(lcDraft.warehouse)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lcDraft.warehouse])

  useEffect(() => {
    if (submission) {
      setLcDraft((prev) => ({ ...buildDraft(submission), container_lookup_code: prev.container_lookup_code ?? '' }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission])

  useEffect(() => {
    if (!multiShared.warehouse) return
    fetchMultiDockDoors(multiShared.warehouse)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiShared.warehouse])

  const draftRef = useRef(draft)
  const lcDraftRef = useRef(lcDraft)
  const multiDraftsRef = useRef(multiDrafts)
  const submissionRef = useRef(submission)
  const conversationIdRef = useRef(conversationId)
  const submitGuardRef = useRef(false)
  const sessionRef = useRef(0)
  const pollingIntervalRef = useRef(null)
  draftRef.current = draft
  lcDraftRef.current = lcDraft
  multiDraftsRef.current = multiDrafts
  submissionRef.current = submission
  conversationIdRef.current = conversationId

  useEffect(() => {
    let sub
    import('@frontapp/plugin-sdk')
      .then(({ default: Front }) => {
        sub = Front.contextUpdates.subscribe((context) => {
          setContextType(context.type)
          if (context.type === 'singleConversation') {
            setConversationId(context.conversation.id)
          } else {
            setConversationId(null)
          }
        })
      })
      .catch((err) => {
        console.warn('[PluginView] Front SDK unavailable:', err.message)
      })

    return () => {
      if (sub && typeof sub.unsubscribe === 'function') sub.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const token = ++sessionRef.current
    const controller = new AbortController()

    if (!conversationId) {
      setPluginView('appointment')
      setSubmission(null)
      setDraft({})
      setNotFound(false)
      setApproved(false)
      setApproveError(null)
      setSaveError(null)
      setSaved(false)
      setDryRunPayload(null)
      setDatexProcessing(false)
      setDatexAppointmentId(null)
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
      setMultiDrafts([])
      setMultiShared({ warehouse: '', type: '', owner: '', project: '' })
      setMultiDockDoors([])
      setMultiResults(null)
      setMultiDraftCreated(false)
      setMultiApproveError(null)
      setMultiConfirming(false)
      setLcDraft({})
      setLcApproved(false)
      setLcApproveError(null)
      setLcApproveWarning(null)
      setLcConfirming(false)
      setLcDraftCreated(false)
      setLcCreatedId(null)
      return () => controller.abort()
    }

    setPluginView('appointment')
    setLoadingRecord(true)
    setNotFound(false)
    setSubmission(null)
    setDraft({})
    setApproved(false)
    setApproveError(null)
    setSaveError(null)
    setSaved(false)
    setDryRunPayload(null)
    setDatexProcessing(false)
    setDatexAppointmentId(null)
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
    setMultiDrafts([])
    setMultiShared({ warehouse: '', type: '', owner: '', project: '' })
    setMultiDockDoors([])
    setMultiResults(null)
    setMultiDraftCreated(false)
    setMultiApproveError(null)
    setMultiConfirming(false)
    setLcDraft({})
    setLcApproved(false)
    setLcApproveError(null)
    setLcApproveWarning(null)
    setLcConfirming(false)
    setLcDraftCreated(false)
    setLcCreatedId(null)

    getSubmissions({ front_conversation_id: conversationId }, controller.signal)
      .then((data) => {
        if (sessionRef.current !== token) return
        if (data.length === 0) {
          setNotFound(true)
          setDraft(buildEmptyDraft(lookups.warehouses, lookups.types))
        } else {
          const sub = data[0]
          setSubmission(sub)
          setDraft(buildDraft(sub))
          setPluginView('appointment')

          if (sub.status === 'processing') {
            setDatexProcessing(true)
            startPolling(sub.id)
          }

          const warehouse = normalizeWarehouse(sub.warehouse || '')
          setMultiShared({ warehouse, type: sub.type || '', owner: sub.owner || '', project: sub.project || '' })
          if (warehouse) fetchMultiDockDoors(warehouse)

          const refNums = sub.reference_number ? sub.reference_number.split(',').map((r) => r.trim()).filter(Boolean) : []

          if (refNums.length > 1) {
            const dateOnly = (sub.scheduled_arrival || '').slice(0, 10)
            setMultiDrafts(
              refNums.map((po) => {
                const slot = { ...buildEmptySlot(), reference_number: po, scheduled_arrival: dateOnly }
                if (sub.project && po) {
                  const abbr = findAbbreviation(sub.project, abbreviations)
                  const prefix = abbr ? `(${abbr})` : sub.project
                  slot.appointment_lookup_code = `${prefix} - ${po}`
                }
                return slot
              })
            )
          }
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        if (sessionRef.current !== token) return
        setNotFound(true)
        setDraft(buildEmptyDraft(lookups.warehouses, lookups.types))
      })
      .finally(() => {
        if (sessionRef.current !== token) return
        setLoadingRecord(false)
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  const handleFieldChange = (key, value) => {
    setSaved(false)
    setSaveError(null)
    setDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'project' && value && !prev.owner) {
        const owner = projectOwnerMapRef.current[value.toLowerCase()]
        if (owner) next.owner = owner
      }
      return next
    })
  }

  // ── Load Container handlers ──────────────────────────────────────────────

  async function fetchLcDockDoors(warehouse) {
    if (!warehouse) return
    setLcDockDoorsLoading(true)
    try {
      let pairs = await getLookupOptionsWithIds('dock_doors', warehouse)
      if (!pairs.length) {
        const names = await getLookupOptions('dock_doors').catch(() => [])
        pairs = names.map((n) => ({ name: n, id: null }))
      }
      if (pairs.length > 0 && typeof pairs[0] !== 'object') pairs = pairs.map((n) => ({ name: n, id: null }))
      setLcDockDoors(pairs.map((p) => p.name))
      setNameToId((prev) => ({
        ...prev,
        dock_doors: { ...prev.dock_doors, ...Object.fromEntries(pairs.map((p) => [p.name.toLowerCase(), p.id])) },
      }))
    } catch {
      setLcDockDoors([])
    } finally {
      setLcDockDoorsLoading(false)
    }
  }

  const handleLcFieldChange = (key, value) => {
    setLcDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'project' && value && !prev.owner) {
        const owner = projectOwnerMapRef.current[value.toLowerCase()]
        if (owner) next.owner = owner
      }
      return next
    })
  }

  const handleLcPushClick = () => {
    const idEdits = computeIdEdits(lcDraftRef.current, nameToIdRef.current)
    const draftWithIds = { ...lcDraftRef.current, ...idEdits }
    const missing = validateForLCPush(draftWithIds)
    if (missing.length > 0) {
      setLcApproveError(`Missing required fields: ${missing.join(', ')}`)
      return
    }
    setLcApproveError(null)
    setLcConfirming(true)
  }

  const handleLcApprove = async () => {
    if (submitGuardRef.current) return
    submitGuardRef.current = true
    setLcConfirming(false)
    setLcApproving(true)
    setLcApproveError(null)
    setLcApproveWarning(null)
    setLcCreatedId(null)

    const currentDraft = lcDraftRef.current
    const sessionToken = sessionRef.current
    const capturedConvId = conversationIdRef.current

    try {
      const orderTypeId = deriveOrderTypeId(currentDraft.type)
      const lcResult = await createLoadContainer({ lookupcode: currentDraft.container_lookup_code, orderTypeId, priority: 5 })

      if (sessionRef.current !== sessionToken) return
      if (lcResult.dry_run) {
        setLcApproveError(`No Datex API key configured (dry run). Load container payload: ${JSON.stringify(lcResult.payload)}`)
        return
      }
      if (!lcResult.ok) {
        throw new Error(lcResult.error || 'Load container creation failed')
      }
      if (lcResult.warning) setLcApproveWarning(lcResult.warning)

      setLcCreatedId(lcResult.loadcontainerId ?? null)

      const { container_lookup_code: _excluded, ...appointmentFields } = currentDraft
      const textFields = Object.fromEntries(Object.entries(appointmentFields).filter(([, v]) => v !== '' && v != null))
      const idEdits = computeIdEdits(currentDraft, nameToIdRef.current)
      const fields = { ...textFields, ...idEdits, load_container_id: lcResult.loadcontainerId }

      const newRecord = await createSubmission(capturedConvId, fields)
      if (!newRecord?.id) throw new Error(`Submission created but returned no ID (got: ${JSON.stringify(newRecord)?.slice(0, 200)})`)

      if (sessionRef.current !== sessionToken) return

      const result = await approveSubmission(newRecord.id, capturedConvId, undefined, 'plugin', draftTemplate)
      if (sessionRef.current !== sessionToken) return

      if (result.dry_run) {
        setLcApproveError('No Datex API key configured for appointment push (dry run).')
      } else {
        await pushToDatexBackground(result.id, 'plugin', draftTemplate, autoEmail)
        if (sessionRef.current !== sessionToken) return
        setDatexProcessing(true)
        startLcPolling(result.id)
      }
    } catch (e) {
      if (sessionRef.current !== sessionToken) return
      const createdId = lcCreatedId
      if (createdId != null) {
        setLcApproveError(`Load container created (ID: ${createdId}). Appointment was not submitted — safe to retry the appointment only. Details: ${e.message}`)
      } else if (createdId === null && e.message && !e.message.includes('Load container')) {
        setLcApproveError(`Load container created (no ID returned). Appointment was not submitted — safe to retry the appointment only. Details: ${e.message}`)
      } else {
        setLcApproveError(e.message)
      }
    } finally {
      submitGuardRef.current = false
      setLcApproving(false)
    }
  }

  // ── Background Datex push polling ────────────────────────────────────────
  function startPolling(recordId) {
    if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current)

    const sessionToken = sessionRef.current
    const startTime = Date.now()
    const TIMEOUT_MS = 30_000

    pollingIntervalRef.current = setInterval(async () => {
      if (sessionRef.current !== sessionToken) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
        return
      }
      if (Date.now() - startTime > TIMEOUT_MS) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
        setDatexProcessing(false)
        const timeoutMsg = 'Timed out waiting for Datex confirmation — verify in Datex and retry if needed.'
        setApproveWarning(timeoutMsg)
        try {
          const data = await getSubmissions({ front_conversation_id: conversationIdRef.current })
          const rec = data.find((r) => r.id === recordId && r.status === 'processing')
          if (rec) {
            await saveSubmission(rec.id, null, { status: 'failed', datex_error: timeoutMsg })
            setSubmission((prev) => ({ ...prev, status: 'failed', datex_error: timeoutMsg }))
          }
        } catch {
          /* non-fatal */
        }
        return
      }
      try {
        const data = await getSubmissions({ front_conversation_id: conversationIdRef.current })
        if (sessionRef.current !== sessionToken) {
          clearInterval(pollingIntervalRef.current)
          pollingIntervalRef.current = null
          return
        }
        const record = data.find((r) => r.id === recordId)
        if (!record) return
        if (record.status === 'approved') {
          clearInterval(pollingIntervalRef.current)
          pollingIntervalRef.current = null
          setDatexProcessing(false)
          setApproved(true)
          if (record.datex_appointment_id != null) setDatexAppointmentId(record.datex_appointment_id)
          if (record.datex_error) setApproveWarning(record.datex_error)
          setSubmission(record)
        } else if (record.status === 'failed') {
          clearInterval(pollingIntervalRef.current)
          pollingIntervalRef.current = null
          setDatexProcessing(false)
          setApproveError(record.datex_error || 'Datex push failed — check Datex directly.')
          setSubmission(record)
        }
      } catch {
        /* keep polling */
      }
    }, 2000)
  }

  function startLcPolling(recordId) {
    if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current)
    const sessionToken = sessionRef.current
    const startTime = Date.now()
    const TIMEOUT_MS = 30_000
    pollingIntervalRef.current = setInterval(async () => {
      if (sessionRef.current !== sessionToken) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
        return
      }
      if (Date.now() - startTime > TIMEOUT_MS) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
        setDatexProcessing(false)
        const timeoutMsg = 'Timed out waiting for Datex confirmation — verify in Datex and retry if needed.'
        setLcApproveWarning(timeoutMsg)
        try {
          const data = await getSubmissions({ front_conversation_id: conversationIdRef.current })
          const rec = data.find((r) => r.id === recordId && r.status === 'processing')
          if (rec) {
            await saveSubmission(rec.id, null, { status: 'failed', datex_error: timeoutMsg })
          }
        } catch {
          /* non-fatal */
        }
        return
      }
      try {
        const data = await getSubmissions({ front_conversation_id: conversationIdRef.current })
        if (sessionRef.current !== sessionToken) {
          clearInterval(pollingIntervalRef.current)
          pollingIntervalRef.current = null
          return
        }
        const record = data.find((r) => r.id === recordId)
        if (!record) return
        if (record.status === 'approved') {
          clearInterval(pollingIntervalRef.current)
          pollingIntervalRef.current = null
          setDatexProcessing(false)
          setLcApproved(true)
          setSubmission(record)
          setDraft(buildDraft(record))
          setNotFound(false)
          if (record.datex_error) setLcApproveWarning(record.datex_error)
        } else if (record.status === 'failed') {
          clearInterval(pollingIntervalRef.current)
          pollingIntervalRef.current = null
          setDatexProcessing(false)
          setLcApproveError(record.datex_error || 'Datex push failed — check Datex directly.')
        }
      } catch {
        /* keep polling */
      }
    }, 2000)
  }

  // ── Multi APPT handlers ──────────────────────────────────────────────────

  async function fetchMultiDockDoors(warehouse) {
    if (!warehouse) return
    setMultiDockDoorsLoading(true)
    try {
      let pairs = await getLookupOptionsWithIds('dock_doors', warehouse)
      if (!pairs.length) {
        const names = await getLookupOptions('dock_doors').catch(() => [])
        pairs = names.map((n) => ({ name: n, id: null }))
      }
      if (pairs.length > 0 && typeof pairs[0] !== 'object') pairs = pairs.map((n) => ({ name: n, id: null }))
      setMultiDockDoors(pairs.map((p) => p.name))
      setNameToId((prev) => ({
        ...prev,
        dock_doors: { ...prev.dock_doors, ...Object.fromEntries(pairs.map((p) => [p.name.toLowerCase(), p.id])) },
      }))
    } catch {
      setMultiDockDoors([])
    } finally {
      setMultiDockDoorsLoading(false)
    }
  }

  const handleMultiSharedChange = (key, value) => {
    setMultiShared((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'owner' && next.project) {
        const map = ownerProjectMapRef.current
        if (Object.keys(map).length > 0) {
          const ownerProjects = map[value?.toLowerCase()]
          if (ownerProjects?.length > 0 && !ownerProjects.includes(next.project)) next.project = ''
        }
      }
      if (key === 'project' && value && !prev.owner) {
        const owner = projectOwnerMapRef.current[value.toLowerCase()]
        if (owner) next.owner = owner
      }
      return next
    })
    if (key === 'project') {
      setMultiDrafts((prev) =>
        prev.map((slot) => {
          if (!slot.reference_number) return slot
          const effectiveProject = slot.project || value
          if (!effectiveProject) return slot
          const abbr = findAbbreviation(effectiveProject, abbreviations)
          const prefix = abbr ? `(${abbr})` : effectiveProject
          return { ...slot, appointment_lookup_code: `${prefix} - ${slot.reference_number.trim()}` }
        })
      )
    }
  }

  const handleMultiFieldChange = (slotIndex, key, value) => {
    setMultiDrafts((prev) => {
      const next = [...prev]
      const slot = { ...next[slotIndex], [key]: value }
      if (key === 'project' && value && !slot.owner) {
        const owner = projectOwnerMapRef.current[value.toLowerCase()]
        if (owner) slot.owner = owner
      }
      if (key === 'reference_number' || key === 'project') {
        const effectiveProject = key === 'project' ? value : slot.project || multiSharedRef.current.project
        const effectiveRef = key === 'reference_number' ? value : slot.reference_number
        if (effectiveProject && effectiveRef) {
          const abbr = findAbbreviation(effectiveProject, abbreviations)
          const prefix = abbr ? `(${abbr})` : effectiveProject
          slot.appointment_lookup_code = `${prefix} - ${effectiveRef.trim()}`
        }
      }
      next[slotIndex] = slot
      return next
    })
  }

  const handleMultiPushClick = () => {
    const errors = []
    multiDrafts.forEach((slot, i) => {
      const merged = buildMergedSlot(slot, multiSharedRef.current, nameToIdRef.current)
      const mergedWithIds = { ...merged, ...computeIdEdits(merged, nameToIdRef.current) }
      const missing = validateForPush(mergedWithIds)
      if (missing.length > 0) errors.push(`Appointment ${i + 1}: missing ${missing.join(', ')}`)
    })
    if (errors.length > 0) {
      setMultiApproveError(errors.join(' \u2022 '))
      return
    }
    setMultiApproveError(null)
    setMultiConfirming(true)
  }

  const handleApproveAll = async () => {
    if (submitGuardRef.current) return
    submitGuardRef.current = true
    const sessionToken = sessionRef.current
    try {
      setMultiConfirming(false)
      setMultiApproving(true)
      setMultiApproveError(null)
      const results = []
      const pushedIds = []
      const batchStartedAt = new Date(Date.now() - 5000).toISOString()
      for (const slotDraft of multiDrafts) {
        try {
          const merged = buildMergedSlot(slotDraft, multiSharedRef.current, nameToIdRef.current)
          const fields = {
            ...Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '' && v != null)),
            ...computeIdEdits(merged, nameToIdRef.current),
          }
          const record = await createSubmission(conversationIdRef.current, fields)
          if (!record?.id) throw new Error(`Submission created but returned no ID (got: ${JSON.stringify(record)?.slice(0, 200)})`)
          const approveResult = await approveSubmission(record.id, conversationIdRef.current, undefined, 'batch', undefined)
          if (approveResult?.dry_run) throw new Error('No Datex API key configured (dry run)')
          await pushToDatexBackground(record.id, 'batch')
          pushedIds.push(record.id)
          results.push({ ok: true, lookup_code: merged.appointment_lookup_code })
        } catch (e) {
          results.push({ ok: false, error: e.message })
        }
      }
      if (sessionRef.current !== sessionToken) return
      setMultiResults(results)
      setMultiApproving(false)
      if (results.length > 0) {
        if (pushedIds.length > 0) {
          const TIMEOUT_MS = 30_000
          const startTime = Date.now()
          await new Promise((resolve) => {
            const interval = setInterval(async () => {
              if (sessionRef.current !== sessionToken || Date.now() - startTime > TIMEOUT_MS) {
                clearInterval(interval)
                resolve()
                return
              }
              try {
                const data = await getSubmissions({ front_conversation_id: conversationIdRef.current })
                const stillProcessing = pushedIds.some((id) => {
                  const rec = data.find((r) => r.id === id)
                  return !rec || rec.status === 'processing'
                })
                if (!stillProcessing) {
                  clearInterval(interval)
                  resolve()
                }
              } catch {
                /* keep polling */
              }
            }, 2000)
          })
        }
        if (sessionRef.current !== sessionToken) return
        try {
          await triggerMultiFrontDraft(conversationIdRef.current, batchStartedAt, multiDraftTemplate)
          if (sessionRef.current !== sessionToken) return
          setMultiDraftCreated(true)
        } catch (e) {
          if (sessionRef.current !== sessionToken) return
          setMultiApproveError(`Draft failed: ${e.message}`)
        }
      }
    } finally {
      submitGuardRef.current = false
    }
  }

  const handleSave = async () => {
    const sub = submissionRef.current
    const currentDraft = draftRef.current
    if (!sub) return
    const edits = computeEdits(currentDraft, sub)
    if (!Object.keys(edits).length) return
    const sessionToken = sessionRef.current
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      await saveSubmission(sub.id, conversationIdRef.current, edits)
      if (sessionRef.current !== sessionToken) return
      const updatedSub = { ...sub, ...edits }
      setSubmission(updatedSub)
      setDraft(buildDraft(updatedSub))
      setSaved(true)
    } catch (e) {
      if (sessionRef.current !== sessionToken) return
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handlePushClick = () => {
    const idEdits = computeIdEdits(draftRef.current, nameToIdRef.current)
    const draftWithIds = { ...draftRef.current, ...idEdits }
    const missing = validateForPush(draftWithIds)
    if (missing.length > 0) {
      setApproveError(`Missing required fields: ${missing.join(', ')}`)
      return
    }
    setApproveError(null)
    setConfirmingApprove(true)
  }

  const handleApprove = async () => {
    if (submitGuardRef.current) return
    submitGuardRef.current = true
    const sub = submissionRef.current
    const currentDraft = draftRef.current
    if (!sub) {
      submitGuardRef.current = false
      return
    }
    const sessionToken = sessionRef.current
    setConfirmingApprove(false)
    const edits = computeEdits(currentDraft, sub)
    const idEdits = computeIdEdits(currentDraft, nameToIdRef.current)
    const allEdits = { ...edits, ...idEdits }
    setApproving(true)
    setApproveError(null)
    setApproveWarning(null)
    setDryRunPayload(null)
    setDatexProcessing(false)
    setDatexAppointmentId(null)
    setSubmission((prev) => ({ ...prev, datex_error: null }))
    try {
      const result = await approveSubmission(sub.id, conversationIdRef.current, Object.keys(allEdits).length ? allEdits : undefined, 'plugin', draftTemplate)
      if (sessionRef.current !== sessionToken) return
      if (result.dry_run) {
        setDryRunPayload(result.payload)
        return
      }
      await pushToDatexBackground(result.id, 'plugin', draftTemplate, autoEmail)
      if (sessionRef.current !== sessionToken) return
      setSubmission((prev) => ({ ...prev, ...edits, status: 'processing' }))
      setDatexProcessing(true)
      startPolling(result.id)
    } catch (e) {
      if (sessionRef.current !== sessionToken) return
      setApproveError(e.message)
    } finally {
      submitGuardRef.current = false
      setApproving(false)
    }
  }
  function buildCreateFields(currentDraft) {
    const textFields = Object.fromEntries(Object.entries(currentDraft).filter(([, v]) => v !== '' && v != null))
    return { ...textFields, ...computeIdEdits(currentDraft, nameToIdRef.current) }
  }

  const handleCreate = async () => {
    const fields = buildCreateFields(draftRef.current)
    const sessionToken = sessionRef.current
    setCreating(true)
    setSaveError(null)
    try {
      const newRecord = await createSubmission(conversationIdRef.current, fields)
      if (sessionRef.current !== sessionToken) return
      setSubmission(newRecord)
      setDraft(buildDraft(newRecord))
      setNotFound(false)
      setSaved(true)
    } catch (e) {
      if (sessionRef.current !== sessionToken) return
      setSaveError(e.message)
    } finally {
      setCreating(false)
    }
  }

  const handleCreateAndApprove = async () => {
    if (submitGuardRef.current) return
    submitGuardRef.current = true
    const sessionToken = sessionRef.current
    setConfirmingApprove(false)
    const fields = buildCreateFields(draftRef.current)
    setCreating(true)
    setApproveError(null)
    setDryRunPayload(null)
    let newRecord
    try {
      newRecord = await createSubmission(conversationIdRef.current, fields)
      if (sessionRef.current !== sessionToken) {
        submitGuardRef.current = false
        setCreating(false)
        return
      }
      setSubmission(newRecord)
      setDraft(buildDraft(newRecord))
      setNotFound(false)
    } catch (e) {
      submitGuardRef.current = false
      setCreating(false)
      if (sessionRef.current !== sessionToken) return
      setSaveError(e.message)
      return
    }
    setCreating(false)
    setApproving(true)
    setDatexProcessing(false)
    setDatexAppointmentId(null)
    try {
      const result = await approveSubmission(newRecord.id, conversationIdRef.current, undefined, 'plugin', draftTemplate)
      if (sessionRef.current !== sessionToken) return
      if (result.dry_run) {
        setDryRunPayload(result.payload)
        return
      }
      await pushToDatexBackground(result.id, 'plugin', draftTemplate, autoEmail)
      if (sessionRef.current !== sessionToken) return
      setSubmission((prev) => ({ ...prev, status: 'processing' }))
      setDatexProcessing(true)
      startPolling(result.id)
    } catch (e) {
      if (sessionRef.current !== sessionToken) return
      setApproveError(e.message)
    } finally {
      submitGuardRef.current = false
      setApproving(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const dirty = !!submission && Object.keys(computeEdits(draft, submission)).length > 0

  const appointmentContent = (() => {
    const msg =
      contextType === 'noConversation'
        ? 'Open a conversation to view carrier data.'
        : contextType === 'multiConversations'
        ? 'Select a single conversation to view carrier data.'
        : loadingRecord
        ? 'Loading…'
        : null
    if (!msg) return null
    return <p className="mt-16 text-sm text-gray-400 text-center px-4 leading-relaxed">{msg}</p>
  })()

  return (
    <div className="bg-white min-h-full p-4">
      <CswBrandHeader />

      {/* Tab switcher */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 mb-4">
        <button
          onClick={() => setPluginView('appointment')}
          className={`flex-1 py-1 rounded-md text-xs font-medium transition-colors ${pluginView === 'appointment' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
        >
          {submission ? submission.carrier || 'Single APPT' : 'Single APPT'}
        </button>
        <button
          onClick={() => {
            setPluginView('loadContainer')
            if (!submissionRef.current && !lcDraftRef.current.warehouse) {
              const warehouse = lookups.warehouses[0] ?? WAREHOUSE_FALLBACK[0] ?? ''
              const type = lookups.types[0] ?? TYPE_FALLBACK[0] ?? ''
              setLcDraft({
                warehouse,
                type,
                owner: '',
                project: '',
                scheduled_arrival: '',
                scheduled_dock_door: '',
                carrier: '',
                reference_number: '',
                appointment_lookup_code: '',
                notes: '',
                container_lookup_code: '',
              })
            }
          }}
          className={`flex-1 py-1 rounded-md text-xs font-medium transition-colors ${pluginView === 'loadContainer' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
        >
          Load Container
        </button>
        <button
          onClick={() => {
            setPluginView('multi')
            if (multiDrafts.length === 0) {
              setMultiDrafts([buildEmptySlot()])
            }
            if (!submissionRef.current && !multiSharedRef.current.warehouse) {
              const warehouse = lookups.warehouses[0] ?? WAREHOUSE_FALLBACK[0] ?? ''
              const type = lookups.types[0] ?? TYPE_FALLBACK[0] ?? ''
              setMultiShared({ warehouse, type, owner: '', project: '' })
            }
          }}
          className={`flex-1 py-1 rounded-md text-xs font-medium transition-colors ${pluginView === 'multi' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
        >
          Multi APPT
        </button>
        <button
          onClick={() => setPluginView('recurring')}
          className={`flex-1 py-1 rounded-md text-xs font-medium transition-colors ${pluginView === 'recurring' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
        >
          Recurring
        </button>
        <button
          onClick={() => setPluginView('settings')}
          title="Settings"
          className={`py-1 px-2.5 rounded-md text-sm font-medium transition-colors ${pluginView === 'settings' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
        >
          ⚙
        </button>
      </div>

      {pluginView === 'settings' ? (
        <PluginSettingsPanel
          abbreviations={abbreviations}
          setAbbreviations={setAbbreviations}
          draftTemplate={draftTemplate}
          setDraftTemplate={setDraftTemplate}
          multiDraftTemplate={multiDraftTemplate}
          setMultiDraftTemplate={setMultiDraftTemplate}
          dockDoorRules={dockDoorRules}
          setDockDoorRules={setDockDoorRules}
          lookups={lookups}
        />
      ) : pluginView === 'recurring' ? (
        <RecurringForm compact />
      ) : pluginView === 'loadContainer' ? (
        <PluginLoadContainerTab
          contextType={contextType}
          conversationId={conversationId}
          lcDraft={lcDraft}
          lcDraftRef={lcDraftRef}
          handleLcFieldChange={handleLcFieldChange}
          lookups={lookups}
          lookupsLoading={lookupsLoading}
          lcFilteredProjects={lcFilteredProjects}
          lcDockDoors={lcDockDoors}
          lcDockDoorsLoading={lcDockDoorsLoading}
          datexProcessing={datexProcessing}
          lcApproved={lcApproved}
          lcApproveWarning={lcApproveWarning}
          lcDraftCreated={lcDraftCreated}
          lcApproveError={lcApproveError}
          lcConfirming={lcConfirming}
          setLcConfirming={setLcConfirming}
          lcApproving={lcApproving}
          handleLcPushClick={handleLcPushClick}
          handleLcApprove={handleLcApprove}
          autoEmail={autoEmail}
          setAutoEmail={setAutoEmail}
        />
      ) : pluginView === 'multi' ? (
        <PluginMultiApptTab
          contextType={contextType}
          conversationId={conversationId}
          multiShared={multiShared}
          handleMultiSharedChange={handleMultiSharedChange}
          multiDrafts={multiDrafts}
          setMultiDrafts={setMultiDrafts}
          multiDraftsRef={multiDraftsRef}
          handleMultiFieldChange={handleMultiFieldChange}
          multiDockDoors={multiDockDoors}
          multiDockDoorsLoading={multiDockDoorsLoading}
          lookups={lookups}
          lookupsLoading={lookupsLoading}
          ownerProjectMap={ownerProjectMap}
          multiResults={multiResults}
          setMultiResults={setMultiResults}
          multiDraftCreated={multiDraftCreated}
          setMultiDraftCreated={setMultiDraftCreated}
          multiApproveError={multiApproveError}
          setMultiApproveError={setMultiApproveError}
          multiConfirming={multiConfirming}
          setMultiConfirming={setMultiConfirming}
          multiApproving={multiApproving}
          handleMultiPushClick={handleMultiPushClick}
          handleApproveAll={handleApproveAll}
          buildEmptySlot={buildEmptySlot}
        />
      ) : appointmentContent ? (
        appointmentContent
      ) : (
        <>
          <div className="flex items-start justify-between mb-4 gap-2">
            <h2 className="text-base font-semibold text-gray-900 leading-tight">{submission ? submission.carrier || 'Carrier Submission' : 'Manual Entry'}</h2>
            {submission && <StatusBadge status={submission.status} />}
          </div>

          {notFound && (
            <div className="mb-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-xs">
              No submission found for this conversation. Use the fields below to manually create an appointment in Datex.
            </div>
          )}

          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <ComboBox small label="Warehouse" fieldKey="warehouse" value={draft.warehouse} options={lookups.warehouses} loading={lookupsLoading} onChange={handleFieldChange} />
              <ComboBox small label="Type" fieldKey="type" value={draft.type} options={lookups.types} loading={lookupsLoading} onChange={handleFieldChange} />
            </div>
            {draft.type === 'Outbound/Drop' && <p className="text-xs text-amber-600">Email confirmation will show Ready Time (arrival + 2 hrs)</p>}
            <div className="grid grid-cols-2 gap-2">
              <ComboBox small label="Project" fieldKey="project" value={draft.project} options={filteredProjects} loading={lookupsLoading} onChange={handleFieldChange} />
              <ComboBox small label="Owner" fieldKey="owner" value={draft.owner} options={lookups.owners} loading={lookupsLoading} onChange={handleFieldChange} />
            </div>
            <div className="grid grid-cols-[5fr_4fr_3fr] gap-1.5">
              <div>
                <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Arrival Date</label>
                <input
                  type="date"
                  value={(draft.scheduled_arrival || '').split('T')[0]}
                  onChange={(e) => {
                    const time = (draft.scheduled_arrival || '').includes('T') ? draft.scheduled_arrival.split('T')[1] : ''
                    handleFieldChange('scheduled_arrival', time ? `${e.target.value}T${time}` : e.target.value)
                  }}
                  className="w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5
                    hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400
                    bg-transparent focus:bg-white transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Arrival Time</label>
                <div className="flex items-center border border-transparent rounded px-1.5 py-1 -mx-1.5 hover:border-gray-300 focus-within:border-indigo-400 focus-within:ring-1 focus-within:ring-indigo-400 bg-transparent focus-within:bg-white transition-colors">
                  {(() => {
                    const timePart = (draft.scheduled_arrival || '').includes('T') ? draft.scheduled_arrival.split('T')[1] : ''
                    const { h24, min } = parseTime24(timePart)
                    const date = (draft.scheduled_arrival || '').split('T')[0]
                    return (
                      <>
                        <select
                          value={h24}
                          onChange={(e) => {
                            const t = buildTime24(e.target.value, '00')
                            if (t) handleFieldChange('scheduled_arrival', date ? `${date}T${t}` : t)
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
                            const cur = draftRef.current.scheduled_arrival || ''
                            const curH24 = parseTime24(cur.includes('T') ? cur.split('T')[1] : '').h24 || '00'
                            const t = buildTime24(curH24, e.target.value)
                            if (t) handleFieldChange('scheduled_arrival', date ? `${date}T${t}` : t)
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
                <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Dur.</label>
                <select
                  value={draft.appt_duration || '30'}
                  onChange={(e) => handleFieldChange('appt_duration', e.target.value)}
                  className="w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5 hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-transparent focus:bg-white transition-colors cursor-pointer"
                >
                  <option value="30">30 min</option>
                  <option value="60">60 min</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ComboBox small label="Dock Door" fieldKey="scheduled_dock_door" value={draft.scheduled_dock_door} options={lookups.dock_doors} loading={dockDoorsLoading} onChange={handleFieldChange} />
              <ComboBox small label="Carrier" fieldKey="carrier" value={draft.carrier} options={lookups.carriers} loading={lookupsLoading} onChange={handleFieldChange} />
            </div>
            <EditableField label="Reference #" fieldKey="reference_number" value={draft.reference_number} onChange={handleFieldChange} />
            <EditableField label="Appointment Code" fieldKey="appointment_lookup_code" value={draft.appointment_lookup_code} onChange={handleFieldChange} />
            <EditableField label="Notes" fieldKey="notes" value={draft.notes} onChange={handleFieldChange} />
          </div>

          {submission && (
            <dl className="space-y-3 mt-3">
              {submission.datex_pushed_at && <ReadOnlyField label="Pushed to Datex" value={new Date(submission.datex_pushed_at).toLocaleString()} />}
              {submission.datex_appointment_id && <ReadOnlyField label="Datex Appointment ID" value={String(submission.datex_appointment_id)} />}
              {submission.datex_error && (
                <div>
                  <dt className="text-xs font-medium text-red-400 uppercase tracking-wide">Datex Error</dt>
                  <dd className="mt-0.5 text-sm text-red-700 break-words">
                    {submission.datex_error.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {saved && <div className="mt-4 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">Changes saved.</div>}
          {saveError && <div className="mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{saveError}</div>}

          {datexProcessing && (
            <div className="mt-4 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm flex items-start gap-2">
              <svg className="animate-spin h-4 w-4 shrink-0 mt-0.5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>
                <span className="font-semibold block">Submitted to Datex</span>
                <span className="text-xs text-blue-600">Push and draft creation run in the background — you can move to the next email now.</span>
              </span>
            </div>
          )}
          {approved && !approveWarning && (
            <div className="mt-4 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
              <p className="font-medium">{datexAppointmentId != null ? `Confirmed — Appt #${datexAppointmentId}` : 'Confirmed and pushed to Datex.'}</p>
              <p className="text-xs mt-0.5 text-green-600">Confirmation draft created in Front.</p>
            </div>
          )}
          {submission?.status === 'approved' && (
            <div className="mt-4 border border-green-200 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-white">
                {draftCreated ? (
                  <p className="text-xs text-green-600 font-medium">Draft created in Front.</p>
                ) : (
                  <>
                    <button
                      onClick={async () => {
                        setDraftCreating(true)
                        setDraftError(null)
                        try {
                          await triggerFrontDraft(submission.id, conversationIdRef.current, draftTemplate)
                          setDraftCreated(true)
                        } catch (e) {
                          setDraftError(e.message)
                        } finally {
                          setDraftCreating(false)
                        }
                      }}
                      disabled={draftCreating}
                      className={`w-full py-1.5 px-3 text-xs font-medium rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
                        approved ? 'bg-white border border-gray-300 text-gray-500 hover:bg-gray-50' : 'bg-indigo-600 text-white hover:bg-indigo-700'
                      }`}
                    >
                      {draftCreating ? 'Creating draft…' : approved ? 'Resend Confirmation Draft' : 'Create Confirmation Draft in Front'}
                    </button>
                    {draftError && <p className="mt-1.5 text-xs text-red-600">{draftError}</p>}
                  </>
                )}
              </div>
            </div>
          )}
          {approveWarning && (
            <div className="mt-4 px-3 py-2 bg-amber-50 border border-amber-300 rounded-lg text-amber-800 text-sm">
              {approved && <p className="font-medium">Approved — verify in Datex</p>}
              <p className={approved ? 'mt-0.5 text-xs' : ''}>{approveWarning}</p>
            </div>
          )}
          {approveError && <div className="mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{approveError}</div>}

          {dryRunPayload && (
            <div className="mt-4 border border-amber-300 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-amber-50 border-b border-amber-300">
                <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Dry Run — Payload Preview</p>
                <p className="text-xs text-amber-700 mt-0.5">No API key configured. This is what would be sent to Datex.</p>
              </div>
              <pre className="px-3 py-2 text-xs text-gray-800 bg-white overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(dryRunPayload, null, 2)}</pre>
            </div>
          )}

          {notFound ? (
            <div className="mt-5 space-y-2">
              {confirmingApprove ? (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-2">
                  <p className="text-xs text-indigo-800 font-medium">Create this appointment and push to Datex?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreateAndApprove}
                      disabled={creating || approving}
                      className="flex-1 py-1.5 px-3 bg-indigo-600 text-white text-xs font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                    >
                      {creating || approving ? 'Processing…' : 'Yes, create & push'}
                    </button>
                    <button
                      onClick={() => setConfirmingApprove(false)}
                      className="flex-1 py-1.5 px-3 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-end gap-2">
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs text-gray-500 whitespace-nowrap">Auto Send Email</span>
                    <button
                      type="button"
                      onClick={() => setAutoEmail((v) => !v)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${autoEmail ? 'bg-indigo-600' : 'bg-gray-300'}`}
                      aria-pressed={autoEmail}
                    >
                      <span className="sr-only">Auto email</span>
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${autoEmail ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>
                  <button
                    onClick={handlePushClick}
                    disabled={creating || approving}
                    className="flex-1 py-2.5 px-4 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Create & Push to Datex
                  </button>
                </div>
              )}
              {!confirmingApprove && (
                <button
                  onClick={handleCreate}
                  disabled={creating || approving}
                  className="w-full py-2 px-4 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {creating ? 'Saving…' : 'Save as Draft'}
                </button>
              )}
            </div>
          ) : submission ? (
            <div className="mt-5 space-y-2">
              {dirty && (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full py-2 px-4 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              )}
              {(submission.status === 'pending' || submission.status === 'failed') &&
                !approved &&
                !datexProcessing &&
                (confirmingApprove ? (
                  <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-2">
                    <p className="text-xs text-indigo-800 font-medium">Approve and push this appointment to Datex?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleApprove}
                        disabled={approving}
                        className="flex-1 py-1.5 px-3 bg-indigo-600 text-white text-xs font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                      >
                        {approving ? 'Approving…' : 'Yes, approve & push'}
                      </button>
                      <button
                        onClick={() => setConfirmingApprove(false)}
                        className="flex-1 py-1.5 px-3 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-end gap-2">
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-xs text-gray-500 whitespace-nowrap">Auto Send Email</span>
                      <button
                        type="button"
                        onClick={() => setAutoEmail((v) => !v)}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${autoEmail ? 'bg-indigo-600' : 'bg-gray-300'}`}
                        aria-pressed={autoEmail}
                      >
                        <span className="sr-only">Auto email</span>
                        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${autoEmail ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </div>
                    <button
                      onClick={handlePushClick}
                      disabled={approving}
                      className="flex-1 py-2.5 px-4 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Approve & Push to Datex
                    </button>
                  </div>
                ))}
            </div>
          ) : null}

          <AppointmentInsights
            warehouse={draft.warehouse || null}
            date={(() => {
              const d = (draft.scheduled_arrival || '').split('T')[0]
              return d || null
            })()}
            selectedHour={(() => {
              const timePart = (draft.scheduled_arrival || '').includes('T') ? draft.scheduled_arrival.split('T')[1] : null
              if (!timePart) return null
              const h = parseInt(timePart.split(':')[0], 10)
              return isNaN(h) ? null : h
            })()}
            selectedOwner={draft.owner || null}
            project={draft.project || null}
          />
        </>
      )}
    </div>
  )
}
