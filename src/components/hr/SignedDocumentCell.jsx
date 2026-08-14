import { useState, useEffect, useRef } from 'react'
import { fetchSignedDocuments, uploadSignedDocument, getSignedDownloadUrl } from '../../lib/hrDocuments.js'

// SignedDocumentCell — drops into any tracker's table row. Shows an
// Upload button when nothing's on file for this record; once something's
// uploaded, shows the filename + a Download link plus a way to add
// another (e.g. a later escalation on the same record).
//
// Added 2026-08-14 for Dan's described loop: automated PDF -> supervisor
// gets it signed -> scans + uploads the signed copy here -> HR downloads
// later to manually enter into B2E. This component only handles the
// upload/download half — nothing here talks to B2E.

export default function SignedDocumentCell({ tracker, recordRef, facility, employeeName }) {
  const [docs, setDocs] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    fetchSignedDocuments(tracker, recordRef).then((d) => { if (!cancelled) setDocs(d) })
    return () => { cancelled = true }
  }, [tracker, recordRef])

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      await uploadSignedDocument({ tracker, recordRef, facility, employeeName, file })
      const fresh = await fetchSignedDocuments(tracker, recordRef)
      setDocs(fresh)
    } catch (err) {
      setError(err.message || 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDownload = async (filePath) => {
    const url = await getSignedDownloadUrl(filePath)
    if (url) window.open(url, '_blank', 'noopener')
    else alert('Could not generate a download link — try again.')
  }

  if (docs === null) return <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>…</span>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      {docs.map((d) => (
        <button
          key={d.id}
          className="b2e-sync-btn"
          style={{ fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          onClick={() => handleDownload(d.file_path)}
          title={`Uploaded ${new Date(d.uploaded_at).toLocaleDateString()} — ${d.file_name}`}
        >
          ⬇ {d.file_name}
        </button>
      ))}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,image/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <button
        className="b2e-sync-btn"
        style={{ fontSize: 11 }}
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading ? 'Uploading…' : docs.length ? '+ Add signed copy' : 'Upload signed copy'}
      </button>
      {error && <span style={{ color: 'var(--red)', fontSize: 10 }}>{error}</span>}
    </div>
  )
}
