-- Space Forecast: link plan rows to live Datex projects (MotherDuck).
--
-- Additive only: creates one new table. space_forecast_zones / _customers /
-- _scenarios are NOT altered, so nothing anyone has typed is touched.
--
-- Each row says "inventory for this Datex warehouse + project (+ optional
-- material group) belongs to this plan row". The live feed (netlify function
-- space-forecast-live) returns on-hand LPs per warehouse + project + material
-- group; the page sums the ones mapped to each customer row for the "Now" column.
--
--   material_group_id NULL      = every material group of the project that no
--                                 group-specific row below has claimed
--   material_group_id NOT NULL  = only that group (used to split one Datex
--                                 project across rows, e.g. DPI Madison
--                                 Freezer / Cooler / Dry)
--
-- A (warehouse, project, group) is claimed by exactly one plan row (unique index).
-- Deleting a plan row removes its mappings; its live inventory then shows up in
-- the page's "Unmapped" list instead of disappearing.

create table if not exists space_forecast_project_map (
  id                uuid primary key default gen_random_uuid(),
  facility          text not null,
  warehouse_id      int  not null,
  project_id        int  not null,
  material_group_id int,
  project_name      text not null default '',
  customer_id       uuid not null references space_forecast_customers(id) on delete cascade,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists space_forecast_project_map_key
  on space_forecast_project_map (warehouse_id, project_id, coalesce(material_group_id, -1));
create index if not exists space_forecast_project_map_fac_idx
  on space_forecast_project_map (facility);
create index if not exists space_forecast_project_map_cust_idx
  on space_forecast_project_map (customer_id);

alter table space_forecast_project_map enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'space_forecast_project_map' and policyname = 'anon rw') then
    create policy "anon rw" on space_forecast_project_map for all using (true) with check (true);
  end if;
end $$;
