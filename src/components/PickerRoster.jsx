import { useState, useEffect, useCallback } from 'react'
import { DndContext, DragOverlay, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { fetchPickerAssignments, upsertPickerAssignment, deletePickerAssignment } from '../lib/supabase.js'
import { fetchWrPickers } from '../lib/omni.js'

// Zone descriptions from CSW-Pickline repo
const ZONE_DESC = [
  '',
  'PizCor / MVP',
  'PizCor / MVP / LM',
  'BrewPub LM High-Vol',
  'BrewPub LM Variety',
  'LM Tail + Roma',
  'Roma + Bell Std',
  'Bell Std + Patriot',
  'Patriot / Orv / HV Tavern',
  'HV / GF / Nancy’s',
  'Lucia’s / Nancy’s / Dessert',
  'Roma 1 / Micro / Pers Sz',
  'Micro / Pers / RD / Brunch',
]

const ZONE_COLORS  = ['','#E3F2FD','#E3F2FD','#E0F7FA','#E0F7FA','#FFF8E1','#FCE4EC','#FCE4EC','#F1F8E9','#F1F8E9','#EDE7F6','#EDE7F6','#FBE9E7']
const ZONE_BORDERS = ['','#90CAF9','#90CAF9','#4DD0E1','#4DD0E1','#FFD54F','#F48FB1','#F48FB1','#AED581','#AED581','#B39DDB','#B39DDB','#FFAB91']

function PickerTile({ picker, onRemove }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: picker.employee_id,
    data: { picker },
  })
  return (
    <div
      ref={setNodeRef} {...listeners} {...attributes}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: isDragging ? '#e3f2fd' : '#fff',
        border: `1px solid ${isDragging ? '#1565C0' : '#ddd'}`,
        borderRadius: 4, padding: '3px 6px', fontSize: 11,
        cursor: 'grab', opacity: isDragging ? 0.4 : 1,
        marginBottom: 3, userSelect: 'none', touchAction: 'none',
        boxShadow: isDragging ? '0 2px 8px rgba(21,101,192,0.2)' : 'none',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        {picker.name}
      </span>
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onRemove(picker.employee_id) }}
        style={{ marginLeft: 4, background: 'none', border: 'none', color: '#bbb', cursor: 'pointer', fontSize: 10, padding: '0 2px', flexShrink: 0 }}
        title="Remove from roster"
      >×</button>
    </div>
  )
}

function ZoneLane({ zone, pickers, onRemove, zoneCases }) {
  const id = zone === 0 ? 'unassigned' : `zone-${zone}`
  const { isOver, setNodeRef } = useDroppable({ id })
  const bg     = zone === 0 ? '#f8f9fa'    : ZONE_COLORS[zone]
  const border = zone === 0 ? '#dee2e6'    : ZONE_BORDERS[zone]
  return (
    <div
      ref={setNodeRef}
      style={{
        border: `1px solid ${isOver ? '#1565C0' : border}`,
        borderRadius: 6,
        background: isOver ? '#e8f0fe' : bg,
        padding: '6px 8px',
        minHeight: zone === 0 ? 44 : 80,
        transition: 'background 0.1s, border-color 0.1s',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ marginBottom: 4 }}>
        {zone === 0 ? (
          <span style={{ fontSize: 10, fontWeight: 'bold', color: '#666' }}>Unassigned ({pickers.length})</span>
        ) : (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 'bold', color: '#333' }}>Z{zone}</span>
            <span style={{ fontSize: 9, color: '#666', flex: 1, minWidth: 0, lineHeight: 1.3 }}>{ZONE_DESC[zone]}</span>
            {zoneCases > 0 && (
              <span style={{ fontSize: 9, color: '#1565C0', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{zoneCases.toLocaleString()}cs</span>
            )}
          </div>
        )}
        {zone !== 0 && (
          <div style={{ fontSize: 9, color: '#999', marginTop: 1 }}>
            {pickers.length} picker{pickers.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }}>
        {pickers.map(p => <PickerTile key={p.employee_id} picker={p} onRemove={onRemove} />)}
        {pickers.length === 0 && zone !== 0 && (
          <div style={{ fontSize: 9, color: '#ccc', textAlign: 'center', paddingTop: 6 }}>drop here</div>
        )}
      </div>
    </div>
  )
}

export default function PickerRoster({ routes = [] }) {
  const [pickers,  setPickers]  = useState([])
  const [loading,  setLoading]  = useState(true)
  const [syncing,  setSyncing]  = useState(false)
  const [syncMsg,  setSyncMsg]  = useState(null)
  const [activeId, setActiveId] = useState(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // Zone case demand from current snapshot
  const zoneCases = {}
  for (const r of routes) {
    for (const [z, v] of Object.entries(r.z || {})) {
      zoneCases[+z] = (zoneCases[+z] || 0) + v
    }
  }

  useEffect(() => {
    fetchPickerAssignments().then(rows => {
      setPickers(rows.map(r => ({ employee_id: r.employee_id, name: r.employee_name, zone: r.zone ?? null })))
      setLoading(false)
    })
  }, [])

  const handleSync = useCallback(async () => {
    setSyncing(true); setSyncMsg(null)
    try {
      const b2ePickers = await fetchWrPickers(new Date().toISOString().slice(0, 10))
      if (b2ePickers.length === 0) {
        setSyncMsg({ err: true, text: 'No job code 206 employees found at WR in B2E' })
        return
      }
      // Preserve existing zone assignments
      const savedZones = {}
      for (const p of pickers) savedZones[p.employee_id] = p.zone ?? null

      const merged = b2ePickers.map(e => ({
        employee_id: String(e.id),
        name:        e.name,
        zone:        savedZones[String(e.id)] ?? null,
      }))

      await Promise.all(merged.map(p => upsertPickerAssignment(p.employee_id, p.name, p.zone)))
      setPickers(merged)
      setSyncMsg({ err: false, text: `Synced ${merged.length} pickers from B2E` })
    } catch (err) {
      setSyncMsg({ err: true, text: err.message ?? 'Sync failed' })
    } finally {
      setSyncing(false)
    }
  }, [pickers])

  const handleRemove = useCallback(async (employeeId) => {
    await deletePickerAssignment(employeeId)
    setPickers(prev => prev.filter(p => p.employee_id !== employeeId))
  }, [])

  const handleDragEnd = useCallback(async (event) => {
    setActiveId(null)
    const { active, over } = event
    if (!over) return
    const employeeId = active.id
    const newZone    = over.id === 'unassigned' ? null : parseInt(over.id.replace('zone-', ''), 10)
    const picker     = pickers.find(p => p.employee_id === employeeId)
    if (!picker || picker.zone === newZone) return
    setPickers(prev => prev.map(p => p.employee_id === employeeId ? { ...p, zone: newZone } : p))
    await upsertPickerAssignment(employeeId, picker.name, newZone)
  }, [pickers])

  const activePicker = activeId ? pickers.find(p => p.employee_id === activeId) : null

  // Group by zone
  const byZone = {}
  for (let z = 0; z <= 12; z++) byZone[z] = []
  for (const p of pickers) byZone[p.zone ?? 0].push(p)

  if (loading) return (
    <div style={{ padding: '10px 0', fontSize: 11, color: '#888' }}>Loading picker roster…</div>
  )

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', fontSize: 11, marginBottom: 10 }}>
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 10px', background: '#37474F', borderRadius: '6px 6px 0 0',
      }}>
        <span style={{ color: '#fff', fontWeight: 'bold', fontSize: 11 }}>CASE PICKER ROSTER</span>
        <span style={{ color: '#90A4AE', fontSize: 10 }}>job code 206 · drag to assign zones</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {syncMsg && (
            <span style={{ fontSize: 10, color: syncMsg.err ? '#ef9a9a' : '#A5D6A7' }}>{syncMsg.text}</span>
          )}
          <button
            onClick={handleSync} disabled={syncing}
            style={{
              fontSize: 10, padding: '3px 10px',
              background: syncing ? '#546E7A' : '#1565C0',
              color: '#fff', border: 'none', borderRadius: 4,
              cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            {syncing ? 'Syncing…' : '↻ Sync from B2E'}
          </button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setActiveId(active.id)}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        {/* Unassigned pool — only shown if there are unassigned pickers */}
        {byZone[0].length > 0 && (
          <div style={{ marginBottom: 6, marginTop: 2 }}>
            <ZoneLane zone={0} pickers={byZone[0]} onRemove={handleRemove} zoneCases={0} />
          </div>
        )}

        {pickers.length === 0 && (
          <div style={{
            textAlign: 'center', padding: '16px', color: '#888', fontSize: 11,
            border: '1px dashed #ddd', borderRadius: 6, background: '#fafafa', margin: '4px 0',
          }}>
            No pickers in roster — click “Sync from B2E” to load job code 206 employees
          </div>
        )}

        {/* Z1–Z12 grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 5, marginTop: 2 }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map(z => (
            <ZoneLane key={z} zone={z} pickers={byZone[z]} onRemove={handleRemove} zoneCases={zoneCases[z] || 0} />
          ))}
        </div>

        <DragOverlay>
          {activePicker && (
            <div style={{
              background: '#1565C0', color: '#fff', borderRadius: 4,
              padding: '4px 10px', fontSize: 11,
              boxShadow: '0 4px 12px rgba(0,0,0,0.25)', cursor: 'grabbing',
            }}>
              {activePicker.name}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
