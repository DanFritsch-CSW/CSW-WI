import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  fetchPviCanonicalAccounts,
  fetchPviAccountNameMap,
  fetchPviMaterialSpecs,
  fetchPviLotDispositions,
  upsertPviLotDisposition,
  insertPviShelfNote,
} from '../lib/supabase.js'
import {
  fetchPviShelfNotesActive,
  updatePviShelfNoteStatusAudited,
  softDeletePviShelfNote,
  fetchPviLotDispositionHistory,
} from '../lib/pviAudit.js'
import {
  buildRawNameToCanonical,
  projectFefo,
  STAGE_META,
  STAGE_ORDER,
  DEFAULT_STAGES,
  DISPOSITION_OPTIONS,
  DISPOSITION_META,
  PROJECT_CODE_MAP,
  formatProjectLabel,
  formatLotForEmail,
  bulkCopyForEmail,
} from '../lib/pviShelfLife.js'

// PVI At Risk Inventory Manager (formerly "PVI Shelf Life").
//
// App title change (2026-07-07, Hill): "change the app title to Palermo's
// At Risk Inventory Manager." Document.title is set below via useEffect so
// both the standalone build (cswpvi.netlify.app) and the main app show the
// new name in the browser tab whenever this component is mounted.
//
// Loads five things in parallel:
//   1. Live risk snapshot from /.netlify/functions/pvi-shelf-life
//   2. Canonical accounts + raw-name map from Supabase
//   3. Notes from Supabase
//   4. Material specs (pvi_material_specs) — ops-curated per-material
//      shelf-life days. Wins over allocation/history in the engine's spec
//      priority (see src/lib/pviShelfLife.js docs).
//   5. Lot dispositions (pvi_lot_dispositions) — Hill's per-lot Tag +
//      Owner tags (2026-07-07). Sticks with the lot until changed.
//
// Then runs FEFO projection client-side and merges dispositions onto rows
// keyed on `${material_code}|${lot_code}`. Renders a filterable table with
// STAGE + DISPOSITION badges and inline OWNER text. Side drawer for per-lot
// notes + disposition/owner editing.
//
// Sortable columns (2026-07-07, Hill): every column header (except the
// trailing action column) is clickable and toggles asc → desc → clear.
// Default severity-first sort applies when no column is active.
//
// CSV export (2026-07-07, Hill): "Export CSV" button exports the currently-
// filtered, currently-sorted row set with all detail columns including the
// new Disposition + Owner tags.
//
// Shortfall label wording (2026-07-07, Hill): "Xd short" read as a failure/
// problem state to Hill, when in most cases it's just describing where the
// FEFO-projected ship date lands relative to spec — not a foregone loss.
// Renamed to "Xd projected ship" in both the row's Vs. spec column and the
// drawer header so the language stays neutral/descriptive.
//
// Project code mapping + multi-select (2026-07-07, Hill): Palermo's
// internal project numbers (PALVI9=247, PALDSD9=243, PALMA9=248) don't
// exist in Datex/Omni — they're purely Palermo's own bookkeeping. Hill
// asked that both codes show together everywhere a project appears, that
// the project filter support picking more than one at once, and that the
// dashboard default to 247 (PALVI9) only on load. See PROJECT_CODE_MAP /
// formatProjectLabel in src/lib/pviShelfLife.js for the mapping itself.
// The project filter changed from a single <select> to a checkbox
// multi-select popover; the underlying state is a Set of raw project_lookup
// codes. An empty Set means "no restriction" (all projects) — Hill can
// clear the filter down to nothing if she wants to see everything.

const STAGES_FOR_TABS = ['expired', 'unshippable', 'critical', 'at_risk', 'watch']

// Raw Omni project_lookup codes this dashboard knows about. Order here
// drives both the multi-select popover and CSV/email — kept in the same
// order as PROJECT_CODE_MAP was documented to Hill (247, 243, 248 order
// would read oddly since PALVI9/247 is the default/primary project).
const PROJECT_LOOKUPS = ['PALVI9', 'PALDSD9', 'PALMA9']

// Default project selection on load. Hill: "default filters to 247 for
// project... (don't select expired or unshippable as default)." Stage
// defaults already live in DEFAULT_STAGES (pviShelfLife.js) — this is the
// project-side counterpart.
const DEFAULT_PROJECT_FILTERS = new Set(['PALVI9'])

// Sort accessors for each sortable column. Return the value used for
// comparison. Nulls sort last regardless of direction (see compareRows).
const SORT_ACCESSORS = {
  stage:       r => STAGE_ORDER.indexOf(r.verdict?.stage ?? 'watch'),
  material:    r => (r.material_code || '').toUpperCase(),
  lot:         r => (r.lot_code || '').toUpperCase(),
  expiration:  r => r.expiration_date_iso ? Date.parse(r.expiration_date_iso) : null,
  daysToCode:  r => r.days_to_code_today,
  spec:        r => r.shortfall_days,
  available:   r => r.cases_available,
  projected:   r => r.primary?.projected_ship_iso ? Date.parse(r.primary.projected_ship_iso) : null,
  velocity:    r => r.velocity?.shipments_30d ?? null,
  disposition: r => (r.disposition || '').toUpperCase() || null,
  owner:       r => (r.owner || '').toUpperCase() || null,
}

function compareRows(a, b, key, direction) {
  const acc = SORT_ACCESSORS[key]
  if (!acc) return 0
  const av = acc(a)
  const bv = acc(b)
  // Nulls last regardless of direction — always push blanks to the bottom.
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  if (typeof av === 'string' && typeof bv === 'string') {
    const cmp = av.localeCompare(bv)
    return direction === 'asc' ? cmp : -cmp
  }
  if (av < bv) return direction === 'asc' ? -1 : 1
  if (av > bv) return direction === 'asc' ? 1 : -1
  return 0
}

// CSV row escape — wrap in quotes if the value contains a delimiter, quote,
// or newline; escape embedded quotes by doubling.
function csvEscape(v) {
  if (v == null) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export default function PviShelfLife() {
  const [snapshot, setSnapshot]         = useState(null)
  const [canonicals, setCanonicals]     = useState([])
  const [nameMap, setNameMap]           = useState([])
  const [notes, setNotes]               = useState([])
  const [materialSpecs, setMaterialSpecs] = useState([])
  const [dispositions, setDispositions] = useState([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState(null)
  const [reloadTick, setReloadTick]     = useState(0)

  // Filters
  const [enabledStages, setEnabledStages] = useState(new Set(DEFAULT_STAGES))
  const [accountFilter, setAccountFilter] = useState('')
  const [projectFilters, setProjectFilters] = useState(new Set(DEFAULT_PROJECT_FILTERS))
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [textFilter, setTextFilter]       = useState('')

  // Sort — { key: null, direction: 'asc' } means default severity-first sort.
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' })

  // Selection
  const [selectedLotId, setSelectedLotId] = useState(null)

  // Set browser tab title while this component is mounted. Restored on
  // unmount so navigating to another CSW tab (or leaving the standalone)
  // doesn't leave "Palermo's At Risk Inventory Manager" stuck in the tab.
  useEffect(() => {
    const prev = document.title
    document.title = "Palermo's At Risk Inventory Manager"
    return () => { document.title = prev }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const [snap, canon, map, noteRows, specs, dispRows] = await Promise.all([
          fetch('/.netlify/functions/pvi-shelf-life', { method: 'POST' })
            .then(async r => {
              if (!r.ok) throw new Error(`Shelf-life fetch failed (${r.status}): ${(await r.text()).slice(0, 200)}`)
              return r.json()
            }),
          fetchPviCanonicalAccounts(),
          fetchPviAccountNameMap(),
          fetchPviShelfNotesActive(),
          fetchPviMaterialSpecs(),
          fetchPviLotDispositions(),
        ])
        if (cancelled) return
        setSnapshot(snap)
        setCanonicals(canon)
        setNameMap(map)
        setNotes(noteRows)
        setMaterialSpecs(specs)
        setDispositions(dispRows)
      } catch (e) {
        if (!cancelled) setError(e.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [reloadTick])

  const canonicalIndex = useMemo(
    () => buildRawNameToCanonical(canonicals, nameMap),
    [canonicals, nameMap],
  )

  // Fast O(1) disposition lookup by (material_code, lot_code). Composite
  // key mirrors the Supabase PK. Rebuilds when dispositions change (edit
  // in drawer triggers a state update via refetch).
  const dispositionsByLot = useMemo(() => {
    const m = new Map()
    for (const d of dispositions) {
      m.set(`${d.material_code}|${d.lot_code}`, d)
    }
    return m
  }, [dispositions])

  // Unique owner names across all persisted dispositions — powers the
  // <datalist> autocomplete in the drawer's Owner input. Sorted, de-duped,
  // case-insensitive. Free-text with autocomplete beats a hard-coded
  // dropdown because Palermo's team roster changes and Hill didn't want
  // to maintain a master list.
  const uniqueOwners = useMemo(() => {
    const set = new Set()
    for (const d of dispositions) {
      if (d.owner && d.owner.trim()) set.add(d.owner.trim())
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [dispositions])

  // Group notes by (item, lot) so the drawer can look them up without a
  // per-render filter scan. Notes ingested from the 7/6 workbook use item =
  // material_code (text) and lot_code — same keys the FEFO rows use.
  const notesByItemLot = useMemo(() => {
    const m = new Map()
    for (const n of notes) {
      const key = `${n.item}|${n.lot_code}`
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(n)
    }
    return m
  }, [notes])
  const notesByItem = useMemo(() => {
    const m = new Map()
    for (const n of notes) {
      if (!m.has(n.item)) m.set(n.item, [])
      m.get(n.item).push(n)
    }
    return m
  }, [notes])

  // Most-recent comment per lot, for the grid's inline "Latest note" column
  // and the CSV export (2026-07-08, Wade/Jessica ask). notes is already
  // ordered created_at DESC (fetchPviShelfNotesActive), and notesByItemLot
  // pushes in that same fetch order, so arr[0] is the latest note for that
  // lot without a second sort pass.
  const latestNoteByLot = useMemo(() => {
    const m = new Map()
    for (const [key, arr] of notesByItemLot) {
      if (arr.length) m.set(key, arr[0])
    }
    return m
  }, [notesByItemLot])

  // Run FEFO projection whenever the inputs change, then merge disposition
  // + owner from pvi_lot_dispositions onto each row. Merging AFTER
  // projectFefo (rather than inside the engine) keeps the engine pure and
  // means dispositions can be updated without re-running the FEFO math.
  const rows = useMemo(() => {
    if (!snapshot) return []
    const projected = projectFefo({
      lots:                snapshot.lots || [],
      pendingOrders:       snapshot.pendingOrders || [],
      velocity:            snapshot.velocity || [],
      materialShipHistory: snapshot.materialShipHistory || [],
      materialSpecs,
      canonicalIndex,
    })
    // Second pass: hydrate each row with its persisted disposition/owner.
    for (const r of projected) {
      const d = dispositionsByLot.get(`${r.material_code}|${r.lot_code}`)
      if (d) {
        r.disposition = d.disposition || null
        r.owner       = d.owner || null
      } else {
        r.disposition = null
        r.owner       = null
      }
    }
    return projected
  }, [snapshot, canonicalIndex, materialSpecs, dispositionsByLot])

  // Stage counts for the tab row — respect project filter but ignore stage/
  // account/text filters, so the operator sees the full workload for
  // whatever project scope they've chosen. Empty projectFilters = no
  // restriction (matches filteredRows logic below).
  const stageCounts = useMemo(() => {
    const c = { expired: 0, unshippable: 0, critical: 0, at_risk: 0, watch: 0 }
    for (const r of rows) {
      if (projectFilters.size > 0 && !projectFilters.has(r.project_lookup)) continue
      c[r.verdict.stage] = (c[r.verdict.stage] || 0) + 1
    }
    return c
  }, [rows, projectFilters])

  // Filtered + sorted rows for the table.
  const filteredRows = useMemo(() => {
    const filtered = rows.filter(r => {
      if (projectFilters.size > 0 && !projectFilters.has(r.project_lookup)) return false
      if (!enabledStages.has(r.verdict.stage)) return false
      if (accountFilter) {
        const canonId = r.primary?.canonical?.id ?? null
        if (String(canonId) !== accountFilter) return false
      }
      if (textFilter.trim()) {
        const q = textFilter.trim().toUpperCase()
        // Include disposition + owner in text-filter search so operators
        // can jump to e.g. all lots owned by "Heather" or all "Donation" rows.
        const hay = `${r.material_code} ${r.material_desc} ${r.lot_code} ${r.disposition || ''} ${r.owner || ''}`.toUpperCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    if (sortConfig.key) {
      return [...filtered].sort((a, b) => compareRows(a, b, sortConfig.key, sortConfig.direction))
    }

    // Default sort: stage severity DESC, then shortfall DESC (worst first),
    // then days-to-code ASC.
    return filtered.sort((a, b) => {
      const sa = STAGE_ORDER.indexOf(a.verdict.stage)
      const sb = STAGE_ORDER.indexOf(b.verdict.stage)
      if (sa !== sb) return sa - sb
      const shA = a.shortfall_days ?? -9999
      const shB = b.shortfall_days ?? -9999
      if (shA !== shB) return shB - shA
      const da = a.days_to_code_today ?? 9999
      const db = b.days_to_code_today ?? 9999
      return da - db
    })
  }, [rows, projectFilters, enabledStages, accountFilter, textFilter, sortConfig])

  const selectedRow = useMemo(
    () => filteredRows.find(r => r.lot_id === selectedLotId) || rows.find(r => r.lot_id === selectedLotId) || null,
    [filteredRows, rows, selectedLotId],
  )

  const toggleStage = (stage) => {
    setEnabledStages(prev => {
      const next = new Set(prev)
      if (next.has(stage)) next.delete(stage); else next.add(stage)
      return next
    })
  }

  const toggleProject = useCallback((lookup) => {
    setProjectFilters(prev => {
      const next = new Set(prev)
      if (next.has(lookup)) next.delete(lookup); else next.add(lookup)
      return next
    })
  }, [])

  const handleSort = useCallback((key) => {
    setSortConfig(prev => {
      if (prev.key === key) {
        if (prev.direction === 'asc') return { key, direction: 'desc' }
        return { key: null, direction: 'asc' }
      }
      return { key, direction: 'asc' }
    })
  }, [])

  const handleCopyLot = useCallback((row) => {
    navigator.clipboard.writeText(formatLotForEmail(row)).then(
      () => flash('Copied to clipboard'),
      () => flash('Copy failed — check clipboard permissions'),
    )
  }, [])

  const handleCopyBulk = useCallback(() => {
    if (filteredRows.length === 0) return
    navigator.clipboard.writeText(bulkCopyForEmail(filteredRows)).then(
      () => flash(`Copied ${filteredRows.length} lot(s) to clipboard`),
      () => flash('Copy failed'),
    )
  }, [filteredRows])

  // Called by NotesDrawer after a successful disposition/owner save.
  // Refetches the disposition table so all row badges + drawer state
  // stay in sync.
  const reloadDispositions = useCallback(async () => {
    const fresh = await fetchPviLotDispositions()
    setDispositions(fresh)
  }, [])

  // CSV export — currently filtered + sorted rows, all detail columns
  // including Disposition + Owner. Project split into two columns (Omni
  // lookup + Palermo's number) rather than the combined "PALVI9 · 247"
  // display string, since a spreadsheet column is more useful to filter/
  // pivot on as two discrete values than as one formatted string.
  //
  // Note columns (2026-07-08, Wade/Jessica ask): Latest Note/Author/Date
  // pull the same latestNoteByLot map that drives the grid's inline column.
  // Note History concatenates every note on the lot (oldest to newest, for
  // readable chronology) as "[MM/DD/YY HH:MM] Author: text" entries joined
  // by " | " — a single cell rather than a variable number of columns,
  // since a lot can have anywhere from zero to a dozen+ notes.
  const handleExportCsv = useCallback(() => {
    if (filteredRows.length === 0) return
    const headers = [
      'Stage', 'Item code', 'Item description', 'Project Lookup', 'Project Number',
      'Lot code', 'Lot status',
      'Code date', 'Days to code (today)', 'Days to code (at ship)',
      'Spec days', 'Spec source', 'Vs spec (days short; negative = buffer)',
      'Cases available', 'Cases on hand', 'Cases committed',
      'Projected recipient', 'Projected ship date', 'Ship source',
      'Order lookup',
      'Velocity 30d shipments', 'Velocity tier',
      'Disposition', 'Owner',
      'Latest Note', 'Latest Note Author', 'Latest Note Date', 'Note Count', 'Note History',
    ]
    const lines = [headers.map(csvEscape).join(',')]
    for (const r of filteredRows) {
      const prim = r.primary
      const shipIso = prim?.projected_ship_iso ? prim.projected_ship_iso.slice(0, 10) : ''
      const recipient = prim?.canonical?.canonical_name || prim?.ship_to_raw_name || ''
      const lotKey = `${r.material_code}|${r.lot_code}`
      const lotNotes = notesByItemLot.get(lotKey) || []
      const latest = latestNoteByLot.get(lotKey)
      const latestDate = latest?.created_at ? new Date(latest.created_at).toLocaleString() : ''
      const history = [...lotNotes].reverse().map(n => {
        const d = n.created_at ? new Date(n.created_at).toLocaleString() : ''
        return `[${d}] ${n.author || '(anon)'}: ${n.note}`
      }).join(' | ')
      lines.push([
        r.verdict?.label ?? '',
        r.material_code ?? '',
        r.material_desc ?? '',
        r.project_lookup ?? '',
        PROJECT_CODE_MAP[r.project_lookup] ?? '',
        r.lot_code ?? '',
        r.lot_status ?? '',
        r.expiration_date_iso ?? '',
        r.days_to_code_today ?? '',
        r.days_to_code_at_ship ?? '',
        r.shelf_life_days ?? '',
        r.spec_source ?? '',
        r.shortfall_days ?? '',
        r.cases_available ?? '',
        r.cases_onhand ?? '',
        r.cases_committed ?? '',
        recipient,
        shipIso,
        prim?.source ?? '',
        prim?.order_lookup ?? '',
        r.velocity?.shipments_30d ?? '',
        r.velocity_confidence?.tier ?? '',
        r.disposition ?? '',
        r.owner ?? '',
        latest?.note ?? '',
        latest?.author ?? '',
        latestDate,
        lotNotes.length,
        history,
      ].map(csvEscape).join(','))
    }
    const csv = lines.join('\r\n')
    const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const today = new Date().toISOString().slice(0, 10)
    const scope = projectFilters.size > 0
      ? `-${[...projectFilters].map(p => p.toLowerCase()).join('-')}`
      : ''
    a.download = `pvi-at-risk-inventory${scope}-${today}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    flash(`Exported ${filteredRows.length} lot(s) to CSV`)
  }, [filteredRows, projectFilters, notesByItemLot, latestNoteByLot])

  const reload = () => setReloadTick(t => t + 1)

  if (loading) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        Loading At Risk Inventory snapshot…
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ color: '#e05a5a', fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 12 }}>
          Error: {error}
        </div>
        <button className="settings-save-btn" onClick={reload}>Retry</button>
      </div>
    )
  }

  const accountOptions = canonicals
    .filter(c => c.account_type === 'end_customer')
    .sort((a, b) => a.canonical_name.localeCompare(b.canonical_name))

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
          {snapshot && (
            <>
              {snapshot.rowCounts?.lots ?? 0} lots · {snapshot.rowCounts?.pendingOrders ?? 0} pending order lines ·
              scanned in {((snapshot.elapsedMs ?? 0) / 1000).toFixed(1)}s ·
              fetched {new Date(snapshot.fetchedAt).toLocaleTimeString()}
              <button className="settings-save-btn" style={{ marginLeft: 8, fontSize: 10 }} onClick={reload}>↻ Refresh</button>
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {STAGES_FOR_TABS.map(stage => {
            const meta = STAGE_META[stage]
            const active = enabledStages.has(stage)
            const count = stageCounts[stage] || 0
            return (
              <button
                key={stage}
                type="button"
                onClick={() => toggleStage(stage)}
                style={{
                  padding: '6px 12px',
                  border: `1px solid ${active ? meta.color : 'var(--border)'}`,
                  background: active ? meta.bg : 'transparent',
                  color: active ? meta.color : 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                  borderRadius: 2,
                  transition: 'all 0.15s ease',
                }}
              >
                {meta.label} <span style={{ opacity: 0.7 }}>({count})</span>
              </button>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <ProjectMultiSelect
            lookups={PROJECT_LOOKUPS}
            selected={projectFilters}
            onToggle={toggleProject}
            onClear={() => setProjectFilters(new Set())}
            onSelectOnly={(lookup) => setProjectFilters(new Set([lookup]))}
            open={projectMenuOpen}
            setOpen={setProjectMenuOpen}
          />
          <select
            className="est-drops-select"
            value={accountFilter}
            onChange={e => setAccountFilter(e.target.value)}
            style={{ fontSize: 11 }}
          >
            <option value="">All accounts</option>
            {accountOptions.map(c => (
              <option key={c.id} value={c.id}>{c.canonical_name}</option>
            ))}
          </select>
          <input
            className="settings-field-input"
            placeholder="Filter by item, lot, description, owner, or disposition…"
            value={textFilter}
            onChange={e => setTextFilter(e.target.value)}
            style={{ width: 300, fontSize: 11 }}
          />
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            {filteredRows.length} of {rows.length} lot(s)
          </span>
          <button
            className="settings-save-btn"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
            style={{ fontSize: 11 }}
            title="Download the currently filtered + sorted rows as a CSV file"
          >
            Export CSV
          </button>
          <button
            className="settings-save-btn"
            onClick={handleCopyBulk}
            disabled={filteredRows.length === 0}
            style={{ fontSize: 11 }}
          >
            Copy all ({filteredRows.length}) for email
          </button>
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            No lots found. Either PVI inventory is empty at CAL or the risk engine returned no rows.
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            No lots match the current filters. Toggle a stage or clear filters above.
          </div>
        ) : (
          <table className="hourly-table">
            <thead>
              <tr>
                <SortableTh sortKey="stage"       align="left"  sortConfig={sortConfig} onSort={handleSort}>Stage</SortableTh>
                <SortableTh sortKey="material"    align="left"  sortConfig={sortConfig} onSort={handleSort}>Item</SortableTh>
                <SortableTh sortKey="lot"         align="left"  sortConfig={sortConfig} onSort={handleSort}>Lot</SortableTh>
                <SortableTh sortKey="expiration"  align="left"  sortConfig={sortConfig} onSort={handleSort}>Code date</SortableTh>
                <SortableTh sortKey="daysToCode"  align="right" sortConfig={sortConfig} onSort={handleSort} title="Days remaining until code date (today)">Days to code</SortableTh>
                <SortableTh sortKey="spec"        align="right" sortConfig={sortConfig} onSort={handleSort} title="Customer's minimum-days-at-receipt spec; positive value = days the lot will land under spec at its projected ship date">Vs. spec</SortableTh>
                <SortableTh sortKey="available"   align="right" sortConfig={sortConfig} onSort={handleSort}>Available</SortableTh>
                <SortableTh sortKey="projected"   align="left"  sortConfig={sortConfig} onSort={handleSort}>Projected ship</SortableTh>
                <SortableTh sortKey="velocity"    align="left"  sortConfig={sortConfig} onSort={handleSort}>Velocity</SortableTh>
                <SortableTh sortKey="disposition" align="left"  sortConfig={sortConfig} onSort={handleSort} title="Disposition tag — click a row to edit in the drawer">Disposition</SortableTh>
                <SortableTh sortKey="owner"       align="left"  sortConfig={sortConfig} onSort={handleSort} title="Owner — Palermo's team member accountable for this lot">Owner</SortableTh>
                <th title="Most recent note on this lot — click the row to see full history">Latest Note</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(r => (
                <ShelfLifeRow
                  key={r.lot_id}
                  row={r}
                  latestNote={latestNoteByLot.get(`${r.material_code}|${r.lot_code}`)}
                  isSelected={r.lot_id === selectedLotId}
                  onSelect={() => setSelectedLotId(r.lot_id)}
                  onCopy={() => handleCopyLot(r)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedRow && (
        <NotesDrawer
          row={selectedRow}
          notes={notesByItemLot.get(`${selectedRow.material_code}|${selectedRow.lot_code}`) || []}
          allNotesForItem={notesByItem.get(selectedRow.material_code) || []}
          uniqueOwners={uniqueOwners}
          onClose={() => setSelectedLotId(null)}
          onNotesChanged={async () => {
            const fresh = await fetchPviShelfNotesActive()
            setNotes(fresh)
          }}
          onDispositionChanged={reloadDispositions}
        />
      )}
    </div>
  )
}

// ── Project multi-select ────────────────────────────────────────────────
//
// Replaces the old single <select> now that Hill wants to be able to pick
// PALVI9 + PALDSD9 together. A checkbox popover rather than a native
// <select multiple> — multiple-select listboxes are notoriously unfriendly
// (ctrl/cmd-click to multi-pick isn't discoverable, and the UI can't show
// both codes plus a checked state cleanly). Click-outside-to-close via a
// full-screen transparent overlay behind the panel.
//
// Empty `selected` Set = no restriction ("All projects"). Button label
// reflects the current selection: the formatted label for exactly one,
// a count for several, or "All PVI projects" for zero/all.
function ProjectMultiSelect({ lookups, selected, onToggle, onClear, onSelectOnly, open, setOpen }) {
  const wrapRef = useRef(null)

  let buttonLabel
  if (selected.size === 0) {
    buttonLabel = 'All PVI projects'
  } else if (selected.size === 1) {
    buttonLabel = formatProjectLabel([...selected][0])
  } else {
    buttonLabel = `${selected.size} projects selected`
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="est-drops-select"
        onClick={() => setOpen(o => !o)}
        style={{ fontSize: 11, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        title="Filter to one or more Palermo's projects"
      >
        {buttonLabel}
        <span style={{ fontSize: 9, opacity: 0.6 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <>
          {/* Click-outside overlay */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          />
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              background: 'var(--bg0, white)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              zIndex: 50,
              minWidth: 200,
              padding: 8,
            }}
          >
            {lookups.map(lookup => {
              const checked = selected.has(lookup)
              return (
                <label
                  key={lookup}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 4px',
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(lookup)}
                  />
                  <span style={{ flex: 1 }}>{formatProjectLabel(lookup)}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelectOnly(lookup) }}
                    style={{
                      fontSize: 9, color: 'var(--text-dim)', background: 'none', border: 'none',
                      cursor: 'pointer', textDecoration: 'underline', padding: 0,
                    }}
                    title={`Show only ${formatProjectLabel(lookup)}`}
                  >
                    only
                  </button>
                </label>
              )
            })}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6, display: 'flex', justifyContent: 'space-between' }}>
              <button
                type="button"
                onClick={onClear}
                style={{ fontSize: 10, color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
              >
                Clear (show all)
              </button>
              <button
                type="button"
                className="settings-save-btn"
                onClick={() => setOpen(false)}
                style={{ fontSize: 10 }}
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Sortable Th ────────────────────────────────────────────────────────────

function SortableTh({ sortKey, align, sortConfig, onSort, title, children }) {
  const isActive = sortConfig.key === sortKey
  const indicator = isActive ? (sortConfig.direction === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th
      style={{
        textAlign: align,
        cursor: 'pointer',
        userSelect: 'none',
        background: isActive ? 'var(--brand-bg, #fef9ec)' : undefined,
        fontWeight: isActive ? 700 : undefined,
      }}
      title={title || `Sort by ${children}`}
      onClick={() => onSort(sortKey)}
    >
      {children}<span style={{ color: 'var(--brand, #a07818)', fontWeight: 700 }}>{indicator}</span>
    </th>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────

const SPEC_SOURCE_BADGE = {
  material_spec:    { label: 'spec',    color: '#3a7a3a' },
  allocation:       { label: 'alloc',   color: '#5b9bd5' },
  material_history: { label: 'hist',    color: '#c88a2a' },
  default_96:       { label: 'default', color: '#999' },
}

function ShelfLifeRow({ row, latestNote, isSelected, onSelect, onCopy }) {
  const meta = STAGE_META[row.verdict.stage]
  const prim = row.primary
  const acct = prim?.canonical?.canonical_name
    || (prim?.ship_to_raw_name ? `(unmapped: ${prim.ship_to_raw_name})` : '(unallocated)')
  const shipIso = prim?.projected_ship_iso ? prim.projected_ship_iso.slice(0, 10) : ''
  const shipSrc = prim?.source === 'scheduled' ? 'sched' : prim?.source === 'projected' ? 'proj' : '—'
  const daysToCode = row.days_to_code_today
  const daysAtShip = row.days_to_code_at_ship
  const vc = row.velocity_confidence
  const req = row.shelf_life_days
  const shortfall = row.shortfall_days
  const specBadge = SPEC_SOURCE_BADGE[row.spec_source] || null
  const shortColor = shortfall == null
    ? 'var(--text-dim)'
    : shortfall > 0 ? '#d1583a'
    : shortfall < 0 ? '#3a7a3a'
    : '#c88a2a'

  // Disposition badge — DISPOSITION_META lookup with short label for the
  // tight inline column. Unknown values (not in the canonical 9) render as
  // a neutral grey badge with the raw value so operators can spot legacy
  // data. Null renders as a subtle "—" placeholder.
  const dispMeta = row.disposition ? (DISPOSITION_META[row.disposition] || {
    label: row.disposition, short: row.disposition, color: '#666', bg: '#eee',
  }) : null

  return (
    <tr
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        background: isSelected ? 'var(--brand-bg, #fef9ec)' : 'transparent',
      }}
    >
      <td>
        <span style={{
          display: 'inline-block',
          padding: '2px 6px',
          background: meta.bg,
          color: meta.color,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 700,
          borderRadius: 2,
        }}>
          {meta.label}
        </span>
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <div>{row.material_code}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{row.material_desc}</div>
        {row.project_lookup && (
          <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>{formatProjectLabel(row.project_lookup)}</div>
        )}
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {row.lot_code}
        {row.lot_status && row.lot_status !== 'Available' && (
          <div style={{ fontSize: 9, color: '#c88a2a', fontStyle: 'italic' }}>{row.lot_status}</div>
        )}
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {row.expiration_date_iso || <span style={{ color: 'var(--text-dim)' }}>—</span>}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {daysToCode == null ? '—' : (
          <>
            <div>{daysToCode}</div>
            {daysAtShip != null && daysAtShip !== daysToCode && (
              <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>@ship: {daysAtShip}</div>
            )}
          </>
        )}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {req == null ? (
          <span style={{ color: 'var(--text-dim)' }} title={prim?.canonical?.account_type === 'internal_transfer' ? 'Internal transfer — no shelf-life spec' : 'No shelf-life spec configured for this account'}>
            —
          </span>
        ) : (
          <>
            <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
              req {req}d
              {specBadge && (
                <span style={{
                  marginLeft: 4,
                  padding: '0 3px',
                  fontSize: 8,
                  fontWeight: 600,
                  color: specBadge.color,
                  border: `1px solid ${specBadge.color}`,
                  borderRadius: 2,
                  letterSpacing: '0.03em',
                }} title={
                  row.spec_source === 'material_spec'   ? 'Ops-curated material spec' :
                  row.spec_source === 'allocation'      ? 'From allocation customer spec' :
                  row.spec_source === 'material_history' ? 'Strictest customer across 365-day history' :
                  row.spec_source === 'default_96'      ? 'Default (no material spec, no history)' : ''
                }>
                  {specBadge.label}
                </span>
              )}
            </div>
            <div style={{ color: shortColor, fontWeight: 600 }}>
              {shortfall > 0 ? `▼ ${shortfall}d projected ship` : shortfall < 0 ? `▲ ${-shortfall}d buffer` : 'at spec'}
            </div>
          </>
        )}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <div>{row.cases_available}</div>
        {row.cases_committed > 0 && (
          <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
            {row.cases_onhand} on / {row.cases_committed} cmt
          </div>
        )}
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <div>{acct}</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
          {shipIso} · {shipSrc}
        </div>
      </td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        <span style={{ color: vc.color, fontWeight: 600 }}>{vc.label}</span>
        {row.velocity && (
          <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
            {row.velocity.shipments_30d} orders / 30d
          </div>
        )}
      </td>
      {/* Disposition — inline badge if set, subtle placeholder if not.
          Click row to edit via drawer. */}
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {dispMeta ? (
          <span
            style={{
              display: 'inline-block',
              padding: '2px 6px',
              background: dispMeta.bg,
              color: dispMeta.color,
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 2,
              whiteSpace: 'nowrap',
            }}
            title={dispMeta.label}
          >
            {dispMeta.short}
          </span>
        ) : (
          <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>—</span>
        )}
      </td>
      {/* Owner — plain text, tighter typography since it's usually a
          first name or "First LastInitial" like "Dave I" or "Greg Y". */}
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {row.owner
          ? row.owner
          : <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>—</span>}
      </td>
      {/* Latest Note — truncated inline preview (2026-07-08, Wade/Jessica
          ask: don't make them open the drawer to see if there's already a
          comment on a lot). Full text + author + timestamp in the title
          attribute for hover; click the row to open the drawer for the
          full history and to add a new one. */}
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, maxWidth: 180 }}>
        {latestNote ? (
          <div
            title={`${latestNote.author || '(anon)'} · ${latestNote.created_at ? new Date(latestNote.created_at).toLocaleString() : ''}\n\n${latestNote.note}`}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>{latestNote.author || '(anon)'}:</span>{' '}
            {latestNote.note}
          </div>
        ) : (
          <span style={{ color: 'var(--text-dim)' }}>—</span>
        )}
      </td>
      <td>
        <button
          className="settings-save-btn"
          onClick={(e) => { e.stopPropagation(); onCopy() }}
          style={{ fontSize: 10 }}
          title="Copy this lot's summary to clipboard for pasting into email"
        >
          Copy
        </button>
      </td>
    </tr>
  )
}

// ── Notes Drawer ──────────────────────────────────────────────────────────

const NOTE_STATUS_OPTIONS = [
  { value: 'open',                label: 'Open' },
  { value: 'awaiting_approval',   label: 'Awaiting approval' },
  { value: 'approved_to_ship',    label: 'Approved to ship' },
  { value: 'resolved',            label: 'Resolved' },
  { value: 'dispose',             label: 'Dispose' },
]

function NotesDrawer({ row, notes, allNotesForItem, uniqueOwners, onClose, onNotesChanged, onDispositionChanged }) {
  const [newNote, setNewNote]   = useState('')
  const [author, setAuthor]     = useState(loadAuthor())
  const [status, setStatus]     = useState('open')
  const [busy, setBusy]         = useState(false)
  const [err, setErr]           = useState(null)

  // Disposition + Owner editors — initialized from the persisted row values.
  // Re-initialize when the selected row changes (operator clicks a different
  // lot without closing the drawer).
  const [dispDraft, setDispDraft]   = useState(row.disposition || '')
  const [ownerDraft, setOwnerDraft] = useState(row.owner || '')
  const [dispBusy, setDispBusy]     = useState(false)
  const [dispErr, setDispErr]       = useState(null)

  useEffect(() => {
    setDispDraft(row.disposition || '')
    setOwnerDraft(row.owner || '')
    setDispErr(null)
  }, [row.lot_id])

  function loadAuthor() {
    try { return localStorage.getItem('pvi_notes_author') || '' } catch { return '' }
  }
  function saveAuthor(v) {
    try { localStorage.setItem('pvi_notes_author', v) } catch (_) {}
  }

  async function handleAdd() {
    setErr(null)
    if (!newNote.trim()) { setErr('Note text required.'); return }
    if (!author.trim())  { setErr('Author required — enter your name once and it will be remembered.'); return }
    setBusy(true)
    try {
      saveAuthor(author.trim())
      await insertPviShelfNote({
        item:     row.material_code,
        lot_code: row.lot_code,
        note:     newNote.trim(),
        status,
        author:   author.trim(),
      })
      setNewNote('')
      await onNotesChanged()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // Status changes and deletes now require an author name (2026-07-08,
  // Wade/Jessica ask: previously anyone could flip status or delete a note
  // with zero record of who did it). Reuses the same author input as
  // "Add note" — one identity field for the whole drawer, no separate login.
  async function handleStatusChange(id, next) {
    if (!author.trim()) { alert('Enter your name in the author field before changing a note\'s status.'); return }
    try {
      await updatePviShelfNoteStatusAudited(id, next, author.trim())
      await onNotesChanged()
    } catch (e) {
      alert(`Failed to update status: ${e.message}`)
    }
  }

  async function handleDelete(id) {
    if (!author.trim()) { alert('Enter your name in the author field before deleting a note.'); return }
    if (!confirm('Delete this note?')) return
    try {
      await softDeletePviShelfNote(id, author.trim())
      await onNotesChanged()
    } catch (e) {
      alert(`Failed to delete: ${e.message}`)
    }
  }

  // Bumped after every successful disposition save so DispositionHistory
  // (below) refetches pvi_lot_disposition_history and shows the new entry
  // without the operator needing to close/reopen the drawer.
  const [historyRefreshTick, setHistoryRefreshTick] = useState(0)

  // Persist the disposition + owner draft. Also stamps updated_by from the
  // notes author field (shared identity input — no separate login).
  async function handleSaveDisposition() {
    setDispErr(null)
    setDispBusy(true)
    try {
      await upsertPviLotDisposition({
        material_code: row.material_code,
        lot_code:      row.lot_code,
        disposition:   dispDraft,
        owner:         ownerDraft,
        updated_by:    (author || '').trim() || null,
      })
      await onDispositionChanged()
      setHistoryRefreshTick(t => t + 1)
      flash('Disposition saved')
    } catch (e) {
      setDispErr(e.message || String(e))
    } finally {
      setDispBusy(false)
    }
  }

  const lotNotes  = notes
  const itemOnly  = allNotesForItem.filter(n => !lotNotes.some(ln => ln.id === n.id))

  const dispDirty = (dispDraft || '') !== (row.disposition || '') || (ownerDraft || '') !== (row.owner || '')

  // Datalist id for owner autocomplete. Unique per drawer instance so
  // multiple drawers (unlikely in practice) don't clash.
  const ownerListId = `pvi-owner-suggestions-${row.lot_id}`

  return (
    <div style={{
      width: 380,
      flexShrink: 0,
      borderLeft: '1px solid var(--border)',
      background: 'var(--bg1, #fafafa)',
      display: 'flex',
      flexDirection: 'column',
      maxHeight: 'calc(100vh - 200px)',
      position: 'sticky',
      top: 16,
    }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{row.material_code}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
            {row.material_desc}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
            Lot {row.lot_code} · {row.cases_available} cs available
          </div>
          {row.project_lookup && (
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
              Project: {formatProjectLabel(row.project_lookup)}
            </div>
          )}
          {row.shelf_life_days != null && row.shortfall_days != null && (
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
              {row.days_to_code_at_ship}d to code @ ship · req {row.shelf_life_days}d ·{' '}
              <span style={{
                color: row.shortfall_days > 0 ? '#d1583a' : row.shortfall_days < 0 ? '#3a7a3a' : '#c88a2a',
                fontWeight: 600,
              }}>
                {row.shortfall_days > 0 ? `${row.shortfall_days}d projected ship` : row.shortfall_days < 0 ? `${-row.shortfall_days}d buffer` : 'at spec'}
              </span>
            </div>
          )}
        </div>
        <button className="settings-save-btn" onClick={onClose} style={{ fontSize: 10 }}>Close</button>
      </div>

      <div style={{ padding: '12px 16px', overflowY: 'auto', flex: 1 }}>
        {/* Disposition + Owner editor — persisted per-lot. Save button
            explicit so operators can pick+type without every keystroke
            hitting the DB. Dirty indicator + disabled Save when unchanged. */}
        <div className="section-label" style={{ marginBottom: 6 }}>Disposition &amp; Owner</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
          <select
            className="est-drops-select"
            value={dispDraft}
            onChange={e => setDispDraft(e.target.value)}
            style={{ fontSize: 11 }}
          >
            <option value="">— none —</option>
            {DISPOSITION_OPTIONS.map(v => {
              const m = DISPOSITION_META[v]
              return <option key={v} value={v}>{m?.label || v}</option>
            })}
          </select>
          <input
            className="settings-field-input"
            list={ownerListId}
            placeholder="Owner (e.g. Heather, Dave I, Greg Y)"
            value={ownerDraft}
            onChange={e => setOwnerDraft(e.target.value)}
            style={{ fontSize: 11 }}
            autoComplete="off"
          />
          {/* HTML5 datalist provides the autocomplete dropdown for owner
              names. Browser-native — zero deps, works offline, ignored
              gracefully if the browser doesn't support it. */}
          <datalist id={ownerListId}>
            {uniqueOwners.map(name => <option key={name} value={name} />)}
          </datalist>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              className="settings-save-btn"
              onClick={handleSaveDisposition}
              disabled={dispBusy || !dispDirty}
              style={{ fontSize: 11 }}
            >
              {dispBusy ? 'Saving…' : 'Save disposition'}
            </button>
            {dispDirty && (
              <span style={{ fontSize: 9, color: '#c88a2a', fontFamily: 'var(--font-mono)' }}>unsaved</span>
            )}
          </div>
          {dispErr && <div style={{ fontSize: 10, color: '#e05a5a', fontFamily: 'var(--font-mono)' }}>{dispErr}</div>}
        </div>

        <DispositionHistory
          materialCode={row.material_code}
          lotCode={row.lot_code}
          refreshKey={historyRefreshTick}
        />

        <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>Add note</div>
        <textarea
          value={newNote}
          onChange={e => setNewNote(e.target.value)}
          placeholder="What's the situation? Include any customer conversation details…"
          rows={3}
          style={{
            width: '100%', fontSize: 11, fontFamily: 'var(--font-mono)',
            padding: 6, boxSizing: 'border-box', marginBottom: 6,
          }}
        />
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <input
            className="settings-field-input"
            placeholder="Your name"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            style={{ flex: 1, minWidth: 120, fontSize: 11 }}
          />
          <select
            className="est-drops-select"
            value={status}
            onChange={e => setStatus(e.target.value)}
            style={{ fontSize: 11 }}
          >
            {NOTE_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            className="settings-save-btn"
            onClick={handleAdd}
            disabled={busy}
            style={{ fontSize: 11 }}
          >
            {busy ? '…' : 'Add'}
          </button>
        </div>
        {err && <div style={{ fontSize: 10, color: '#e05a5a', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>{err}</div>}

        <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>
          This lot ({lotNotes.length})
        </div>
        {lotNotes.length === 0
          ? <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>No notes yet.</div>
          : lotNotes.map(n => (
              <NoteCard
                key={n.id}
                note={n}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
              />
            ))
        }

        {itemOnly.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>
              Other lots of this item ({itemOnly.length})
            </div>
            {itemOnly.map(n => (
              <NoteCard
                key={n.id}
                note={n}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
                showLot
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function NoteCard({ note, onStatusChange, onDelete, showLot }) {
  const created = note.created_at ? new Date(note.created_at) : null
  return (
    <div style={{
      padding: 8,
      background: 'var(--bg0, white)',
      border: '1px solid var(--border)',
      marginBottom: 6,
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>{note.author || '(anon)'}</span>
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
          {created ? created.toLocaleString() : ''}
        </span>
      </div>
      <div style={{ marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note.note}</div>
      {showLot && (
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 4 }}>Lot: {note.lot_code || '(none)'}</div>
      )}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="est-drops-select"
          value={note.status || 'open'}
          onChange={e => onStatusChange(note.id, e.target.value)}
          style={{ fontSize: 10, flex: 1, minWidth: 100 }}
        >
          {NOTE_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          className="settings-save-btn"
          onClick={() => onDelete(note.id)}
          style={{ fontSize: 9, color: '#e05a5a', borderColor: '#e05a5a' }}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

// ── Disposition change log ─────────────────────────────────────────────────
//
// Renders the append-only pvi_lot_disposition_history for the selected lot
// (2026-07-08, Wade ask: "can we see history of who did what"). Refetches
// whenever the lot changes or refreshKey bumps (fires right after a save in
// the parent drawer, so a new entry shows up without reopening the drawer).
// Collapsed by default since most lots have zero or one prior change and a
// long always-open list would just be noise on the common case.
function DispositionHistory({ materialCode, lotCode, refreshKey }) {
  const [open, setOpen]       = useState(false)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetchPviLotDispositionHistory(materialCode, lotCode).then(rows => {
      if (!cancelled) { setEntries(rows); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [open, materialCode, lotCode, refreshKey])

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          fontSize: 10, color: 'var(--text-dim)', background: 'none', border: 'none',
          cursor: 'pointer', textDecoration: 'underline', padding: 0,
        }}
      >
        {open ? '▾' : '▸'} Change history
      </button>
      {open && (
        loading ? (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>Loading…</div>
        ) : entries.length === 0 ? (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic', marginTop: 4 }}>
            No changes logged yet.
          </div>
        ) : (
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {entries.map(e => {
              const dispMeta = e.disposition ? (DISPOSITION_META[e.disposition] || { label: e.disposition }) : null
              return (
                <div
                  key={e.id}
                  style={{
                    fontSize: 10, fontFamily: 'var(--font-mono)',
                    padding: 6, background: 'var(--bg0, white)', border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 600 }}>{e.changed_by || '(unknown)'}</span>
                    <span style={{ color: 'var(--text-dim)' }}>
                      {e.changed_at ? new Date(e.changed_at).toLocaleString() : ''}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
                    {e.action === 'created' ? 'Set' : 'Changed to'}: {dispMeta?.label || '(none)'}
                    {e.owner ? ` · Owner: ${e.owner}` : ''}
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}

// ── Toast (dead simple, no library) ───────────────────────────────────────

let _flashTimer = null
function flash(msg) {
  let el = document.getElementById('pvi-flash-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'pvi-flash-toast'
    Object.assign(el.style, {
      position:  'fixed',
      bottom:    '24px',
      right:     '24px',
      padding:   '10px 16px',
      background: 'rgba(30, 30, 30, 0.92)',
      color:     'white',
      fontFamily: 'var(--font-mono, monospace)',
      fontSize:  '12px',
      borderRadius: '4px',
      zIndex:    9999,
      transition: 'opacity 0.2s ease',
      opacity:   '0',
      pointerEvents: 'none',
    })
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.style.opacity = '1'
  clearTimeout(_flashTimer)
  _flashTimer = setTimeout(() => { el.style.opacity = '0' }, 2200)
}
