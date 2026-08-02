import { useState, useEffect, useMemo, useCallback } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import {
  currentQuarter, priorQuarter, fetchScorecard,
  seedQuarterIfMissing, updateMetric, computeAttainment,
  computeOverallAttainment, fetchLiveOtt, fetchLiveCasePickAccuracy,
  fetchLiveOsdDollar, fetchLiveOsdCount, fetchLiveTakt,
} from '../lib/managerBonus.js'

const FACILITY_COLOR_VAR = { cal: 'var(--cal)', ken: 'var(--ken)', mad: 'var(--mad)', wr: 'var(--wr)', ec: 'var(--ec)' }

function fmtVal(v, unit) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (Number.isNaN(n)) return '—'
  if (unit === '$') return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (unit === '%') return `${n}%`
  return `${n}`
}

function attainmentColor(att) {
  if (att == null) return 'var(--text-dim)'
  if (att >= 100) return 'var(--green)'
  if (att >= 70) return 'var(--amber, #d4b84a)'
  return 'var(--red)'
}

// Small inline-editable numeric cell. Local draft state, commits on blur
// (or Enter) so we're not writing to Supabase on every keystroke.
function EditableCell({ value, unit, onCommit }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => { setDraft(value == null ? '' : String(value)) }, [value])

  function commit() {
    const trimmed = draft.trim()
    if (trimmed === '') { onCommit(null); return }
    const n = Number(trimmed)
    if (Number.isNaN(n)) { setDraft(value == null ? '' : String(value)); return }
    onCommit(n)
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
      style={{
        width: unit === '$' ? 78 : 60,
        textAlign: 'center',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        padding: '4px 6px',
        borderRadius: 4,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg2, transparent)',
        color: 'inherit',
      }}
    />
  )
}

// Bonus target calculator — deliberately NOT persisted anywhere. Added
// 2026-07-28 as a saved-per-facility Supabase field; changed 2026-07-31
// per Dean's explicit direction on the Dean<>Dan call: since every
// facility shares the same page password, a saved target would let any
// GM/ops manager see every other facility's bonus target just by
// switching tabs (this came up specifically because Eau Claire's Deb is
// getting a reduced H1 bonus for performance reasons, and Dean does not
// want that comparison possible). Fix: nobody's target is ever written to
// the database. Each person types their own number in to see their own
// projected payout, and it clears the moment they click away (onBlur) —
// "it always resets after you tab off" was Dean's exact ask. This is a
// pure client-side calculator now, no fetchSettings/upsertSettings call
// in this component at all.
//
// Went Annual -> Quarterly -> back to Annual-with-quarterly-breakdown
// across three requests on 2026-08-02: first Dan asked for a straight
// Quarterly relabel (bonuses ARE paid quarterly), then flagged that the
// number people actually think in is their ANNUAL target, and asked to
// see the quarterly amount broken out too rather than replacing one with
// the other. Current design: input stays labeled Annual (that's the
// number people know off the top of their head); quarterly target is
// derived as annual/4, and the projected payout is computed off that
// quarterly target (not the raw annual figure) — since attainment is
// tracked and paid per quarter, not per year.
function BonusCalculator({ overall }) {
  const [draft, setDraft] = useState('')
  const annualNum = draft.trim() === '' ? null : Number(draft)
  const quarterlyTarget = annualNum != null && !Number.isNaN(annualNum) ? annualNum / 4 : null
  const projectedPayout = overall != null && quarterlyTarget != null
    ? (quarterlyTarget * overall) / 100
    : null

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
          Your Annual Target Bonus
        </div>
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft('')}
          placeholder="Type your annual target to see your payout"
          style={{
            width: 260, fontFamily: 'var(--font-mono)', fontSize: 13, padding: '6px 10px',
            borderRadius: 4, border: '1px solid var(--border-subtle)', background: 'var(--bg2, transparent)', color: 'inherit',
          }}
        />
      </div>
      {quarterlyTarget != null && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            Quarterly Target (Annual ÷ 4)
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: 'var(--text-primary, #fff)' }}>
            ${quarterlyTarget.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
        </div>
      )}
      {projectedPayout != null && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            Projected Payout (Overall × Quarterly Target)
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: attainmentColor(overall) }}>
            ${projectedPayout.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
        </div>
      )}
    </div>
  )
}

function ScorecardTable({ metrics, editable, onFieldChange }) {
  const overall = useMemo(() => computeOverallAttainment(metrics), [metrics])

  return (
    <table className="appt-list-table" style={{ width: '100%' }}>
      <thead>
        <tr>
          <th>Metric</th>
          <th>Weight</th>
          <th>0% Anchor</th>
          <th>100% Target</th>
          <th>120% Target</th>
          <th>Actual</th>
          <th>Attainment</th>
        </tr>
      </thead>
      <tbody>
        {metrics.map((m) => {
          const att = computeAttainment(m)
          return (
            <tr key={m.metric_key || m.id}>
              <td style={{ fontWeight: 600 }}>{m.label}</td>
              {editable ? (
                <>
                  <td><EditableCell value={m.weight} unit="%" onCommit={(v) => onFieldChange(m, 'weight', v)} /></td>
                  <td><EditableCell value={m.anchor} unit={m.unit} onCommit={(v) => onFieldChange(m, 'anchor', v)} /></td>
                  <td><EditableCell value={m.target_100} unit={m.unit} onCommit={(v) => onFieldChange(m, 'target_100', v)} /></td>
                  <td><EditableCell value={m.target_120} unit={m.unit} onCommit={(v) => onFieldChange(m, 'target_120', v)} /></td>
                  <td><EditableCell value={m.actual} unit={m.unit} onCommit={(v) => onFieldChange(m, 'actual', v)} /></td>
                </>
              ) : (
                <>
                  <td>{fmtVal(m.weight, '%')}</td>
                  <td>{fmtVal(m.anchor, m.unit)}</td>
                  <td>{fmtVal(m.target_100, m.unit)}</td>
                  <td>{fmtVal(m.target_120, m.unit)}</td>
                  <td>{fmtVal(m.actual, m.unit)}</td>
                </>
              )}
              <td style={{ fontWeight: 700, color: attainmentColor(att) }}>
                {att == null ? '—' : `${Math.round(att)}%`}
              </td>
            </tr>
          )
        })}
        <tr style={{ borderTop: '2px solid var(--border-subtle)' }}>
          <td style={{ fontWeight: 800 }}>Overall Attainment</td>
          <td style={{ fontWeight: 800 }}>
            {metrics.reduce((s, m) => s + (Number(m.weight) || 0), 0)}%
          </td>
          <td /><td /><td /><td />
          <td style={{ fontWeight: 800, fontSize: 14, color: attainmentColor(overall) }}>
            {overall == null ? '—' : `${Math.round(overall)}%`}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

// Pulls live OTT, Case Pick Accuracy (WR only), OSD $ (all facilities),
// OSD count (cal/ken/mad/ec), and Takt Performance (all facilities) for
// one quarter's metric list and writes any hits straight into Supabase
// via updateMetric, then reports the updates back through `applyLocal` so
// the caller can patch its own state. Used for BOTH the current quarter
// and last quarter — these are all objectively computable from real
// historical data regardless of whether the quarter is still open, so
// there's no reason a closed quarter should sit with a stale/blank number
// waiting on a manual pull that no longer exists as a button (Dan's ask
// 2026-07-30: remove the button, auto-pull on open — and pull it for Q2
// too, since that's a completed quarter and the data has been sitting
// there the whole time). OSD $ added 2026-07-31, OSD count and Takt both
// added 2026-08-02, each following the same pattern once their respective
// sources were verified. Takt specifically carries a known residual
// accuracy caveat — see motherduck-takt.cjs header for the full story;
// shipped per Dan's explicit decision after extensive validation reduced
// the gap from ~2x-inflated down to single digits, not because it's
// verified exact.
async function autoPullLiveMetrics(facility, quarterStr, metricsList, applyLocal) {
  if (!metricsList || metricsList.length === 0) return { ok: true, pulledAt: null }
  const errors = []
  let pulledAt = null

  try {
    const ott = await fetchLiveOtt(facility, quarterStr)
    const ott2 = metricsList.find((m) => m.metric_key === 'ott2')
    const ott3 = metricsList.find((m) => m.metric_key === 'ott3')
    if (ott2 && ott.ott2.pct != null) {
      applyLocal(ott2.id, 'actual', ott.ott2.pct)
      await updateMetric(ott2.id, { actual: ott.ott2.pct })
    }
    if (ott3 && ott.ott3.pct != null) {
      applyLocal(ott3.id, 'actual', ott.ott3.pct)
      await updateMetric(ott3.id, { actual: ott.ott3.pct })
    }
    pulledAt = ott.fetchedAt
  } catch (e) {
    errors.push(`OTT: ${e.message}`)
  }

  if (facility === 'wr') {
    try {
      const cpa = await fetchLiveCasePickAccuracy(quarterStr)
      const cpaMetric = metricsList.find((m) => m.metric_key === 'case_pick')
      if (cpaMetric && cpa.casePickAccuracy.pct != null) {
        applyLocal(cpaMetric.id, 'actual', cpa.casePickAccuracy.pct)
        await updateMetric(cpaMetric.id, { actual: cpa.casePickAccuracy.pct })
      }
      pulledAt = cpa.fetchedAt
    } catch (e) {
      errors.push(`Case Pick Accuracy: ${e.message}`)
    }
  }

  try {
    const osd = await fetchLiveOsdDollar(facility, quarterStr)
    const osdMetric = metricsList.find((m) => m.metric_key === 'osd_dollar')
    if (osdMetric && osd.osdDollar.amount != null) {
      applyLocal(osdMetric.id, 'actual', osd.osdDollar.amount)
      await updateMetric(osdMetric.id, { actual: osd.osdDollar.amount })
    }
    pulledAt = osd.fetchedAt
  } catch (e) {
    errors.push(`OSD $: ${e.message}`)
  }

  // OSD count — cal/ken/mad (already-synced Silver tables) and ec (direct
  // SharePoint read); not applicable to wr (no osd_count metric there).
  if (['cal', 'ken', 'mad', 'ec'].includes(facility)) {
    try {
      const osdCount = await fetchLiveOsdCount(facility, quarterStr)
      const osdCountMetric = metricsList.find((m) => m.metric_key === 'osd_count')
      if (osdCountMetric && osdCount.osdCount.count != null) {
        applyLocal(osdCountMetric.id, 'actual', osdCount.osdCount.count)
        await updateMetric(osdCountMetric.id, { actual: osdCount.osdCount.count })
      }
      pulledAt = osdCount.fetchedAt
    } catch (e) {
      errors.push(`OSD count: ${e.message}`)
    }
  }

  // Takt Performance — all 5 facilities.
  try {
    const takt = await fetchLiveTakt(facility, quarterStr)
    const taktMetric = metricsList.find((m) => m.metric_key === 'takt')
    if (taktMetric && takt.performance.pct != null) {
      applyLocal(taktMetric.id, 'actual', takt.performance.pct)
      await updateMetric(taktMetric.id, { actual: takt.performance.pct })
    }
    pulledAt = takt.fetchedAt
  } catch (e) {
    errors.push(`Takt: ${e.message}`)
  }

  return { ok: errors.length === 0, pulledAt, error: errors.length ? errors.join('; ') : null }
}

function FacilityScorecard({ facility }) {
  const quarter = currentQuarter()
  const lastQuarter = priorQuarter(quarter)

  const [metrics, setMetrics] = useState(null)
  const [lastMetrics, setLastMetrics] = useState(null)
  const [err, setErr] = useState(null)
  const [liveSync, setLiveSync] = useState({ loading: false, pulledAt: null, error: null })

  useEffect(() => {
    let cancelled = false
    setMetrics(null)
    setLastMetrics(null)
    setErr(null)
    setLiveSync({ loading: true, pulledAt: null, error: null })
    ;(async () => {
      try {
        await seedQuarterIfMissing(facility, quarter)
        const [cur, last] = await Promise.all([
          fetchScorecard(facility, quarter),
          fetchScorecard(facility, lastQuarter),
        ])
        if (cancelled) return
        setMetrics(cur)
        setLastMetrics(last)

        // Auto-pull live OTT/Case Pick Accuracy/OSD $/OSD count/Takt for
        // both quarters, no button, no waiting on the person to click
        // anything.
        const [curRes, lastRes] = await Promise.all([
          autoPullLiveMetrics(facility, quarter, cur, (id, field, value) => {
            if (cancelled) return
            setMetrics((prev) => prev.map((m) => (m.id === id ? { ...m, [field]: value } : m)))
          }),
          autoPullLiveMetrics(facility, lastQuarter, last, (id, field, value) => {
            if (cancelled) return
            setLastMetrics((prev) => prev.map((m) => (m.id === id ? { ...m, [field]: value } : m)))
          }),
        ])
        if (cancelled) return
        const combinedError = [curRes.error, lastRes.error].filter(Boolean).join(' | ') || null
        const latestPulledAt = [curRes.pulledAt, lastRes.pulledAt].filter(Boolean).sort().pop() || null
        setLiveSync({ loading: false, pulledAt: latestPulledAt, error: combinedError })
      } catch (e) {
        if (!cancelled) {
          setErr(e.message)
          setLiveSync({ loading: false, pulledAt: null, error: null })
        }
      }
    })()
    return () => { cancelled = true }
  }, [facility, quarter, lastQuarter])

  const handleFieldChange = useCallback(async (metric, field, value) => {
    setMetrics((prev) => prev.map((m) => (m.id === metric.id ? { ...m, [field]: value } : m)))
    try {
      await updateMetric(metric.id, { [field]: value })
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  // Last Quarter box needs its own edit path (separate from handleFieldChange
  // above, which targets the current-quarter `metrics` state) — this is
  // what lets Dean punch in Q2's real actuals (for the metrics that aren't
  // auto-pulled — just Discretionary now that Takt is live) once they're
  // finalized.
  const handleLastFieldChange = useCallback(async (metric, field, value) => {
    setLastMetrics((prev) => prev.map((m) => (m.id === metric.id ? { ...m, [field]: value } : m)))
    try {
      await updateMetric(metric.id, { [field]: value })
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  if (err) return <div style={{ color: 'var(--red)', fontSize: 13, padding: '12px 0' }}>Error: {err}</div>
  if (!metrics) return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0' }}>Loading…</div>

  const overall = computeOverallAttainment(metrics)

  return (
    <div>
      <BonusCalculator overall={overall} />

      {/* Current quarter scorecard */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>{quarter} Scorecard</span>
          <span style={{ fontSize: 11, color: liveSync.error ? 'var(--red)' : 'var(--text-dim)' }}>
            {liveSync.loading
              ? 'Syncing live data…'
              : liveSync.error
                ? `Live sync issue: ${liveSync.error}`
                : liveSync.pulledAt
                  ? `Live data synced ${new Date(liveSync.pulledAt).toLocaleTimeString()}`
                  : null}
          </span>
        </div>
        <ScorecardTable metrics={metrics} editable onFieldChange={handleFieldChange} />
      </div>

      {/* Last quarter comparison — targets/weights carried over from
          current quarter; OTT/Case Pick Accuracy/OSD $/OSD count/Takt
          auto-pulled same as the current quarter (real historical data,
          not manual); Discretionary left blank for Dean to fill in.
          Editable so entry is actually possible. */}
      <div className="chart-card">
        <div className="chart-header">
          <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>{lastQuarter} (Last Quarter)</span>
        </div>
        {lastMetrics && lastMetrics.length > 0 ? (
          <ScorecardTable metrics={lastMetrics} editable onFieldChange={handleLastFieldChange} />
        ) : (
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '8px 0' }}>
            No data recorded for {lastQuarter} yet.
          </div>
        )}
      </div>
    </div>
  )
}

export default function Manager() {
  const [facility, setFacility] = useState('cal')

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">
            Manager <span className="page-title-gold">Bonus Scorecard</span>
          </div>
          <div className="page-subtitle">Quarterly attainment tracking — weights, anchors, and targets are all adjustable</div>
        </div>
      </div>

      <div className="facility-tabs">
        {FACILITY_LIST.map((f) => (
          <button
            key={f.id}
            className={`fac-tab${facility === f.id ? ' active' : ''}`}
            onClick={() => setFacility(f.id)}
          >
            <span className="dot" style={{ background: FACILITY_COLOR_VAR[f.id] || 'var(--text-dim)' }} />
            {f.code}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        <FacilityScorecard key={facility} facility={facility} />
      </div>
    </div>
  )
}
