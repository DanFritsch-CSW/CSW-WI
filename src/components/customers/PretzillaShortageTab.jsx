// src/components/customers/PretzillaShortageTab.jsx
//
// Customer Shortage Report. Built 2026-08-31 per Dan's ask (Fathom
// "Pretzilla Daily" call) — automates the team's daily hand-built shortage
// Excel (Pretzilla_Template.xlsx). Backend: netlify/functions/motherduck-
// pretzilla-shortage.cjs — see that file's header for the full validation
// writeup, including bugs found and fixed 2026-09-01: appointment coverage
// (was only 2 of 6 real appointments) and Soft-Allocated inventory (was
// reading the wrong gold table, always 0).
//
// Header/subtitle wording deliberately genericized 2026-08-31 (later same
// day, per Dan's ask) — this component is currently wired to Kenosha only
// (see the backend function's PROJECT_IDS), but the report shape is meant
// to serve other customers too, the same way FEFO Rotation already covers
// multiple customers/projects behind one tab.
//
// Appointment link-status badges (added 2026-09-01, per Dan's explicit
// ask): every appointment shows regardless of whether Datex has a
// relational order link, tagged Linked / Not Linked / No Order Within
// Datex. Only Linked orders count toward Needed — see the backend
// function's header for the full classification writeup.
//
// Allocated column (added 2026-09-01, later same day, per Dan's ask):
// replaces the separate Soft-Allocated column with a combined
// soft-allocated + hard-allocated figure, after confirming live that
// watching Soft-Allocated alone made real pick progress look like
// inventory disappearing (120 units moved from soft- to hard-allocated in
// ~15 minutes; the combined total was unchanged). The Inbound (auto)
// column is REMOVED from this table per the same request —
// incoming_packaged_amount has read 0 in every case tested. It is still
// part of the Short calculation server-side; only the display column is
// gone, so there's no client-side override for it anymore (Inactive
// remains editable).
//
// Inbound removed from the Short calculation entirely (2026-09-01, later
// same day, per Dan's ask) — most customers don't have InASN orders in at
// the time this report is generated. Short is now simply Active - Needed,
// computed server-side; see the backend function's header for detail.
//
// Order status shown per order (2026-09-01, later same day, per Dan's
// ask): each order in the appointments panel now shows its Datex status
// (Created/Processing/etc.) next to its number. Created and Processing
// get distinct colors since Created orders are the likely explanation for
// why an appointment shows Not Linked / No Order Within Datex — see the
// backend function's header for the live example that prompted this
// (three "Not Linked" orders for 9/3, all sitting in Created).
//
// Currently VALIDATION MODE: visible in the app for Dan to compare against
// the team's manual sheet each day this week before this replaces the
// manual process for the CSR team. No Excel export or Front send yet —
// same staged rollout pattern as PVI Shortage Report.
//
// Email Draft editor (added 2026-09-01, see ShortageReportEmailEditor.jsx
// for the full story): renders below the material table, collapsed by
// default. Creates a Front email draft of this shortage table — TO/CC,
// From channel, Draft Author all editable in the UI. Keyed by reportKey
// ('pretzilla_ken' today) rather than facility, so a second customer
// added to this tab later gets its own reportKey/editor instance without
// restructuring this component.

import React, { useEffect, useState, useCallback } from 'react';
import {
  fetchPretzillaShortage,
  fetchShortageOverrides,
  upsertShortageOverride,
  tomorrowCentral,
} from '../../lib/pretzillaShortage';
import ShortageReportEmailEditor from './ShortageReportEmailEditor.jsx';

function fmtNumber(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

const cellStyle = { padding: '6px 8px' };
const labelStyle = { fontSize: 12, color: 'var(--text-secondary, #9aa1ac)' };

const LINK_STATUS = {
  linked: { text: 'Linked', bg: 'rgba(56,161,105,0.15)', color: '#38a169' },
  not_linked: { text: 'Not Linked', bg: 'rgba(245,166,35,0.15)', color: '#f5a623' },
  no_order_in_datex: { text: 'No Order Within Datex', bg: 'rgba(229,72,77,0.15)', color: '#e5484d' },
};

function LinkStatusBadge({ status }) {
  const cfg = LINK_STATUS[status] || LINK_STATUS.no_order_in_datex;
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px',
      borderRadius: 999, background: cfg.bg, color: cfg.color, whiteSpace: 'nowrap',
    }}>
      {cfg.text}
    </span>
  );
}

// Order status (Datex silver.datex_slv_orderstatuses — Created/Processing/
// Completed/Cancelled/etc.). Created and Processing get their own colors
// since those are the two Dan specifically flagged as worth calling out
// (Created being the likely explanation for Not Linked/No Order
// appointments — see the backend function's header). Everything else
// (Completed, Cancelled, Hold, etc.) falls back to a neutral color.
const ORDER_STATUS_COLOR = {
  Created: '#8b8fa3',
  Processing: '#38a169',
};

function OrderTag({ orderNo, orderStatus }) {
  const color = ORDER_STATUS_COLOR[orderStatus] || 'var(--text-secondary, #9aa1ac)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span style={{ color: 'var(--text-secondary, #9aa1ac)' }}>{orderNo}</span>
      {orderStatus && (
        <span style={{ fontSize: 10, fontWeight: 600, color }}>({orderStatus})</span>
      )}
    </span>
  );
}

export default function PretzillaShortageTab() {
  const [targetDate, setTargetDate] = useState(tomorrowCentral());
  const [data, setData] = useState(null);
  const [overrides, setOverrides] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAppointments, setShowAppointments] = useState(true);
  const [savingKey, setSavingKey] = useState(null);

  const load = useCallback(async (date) => {
    setLoading(true);
    setError(null);
    try {
      const [result, overrideMap] = await Promise.all([
        fetchPretzillaShortage(date),
        fetchShortageOverrides(date),
      ]);
      setData(result);
      setOverrides(overrideMap);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(targetDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDateChange = (v) => {
    setTargetDate(v);
    load(v);
  };

  const handleInactiveSave = async (materialCode, rawValue) => {
    const key = `${materialCode}-inactive`;
    setSavingKey(key);
    const existing = overrides.get(materialCode) || {};
    const numeric = rawValue === '' ? null : Number(rawValue);
    try {
      await upsertShortageOverride(targetDate, materialCode, {
        inactiveOverride: numeric,
        inboundOverride: existing.inbound_override,
      });
      const newMap = new Map(overrides);
      newMap.set(materialCode, {
        material_code: materialCode,
        inactive_override: numeric,
        inbound_override: existing.inbound_override,
      });
      setOverrides(newMap);
    } catch (e) {
      setError(`Failed to save override for ${materialCode}: ${e.message || e}`);
    } finally {
      setSavingKey(null);
    }
  };

  const rows = (data?.materials || []).map((m) => {
    const ov = overrides.get(m.materialCode);
    const inactive = ov?.inactive_override ?? m.inactive;
    return { ...m, inactiveEffective: inactive };
  }).sort((a, b) => a.short - b.short);

  const shortCount = rows.filter((r) => r.short < 0).length;
  const linkedCount = (data?.appointments || []).filter((a) => a.linkStatus === 'linked').length;

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, color: 'var(--text-primary, #fff)' }}>Shortage Report</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={labelStyle}>
            Orders for{' '}
            <input
              type="date"
              value={targetDate}
              onChange={(e) => handleDateChange(e.target.value)}
              style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 6px' }}
            />
          </label>
          <button
            onClick={() => load(targetDate)}
            disabled={loading}
            style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: '#e5484d', marginBottom: 12 }}>{error}</div>
      )}

      {data && (
        <>
          {/* Stat row */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            {[
              ['Orders', data.orderCount],
              ['Appointments', data.appointments.length],
              ['Materials', data.materials.length],
              ['Short', shortCount],
            ].map(([label, value]) => (
              <div key={label} style={{ background: 'var(--bg2, #1a1d24)', border: '1px solid var(--border, #2a2e38)', borderRadius: 6, padding: '8px 14px', minWidth: 90 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)' }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 600, color: label === 'Short' && value > 0 ? '#e5484d' : 'var(--text-primary, #fff)' }}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Appointments panel */}
          <div style={{ background: 'var(--bg2, #1a1d24)', border: '1px solid var(--border, #2a2e38)', borderRadius: 6, marginBottom: 16, overflow: 'hidden' }}>
            <button
              onClick={() => setShowAppointments((s) => !s)}
              style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text-primary, #fff)', padding: '10px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span>
                Appointment → order matching{' '}
                <span style={labelStyle}>
                  ({data.appointments.length} appointment{data.appointments.length === 1 ? '' : 's'}, {linkedCount} linked)
                </span>
              </span>
              <span style={labelStyle}>{showAppointments ? 'Hide' : 'Show'}</span>
            </button>
            {showAppointments && (
              <div style={{ borderTop: '1px solid var(--border, #2a2e38)' }}>
                {data.appointments.map((a) => (
                  <div key={a.apptId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 14px', fontSize: 13, borderBottom: '1px solid var(--border, #2a2e38)', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ color: 'var(--text-secondary, #9aa1ac)', marginRight: 10 }}>{fmtDateTime(a.scheduledArrival)}</span>
                      <span style={{ color: 'var(--text-primary, #fff)' }}>{a.apptCode}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                      {a.orders.length > 0 ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {a.orders.map((o) => (
                            <OrderTag key={o.orderNo} orderNo={o.orderNo} orderStatus={o.orderStatus} />
                          ))}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-secondary, #9aa1ac)' }}>—</span>
                      )}
                      <LinkStatusBadge status={a.linkStatus} />
                    </div>
                  </div>
                ))}
                {data.appointments.length === 0 && (
                  <div style={{ padding: '12px 14px', color: 'var(--text-secondary, #9aa1ac)', fontSize: 13 }}>No appointments for this date.</div>
                )}
              </div>
            )}
          </div>

          {/* Material table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary, #9aa1ac)', borderBottom: '1px solid var(--border, #2a2e38)' }}>
                  <th style={cellStyle}>Material</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>Needed</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>Active</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>Inactive</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>Allocated</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>Short</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const isShort = m.short < 0;
                  return (
                    <tr key={m.materialCode} style={{ borderBottom: '1px solid var(--border, #2a2e38)', background: isShort ? 'rgba(229,72,77,0.08)' : 'transparent' }}>
                      <td style={cellStyle}>
                        <div style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11, color: 'var(--text-secondary, #9aa1ac)' }}>{m.materialCode}</div>
                        <div style={{ color: 'var(--text-primary, #fff)' }}>{m.description}</div>
                      </td>
                      <td style={{ ...cellStyle, textAlign: 'right', color: 'var(--text-primary, #fff)' }}>{fmtNumber(m.needed)}</td>
                      <td style={{ ...cellStyle, textAlign: 'right', color: 'var(--text-primary, #fff)' }}>{fmtNumber(m.active)}</td>
                      <td style={{ ...cellStyle, textAlign: 'right' }}>
                        <EditableCell
                          value={m.inactiveEffective}
                          saving={savingKey === `${m.materialCode}-inactive`}
                          onCommit={(v) => handleInactiveSave(m.materialCode, v)}
                        />
                      </td>
                      <td style={{ ...cellStyle, textAlign: 'right', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtNumber(m.allocated)}</td>
                      <td style={{ ...cellStyle, textAlign: 'right', fontWeight: 600, color: isShort ? '#e5484d' : 'var(--text-secondary, #9aa1ac)' }}>
                        {isShort ? fmtNumber(m.short) : '—'}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-secondary, #9aa1ac)' }}>
                      No orders found for {targetDate}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', marginTop: 12 }}>
            As of {new Date(data.fetchedAt).toLocaleString()} · Short = Active − Needed (only shown when negative; Inbound is not part of this calculation right now) ·
            {' '}Inactive and Allocated (soft + hard) are informational only, not netted into Short ·
            {' '}Inactive is editable — click a value to correct it ·
            {' '}Only Linked appointments count toward Needed — Not Linked / No Order Within Datex are shown for review only.
          </div>

          <ShortageReportEmailEditor reportKey="pretzilla_ken" reportLabel="Pretzilla — Kenosha" />
        </>
      )}

      {loading && !data && (
        <div style={{ color: 'var(--text-secondary, #9aa1ac)' }}>Loading…</div>
      )}
    </div>
  );
}

function EditableCell({ value, saving, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? 0));

  useEffect(() => {
    if (!editing) setDraft(String(value ?? 0));
  }, [value, editing]);

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        style={{ cursor: 'pointer', color: 'var(--text-primary, #fff)', borderBottom: '1px dashed var(--border, #2a2e38)' }}
        title="Click to edit"
      >
        {saving ? '…' : fmtNumber(value)}
      </span>
    );
  }

  return (
    <input
      type="number"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); onCommit(draft); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { setEditing(false); onCommit(draft); }
        if (e.key === 'Escape') { setEditing(false); setDraft(String(value ?? 0)); }
      }}
      style={{ width: 70, textAlign: 'right', background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 4px' }}
    />
  );
}
