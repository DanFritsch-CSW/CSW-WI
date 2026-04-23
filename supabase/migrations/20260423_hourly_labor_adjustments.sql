-- Per-hour manual labor adjustments for the planning board.
-- Positive values increase the labor required for that hour (e.g. difficult appointments
-- like white wood that need more people than the formula accounts for).
create table if not exists hourly_labor_adjustments (
  facility   text not null,
  plan_date  date not null,
  hour       int  not null,
  adjustment int  not null default 0,
  primary key (facility, plan_date, hour)
);

alter table hourly_labor_adjustments enable row level security;
create policy "anon rw" on hourly_labor_adjustments
  for all using (true) with check (true);
