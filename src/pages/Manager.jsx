import { useState, useEffect, useMemo, useCallback } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import {
  currentQuarter, priorQuarter, fetchScorecard, fetchSettings,
  seedQuarterIfMissing, updateMetric, upsertSettings, computeAttainment,
  computeOverallAttainment, fetchLiveOtt, fetchLiveCasePickAccuracy,
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

// Pulls live OTT (and Case Pick Accuracy for WR) for one quarter's metric
// list and writes any hits straight into Supabase via updateMetric, then
// reports the updates back through `applyLocal` so the caller can patch
// its own state. Used for BOTH the current quarter and last quarter —
// OTT/Case Pick Accuracy are objectively computable from real historical
// data regardless of whether the quarter is still open, so there's no
// reason a closed quarter should sit with a stale/blank number waiting on
// a manual pull that no longer exists as a button (Dan's ask 2026-07-30:
// remove the button, auto-pull on open — and pull it for Q2 too, since
// that's a completed quarter and the data has been sitting there the
// whole time).
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

  return { ok: errors.length === 0, pulledAt, error: errors.length ? errors.join('; ') : null }
}

function FacilityScorecard({ facility }) {
  const quarter = currentQuarter()
  const lastQuarter = priorQuarter(quarter)

  const [metrics, setMetrics] = useState(null)
  const [lastMetrics, setLastMetrics] = useState(null)
  const [settings, setSettings] = useState(null)
  const [bonusDraft, setBonusDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [liveSync, setLiveSync] = useState({ loading: false, pulledAt: null, error: null })

  useEffect(() => {
    let cancelled = false
    setMetrics(null)
    setLastMetrics(null)
    setSettings(null)
    setErr(null)
    setLiveSync({ loading: true, pulledAt: null, error: null })
    ;(async () => {
      try {
        await seedQuarterIfMissing(facility, quarter)
        const [cur, last, sett] = await Promise.all([
          fetchScorecard(facility, quarter),
          fetchScorecard(facility, lastQuarter),
          fetchSettings(facility, quarter),
        ])
        if (cancelled) return
        setMetrics(cur)
        setLastMetrics(last)
        setSettings(sett)
        setBonusDraft(sett?.annual_target_bonus != null ? String(sett.annual_target_bonus) : '')

        // Auto-pull live OTT/Case Pick Accuracy for both quarters, no
        // button, no waiting on the person to click anything.
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
  // auto-pulled — Takt, OSDs, Discretionary) once they're finalized.
  const handleLastFieldChange = useCallback(async (metric, field, value) => {
    setLastMetrics((prev) => prev.map((m) => (m.id === metric.id ? { ...m, [field]: value } : m)))
    try {
      await updateMetric(metric.id, { [field]: value })
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  async function saveBonus() {
    setSaving(true)
    try {
      const n = bonusDraft.trim() === '' ? null : Number(bonusDraft)
      await upsertSettings(facility, quarter, Number.isNaN(n) ? null : n)
      setSettings((prev) => ({ ...(prev || {}), annual_target_bonus: n }))
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (err) return <div style={{ color: 'var(--red)', fontSize: 13, padding: '12px 0' }}>Error: {err}</div>
  if (!metrics) return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0' }}>Loading…</div>

  const overall = computeOverallAttainment(metrics)
  const bonusNum = settings?.annual_target_bonus != null ? Number(settings.annual_target_bonus) : null
  const projectedPayout = overall != null && bonusNum != null ? (bonusNum * overall) / 100 : null

  return (
    <div>
      {/* Annual target bonus + projected payout */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            Annual Target Bonus
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              inputMode="decimal"
              value={bonusDraft}
              onChange={(e) => setBonusDraft(e.target.value)}
              placeholder="e.g. 5000"
              style={{
                width: 120, fontFamily: 'var(--font-mono)', fontSize: 13, padding: '6px 10px',
                borderRadius: 4, border: '1px solid var(--border-subtle)', background: 'var(--bg2, transparent)', color: 'inherit',
              }}
            />
            <button className="b2e-sync-btn" onClick={saveBonus} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        {projectedPayout != null && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
              Projected Payout (Overall × Target)
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: attainmentColor(overall) }}>
              ${projectedPayout.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
          </div>
        )}
      </div>

      {/* Current quarter scorecard */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>{quarter} Scorecard</span>
          <span style={{ fontSize: 11, color: liveSync.error ? 'var(--red)' : 'var(--text-dim)' }}>
            {liveSync.loading
              ? 'Syncing live OTT…'
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
          current quarter; OTT/Case Pick Accuracy auto-pulled same as the
          current quarter (real historical data, not manual); Takt/OSDs/
          Discretionary left blank for Dean to fill in. Editable so entry
          is actually possible. */}
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
