// src/components/customers/ExpCheckTab.jsx
//
// EXP Check (Pretzilla / Bernatello's) — math-reconciliation view.
// Flags vendor lots where expiration_date doesn't reconcile with
// manufacture_date + material.shelf_life_span. See motherduck-exp-check.cjs
// for exactly what this does and doesn't catch.
//
// Dismiss/restore (added 2026-08-02): a lot can be dismissed for a fixed
// period (or permanently) so a confirmed-fine row -- most commonly one of
// the "relabeled -- verify manually" ones once someone's actually checked
// it -- stops cluttering the default view. Dismissals are keyed on
// (lotCode, materialCode), the same identity used as the table's row key,
// so a dismissal follows the lot regardless of which verdict bucket it's
// currently in. See src/lib/expCheckDismissals.js for the CRUD.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchExpCheck } from '../../lib/expCheck';
import { fetchActiveDismissals, fetchAllDismissals, dismissLot, restoreLot, dismissalKey } from '../../lib/expCheckDismissals';

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

const DISMISS_OPTIONS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'Permanently', days: null },
];

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

function DismissMenu({ onPick, onClose }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        zIndex: 20,
        background: 'var(--bg2, #1a1d24)',
        border: '1px solid var(--border, #2a2e38)',
        borderRadius: 6,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        minWidth: 140,
        marginTop: 4,
      }}
      onMouseLeave={onClose}
    >
      {DISMISS_OPTIONS.map((opt) => (
        <button
          key={opt.label}
          onClick={() => onPick(opt.days)}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 10px',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-primary, #fff)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Dismiss {opt.days ? `for ${opt.label}` : opt.label}
        </button>
      ))}
    </div>
  );
}

export default function ExpCheckTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('flagged'); // 'flagged' | 'all' | 'mismatch' | 'no_shelf_life' | 'relabeled' | 'dismissed'
  const [customerFilter, setCustomerFilter] = useState('all'); // 'all' | 'Pretzilla' | "Bernatello's"
  const [dayWindow, setDayWindow] = useState(45);
  const [activeDismissals, setActiveDismissals] = useState(new Map());
  const [allDismissals, setAllDismissals] = useState([]);
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const [dismissBusyKey, setDismissBusyKey] = useState(null);

  const load = useCallback(async (windowDays) => {
    setLoading(true);
    setError(null);
    try {
      const [result, active] = await Promise.all([
        fetchExpCheck(windowDays),
        fetchActiveDismissals(),
      ]);
      setData(result);
      setActiveDismissals(active);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDismissedTab = useCallback(async () => {
    try {
      const rows = await fetchAllDismissals();
      setAllDismissals(rows);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => {
    load(dayWindow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (filter === 'dismissed') loadDismissedTab();
  }, [filter, loadDismissedTab]);

  const customers = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.lots.map((l) => l.customer).filter(Boolean))];
  }, [data]);

  const notDismissed = useMemo(() => {
    if (!data) return [];
    return data.lots.filter((l) => !activeDismissals.has(dismissalKey(l.lotCode, l.materialCode)));
  }, [data, activeDismissals]);

  const byCustomer = useMemo(() => {
    if (customerFilter === 'all') return notDismissed;
    return notDismissed.filter((l) => l.customer === customerFilter);
  }, [notDismissed, customerFilter]);

  const visible = useMemo(() => {
    if (filter === 'all') return byCustomer;
    if (filter === 'flagged') return byCustomer.filter((l) => l.verdict !== 'clean');
    if (filter === 'dismissed') return [];
    return byCustomer.filter((l) => l.verdict === filter);
  }, [byCustomer, filter]);

  // Recomputed summary reflects the customer filter + dismissed lots removed,
  // so the stat cards match what the "Needs Review"/"All" table actually shows.
  const summary = useMemo(() => {
    const base = { clean: 0, mismatch: 0, no_shelf_life: 0, relabeled: 0 };
    for (const l of byCustomer) base[l.verdict] = (base[l.verdict] || 0) + 1;
    return base;
  }, [byCustomer]);

  const handleDismiss = async (lot, days) => {
    const key = dismissalKey(lot.lotCode, lot.materialCode);
    setDismissBusyKey(key);
    setOpenMenuKey(null);
    try {
      await dismissLot(lot.lotCode, lot.materialCode, days);
      const active = await fetchActiveDismissals();
      setActiveDismissals(active);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDismissBusyKey(null);
    }
  };

  const handleRestore = async (row) => {
    const key = dismissalKey(row.lot_code, row.material_code);
    setDismissBusyKey(key);
    try {
      await restoreLot(row.lot_code, row.material_code);
      const [active, all] = await Promise.all([fetchActiveDismissals(), fetchAllDismissals()]);
      setActiveDismissals(active);
      setAllDismissals(all);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDismissBusyKey(null);
    }
  };

  const dismissedCount = activeDismissals.size;

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, color: 'var(--text-primary, #fff)' }}>EXP Check — Pretzilla &amp; Bernatello's</h3>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)', marginTop: 4, maxWidth: 640 }}>
            Cross-references each lot's stored expiration date against manufacture date + the
            material's configured shelf life. Catches missing shelf-life setup and math
            discrepancies — does <strong>not</strong> catch a misread manufacture date that's
            internally consistent (that still needs a human checking against the case
            label/BOL).
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)' }}>
            Lots created in last{' '}
            <select
              value={dayWindow}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDayWindow(v);
                load(v);
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
            onClick={() => load(dayWindow)}
            disabled={loading}
            style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: '#e5484d', marginBottom: 12 }}>
          Couldn't load EXP Check data: {error}
        </div>
      )}

      {data && (
        <>
          {customers.length > 1 && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {['all', ...customers].map((c) => (
                <button
                  key={c}
                  onClick={() => setCustomerFilter(c)}
                  style={{
                    background: customerFilter === c ? 'var(--brand, #a07818)' : 'var(--bg2, #1a1d24)',
                    color: '#fff',
                    border: '1px solid var(--border, #2a2e38)',
                    borderRadius: 4,
                    padding: '4px 10px',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: customerFilter === c ? 600 : 400,
                  }}
                >
                  {c === 'all' ? 'All Customers' : c}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard label="Clean" value={summary.clean} color={VERDICT_COLOR.clean} />
            <StatCard label="Mismatch" value={summary.mismatch} color={VERDICT_COLOR.mismatch} />
            <StatCard label="No Shelf Life" value={summary.no_shelf_life} color={VERDICT_COLOR.no_shelf_life} />
            <StatCard label="Relabeled — Verify" value={summary.relabeled} color={VERDICT_COLOR.relabeled} />
            <StatCard label="Dismissed" value={dismissedCount} color="#888" />
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

          {filter === 'dismissed' ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-secondary, #9aa1ac)', borderBottom: '1px solid var(--border, #2a2e38)' }}>
                    <th style={{ padding: '6px 8px' }}>Lot</th>
                    <th style={{ padding: '6px 8px' }}>Material</th>
                    <th style={{ padding: '6px 8px' }}>Dismissed At</th>
                    <th style={{ padding: '6px 8px' }}>Dismissed Until</th>
                    <th style={{ padding: '6px 8px' }}>Status</th>
                    <th style={{ padding: '6px 8px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {allDismissals.map((row) => {
                    const expired = row.dismissed_until && new Date(row.dismissed_until).getTime() <= Date.now();
                    const key = dismissalKey(row.lot_code, row.material_code);
                    return (
                      <tr key={key} style={{ borderBottom: '1px solid var(--border, #2a2e38)' }}>
                        <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>{row.lot_code}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>{row.material_code}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtDate(row.dismissed_at)}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>
                          {row.dismissed_until ? fmtDate(row.dismissed_until) : 'Permanent'}
                        </td>
                        <td style={{ padding: '6px 8px', color: expired ? '#f5a623' : 'var(--text-secondary, #9aa1ac)' }}>
                          {expired ? 'Expired (reappeared in check)' : 'Active'}
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <button
                            onClick={() => handleRestore(row)}
                            disabled={dismissBusyKey === key}
                            style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}
                          >
                            {dismissBusyKey === key ? '…' : 'Restore'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {allDismissals.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-secondary, #9aa1ac)' }}>
                        No lots have been dismissed.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-secondary, #9aa1ac)', borderBottom: '1px solid var(--border, #2a2e38)' }}>
                    <th style={{ padding: '6px 8px' }}>Lot</th>
                    <th style={{ padding: '6px 8px' }}>Material</th>
                    {customers.length > 1 && <th style={{ padding: '6px 8px' }}>Customer</th>}
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
                    const key = dismissalKey(l.lotCode, l.materialCode);
                    return (
                      <tr key={`${key}-${i}`} style={{ borderBottom: '1px solid var(--border, #2a2e38)' }}>
                        <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>{l.lotCode}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>
                          {l.materialCode} — {l.materialName}
                        </td>
                        {customers.length > 1 && (
                          <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{l.customer || '—'}</td>
                        )}
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
                        <td style={{ padding: '6px 8px', position: 'relative' }}>
                          <button
                            onClick={() => setOpenMenuKey(openMenuKey === key ? null : key)}
                            disabled={dismissBusyKey === key}
                            style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}
                          >
                            {dismissBusyKey === key ? '…' : 'Dismiss'}
                          </button>
                          {openMenuKey === key && (
                            <DismissMenu
                              onPick={(days) => handleDismiss(l, days)}
                              onClose={() => setOpenMenuKey(null)}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={customers.length > 1 ? 12 : 11} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-secondary, #9aa1ac)' }}>
                        Nothing in this bucket for the selected window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', marginTop: 12 }}>
            As of {new Date(data.fetchedAt).toLocaleString()} · scanning lots created in the last {data.dayWindow} days across Pretzilla (Kenosha, Caledonia, Madison) and Bernatello's (Madison, Wisconsin Rapids).
            {dismissedCount > 0 && ` · ${dismissedCount} lot${dismissedCount === 1 ? '' : 's'} currently dismissed.`}
          </div>
        </>
      )}

      {loading && !data && (
        <div style={{ color: 'var(--text-secondary, #9aa1ac)' }}>Loading…</div>
      )}
    </div>
  );
}
