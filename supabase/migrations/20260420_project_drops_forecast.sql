-- Per-project daily estimated drop counts for the labor planning app.
-- Separate from hourly_drops_forecast (which drives the hourly chart).
-- These values populate the "Est Drops" column in the Projects Table.
create table if not exists project_drops_forecast (
  facility     text not null,
  plan_date    date not null,
  project_name text not null,
  est_drops    int  not null default 0,
  primary key (facility, plan_date, project_name)
);

alter table project_drops_forecast enable row level security;
create policy "anon rw" on project_drops_forecast
  for all using (true) with check (true);
