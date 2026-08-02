// src/components/customers/ExpCheckTab.jsx
//
// EXP Check — math-reconciliation view. Multi-customer (added 2026-08-02):
// Pretzilla and Bernatello's, selectable via the customer dropdown. See
// motherduck-exp-check.cjs for exactly what this does and doesn't catch,
// and for real per-customer findings (Bernatello's non-food SKU exclusion,
// the Madison Bernatello's inactivity, etc.).
//
// Dismiss/restore (added 2026-08-02, Dan's ask): lots ending in "A"
// (relabeled) — or really any flagged lot — can be dismissed for a chosen
// number of days so the dashboard doesn't stay cluttered with the same
// already-reviewed items every day. Dismissing does NOT mean "this is
// fine forever" — it reappears automatically once dismissed_until passes,
// so a lot that's still genuinely unresolved after that window comes back
// into view rather than disappearing for good. See expCheckDismissals.js.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchExpCheck, EXP_CHECK_CUSTOMERS } from '../../lib/expCheck';
import { fetchDismissals, dismissLot, undismissLot } from '../../lib/expCheckDismissals';

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
  const [filter, setFilter] = useState('flagged'); // 'flagged' | 'all' | 'mismatch' | 'no_shelf_life' | 'relabeled' | 'dismissed'
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
    const isActivelyDismissed = (l) => {
      const entry = dismissalMap.get(dismissKey(l.lotCode, l.materialCode));
      return !!(entry && entry.active);
    };

    if (filter === 'dismissed') return data.lots.filter(isActivelyDismissed);
    if (filter === 'all') return data.lots;
    if (filter === 'flagged') return data.lots.filter((l) => l.verdict !== 'clean' && !isActivelyDismissed(l));
    return data.lots.filter((l) => l.verdict === filter && !isActivelyDismissed(l));
  }, [data, filter, dismissalMap]);

  const activeDismissedCount = useMemo(() => {
    let n = 0;
    for (const entry of dismissalMap.values()) if (entry.active) n += 1;
    return n;
  }, [dismissalMap]);

  const customerLabel = data?.customerLabel || EXP_CHECK_CUSTOMERS.find((c) => c.key === customer)?.label || customer;

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, color: 'var(--text-primary, #fff)' }}>EXP Check — {customerLabel}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)', marginTop: 4, maxWidth: 640 }}>
            Cross-references each lot's stored expiration date against manufacture date + the
            material's configured shelf life. Catches missing shelf-life setup and math
            discrepancies — does <strong>not</strong> catch a misread manufacture date that's
            internally consistent (that still needs a human checking against the case
            label/BOL). Dismiss a lot to clear it off the dashboard for a chosen period — it
            comes back automatically once that period passes if it's still unresolved.
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

      {error && (
        <div style={{ color: '#e5484d', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="Clean" value={data.summary.clean} color={VERDICT_COLOR.clean} />
            <StatCard label="Mismatch" value={data.summary.mismatch} color={VERDICT_COLOR.mismatch} />
            <StatCard label="No Shelf Life" value={data.summary.no_shelf_life} color={VERDICT_COLOR.no_shelf_life} />
            <StatCard label="Relabeled — Verify" value={data.summary.relabeled} color={VERDICT_COLOR.relabeled} />
            <StatCard label="Dismissed" value={activeDismissedCount} color="#8b8f99" />
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {[
              ['flagged', 'Needs Review'],
              ['all', 'All'],
              ['mismatch', 'Mismatch'],
              ['no_shelf_life', 'No Shelf Life'],
              ['relabeled', 'Relabeled'],
              ['dismissed', 'Dismissed'],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                style={{
                  background: filter === key ? 'var(--accent, #3b82f6)' : 'var(--bg2, #1a1d24)',
                  color: '#fff',
                  border: '1px solid var(--border, #2a2e38)',
                  borderRadius: 4,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontSize: 12,
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
                  <th style={{ padding: '6px 8px' }}>Shelf Life (days)</th>
                  <th style={{ padding: '6px 8px' }}>MFG Date</th>
                  <th style={{ padding: '6px 8px' }}>EXP Date (system)</th>
                  <th style={{ padding: '6px 8px' }}>Expected EXP</th>
                  <th style={{ padding: '6px 8px' }}>Diff (days)</th>
                  <th style={{ padding: '6px 8px' }}>Created By</th>
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
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>
                        {l.shelfLifeSpan ?? '—'}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtDate(l.manufactureDate)}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtDate(l.expirationDate)}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtDate(l.expectedExpiration)}</td>
                      <td
                        style={{
                          padding: '6px 8px',
                          color: l.diffDays && Math.abs(l.diffDays) > 1 ? '#e5484d' : 'var(--text-secondary, #9aa1ac)',
                          fontWeight: l.diffDays && Math.abs(l.diffDays) > 1 ? 700 : 400,
                        }}
                      >
                        {l.diffDays ?? '—'}
                      </td>
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
                    <td colSpan={11} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-secondary, #9aa1ac)' }}>
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
