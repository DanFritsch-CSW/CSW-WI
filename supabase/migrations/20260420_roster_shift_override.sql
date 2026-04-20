-- Add per-day shift time override columns to roster_assignments.
-- Null = fall back to base employee schedule / facility settings.
-- Non-null = override just for this plan_date.
alter table roster_assignments
  add column if not exists shift_start smallint,      -- 0–23
  add column if not exists shift_hours numeric(4,1);  -- e.g. 9.0
