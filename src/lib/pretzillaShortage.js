// src/lib/pretzillaShortage.js
//
// Fetch wrapper for the Customer Shortage Report tab — GENERALIZED
// 2026-09-01 to accept `reportKey` instead of being hardcoded to Pretzilla
// Kenosha. Per Dan's explicit direction when Sargento (Caledonia) joined
// Pretzilla (Kenosha): "mimic Sargento just as Pretzilla -- any future
// additions will probably be for all customers."
//
// Calls the generalized motherduck-shortage-report.cjs (replaces the old
// motherduck-pretzilla-shortage.cjs, now orphaned/unregistered) with
// {targetDate, reportKey}.
//
// Supabase overrides for Inactive (informational in the source Excel too,
// but still editable here in case the auto value needs a human correction
// during validation week) are now scoped by report_key as well as
// (report_date, material_code) — added 2026-09-01, same migration that
// added Sargento, so an override for one customer's report never leaks
// into another's on a day their material codes happen to collide.

import { supabase } from './supabase';

export async function fetchShortageReport(targetDate, reportKey) {
  const res = await fetch('/.netlify/functions/motherduck-shortage-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDate, reportKey }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Shortage Report fetch failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function fetchShortageOverrides(reportDate, reportKey) {
  if (!supabase) return new Map();
  const { data, error } = await supabase
    .from('pretzilla_shortage_overrides')
    .select('material_code, inactive_override, inbound_override')
    .eq('report_date', reportDate)
    .eq('report_key', reportKey);
  if (error) { console.error('fetchShortageOverrides:', error); return new Map(); }
  return new Map((data ?? []).map((r) => [r.material_code, r]));
}

export async function upsertShortageOverride(reportDate, reportKey, materialCode, { inactiveOverride, inboundOverride, updatedBy }) {
  if (!supabase) return;
  const { error } = await supabase
    .from('pretzilla_shortage_overrides')
    .upsert(
      {
        report_date: reportDate,
        report_key: reportKey,
        material_code: materialCode,
        inactive_override: inactiveOverride ?? null,
        inbound_override: inboundOverride ?? null,
        updated_by: updatedBy ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'report_date,material_code,report_key' }
    );
  if (error) { console.error('upsertShortageOverride:', error); throw error; }
}

// tomorrowCentral — computes "tomorrow" in America/Chicago, the business
// day the team actually plans against. Computed on the frontend
// deliberately (see the Netlify function's header) so the server-side
// function never has to reason about timezone/UTC-runtime at all.
export function tomorrowCentral() {
  const now = new Date();
  const centralNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  centralNow.setDate(centralNow.getDate() + 1);
  const y = centralNow.getFullYear();
  const m = String(centralNow.getMonth() + 1).padStart(2, '0');
  const d = String(centralNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
