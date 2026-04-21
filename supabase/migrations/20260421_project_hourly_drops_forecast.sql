-- Per-project hourly estimated drop counts for the labor planning app.
-- Replaces the facility-wide hourly_drops_forecast with project-level granularity,
-- allowing the HourlyTable to show collapsible per-project columns.
create table if not exists project_hourly_drops_forecast (
  facility     text not null,
  plan_date    date not null,
  project_name text not null,
  hour         int  not null,
  est_drops    int  not null default 0,
  primary key (facility, plan_date, project_name, hour)
);

alter table project_hourly_drops_forecast enable row level security;
create policy "anon rw" on project_hourly_drops_forecast
  for all using (true) with check (true);
