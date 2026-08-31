// src/lib/pretzillaShortage.js
// Fetch wrapper for the Pretzilla Kenosha Shortage Report tab, plus
// Supabase overrides for Inbound (auto-pulled from
// gold.available_inventory_by_lp's incoming_packaged_amount, editable —
// "auto-pull with editable override" per Dan's 2026-08-31 ask) and
// Inactive (informational in the source Excel too, but still editable here
// in case the auto value needs a human correction during validation week).
//
// Overrides are keyed on (report_date, material_code) so tomorrow's report
// doesn't inherit today's manual corrections — same reasoning as every
// other plan_date-scoped table in this app.

import { supabase } from './supabase';

export async function fetchPretzillaShortage(targetDate) {
  const res = await fetch('/.netlify/functions/motherduck-pretzilla-shortage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDate }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Pretzilla Shortage Report fetch failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function fetchShortageOverrides(reportDate) {
  if (!supabase) return new Map();
  const { data, error } = await supabase
    .from('pretzilla_shortage_overrides')
    .select('material_code, inactive_override, inbound_override')
    .eq('report_date', reportDate);
  if (error) { console.error('fetchShortageOverrides:', error); return new Map(); }
  return new Map((data ?? []).map((r) => [r.material_code, r]));
}

export async function upsertShortageOverride(reportDate, materialCode, { inactiveOverride, inboundOverride, updatedBy }) {
  if (!supabase) return;
  const { error } = await supabase
    .from('pretzilla_shortage_overrides')
    .upsert(
      {
        report_date: reportDate,
        material_code: materialCode,
        inactive_override: inactiveOverride ?? null,
        inbound_override: inboundOverride ?? null,
        updated_by: updatedBy ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'report_date,material_code' }
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
