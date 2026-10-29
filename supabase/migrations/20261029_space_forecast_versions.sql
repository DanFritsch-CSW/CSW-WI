-- Space Forecast: shared scenario versions (2026-10-29).
-- Master = every existing row (version_id IS NULL). Nothing is backfilled or rewritten.
-- Additive only: one new table + nullable columns. A hypothetical version is a full copy
-- of zones / customers / scenarios stamped with its version_id; deleting a version
-- cascades only to its own copies, never Master.
--   customers.source_id = the Master customer a copy came from, so a copy still reads the
--   same live Datex count; null for rows created inside a hypothetical or moved facility.
create table if not exists space_forecast_versions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  updated_by  text not null default '',
  updated_at  timestamptz not null default now(),
  based_on    text not null default 'Master'
);
alter table space_forecast_versions enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'space_forecast_versions' and policyname = 'anon rw') then
    create policy "anon rw" on space_forecast_versions for all using (true) with check (true);
  end if;
end $$;

alter table space_forecast_zones     add column if not exists version_id uuid references space_forecast_versions(id) on delete cascade;
alter table space_forecast_customers add column if not exists version_id uuid references space_forecast_versions(id) on delete cascade;
alter table space_forecast_customers add column if not exists source_id  uuid;
alter table space_forecast_scenarios add column if not exists version_id uuid references space_forecast_versions(id) on delete cascade;
create index if not exists space_forecast_zones_ver_idx     on space_forecast_zones (version_id);
create index if not exists space_forecast_customers_ver_idx on space_forecast_customers (version_id);
create index if not exists space_forecast_scenarios_ver_idx on space_forecast_scenarios (version_id);
