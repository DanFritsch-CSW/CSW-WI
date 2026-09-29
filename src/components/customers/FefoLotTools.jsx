import { lineVerdict, VERDICT_TOKENS } from '../../lib/fefo.js'

// FEFO Rotation companion — added 2026-09-29 (PVI FEFO call: Dan, Dean,
// Sam Vega). Split out of FefoRotationTab.jsx (already ~55 KB) so the tab
// file stays small enough to push safely.
//
// Problem: the Front digest names a culprit LOT, but finding that lot in
// the tab meant opening every order card, and the dismiss control only
// lived inside the expanded row. Two additions:
//   - LotRibbon: culprit lot(s) + verdict shown on the collapsed order
//     card; violation lots get a DISMISS LOT button right there.
//   - LotSearchBar / filterOrdersByQuery: type a lot / item / order # to
//     narrow the order list (list-only — banners/KPIs stay on the full view).

// filterOrdersByQuery — substring match (case-insensitive) on order id, line
// item code, oldest-remaining lot, and every shipping lot on the order.
export function filterOrdersByQuery(orders, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return orders
  const hit = v => String(v ?? '').toLowerCase().includes(q)
  return orders.filter(o =>
    hit(o.id) || (o.lines || []).some(l =>
      hit(l.code) || hit(l.rem?.lot) || (l.ship || []).some(sh => hit(sh.lot))))
}

export function LotSearchBar({ value, onChange, shown, total }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Search lot, item or order # (e.g. WC104321)"
        style={{
          flex: 1, minWidth: 220, maxWidth: 420,
          fontSize: 12, padding: '6px 10px',
          background: 'var(--bg1, #fff)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm, 4px)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        }}
      />
      {value.trim() && (
        <>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
            {shown} of {total} order{total === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={() => onChange('')}
            style={{
              fontSize: 11, padding: '4px 10px',
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm, 4px)', color: 'var(--text-secondary)', cursor: 'pointer',
            }}
          >Clear</button>
        </>
      )}
    </div>
  )
}

// LotRibbon — rendered as a SIBLING of the order header <button> (buttons
// can't nest). `Dismiss` is the tab's own DismissAction, passed in as a prop
// so this file doesn't import back from FefoRotationTab.jsx (no circular
// import). Violation lots get the dismiss button (same fefo-dismissals POST,
// per LOT not per order). Hold / receiving lots are display-only on purpose:
// Dan wants held lots to keep surfacing daily until someone destroys or
// releases them, not be silenced for N days.
export function LotRibbon({ order, onRefetch, Dismiss }) {
  const seen = new Map()
  for (const line of order.lines || []) {
    const v = lineVerdict(line)
    if (v !== 'violation' && v !== 'hold' && v !== 'blocked') continue
    if (!line.rem?.lot) continue
    const key = `${line.code}|${line.rem.lot}`
    if (!seen.has(key)) seen.set(key, { code: line.code, lot: line.rem.lot, v, holdType: line.rem.holdType })
  }
  const items = [...seen.values()]
  if (!items.length) return null
  const LABEL = { violation: 'out of rotation', hold: 'on hold', blocked: 'in receiving' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 14px 10px 42px' }}>
      {items.map(it => {
        const t = VERDICT_TOKENS[it.v]
        return (
          <div key={`${it.code}|${it.lot}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--text-secondary)' }}>{it.code}</span>
            <span style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: t.color }}>lot {it.lot}</span>
            <span style={{ fontSize: 10, color: t.color, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              {it.v === 'hold' && it.holdType ? it.holdType : LABEL[it.v]}
            </span>
            {it.v === 'violation' && Dismiss && (
              <div style={{ marginLeft: 'auto' }}>
                <Dismiss compact projectId={order.proj} lotLookupCode={it.lot} materialCode={it.code} onDone={onRefetch} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
