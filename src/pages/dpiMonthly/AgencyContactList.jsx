import React, { useState, useEffect, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase.js'
import { colors, cardStyle } from './dpiMonthlyStyles.js'

// Agency Contact List (A10/#5) — added 2026-09-28, directly from the
// JW<>DF DPI Monthly Build call. Front's own "Lists" feature was the
// original plan for agency contacts, but Dan's Front connector couldn't
// reliably read Front Lists (conflicting results across attempts), so
// this is the confirmed fallback: a self-service, in-app contact list Jen
// manages directly — she explicitly said she'd PREFER this over Front,
// since she already maintains her own copy of this exact spreadsheet and
// can just re-import it whenever DPI sends an update.
//
// Import source: the real DPI-provided "Updated Delivery Contacts" Excel
// workbook (SharePoint, same folder as DPI scheduling) — its "Master -
// State Delivery" sheet, confirmed against a real copy before building
// this. Header is NOT row 1 (that's a title; row 4 has section labels
// spanning multiple columns; row 5 has the real per-column headers; data
// starts row 6). Column mapping, confirmed against real agency numbers
// (673925 New Berlin, 407076 Hales Corners, 709270 ADVOCAP-Winnebago,
// 408011 Dr Howard Fuller all matched column C, not column K "Site Nbr,"
// which is a different, largely unrelated identifier):
//   B  Sponsor Name (agency_name)      C  Sponsor Nbr (agency_number, the
//   match key)                          D  County
//   E  Warehouse Assignment — text like "Central Storage and Warehouse
//      Eau Claire - NSLP" or "...Madison...", mapped to a plain facility
//      name below
//   F-J   Primary contact: first, last, email, phone, ext
//   K-T   "Delivery Primary" contact (Site Nbr, first, last, email,
//         phone, ext, then the delivery address) — Jen's own label for
//         this column group is "Day of Delivery Contact on Order Form"
//   U-Y   Alternate contact: first, last, email, phone, ext
//
// Per Jen, agency comms should email H (primary) + N (delivery primary)
// + W (alternate) — all three, not just one — and the route sheet's
// driver-facing contact should call the Delivery Primary phone (O+P)
// first, falling back to the Alternate (X+Y). See Phase4AgencyComms.jsx
// and Phase5FinalPush.jsx for where this table actually gets used.
//
// Import is an upsert on (facility, agency_number) — re-importing an
// updated copy of the same spreadsheet updates existing rows rather than
// duplicating them, matching how Jen actually works (she re-requests this
// sheet from DPI "every time there's a lot of changes"). No drag-and-drop
// anywhere on this screen, same reasoning as TemplateEditor.jsx — an
// occasional-use admin screen doesn't need it, and there's no interaction
// class here to get wrong.

function facilityFromWarehouseText(text) {
  const t = String(text || '')
  if (t.includes('Eau Claire')) return 'Eau Claire'
  if (t.includes('Madison')) return 'Madison'
  return null
}

const emptyContact = {
  agency_number: '', agency_name: '', county: '',
  primary_first_name: '', primary_last_name: '', primary_email: '', primary_phone: '', primary_ext: '',
  delivery_first_name: '', delivery_last_name: '', delivery_email: '', delivery_phone: '', delivery_ext: '',
  delivery_addr1: '', delivery_city: '', delivery_state: '', delivery_zip: '',
  alt_first_name: '', alt_last_name: '', alt_email: '', alt_phone: '', alt_ext: '',
}

export default function AgencyContactList({ facility }) {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [editingId, setEditingId] = useState(null) // 'new' for the add form, or a contact's id
  const [editFields, setEditFields] = useState(emptyContact)
  const fileInputRef = useRef(null)

  const load = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    setLoading(true)
    const { data, error } = await supabase
      .from('dpi_agency_contacts')
      .select('*')
      .eq('facility', facility)
      .order('agency_name')
    if (error) console.error('load agency contacts:', error)
    setContacts(data || [])
    setLoading(false)
  }, [facility])

  useEffect(() => { load() }, [load])

  const handleImportFile = async (file) => {
    setImporting(true)
    setImportResult(null)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets['Master - State Delivery']
      if (!sheet) {
        setImportResult({ error: `Sheet "Master - State Delivery" not found in this workbook. Sheets present: ${wb.SheetNames.join(', ')}` })
        return
      }
      // header: false + range starting at row 6 (0-indexed 5) since rows
      // 1-5 are title/section-header/column-header rows, not data.
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 5, defval: '' })

      const upserts = []
      let skippedNoFacilityMatch = 0
      let skippedNoAgencyNumber = 0
      for (const row of rows) {
        const agencyNumber = String(row[2] || '').trim() // C
        const warehouseText = row[4] // E
        const rowFacility = facilityFromWarehouseText(warehouseText)
        if (!agencyNumber) { skippedNoAgencyNumber++; continue }
        if (rowFacility !== facility) { skippedNoFacilityMatch++; continue } // import is facility-scoped

        upserts.push({
          facility,
          agency_number: agencyNumber,
          agency_name: String(row[1] || '').trim() || null, // B
          county: String(row[3] || '').trim() || null, // D
          primary_first_name: String(row[5] || '').trim() || null, // F
          primary_last_name: String(row[6] || '').trim() || null, // G
          primary_email: String(row[7] || '').trim() || null, // H
          primary_phone: String(row[8] || '').trim() || null, // I
          primary_ext: String(row[9] || '').trim() || null, // J
          delivery_first_name: String(row[11] || '').trim() || null, // L
          delivery_last_name: String(row[12] || '').trim() || null, // M
          delivery_email: String(row[13] || '').trim() || null, // N
          delivery_phone: String(row[14] || '').trim() || null, // O
          delivery_ext: String(row[15] || '').trim() || null, // P
          delivery_addr1: String(row[16] || '').trim() || null, // Q
          delivery_city: String(row[17] || '').trim() || null, // R
          delivery_state: String(row[18] || '').trim() || null, // S
          delivery_zip: String(row[19] || '').trim() || null, // T
          alt_first_name: String(row[20] || '').trim() || null, // U
          alt_last_name: String(row[21] || '').trim() || null, // V
          alt_email: String(row[22] || '').trim() || null, // W
          alt_phone: String(row[23] || '').trim() || null, // X
          alt_ext: String(row[24] || '').trim() || null, // Y
          updated_at: new Date().toISOString(),
        })
      }

      if (upserts.length === 0) {
        setImportResult({ error: `No rows matched facility "${facility}" — check this is the right file, or that the Warehouse Assignment column mentions "${facility}".` })
        return
      }

      if (!supabase) return
      const { error } = await supabase.from('dpi_agency_contacts').upsert(upserts, { onConflict: 'facility,agency_number' })
      if (error) { setImportResult({ error: error.message }); return }

      setImportResult({ success: true, count: upserts.length, skippedNoFacilityMatch, skippedNoAgencyNumber })
      load()
    } catch (err) {
      setImportResult({ error: `Could not read this file: ${err.message}` })
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const startEdit = (contact) => {
    setEditingId(contact.id)
    setEditFields({ ...emptyContact, ...contact })
  }

  const startAdd = () => {
    setEditingId('new')
    setEditFields(emptyContact)
  }

  const saveEdit = async () => {
    if (!supabase || !editFields.agency_number.trim()) return
    const payload = { ...editFields, facility, updated_at: new Date().toISOString() }
    delete payload.id
    delete payload.created_at
    const { error } = await supabase.from('dpi_agency_contacts').upsert(payload, { onConflict: 'facility,agency_number' })
    if (error) { console.error('save contact:', error); return }
    setEditingId(null)
    load()
  }

  const deleteContact = async (contact) => {
    if (!supabase) return
    if (!window.confirm(`Remove ${contact.agency_name || contact.agency_number} from the contact list?`)) return
    const { error } = await supabase.from('dpi_agency_contacts').delete().eq('id', contact.id)
    if (error) { console.error('delete contact:', error); return }
    load()
  }

  const filtered = contacts.filter((c) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (c.agency_name || '').toLowerCase().includes(q) || (c.agency_number || '').includes(q)
  })

  const fieldStyle = { fontSize: 12, padding: '4px 6px', borderRadius: 4, border: `1px solid ${colors.border}`, background: colors.bg, color: colors.text, width: '100%' }
  const fieldRowStyle = { display: 'grid', gridTemplateColumns: '90px 1fr', gap: 6, alignItems: 'center', marginBottom: 4 }

  if (loading) return <div style={{ fontSize: 13, color: colors.textFaint }}>Loading agency contacts…</div>

  return (
    <div>
      <div style={{ fontSize: 12, color: colors.textFaint, marginBottom: 16, maxWidth: 720 }}>
        Agency contacts for {facility} — used by Agency Comms (recipient emails) and the final route sheet (driver-facing phone contact). Import the DPI-provided "Updated Delivery Contacts" spreadsheet below whenever you get an updated copy; re-importing updates existing agencies rather than duplicating them. Add or edit individual contacts directly any time.
      </div>

      <div style={{ ...cardStyle, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f) }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: `1px solid ${colors.accent}`, background: 'transparent', color: colors.accent, cursor: importing ? 'default' : 'pointer', opacity: importing ? 0.5 : 1 }}
        >
          {importing ? 'Importing…' : '📥 Import contact spreadsheet'}
        </button>
        {importResult?.success && (
          <span style={{ fontSize: 12, color: colors.success }}>
            Imported/updated {importResult.count} contact{importResult.count === 1 ? '' : 's'} for {facility}
            {importResult.skippedNoFacilityMatch > 0 ? ` (skipped ${importResult.skippedNoFacilityMatch} row(s) for other facilities)` : ''}.
          </span>
        )}
        {importResult?.error && <span style={{ fontSize: 12, color: colors.danger }}>{importResult.error}</span>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by agency name or number…"
          style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.borderStrong}`, background: colors.bg, color: colors.text, minWidth: 260 }}
        />
        <button
          onClick={startAdd}
          style={{ fontSize: 13, padding: '6px 12px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.textMuted, cursor: 'pointer' }}
        >
          + Add contact
        </button>
        <span style={{ fontSize: 12, color: colors.textFaint }}>{filtered.length} of {contacts.length}</span>
      </div>

      {editingId === 'new' && (
        <ContactEditForm fields={editFields} setFields={setEditFields} onSave={saveEdit} onCancel={() => setEditingId(null)} fieldStyle={fieldStyle} fieldRowStyle={fieldRowStyle} isNew />
      )}

      <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '90px 1.4fr 1.4fr 1.4fr 1.2fr 70px', padding: '10px 16px', fontSize: 11, color: colors.textFaint, borderBottom: `1px solid ${colors.border}` }}>
          <div>Agency #</div>
          <div>Agency</div>
          <div>Primary</div>
          <div>Delivery Contact</div>
          <div>Alternate</div>
          <div></div>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding: 16, fontSize: 13, color: colors.textFaint, fontStyle: 'italic' }}>
            {contacts.length === 0 ? 'No contacts imported yet for this facility.' : 'No contacts match your search.'}
          </div>
        )}
        {filtered.map((c) => (
          <React.Fragment key={c.id}>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1.4fr 1.4fr 1.4fr 1.2fr 70px', padding: '10px 16px', fontSize: 12, borderBottom: `1px solid ${colors.border}`, alignItems: 'center' }}>
              <div style={{ color: colors.textFaint }}>{c.agency_number}</div>
              <div style={{ color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.agency_name || '—'}</div>
              <div style={{ color: colors.textMuted, fontSize: 11 }}>
                {c.primary_first_name || c.primary_last_name ? `${c.primary_first_name || ''} ${c.primary_last_name || ''}`.trim() : '—'}
                {c.primary_email && <div style={{ color: colors.textFaint }}>{c.primary_email}</div>}
              </div>
              <div style={{ color: colors.textMuted, fontSize: 11 }}>
                {c.delivery_first_name || c.delivery_last_name ? `${c.delivery_first_name || ''} ${c.delivery_last_name || ''}`.trim() : '—'}
                {c.delivery_email && <div style={{ color: colors.textFaint }}>{c.delivery_email}</div>}
                {c.delivery_phone && <div style={{ color: colors.textFaint }}>{c.delivery_phone}{c.delivery_ext ? ` x${c.delivery_ext}` : ''}</div>}
              </div>
              <div style={{ color: colors.textMuted, fontSize: 11 }}>
                {c.alt_email || c.alt_phone ? (
                  <>
                    {c.alt_email && <div>{c.alt_email}</div>}
                    {c.alt_phone && <div style={{ color: colors.textFaint }}>{c.alt_phone}{c.alt_ext ? ` x${c.alt_ext}` : ''}</div>}
                  </>
                ) : '—'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => startEdit(c)} style={{ fontSize: 11, color: colors.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Edit</button>
                <button onClick={() => deleteContact(c)} style={{ fontSize: 11, color: colors.danger, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>
              </div>
            </div>
            {editingId === c.id && (
              <div style={{ padding: 16, borderBottom: `1px solid ${colors.border}`, background: colors.panelAlt }}>
                <ContactEditForm fields={editFields} setFields={setEditFields} onSave={saveEdit} onCancel={() => setEditingId(null)} fieldStyle={fieldStyle} fieldRowStyle={fieldRowStyle} />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

// Shared edit form for both "add new" and "edit existing" — same fields
// either way, matching the real spreadsheet's three contact groups.
function ContactEditForm({ fields, setFields, onSave, onCancel, fieldStyle, fieldRowStyle, isNew }) {
  const set = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }))
  return (
    <div style={{ marginBottom: isNew ? 16 : 0, padding: 12, borderRadius: 6 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: fieldStyle.color, marginBottom: 6 }}>Agency</div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Number</span><input value={fields.agency_number} onChange={set('agency_number')} style={fieldStyle} disabled={!isNew} title={isNew ? undefined : "Agency number can't be changed after creation — delete and re-add if it was entered wrong"} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Name</span><input value={fields.agency_name} onChange={set('agency_name')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>County</span><input value={fields.county} onChange={set('county')} style={fieldStyle} /></div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Primary Contact</div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>First</span><input value={fields.primary_first_name} onChange={set('primary_first_name')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Last</span><input value={fields.primary_last_name} onChange={set('primary_last_name')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Email</span><input value={fields.primary_email} onChange={set('primary_email')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Phone</span><input value={fields.primary_phone} onChange={set('primary_phone')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Ext</span><input value={fields.primary_ext} onChange={set('primary_ext')} style={fieldStyle} /></div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Delivery Contact (day-of, on order form)</div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>First</span><input value={fields.delivery_first_name} onChange={set('delivery_first_name')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Last</span><input value={fields.delivery_last_name} onChange={set('delivery_last_name')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Email</span><input value={fields.delivery_email} onChange={set('delivery_email')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Phone</span><input value={fields.delivery_phone} onChange={set('delivery_phone')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Ext</span><input value={fields.delivery_ext} onChange={set('delivery_ext')} style={fieldStyle} /></div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Delivery Address</div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Street</span><input value={fields.delivery_addr1} onChange={set('delivery_addr1')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>City</span><input value={fields.delivery_city} onChange={set('delivery_city')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>State</span><input value={fields.delivery_state} onChange={set('delivery_state')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Zip</span><input value={fields.delivery_zip} onChange={set('delivery_zip')} style={fieldStyle} /></div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Alternate Contact</div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>First</span><input value={fields.alt_first_name} onChange={set('alt_first_name')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Last</span><input value={fields.alt_last_name} onChange={set('alt_last_name')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Email</span><input value={fields.alt_email} onChange={set('alt_email')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Phone</span><input value={fields.alt_phone} onChange={set('alt_phone')} style={fieldStyle} /></div>
          <div style={fieldRowStyle}><span style={{ fontSize: 11 }}>Ext</span><input value={fields.alt_ext} onChange={set('alt_ext')} style={fieldStyle} /></div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={onSave} disabled={!fields.agency_number?.trim()} style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: 'none', background: fields.agency_number?.trim() ? colors.accent : colors.border, color: '#fff', cursor: fields.agency_number?.trim() ? 'pointer' : 'default' }}>Save</button>
        <button onClick={onCancel} style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.textMuted, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  )
}
