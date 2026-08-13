import { useState, useEffect } from 'react'
import { fetchJdfMaterialList } from '../lib/jdfLpLocator.js'

// ─── JDF Same-Item Reference Table ──────────────────────────────────────
// Added 2026-08-13, per Dan's ask: "add this table to the bottom of the
// JDF Putaway tab... that way I have a reference." Live version of the
// "Rank / SKU / Description / Active LPs / % Same Item" table built ad hoc
// in chat earlier this project -- every JDF material ranked by all-time
// shipping-pallet throughput (fastest movers first), with current active
// LPs and % Same Item (JDF-wide location purity, not F8-only) alongside.
//
// Reuses fetchJdfMaterialList() -- the same call JdfLpLocator.jsx makes for
// its dropdown -- since the backend now returns a `referenceTable` field on
// that same response (see motherduck-jdf-lp-locations.cjs's 2026-08-13
// header note). Deliberately a separate component/fetch rather than lifting
// state up into JdfLpLocator, matching this app's usual pattern of
// independent per-section fetches rather than shared context -- the
// picklist call is fast and cheap, so a second fetch on mount is fine.

export default function JdfSameItemReference() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchJdfMaterialList()
      .then(d => {
        if (cancelled) return
        setRows(d.referenceTable ?? [])
        setFetchedAt(d.fetchedAt ?? null)
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="section-label" style={{ marginBottom: 4 }}>JDF Same-Item Reference — All Materials by Throughput</div>
        {fetchedAt && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
            as of {new Date(fetchedAt).toLocaleTimeString()}
          </div>
        )}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, maxWidth: 720 }}>
        Every JDF material, sequenced by all-time shipping-pallet throughput (fastest movers first), with current active
        LPs and % Same Item (location-level purity, JDF-wide — not limited to F8). Live reference for the same-item/
        same-tier consolidation project.
      </div>

      {loading && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>Loading reference table…</div>
      )}
      {err && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red)' }}>{err}</div>
      )}

      {!loading && !err && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden', maxHeight: 480, overflowY: 'auto' }}>
          <table className="hourly-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Rank</th>
                <th style={{ textAlign: 'left' }}>SKU</th>
                <th style={{ textAlign: 'left' }}>Description</th>
                <th>Active LPs</th>
                <th>% Same Item</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.code}>
                  <td>{r.rank}</td>
                  <td style={{ textAlign: 'left', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.code}</td>
                  <td style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>{r.name || '—'}</td>
                  <td>{r.activeLps || '—'}</td>
                  <td style={{
                    color: r.pctSameItem === null ? 'var(--text-dim)'
                      : r.pctSameItem >= 60 ? 'var(--green)'
                      : r.pctSameItem >= 40 ? 'var(--yellow)'
                      : 'var(--red)',
                    fontWeight: 600,
                  }}>
                    {r.pctSameItem === null ? 'n/a' : `${r.pctSameItem}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
