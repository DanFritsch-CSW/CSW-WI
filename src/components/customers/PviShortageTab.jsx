// src/components/customers/PviShortageTab.jsx
//
// PVI Shortage Report -- Palermo's CALEDONIA finished. Built 2026-08-28,
// replacing the Omni version of this report entirely (see
// netlify/functions/motherduck-pvi-shortage.cjs for the full design
// writeup, what changed vs. the original Omni report, and every open
// item still needing Hill/Katie confirmation before this becomes the
// customer-facing automated send).
//
// This first pass is VIEW ONLY -- no Excel export, no Front send yet.
// Per Dan's ask: get it visible in the app first, work through the open
// items with the team, then automate the daily send once the numbers are
// trusted.
//
// The "Exclude unallocated Lot/LP lines" toggle exists specifically so
// Dan can compare the report with/without that filter live, since the
// underlying status_id=8 mapping is an unconfirmed guess -- see the
// banner below and the backend function's header.

import React, { useEffect, useState, useCallback } from 'react';
import { fetchPviShortage } from '../../lib/pviShortage';

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

function fmtNumber(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

export default function PviShortageTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dayWindow, setDayWindow] = useState(1);
  const [excludeLotLp, setExcludeLotLp] = useState(true);

  const load = useCallback(async (windowDays, exclude) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPviShortage(windowDays, exclude);
      setData(result);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(dayWindow, excludeLotLp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWindowChange = (v) => {
    setDayWindow(v);
    load(v, excludeLotLp);
  };

  const handleExcludeToggle = (v) => {
    setExcludeLotLp(v);
    load(dayWindow, v);
  };

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, color: 'var(--text-primary, #fff)' }}>PVI Shortage Report — Palermo's CALEDONIA finished</h3>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)', marginTop: 4, maxWidth: 680 }}>
            Manual Pick Allocation tasks on Processing orders, released within the selected window.
            Rebuilt directly against MotherDuck (moved out of Omni 2026-08-28 — see Front cnv_1c79gvh0).
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)' }}>
            Tasks released in last{' '}
            <select
              value={dayWindow}
              onChange={(e) => handleWindowChange(Number(e.target.value))}
              style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 6px' }}
            >
              <option value={1}>1 day</option>
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #9aa1ac)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={excludeLotLp}
              onChange={(e) => handleExcludeToggle(e.target.checked)}
            />
            Exclude unallocated Lot/LP lines
          </label>
          <button
            onClick={() => load(dayWindow, excludeLotLp)}
            disabled={loading}
            style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Open items banner -- remove once these are resolved with Hill/Katie */}
      <div style={{
        background: 'var(--bg2, #1a1d24)', border: '1px solid #f5a623', borderRadius: 6,
        padding: '10px 14px', marginBottom: 16, fontSize: 12, color: 'var(--text-secondary, #9aa1ac)',
      }}>
        <strong style={{ color: '#f5a623' }}>Open items before this replaces the Omni report for the team:</strong>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>"Exclude unallocated Lot/LP lines" assumes order line status_id = 8 (PLAN) means unallocated — unconfirmed with Hill. Use the toggle above to compare with/without.</li>
          <li>"Create Manual Allocation Tasks" order exclusion (Katie's #3) is not applied here yet — unvalidated.</li>
          <li>Soft Incoming has returned 0 for every row tested so far — worth confirming this project ever has non-zero soft-incoming inventory.</li>
          <li>Kenosha transfer columns (J-P, Katie's #1) — still need the exact columns from Katie; not represented in this rebuild.</li>
        </ul>
      </div>

      {error && (
        <div style={{ color: '#e5484d', marginBottom: 12 }}>{error}</div>
      )}

      {data && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary, #9aa1ac)', borderBottom: '1px solid var(--border, #2a2e38)' }}>
                  <th style={{ padding: '6px 8px' }}>Item Code</th>
                  <th style={{ padding: '6px 8px' }}>Description</th>
                  <th style={{ padding: '6px 8px' }}>Order #</th>
                  <th style={{ padding: '6px 8px' }}>Destination</th>
                  <th style={{ padding: '6px 8px' }}>Appointment Time</th>
                  <th style={{ padding: '6px 8px' }}>Appointment Lookup</th>
                  <th style={{ padding: '6px 8px' }}>Non-Active Inventory</th>
                  <th style={{ padding: '6px 8px' }}>Qty Needed (Short)</th>
                  <th style={{ padding: '6px 8px' }}>Soft Incoming</th>
                  <th style={{ padding: '6px 8px' }}>Marks</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, i) => (
                  <tr key={`${item.itemCode}-${item.orderNumber}-${i}`} style={{ borderBottom: '1px solid var(--border, #2a2e38)' }}>
                    <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>{item.itemCode}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>{item.description}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{item.orderNumber}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{item.destination}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)', whiteSpace: 'nowrap' }}>{fmtDateTime(item.apptTime)}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{item.apptLookupCode || '—'}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{item.nonActiveInventory || '—'}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-primary, #fff)' }}>{fmtNumber(item.qtyNeededShort)}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtNumber(item.softIncomingAmount)}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-secondary, #9aa1ac)' }}>{item.marks || '—'}</td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-secondary, #9aa1ac)' }}>
                      Nothing in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', marginTop: 12 }}>
            As of {new Date(data.fetchedAt).toLocaleString()} · {data.items.length} row{data.items.length === 1 ? '' : 's'} ·
            {' '}window: last {data.dayWindow} day{data.dayWindow === 1 ? '' : 's'} ·
            {' '}Lot/LP exclusion: {data.excludeLotLp ? 'ON' : 'OFF'}
          </div>
        </>
      )}

      {loading && !data && (
        <div style={{ color: 'var(--text-secondary, #9aa1ac)' }}>Loading…</div>
      )}
    </div>
  );
}
