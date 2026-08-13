import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchJdfMaterialList, fetchJdfLpLocations } from '../lib/jdfLpLocator.js'
import '../styles/jdf-lp-locator.css'

// ─── JDF LP Locator ──────────────────────────────────────────────────────
// Added 2026-08-13, per Dan's ask: "select a JDF material and the PDF
// document is available to print." Lives as a section inside the JDF
// Putaways tab (imported by JdfPutaways.jsx), not a separate top-level tab.
//
// Repeatable version of the one-off pallet-location worksheet built earlier
// for SKU 018505 in chat — same table shape (Location, LP Code, MFG Date,
// Units, Clean/Mixed status, Sharing With), same Clean/Mixed logic (a bin
// is Mixed if any other JDF SKU shares that exact location), now backed by
// motherduck-jdf-lp-locations.cjs so it works for any material, not just
// one hardcoded pull.
//
// "PDF" here means browser print-to-PDF (window.print(), same pattern as
// src/pages/InventoryReport.jsx's cycle-count sheet) rather than a
// server-generated PDF file — no native PDF library needed, and the
// browser's own "Save as PDF" print destination produces the same result
// the person asked for. See jdf-lp-locator.css for the print-only view.
//
// FIXED 2026-08-13 (same day): dropped the `jdflp-no-print` class from the
// wrapper below -- confirmed live that it wasn't enough, since this
// component is only one section inside JdfPutaways and everything ELSE on
// that tab (scorecards, Notify panel, aisle breakdown, Same-Item Reference
// table, app nav) was still printing alongside the worksheet. The CSS now
// hides the whole page during print and re-shows only `.jdflp-print-only`
// (see jdf-lp-locator.css's header for the full story), so no no-print
// class is needed on this wrapper anymore.

export default function JdfLpLocator() {
  const [materials, setMaterials] = useState([])
  const [materialsLoading, setMaterialsLoading] = useState(true)
  const [materialsErr, setMaterialsErr] = useState(null)

  const [selectedSku, setSelectedSku] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailErr, setDetailErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchJdfMaterialList()
      .then(d => { if (!cancelled) setMaterials(d.materials ?? []) })
      .catch(e => { if (!cancelled) setMaterialsErr(e.message) })
      .finally(() => { if (!cancelled) setMaterialsLoading(false) })
    return () => { cancelled = true }
  }, [])

  const loadDetail = useCallback((sku) => {
    if (!sku) { setDetail(null); return }
    setDetailLoading(true)
    setDetailErr(null)
    fetchJdfLpLocations(sku)
      .then(setDetail)
      .catch(e => setDetailErr(e.message))
      .finally(() => setDetailLoading(false))
  }, [])

  const handleSelect = (e) => {
    const sku = e.target.value
    setSelectedSku(sku)
    loadDetail(sku)
  }

  // Same body-class-toggle pattern as InventoryReport.jsx's handlePrintSheet
  // (see jdf-lp-locator.css) — scoped to this print action only, cleaned up
  // on 'afterprint' so it doesn't linger and affect other tabs' printing.
  const handlePrint = useCallback(() => {
    document.body.classList.add('jdflp-printing')
    const cleanup = () => document.body.classList.remove('jdflp-printing')
    window.addEventListener('afterprint', cleanup, { once: true })
    window.print()
  }, [])

  const printDateStr = useMemo(
    () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    [detail]
  )

  const cardStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '12px 16px' }
  const selectStyle = { fontFamily: 'var(--font-mono)', fontSize: 12, padding: '6px 10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--bg1)', color: 'var(--text-primary)', minWidth: 320, outline: 'none' }
  const btnStyle = { padding: '7px 14px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }

  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginTop: 8, marginBottom: 16 }}>
      <div className="section-label" style={{ marginBottom: 4 }}>JDF LP Locator — Print Pallet Locations by Material</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, maxWidth: 640 }}>
        Select a material to see every active pallet and its current location, live from MotherDuck. Use this to work a
        same-item/same-tier consolidation pass on the floor — print or save as PDF to take with you.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        {materialsLoading ? (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>Loading materials…</span>
        ) : materialsErr ? (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red)' }}>{materialsErr}</span>
        ) : (
          <select value={selectedSku} onChange={handleSelect} style={selectStyle}>
            <option value="">— Select a JDF material —</option>
            {materials.map(m => (
              <option key={m.code} value={m.code}>
                {m.code} — {m.name} ({m.activeLps} active LP{m.activeLps === 1 ? '' : 's'})
              </option>
            ))}
          </select>
        )}
        {detail && !detailLoading && (
          <button style={btnStyle} onClick={handlePrint} title="Opens the print dialog — choose 'Save as PDF' as the destination to download instead of printing.">
            🖨 Print / Save PDF
          </button>
        )}
      </div>

      {detailLoading && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>Loading pallet locations for {selectedSku}…</div>
      )}
      {detailErr && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red)' }}>{detailErr}</div>
      )}

      {detail && !detailLoading && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
            <div style={{ ...cardStyle, textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 4 }}>Total Active LPs</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600 }}>{detail.totalLps}</div>
            </div>
            <div style={{ ...cardStyle, textAlign: 'center', borderTop: '2px solid var(--green)' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 4 }}>Clean Bins</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--green)' }}>{detail.cleanCount}</div>
            </div>
            <div style={{ ...cardStyle, textAlign: 'center', borderTop: '2px solid var(--red)' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 4 }}>Mixed Bins</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--red)' }}>{detail.mixedCount}</div>
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden', maxHeight: 420, overflowY: 'auto' }}>
            <table className="hourly-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Location</th>
                  <th style={{ textAlign: 'left' }}>LP Code</th>
                  <th style={{ textAlign: 'left' }}>MFG Date</th>
                  <th>Units</th>
                  <th style={{ textAlign: 'left' }}>Status</th>
                  <th style={{ textAlign: 'left' }}>Sharing With</th>
                </tr>
              </thead>
              <tbody>
                {detail.lps.map(lp => (
                  <tr key={lp.lpCode}>
                    <td style={{ textAlign: 'left', fontWeight: 600 }}>{lp.location}</td>
                    <td style={{ textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{lp.lpCode}</td>
                    <td style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>{lp.mfgDate || '—'}</td>
                    <td>{lp.units}</td>
                    <td style={{ textAlign: 'left', color: lp.status === 'clean' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {lp.status === 'clean' ? 'Clean' : 'Mixed'}
                    </td>
                    <td style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>{lp.sharingWith.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Print-only worksheet — hidden on screen, rendered only via
          @media print in jdf-lp-locator.css. Plain single table, natural
          page flow (see that file's header for why this doesn't need
          Inventory's JS-chunked 2-column layout). */}
      {detail && (
        <div className="jdflp-print-only">
          <div className="jdflp-print-header">
            <div className="title">CSW — JDF Pallet Locations — {detail.sku} {detail.materialName ? `(${detail.materialName})` : ''}</div>
            <div className="meta">Printed {printDateStr} · Live from MotherDuck</div>
            <div className="summary">
              <span>Total: <b>{detail.totalLps}</b></span>
              <span style={{ color: '#15803d' }}>Clean: <b>{detail.cleanCount}</b></span>
              <span style={{ color: '#b91c1c' }}>Mixed: <b>{detail.mixedCount}</b></span>
            </div>
            <div className="meta small">"Clean" = every pallet in that bin is this SKU. "Mixed" = the bin also holds one or more other SKUs, listed under Sharing With — priority locations for the same-item/same-tier consolidation project.</div>
          </div>
          <table className="jdflp-print-table">
            <thead>
              <tr>
                <th className="loc-col">Location</th>
                <th className="lp-col">LP Code</th>
                <th className="date-col">MFG Date</th>
                <th className="units-col">Units</th>
                <th className="status-col">Status</th>
                <th className="share-col">Sharing With</th>
              </tr>
            </thead>
            <tbody>
              {detail.lps.map(lp => (
                <tr key={lp.lpCode}>
                  <td className="loc">{lp.location}</td>
                  <td className="lp">{lp.lpCode}</td>
                  <td>{lp.mfgDate || '—'}</td>
                  <td>{lp.units}</td>
                  <td className={lp.status === 'clean' ? 'clean' : 'mixed'}>{lp.status === 'clean' ? 'Clean' : 'Mixed'}</td>
                  <td>{lp.sharingWith.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
