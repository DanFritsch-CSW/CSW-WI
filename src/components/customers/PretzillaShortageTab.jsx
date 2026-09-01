// src/components/customers/PretzillaShortageTab.jsx
//
// Customer Shortage Report. Built 2026-08-31 per Dan's ask (Fathom
// "Pretzilla Daily" call) — automates the team's daily hand-built shortage
// Excel (Pretzilla_Template.xlsx). Backend: netlify/functions/motherduck-
// pretzilla-shortage.cjs — see that file's header for the full validation
// writeup, including two live-data bugs found and fixed 2026-09-01:
// appointment coverage (was only 2 of 6 real appointments, since most
// don't carry a Datex relational order link — see below) and Soft-
// Allocated inventory (was reading the wrong gold table, always 0).
//
// Header/subtitle wording deliberately genericized 2026-08-31 (later same
// day, per Dan's ask) — this component is currently wired to Kenosha only
// (see the backend function's PROJECT_IDS), but the report shape is meant
// to serve other customers too, the same way FEFO Rotation already covers
// multiple customers/projects behind one tab.
//
// Appointment link-status badges (added 2026-09-01, per Dan's explicit
// ask): every appointment now shows regardless of whether Datex has a
// relational order link, tagged with one of three states:
//   - "Linked"                — has a real dockappointmentitems→Order
//                                link; its order(s) count toward Needed.
//   - "Not Linked"             — no relational link, but the appointment
//                                name references an order number that DOES
//                                exist in Datex. NOT counted in Needed —
//                                flagged for a human to link in Datex.
//   - "No Order Within Datex"  — no relational link, and either no order
//                                number in the name (pure holds) or the
//                                referenced number doesn't exist as a real
//                                order yet.
// Per Dan's decision, none of these get auto-parsed into demand — this is
// visibility only, not an automatic fallback.
//
// Currently VALIDATION MODE: visible in the app for Dan to compare against
// the team's manual sheet each day this week before this replaces the
// manual process for the CSR team. No Excel export or Front send yet —
// same staged rollout pattern as PVI Shortage Report.

import React, { useEffect, useState, useCallback } from 'react';
import {
  fetchPretzillaShortage,
  fetchShortageOverrides,
  upsertShortageOverride,
  tomorrowCentral,
} from '../../lib/pretzillaShortage';

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

  const handleOverrideSave = async (materialCode, field, rawValue) => {
    const key = `${materialCode}-${field}`;
    setSavingKey(key);
    const existing = overrides.get(materialCode) || {};
    const numeric = rawValue === '' ? null : Number(rawValue);
    const next = {
      inactiveOverride: field === 'inactive' ? numeric : existing.inactive_override,
      inboundOverride: field === 'inbound' ? numeric : existing.inbound_override,
    };
    try {
      await upsertShortageOverride(targetDate, materialCode, next);
      const newMap = new Map(overrides);
      newMap.set(materialCode, {
        material_code: materialCode,
        inactive_override: next.inactiveOverride,
        inbound_override: next.inboundOverride,
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
    const inbound = ov?.inbound_override ?? m.inboundAuto;
    const rawShort = m.active + inbound - m.needed;
    const short = rawShort < 0 ? rawShort : 0;
    return { ...m, inactiveEffective: inactive, inboundEffective: inbound, shortEffective: short };
  }).sort((a, b) => a.shortEffective - b.shortEffective);

  const shortCount = rows.filter((r) => r.shortEffective < 0).length;
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
                      <span style={{ color: 'var(--text-secondary, #9aa1ac)' }}>
                        {a.orders.length > 0 ? a.orders.join(', ') : '—'}
                      </span>
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
                  <th style={{ ...cellStyle, textAlign: 'right' }}>Inbound (auto)</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>Soft-alloc.</th>
                  <th style={{ ...cellStyle, textAlign: 'right' }}>Short</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const isShort = m.shortEffective < 0;
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
                          onCommit={(v) => handleOverrideSave(m.materialCode, 'inactive', v)}
                        />
                      </td>
                      <td style={{ ...cellStyle, textAlign: 'right' }}>
                        <EditableCell
                          value={m.inboundEffective}
                          saving={savingKey === `${m.materialCode}-inbound`}
                          onCommit={(v) => handleOverrideSave(m.materialCode, 'inbound', v)}
                        />
                      </td>
                      <td style={{ ...cellStyle, textAlign: 'right', color: 'var(--text-secondary, #9aa1ac)' }}>{fmtNumber(m.softAlloc)}</td>
                      <td style={{ ...cellStyle, textAlign: 'right', fontWeight: 600, color: isShort ? '#e5484d' : 'var(--text-secondary, #9aa1ac)' }}>
                        {isShort ? fmtNumber(m.shortEffective) : '—'}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-secondary, #9aa1ac)' }}>
                      No orders found for {targetDate}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', marginTop: 12 }}>
            As of {new Date(data.fetchedAt).toLocaleString()} · Short = Active + Inbound − Needed (only shown when negative) ·
            {' '}Inactive and Soft-Allocated are informational only, matching the source spreadsheet's actual formula ·
            {' '}Inactive/Inbound are editable — click a value to correct it ·
            {' '}Only Linked appointments count toward Needed — Not Linked / No Order Within Datex are shown for review only.
          </div>
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
