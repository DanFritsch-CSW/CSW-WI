import { useState, useEffect, useMemo, useCallback } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import {
  currentQuarter, priorQuarter, fetchScorecard, fetchSettings,
  seedQuarterIfMissing, updateMetric, upsertSettings, computeAttainment,
  computeOverallAttainment,
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

function FacilityScorecard({ facility }) {
  const quarter = currentQuarter()
  const lastQuarter = priorQuarter(quarter)

  const [metrics, setMetrics] = useState(null)
  const [lastMetrics, setLastMetrics] = useState(null)
  const [settings, setSettings] = useState(null)
  const [bonusDraft, setBonusDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    setMetrics(null)
    setLastMetrics(null)
    setSettings(null)
    setErr(null)
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
      } catch (e) {
        if (!cancelled) setErr(e.message)
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
        <div className="chart-header"><span className="chart-title">{quarter} Scorecard</span></div>
        <ScorecardTable metrics={metrics} editable onFieldChange={handleFieldChange} />
      </div>

      {/* Last quarter comparison, read-only */}
      <div className="chart-card">
        <div className="chart-header"><span className="chart-title">{lastQuarter} (Last Quarter)</span></div>
        {lastMetrics && lastMetrics.length > 0 ? (
          <ScorecardTable metrics={lastMetrics} editable={false} onFieldChange={() => {}} />
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
