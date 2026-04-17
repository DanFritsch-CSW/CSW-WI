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

-- Anon can read employees (internal app, no auth yet)
create policy "anon_read_employees"
  on employees for select using (true);

-- Anon can read/write roster_assignments
create policy "anon_read_roster"
  on roster_assignments for select using (true);

create policy "anon_insert_roster"
  on roster_assignments for insert with check (true);

create policy "anon_update_roster"
  on roster_assignments for update using (true);

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
