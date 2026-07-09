import { supabase } from './supabase.js'

// --- PVI Audit Trail (notes + disposition history) -------------------------
//
// Split out from supabase.js (2026-07-08) purely for delivery reasons: the
// main supabase.js file is at ~68KB and create_or_update_file was silently
// failing against it (no error surfaced, sha never advanced). Rather than
// keep fighting that ceiling, new PVI audit functionality lives here as a
// thin companion module that imports the shared `supabase` client.
// Functionally these are a straight continuation of the "PVI Lot
// Dispositions" / "PVI Shelf Life" sections in supabase.js -- see those
// sections for schema notes on pvi_shelf_notes and pvi_lot_dispositions.
//
// Backing tables (migrations already applied via Supabase MCP):
//   pvi_lot_disposition_history -- append-only. Populated EXCLUSIVELY by a
//     DB trigger (log_pvi_lot_disposition_change) on insert/update to
//     pvi_lot_dispositions. The anon role has no insert/update/delete grant
//     on this table, so nothing in the app (or a bug in it) can write to or
//     alter the log directly -- only the trigger can.
//   pvi_shelf_notes -- gained deleted_at/deleted_by, status_changed_by/
//     status_changed_at columns. A parallel trigger
//     (log_pvi_shelf_note_change) mirrors creates/status-changes/deletes
//     into pvi_shelf_notes_history, same anon-write-protected pattern.
//
// Why "Active" / "Audited" / "soft" in these names instead of just
// overriding the originals: supabase.js still exports the original
// fetchPviShelfNotes / updatePviShelfNoteStatus / deletePviShelfNote for any
// other consumer. PviShelfLife.jsx imports the versions here instead of
// those, so behavior changes without editing supabase.js.

// fetchPviShelfNotesActive -- same as fetchPviShelfNotes in supabase.js,
// plus .is('deleted_at', null) so soft-deleted notes disappear from the UI
// exactly like a hard delete used to, but the row (and its trigger-logged
// history) survives underneath.
export async function fetchPviShelfNotesActive(itemLotPairs) {
  if (!supabase) return []
  let query = supabase
    .from('pvi_shelf_notes')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (itemLotPairs && itemLotPairs.length) {
    const items = [...new Set(itemLotPairs.map(p => p.item))]
    const lots  = [...new Set(itemLotPairs.map(p => p.lot_code))]
    query = query.in('item', items).in('lot_code', lots)
  }
  const { data, error } = await query
  if (error) { console.error('fetchPviShelfNotesActive:', error); return [] }
  return data ?? []
}

// updatePviShelfNoteStatusAudited -- like updatePviShelfNoteStatus but
// records who made the change. Previously a status flip left zero trace of
// who did it (the note still showed only the original author, even if
// someone else moved it to "resolved" or "dispose"). The
// log_pvi_shelf_note_change trigger appends this to pvi_shelf_notes_history
// too, so the change survives even if these columns get overwritten again.
export async function updatePviShelfNoteStatusAudited(id, status, changedBy) {
  if (!supabase) return
  const { error } = await supabase
    .from('pvi_shelf_notes')
    .update({
      status,
      status_changed_by: (changedBy || '').trim() || null,
      status_changed_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) { console.error('updatePviShelfNoteStatusAudited:', error); throw error }
}

// softDeletePviShelfNote -- soft-delete instead of hard DELETE. Previously a
// note could vanish with zero record of who removed it or what it said.
// Sets deleted_at/deleted_by; fetchPviShelfNotesActive filters these out by
// default so the UI behaves identically, but the row (and the
// pvi_shelf_notes_history trigger entry) survives for audit.
export async function softDeletePviShelfNote(id, deletedBy) {
  if (!supabase) return
  const { error } = await supabase
    .from('pvi_shelf_notes')
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: (deletedBy || '').trim() || null,
    })
    .eq('id', id)
  if (error) { console.error('softDeletePviShelfNote:', error); throw error }
}

// fetchPviLotDispositionHistory -- reads the append-only change log for a
// single lot (2026-07-08, Wade ask: "can we see history of who did what").
// Populated exclusively by the log_pvi_lot_disposition_change trigger on
// every insert/update to pvi_lot_dispositions.
export async function fetchPviLotDispositionHistory(materialCode, lotCode) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('pvi_lot_disposition_history')
    .select('*')
    .eq('material_code', String(materialCode))
    .eq('lot_code', String(lotCode))
    .order('changed_at', { ascending: false })
  if (error) { console.error('fetchPviLotDispositionHistory:', error); return [] }
  return data ?? []
}
