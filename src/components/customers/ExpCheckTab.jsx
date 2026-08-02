// src/components/customers/ExpCheckTab.jsx
//
// EXP Check — two independent reconciliations, per customer (Pretzilla /
// Bernatello's, selectable via the dropdown). See motherduck-exp-check.cjs
// for the full story on both checks and per-customer findings.
//
// 1. Julian Check (added 2026-08-02, Dan's ask): decodes the LOT CODE
//    ITSELF as a Julian manufacture-date and compares it to the stored
//    manufacture_date. This is the actual "did someone misread the Julian
//    code" check — it catches a bad MFG entry even when EXP was computed
//    "correctly" off that same bad MFG date, which the EXP Check below
//    cannot see (it only compares Datex's own stored fields to each
//    other, never against the physical case label).
// 2. EXP Check (original build): stored EXP vs. stored MFG + the
//    material's configured shelf life. Catches missing shelf-life setup
//    and internal math discrepancies.
//
// Dismiss/restore (added 2026-08-02, Dan's ask): lots ending in "A"
// (relabeled) — or really any flagged lot — can be dismissed for a chosen
// number of days so the dashboard doesn't stay cluttered with the same
// already-reviewed items every day. Dismissing does NOT mean "this is
// fine forever" — it reappears automatically once dismissed_until passes,
// so a lot that's still genuinely unresolved after that window comes back
// into view rather than disappearing for good. See expCheckDismissals.js.
//
// Stat cards exclude dismissed lots (added 2026-08-02, Dan's ask): the
// cards used to show raw server counts (data.summary/data.julianSummary),
// which included lots the person had already dismissed — a dismissed lot
// stayed invisible in the "Needs Review" list but still inflated the
// headline numbers, which defeats the point of dismissing something.
// filteredCounts (below) recomputes every card's count from the same
// dismissalMap the table already uses, so a dismissed lot disappears from
// every count except the dedicated "Dismissed" card itself. The nightly
// Front digest does the equivalent exclusion server-side — see
// exp-check-digest-shared.cjs.
//
// Created At column (added 2026-08-02, Dean's ask via Dan): exact
// created_sys_date_time, not just the date, shown in Central time so it
// lines up with dock camera footage — Dean's use case is watching video
// of the window/dock computer at that specific time to see who actually
// keyed the lot. Central conversion matters here specifically because the
// underlying timestamp is stored in UTC (confirmed live while building
// the EXP-vs-MFG check — a lot's created_sys_date_time regularly reads a
// few hours ahead of local wall-clock time), so displaying it as-is would
// point Dean at the wrong minute of footage.
//
// Notify settings (added 2026-08-02, Dan's ask, "similar to the FEFO
// tab", then corrected to owner/customer level): per-customer Front
// digest settings, split into ExpCheckNotifySettings.jsx per this
// project's file-size-hygiene convention (same reason
// FefoReallocationAlerts.jsx is its own file).

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchExpCheck, EXP_CHECK_CUSTOMERS } from '../../lib/expCheck';
import { fetchDismissals, dismissLot, undismissLot } from '../../lib/expCheckDismissals';
import ExpCheckNotifySettings from './ExpCheckNotifySettings';

const VERDICT_LABEL = {
  mismatch: 'Mismatch',
  no_shelf_life: 'No Shelf Life Configured',
  relabeled: 'Relabeled — Verify Manually',
  clean: 'Clean',
};

const VERDICT_COLOR = {
  mismatch: '#e5484d',
  no_shelf_life: '#f5a623',
  relabeled: '#5b9bd5',
  clean: '#3bb273',
};

const JULIAN_LABEL = {
  match: 'Matches MFG',
  mismatch: 'Julian ≠ MFG',
  not_applicable: 'N/A',
};

const JULIAN_COLOR = {
  match: '#3bb273',
  mismatch: '#e5484d',
  not_applicable: '#5c6270',
};

const FACILITY_LABEL = { ken: 'Kenosha', cal: 'Caledonia', mad: 'Madison', wr: 'Wisconsin Rapids' };

const DISMISS_DURATIONS = [
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

function dismissKey(lotCode, materialCode) {
  return `${lotCode}|${materialCode}`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
}

// Exact created date + time, converted to Central (America/Chicago) so it
// matches dock/window camera footage timestamps rather than the raw UTC
// value Datex stores. See file header for why this matters.
function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// created_sys_user comes through as-is from Datex — sometimes a domain login
// (FOOTPRINT\csw-xxxxx), sometimes an email (name@csw-wi.com), and sometimes
// "SmartUp API" (automated creation, not a person). Strip the FOOTPRINT\
// prefix for readability but don't otherwise normalize, so a real distinction
// (who typed this vs. what system created it) stays visible rather than
// getting collapsed into one generic "creator" string.
function fmtCreatedBy(u) {
  if (!u) return '—';
  return u.replace(/^FOOTPRINT\\/i, '');
}

function isSystemCreated(u) {
  if (!u) return false;
  return /smartup/i.test(u) || /api/i.test(u);
}

function StatCard({ label, value, color }) {
  return (
    <div
      style={{
        background: 'var(--bg2, #1a1d24)',
        border: '1px solid var(--border, #2a2e38)',
        borderRadius: 8,
        padding: '12px 16px',
        minWidth: 140,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || 'var(--text-primary, #fff)' }}>{value}</div>
    </div>
  );
}

function VerdictBadge({ verdict }) {
  const color = VERDICT_COLOR[verdict] || '#888';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: 11,
        fontWeight: 600,
        color: '#fff',
        background: color,
        whiteSpace: 'nowrap',
      }}
    >
      {VERDICT_LABEL[verdict] || verdict}
    </span>
  );
}

function JulianBadge({ verdict }) {
  const color = JULIAN_COLOR[verdict] || '#888';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: 11,
        fontWeight: 600,
        color: verdict === 'not_applicable' ? 'var(--text-secondary, #9aa1ac)' : '#fff',
        background: verdict === 'not_applicable' ? 'transparent' : color,
        border: verdict === 'not_applicable' ? '1px solid var(--border, #2a2e38)' : 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {JULIAN_LABEL[verdict] || verdict}
    </span>
  );
}

function DismissControl({ lot, onDismiss, busy }) {
  const [days, setDays] = useState(30);
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <select
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
        style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 4px', fontSize: 11 }}
      >
        {DISMISS_DURATIONS.map((d) => (
          <option key={d.days} value={d.days}>{d.label}</option>
        ))}
      </select>
      <button
        onClick={() => onDismiss(lot, days)}
        disabled={busy}
        style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-secondary, #9aa1ac)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}
      >
        Dismiss
      </button>
    </div>
  );
}

export default function ExpCheckTab() {
  const [customer, setCustomer] = useState('pretzilla');
  const [data, setData] = useState(null);
  const [dismissals, setDismissals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('flagged'); // 'flagged' | 'all' | 'mismatch' | 'no_shelf_life' | 'relabeled' | 'julian_mismatch' | 'dismissed'
  const [dayWindow, setDayWindow] = useState(45);
  const [busyKey, setBusyKey] = useState(null);

  const loadLots = useCallback(async (windowDays, customerKey) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchExpCheck(windowDays, customerKey);
      setData(result);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDismissals = useCallback(async () => {
    try {
      const rows = await fetchDismissals();
      setDismissals(rows);
    } catch (e) {
      // non-fatal — dismiss/restore just won't be available this load
      console.error('Failed to load EXP Check dismissals:', e);
    }
  }, []);

  useEffect(() => {
    loadLots(dayWindow, customer);
    loadDismissals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissalMap = useMemo(() => {
    const now = Date.now();
    const map = new Map();
    for (const d of dismissals) {
      const active = d.dismissed_until && new Date(d.dismissed_until).getTime() > now;
      map.set(dismissKey(d.lot_code, d.material_code), { ...d, active });
    }
    return map;
  }, [dismissals]);

  const isActivelyDismissed = useCallback((l) => {
    const entry = dismissalMap.get(dismissKey(l.lotCode, l.materialCode));
    return !!(entry && entry.active);
  }, [dismissalMap]);

  const handleCustomerChange = useCallback((newCustomer) => {
    setCustomer(newCustomer);
    setFilter('flagged');
    loadLots(dayWindow, newCustomer);
  }, [dayWindow, loadLots]);

  const handleDismiss = useCallback(async (lot, days) => {
    const key = dismissKey(lot.lotCode, lot.materialCode);
    setBusyKey(key);
    try {
      await dismissLot(lot.lotCode, lot.materialCode, days);
      await loadDismissals();
    } catch (e) {
      setError(`Couldn't dismiss ${lot.lotCode}: ${e.message || e}`);
    } finally {
      setBusyKey(null);
    }
  }, [loadDismissals]);

  const handleRestore = useCallback(async (lot) => {
    const key = dismissKey(lot.lotCode, lot.materialCode);
    setBusyKey(key);
    try {
      await undismissLot(lot.lotCode, lot.materialCode);
      await loadDismissals();
    } catch (e) {
      setError(`Couldn't restore ${lot.lotCode}: ${e.message || e}`);
    } finally {
      setBusyKey(null);
    }
  }, [loadDismissals]);

  const visible = useMemo(() => {
    if (!data) return [];
    // "Needs review" = either check flags it — a lot can be EXP-clean but
    // still have a real Julian-code/MFG mismatch, which is exactly the
    // case this whole feature exists to surface.
    const needsReview = (l) => (l.verdict !== 'clean' || l.julianVerdict === 'mismatch') && !isActivelyDismissed(l);

    if (filter === 'dismissed') return data.lots.filter(isActivelyDismissed);
    if (filter === 'all') return data.lots;
    if (filter === 'flagged') return data.lots.filter(needsReview);
    if (filter === 'julian_mismatch') return data.lots.filter((l) => l.julianVerdict === 'mismatch' && !isActivelyDismissed(l));
    return data.lots.filter((l) => l.verdict === filter && !isActivelyDismissed(l));
  }, [data, filter, isActivelyDismissed]);

  const activeDismissedCount = useMemo(() => {
    let n = 0;
    for (const entry of dismissalMap.values()) if (entry.active) n += 1;
    return n;
  }, [dismissalMap]);

  // Stat-card counts, recomputed with dismissed lots excluded — the raw
  // data.summary/data.julianSummary from the server has no idea a lot's
  // been dismissed (dismissals live in Supabase, not MotherDuck), so
  // trusting those directly would keep showing a dismissed lot in the
  // headline count even though it's already hidden from Needs Review.
  const filteredCounts = useMemo(() => {
    const summary = { clean: 0, mismatch: 0, no_shelf_life: 0, relabeled: 0 };
    const julianSummary = { match: 0, mismatch: 0, not_applicable: 0 };
    if (!data) return { summary, julianSummary };
    for (const l of data.lots) {
      if (isActivelyDismissed(l)) continue;
      if (summary[l.verdict] !== undefined) summary[l.verdict] += 1;
      if (julianSummary[l.julianVerdict] !== undefined) julianSummary[l.julianVerdict] += 1;
    }
    return { summary, julianSummary };
  }, [data, isActivelyDismissed]);

  const customerLabel = data?.customerLabel || EXP_CHECK_CUSTOMERS.find((c) => c.key === customer)?.label || customer;

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, color: 'var(--text-primary, #fff)' }}>EXP Check — {customerLabel}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)', marginTop: 4, maxWidth: 680 }}>
            Two checks: <strong>Julian Check</strong> decodes each lot's own lot code as a
            Julian manufacture date and compares it to the stored MFG date — this is the one
            that actually catches a misread Julian code. <strong>Verdict</strong>
            cross-references the stored EXP date against MFG + the material's shelf life —
            catches missing shelf-life setup and internal math discrepancies, but can't tell
            if the MFG date itself was wrong (that's what Julian Check is for). Dismiss a lot
            to clear it off the dashboard for a chosen period — it comes back automatically
            if it's still unresolved after that.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)' }}>
            Customer{' '}
            <select
              value={customer}
              onChange={(e) => handleCustomerChange(e.target.value)}
              style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 6px' }}
            >
              {EXP_CHECK_CUSTOMERS.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)' }}>
            Lots created in last{' '}
            <select
              value={dayWindow}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDayWindow(v);
                loadLots(v, customer);
              }}
              style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 6px' }}
            >
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={45}>45 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          <button
            onClick={() => { loadLots(dayWindow, customer); loadDismissals(); }}
            disabled={loading}
            style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      <ExpCheckNotifySettings />

      {error && (
        <div style={{ color: '#e5484d', marginBottom: 12, marginTop: 12 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', marginTop: 16 }}>
            <StatCard label="Julian Mismatch" value={filteredCounts.julianSummary.mismatch} color={JULIAN_COLOR.mismatch} />
            <StatCard label="Clean" value={filteredCounts.summary.clean} color={VERDICT_COLOR.clean} />
            <StatCard label="EXP Mismatch" value={filteredCounts.summary.mismatch} color={VERDICT_COLOR.mismatch} />
            <StatCard label="No Shelf Life" value={filteredCounts.summary.no_shelf_life} color={VERDICT_COLOR.no_shelf_life} />
            <StatCard label="Relabeled — Verify" value={filteredCounts.summary.relabeled} color={VERDICT_COLOR.relabeled} />
            <StatCard label="Dismissed" value={activeDismissedCount} color="#8b8f99" />
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {[
              ['flagged', 'Needs Review'],
              ['all', 'All'],
              ['julian_mismatch', 'Julian Mismatch'],
              ['mismatch', 'EXP Mismatch'],
              ['no_shelf_life', 'No Shelf Life'],
              ['relabeled', 'Relabeled'],
              ['dismissed', 'Dismissed'],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                style={{
                  background: filter === key ? 'var(--accent, #3b82f6)' : 'var(--bg2, #1a1d24)',
                  color: filter === key ? '#fff' : 'var(--text-primary, #1a1d24)',
                  border: '1px solid var(--border, #2a2e38)',
                  borderRadius: 4,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: filter === key ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary, #9aa1ac)', borderBottom: '1px solid var(--border, #2a2e38)' }}>
                  <th style={{ padding: '6px 8px' }}>Lot</th>
                  <th style={{ padding: '6px 8px' }}>Material</th>
                  <th style={{ padding: '6px 8px' }}>Facility</th>
                  <th style={{ padding: '6px 8px' }}>MFG Date</th>
                  <th style={{ padding: '6px 8px' }}>Julian Decodes To</th>
                  <th style={{ padding: '6px 8px' }}>Julian Check</th>
                  <th style={{ padding: '6px 8px' }}>Shelf Life (days)</th>
                  <th style={{ padding: '6px 8px' }}>EXP Date (system)</th>
                  <th style={{ padding: '6px 8px' }}>Expected EXP</th>
                  <th style={{ padding: '6px 8px' }}>Created By</th>
                  <th style={{ padding: '6px 8px' }}>Created At (Central)</th>
                  <th style={{ padding: '6px 8px' }}>Verdict</th>
                  <th style={{ padding: '6px 8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l, i) => {
                  const key = dismissKey(l.lotCode, l.materialCode);
                  const dismissal = dismissalMap.get(key);
                  const isDismissed = !!(dismissal && dismissal.active);
                  return (
                    <tr key={`${l.lotCode}-${l.materialCode}-${i}`} style={{ borderBottom: '1px solid var(--border, #2a2e38)', opacity: isDismissed ? 0.6 : 1 }}>
                      <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>{l.lotCode}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>
                        {l.materialCode} — {l.materialName}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>
                        {FACILITY_LABEL[l.facility] || l.facility || '—'}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtDate(l.manufactureDate)}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>
                        {l.julianApplicable ? fmtDate(l.julianDecodedDate) : '—'}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <JulianBadge verdict={l.julianVerdict} />
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>
                        {l.shelfLifeSpan ?? '—'}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtDate(l.expirationDate)}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtDate(l.expectedExpiration)}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>
                        {fmtCreatedBy(l.createdBy)}
                        {isSystemCreated(l.createdBy) && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              padding: '1px 5px',
                              borderRadius: 8,
                              background: 'var(--bg2, #1a1d24)',
                              border: '1px solid var(--border, #2a2e38)',
                              color: 'var(--text-secondary, #9aa1ac)',
                            }}
                          >
                            system
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)', whiteSpace: 'nowrap' }}>
                        {fmtDateTime(l.createdAt)}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <VerdictBadge verdict={l.verdict} />
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {isDismissed ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                            <span style={{ fontSize: 10, color: 'var(--text-secondary, #9aa1ac)' }}>
                              Dismissed until {fmtDate(dismissal.dismissed_until)}
                            </span>
                            <button
                              onClick={() => handleRestore(l)}
                              disabled={busyKey === key}
                              style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-secondary, #9aa1ac)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                            >
                              Restore
                            </button>
                          </div>
                        ) : (
                          <DismissControl lot={l} onDismiss={handleDismiss} busy={busyKey === key} />
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={13} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-secondary, #9aa1ac)' }}>
                      Nothing in this bucket for the selected window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', marginTop: 12 }}>
            As of {new Date(data.fetchedAt).toLocaleString()} · scanning {customerLabel} lots created in the last {data.dayWindow} days.
          </div>
        </>
      )}

      {loading && !data && (
        <div style={{ color: 'var(--text-secondary, #9aa1ac)' }}>Loading…</div>
      )}
    </div>
  );
}
