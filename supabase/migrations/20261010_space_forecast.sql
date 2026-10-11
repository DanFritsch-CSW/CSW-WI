-- Space Forecast (/spaceforecast) — per-facility capacity vs. projected footprint.
-- Separate from the Customers > Space Planning tab (space_* tables): that tab is
-- the current-footprint view; this is the forward forecast + what-if tool.
--
-- forecast is a jsonb map keyed 'YYYY-MM' -> pallets. Months with no key inherit
-- the previous explicit month (or current_pallets), so the grid never needs to
-- shift when the calendar rolls over.
-- positions = pallets / stack.

create table if not exists space_forecast_zones (
  id         uuid primary key default gen_random_uuid(),
  facility   text not null,
  name       text not null,
  note       text not null default '',
  capacity   numeric not null default 0,
  sort_order int  not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists space_forecast_customers (
  id                uuid primary key default gen_random_uuid(),
  facility          text not null,
  zone_id           uuid not null references space_forecast_zones(id) on delete cascade,
  name              text not null,
  stack             numeric not null default 1,
  current_pallets   numeric not null default 0,
  current_updated_at timestamptz,
  forecast          jsonb not null default '{}'::jsonb,
  up_pct            numeric not null default 10,
  down_pct          numeric not null default 10,
  min_gap           numeric not null default 25,
  updated_at        timestamptz not null default now()
);

create table if not exists space_forecast_scenarios (
  id         uuid primary key default gen_random_uuid(),
  facility   text not null,
  zone_id    uuid not null references space_forecast_zones(id) on delete cascade,
  name       text not null,
  pallets    numeric not null default 0,
  stack      numeric not null default 1,
  from_month text not null,
  to_month   text not null,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists space_forecast_zones_fac_idx     on space_forecast_zones (facility);
create index if not exists space_forecast_customers_fac_idx on space_forecast_customers (facility);
create index if not exists space_forecast_scenarios_fac_idx on space_forecast_scenarios (facility);

alter table space_forecast_zones     enable row level security;
alter table space_forecast_customers enable row level security;
alter table space_forecast_scenarios enable row level security;
create policy "anon rw" on space_forecast_zones     for all using (true) with check (true);
create policy "anon rw" on space_forecast_customers for all using (true) with check (true);
create policy "anon rw" on space_forecast_scenarios for all using (true) with check (true);
