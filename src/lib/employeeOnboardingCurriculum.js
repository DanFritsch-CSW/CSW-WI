// Employee Onboarding curriculum — STRUCTURAL constants only. Month keys/
// labels, weekly-log config, end-of-onboarding eval categories, and facility
// list rarely change, so they stay as code.
//
// The actual WORDING — per-month values-discussion content and the numbered
// training modules — moved to Supabase (eo_curriculum_values /
// eo_curriculum_modules) on 2026-07-18 so Eli/leadership can edit titles,
// bullets, objectives, and resource links in-app via the Template Editor
// (src/components/employeeOnboarding/TemplateEditor.jsx) without needing a
// code change each time. See src/lib/employeeOnboardingTemplate.js for the
// fetch/CRUD functions. This file no longer exports MODULES or per-month
// value titles/bullets — those come from Supabase at runtime.
//
// Per-employee COMPLETION state (dates, grades, comments, observer names)
// lives in Supabase (eo_completions / eo_evaluations) — see
// src/lib/employeeOnboarding.js.

export const MONTHS = [
  { key: 'm1', label: 'Month 1 — Unloading', value: { key: 'm1_values' } },
  { key: 'm2', label: 'Month 2 — Loading', value: { key: 'm2_values' } },
  { key: 'm3', label: 'Month 3 — Putaways, Picking, Dropping', value: { key: 'm3_values' } },
]

// Weekly observation logs — each week supports up to 10 individual load
// entries (date / grade / comments / observer). m3 has no grade field per
// the source doc (putaways/picks/drops observed, no diagram/receipt grade).
export const WEEKLY_CONFIG = {
  m1: { label: 'Unloads Observed', gradeLabel: 'Grade of inbound receipt', hasGrade: true, weeks: 4 },
  m2: { label: 'Loading Observed', gradeLabel: 'Grade of loading diagram', hasGrade: true, weeks: 4 },
  m3: { label: 'Putaways, Picks, Drops Observed', gradeLabel: null, hasGrade: false, weeks: 4 },
}
export const MAX_LOADS_PER_WEEK = 10

// ─── End-of-Onboarding Evaluation ───────────────────────────────────────────
// Every category gets an independent Trainer eval + Supervisor eval (free
// text — the source doc doesn't specify a rating scale, just dual sign-off).
// Kept static (not template-editable) — structural, not wording, and far
// less likely to change than module content.
export const END_EVAL_SECTIONS = [
  {
    key: 'equipment', title: 'Operate All Equipment', items: [
      { key: 'equip_operation', label: 'Pallet jacks, high reaches (Crown/Raymond), tablets, scanners' },
    ],
  },
  {
    key: 'housing', title: 'Preferred Housing', items: [
      { key: 'housing_understanding', label: 'Understanding of preferred housing (per customer)' },
    ],
  },
  {
    key: 'tasks', title: '"Doing" the Tasks', items: [
      { key: 'task_unloading', label: 'Unloading' },
      { key: 'task_loading', label: 'Loading' },
      { key: 'task_dropping', label: 'Dropping' },
      { key: 'task_putaway', label: 'Putaway' },
      { key: 'task_picking', label: 'Picking' },
    ],
  },
  {
    key: 'tech', title: 'Warehouse Technology', items: [
      { key: 'tech_takt', label: 'Takt' },
      { key: 'tech_maintainx', label: 'MaintainX' },
      { key: 'tech_loadproof', label: 'Loadproof' },
      { key: 'tech_datex', label: 'Datex NexGen' },
    ],
  },
  {
    key: 'accuracy', title: 'Accuracy', items: [
      { key: 'accuracy_osd', label: 'Any errors associated with name on OSD tracker' },
    ],
  },
  {
    key: 'values', title: 'CSW Values Fit', items: [
      { key: 'value_coachable', label: 'Coachable?' },
      { key: 'value_accountable', label: 'Accountable?' },
      { key: 'value_teambased', label: 'Team-Based?' },
      { key: 'value_service', label: 'Service-Oriented?' },
      { key: 'value_peoplefirst', label: 'People-First?' },
    ],
  },
]

export const FACILITIES = ['cal', 'mad', 'ken', 'wr', 'ec']
