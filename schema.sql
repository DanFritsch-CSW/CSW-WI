-- CSW Operations Hub — Supabase Schema
-- Run this in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/ppsbqekabtbwsmvdiyga/sql/new

-- ── Employees ────────────────────────────────────────────────────
create table if not exists employees (
  id           text primary key,
  facility     text not null,
  name         text not null,
  role         text,
  default_lane text default 'shift1'
);

-- ── Roster Assignments ───────────────────────────────────────────
create table if not exists roster_assignments (
  id            uuid primary key default gen_random_uuid(),
  facility      text not null,
  employee_id   text not null,
  employee_name text,
  role          text,
  lane          text not null,
  plan_date     date not null,
  updated_at    timestamptz default now(),
  unique (facility, employee_id, plan_date)
);

-- ── Row Level Security ───────────────────────────────────────────
alter table employees          enable row level security;
alter table roster_assignments enable row level security;

-- Anon can read/write employees (internal app, no auth yet)
create policy "anon_read_employees"
  on employees for select using (true);

create policy "anon_insert_employees"
  on employees for insert with check (true);

create policy "anon_update_employees"
  on employees for update using (true);

-- Anon can read/write roster_assignments
create policy "anon_read_roster"
  on roster_assignments for select using (true);

create policy "anon_insert_roster"
  on roster_assignments for insert with check (true);

create policy "anon_update_roster"
  on roster_assignments for update using (true);

-- ── Facility Settings ────────────────────────────────────────────
create table if not exists facility_settings (
  facility       text primary key,
  hours_per_appt numeric default 1.5,
  break_pct      numeric default 10,
  shift1_hours   numeric default 8,
  shift2_hours   numeric default 8,
  updated_at     timestamptz default now()
);

alter table facility_settings enable row level security;

create policy "anon_read_facility_settings"
  on facility_settings for select using (true);

create policy "anon_insert_facility_settings"
  on facility_settings for insert with check (true);

create policy "anon_update_facility_settings"
  on facility_settings for update using (true);

create trigger facility_settings_updated_at
  before update on facility_settings
  for each row execute procedure update_updated_at();

-- ── Temp employee flag on roster_assignments ─────────────────────
alter table roster_assignments
  add column if not exists is_temp boolean default false;

-- ── Shift start time on employees (from B2E modified_start_time) ──
alter table employees
  add column if not exists shift_start text;

-- ── Default shift start hours on facility_settings ───────────────
-- Used as fallback when an employee has no shift_start from B2E
alter table facility_settings
  add column if not exists shift1_start numeric default 5;

alter table facility_settings
  add column if not exists shift2_start numeric default 13;

-- ── Auto-update updated_at ───────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger roster_updated_at
  before update on roster_assignments
  for each row execute procedure update_updated_at();
