import { supabase } from './supabase.js'

// hrDocuments — signed-document custody for the HR tab. Added 2026-08-14
// per Dan's described loop: automated PDF -> supervisor gets it signed ->
// supervisor scans + uploads the signed copy back into the app -> HR
// downloads it later to manually enter into B2E. This file is ONLY the
// custody piece (store/retrieve); it does not push anything into B2E
// itself — that upload is a manual step HR does on their own.
//
// Backing infra: 'hr_signed_documents' table (metadata) + 'hr-documents'
// Storage bucket (private — not public, access via signed URLs). Both
// created 2026-08-14. RLS is wide open to anon on both, same security
// posture as every other table in this app — the HR password gate is
// the actual access control, not RLS.
//
// record_ref reuses whatever id each tracker's frontend already generates
// (e.g. 'MIS-003', 'PIP-001') or the attendance_points_actions.id cast to
// text — no new key scheme invented.

const BUCKET = 'hr-documents'

export async function fetchSignedDocuments(tracker, recordRef) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('hr_signed_documents')
    .select('*')
    .eq('tracker', tracker)
    .eq('record_ref', String(recordRef))
    .order('uploaded_at', { ascending: false })
  if (error) { console.error('fetchSignedDocuments:', error); return [] }
  return data ?? []
}

// uploadSignedDocument — stores the file in the private bucket, then
// records its metadata. Path is namespaced by tracker/recordRef/timestamp
// so re-uploads for the same record never collide.
export async function uploadSignedDocument({ tracker, recordRef, facility, employeeName, file, uploadedBy }) {
  if (!supabase) throw new Error('Supabase not configured')
  const safeName = (file.name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `${tracker}/${recordRef}/${Date.now()}-${safeName}`

  const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/pdf',
    upsert: false,
  })
  if (uploadErr) { console.error('uploadSignedDocument storage:', uploadErr); throw uploadErr }

  const { data, error: insertErr } = await supabase
    .from('hr_signed_documents')
    .insert({
      tracker,
      record_ref: String(recordRef),
      facility: facility || null,
      employee_name: employeeName || null,
      file_path: path,
      file_name: file.name || safeName,
      uploaded_by: uploadedBy || null,
    })
    .select()
    .single()
  if (insertErr) { console.error('uploadSignedDocument insert:', insertErr); throw insertErr }
  return data
}

// getSignedDownloadUrl — short-lived signed URL (1 hour) so HR can open
// or download the file. Bucket is private, so a plain public URL won't
// work.
export async function getSignedDownloadUrl(filePath) {
  if (!supabase) return null
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 3600)
  if (error) { console.error('getSignedDownloadUrl:', error); return null }
  return data?.signedUrl ?? null
}

export async function deleteSignedDocument(id, filePath) {
  if (!supabase) return
  const { error: storageErr } = await supabase.storage.from(BUCKET).remove([filePath])
  if (storageErr) console.error('deleteSignedDocument storage:', storageErr)
  const { error: rowErr } = await supabase.from('hr_signed_documents').delete().eq('id', id)
  if (rowErr) console.error('deleteSignedDocument row:', rowErr)
}
