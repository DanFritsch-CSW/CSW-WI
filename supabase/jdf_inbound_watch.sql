-- JDF Inbound Watch state. One row per announced JDF inbound order.
-- RLS convention matches auto_appt_attempts / agent_field_accuracy: RLS on, with
-- open anon policies per operation (the Netlify functions use the same key as
-- the other digests). The table holds only order codes and Front task IDs.
-- (Already applied to production Supabase as migration `jdf_inbound_watch`.)
create table if not exists public.jdf_inbound_watch (
  order_id         bigint primary key,           -- Datex order_id
  order_code       text   not null,              -- e.g. JD101626-3IN
  task_id          text,                         -- Front task conversation id (cnv_...)
  pallets_expected int    not null default 0,    -- order lines at announce time
  sku_count        int    not null default 0,
  silent_seed      boolean not null default false, -- true = pre-existing at first run, never announced
  progress_sent    boolean not null default false,
  final_sent       boolean not null default false,
  announced_at     timestamptz not null default now()
);

create index if not exists jdf_inbound_watch_open_idx
  on public.jdf_inbound_watch (order_id) where final_sent = false;

alter table public.jdf_inbound_watch enable row level security;

create policy "anon_select_jdf_inbound_watch" on public.jdf_inbound_watch for select to public using (true);
create policy "anon_insert_jdf_inbound_watch" on public.jdf_inbound_watch for insert to public with check (true);
create policy "anon_update_jdf_inbound_watch" on public.jdf_inbound_watch for update to public using (true) with check (true);
create policy "anon_delete_jdf_inbound_watch" on public.jdf_inbound_watch for delete to public using (true);
