-- Space Forecast: stackability override per Datex project + material group (2026-10-29).
-- Additive: one new table, nothing existing altered.
-- Datex's material-group stack flag is wrong for some product (Jones should be 1:1,
-- Givaudan annato seeds). A row here says "for this warehouse + project + material
-- group, N license plates occupy one position". material_group_id -1 = the live row
-- has no material group. The page uses it to turn live LPs into effective positions.
create table if not exists space_forecast_stack_override (
  id                uuid primary key default gen_random_uuid(),
  facility          text not null,
  warehouse_id      int  not null,
  project_id        int  not null,
  material_group_id int  not null default -1,
  stack             numeric not null check (stack > 0),
  note              text not null default '',
  updated_at        timestamptz not null default now(),
  unique (warehouse_id, project_id, material_group_id)
);
create index if not exists space_forecast_stack_override_fac_idx on space_forecast_stack_override (facility);
alter table space_forecast_stack_override enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'space_forecast_stack_override' and policyname = 'anon rw') then
    create policy "anon rw" on space_forecast_stack_override for all using (true) with check (true);
  end if;
end $$;
