-- Add hour granularity to project_drops_forecast so drops can be
-- distributed across shift hours per project (used by the inline editor).
alter table project_drops_forecast
  drop constraint if exists project_drops_forecast_pkey;

alter table project_drops_forecast
  add column if not exists hour smallint not null default 0
    check (hour between 0 and 23);

alter table project_drops_forecast
  add primary key (facility, plan_date, project_name, hour);
