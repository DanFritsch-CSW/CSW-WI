-- JDF Pick Timer state. One row per tracked JDF outbound order.
-- RLS convention matches auto_appt_attempts / jdf_inbound_watch: RLS on, open anon
-- policies per operation (the Netlify functions use the same key as the other digests).
-- (Already applied to production Supabase as migration `jdf_pick_timer`.)
create table if not exists public.jdf_pick_timer (
  order_id         bigint primary key,            -- Datex order_id (project 365)
  order_code       text   not null,               -- e.g. JD101626-3OUT
  task_id          text,                          -- Front task conversation id (cnv_...)
  started_at       text,                          -- first completed pick, Central local 'YYYY-MM-DD HH:MM:SS'
  picks_expected   int    not null default 0,
  manuals_expected int    not null default 0,
  silent_seed      boolean not null default false, -- true = already finished at first run, never announced
  final_sent       boolean not null default false,
  last_sig         text,                           -- 'picksDone/manualsDone' at the last update
  stall_sent       boolean not null default false,
  handoff_date     text,                           -- Central date of the last 10 PM note
  announced_at     timestamptz not null default now()
);

create index if not exists jdf_pick_timer_open_idx
  on public.jdf_pick_timer (order_id) where final_sent = false;

alter table public.jdf_pick_timer enable row level security;

create policy "anon_select_jdf_pick_timer" on public.jdf_pick_timer for select to public using (true);
create policy "anon_insert_jdf_pick_timer" on public.jdf_pick_timer for insert to public with check (true);
create policy "anon_update_jdf_pick_timer" on public.jdf_pick_timer for update to public using (true) with check (true);
create policy "anon_delete_jdf_pick_timer" on public.jdf_pick_timer for delete to public using (true);
