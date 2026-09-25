-- supabase/schema.sql
-- TapESTORY accounts & cross-device progress (CLAUDE.md section C).
-- Run this once in the Supabase SQL editor for your project (see README.md
-- "Setting up accounts (Supabase)"). Idempotent where practical - safe to
-- re-run after a schema tweak.
--
-- Tables:
--   profiles(id, display_name, created_at)      - one row per auth user
--   progress(user_id, level, cleared, practiced_cues, games_played, updated_at)
--                                                 - one synced row per user
--   plays(id, user_id, client_id, played_at, game_id, level, seed, accuracy,
--         perfect, good, miss, avoided, median_timing_ms, device_label)
--                                                 - append-only play history
--
-- RLS is enabled on all three, every policy scoped to auth.uid(). The anon
-- key is public by design (js/config.js) - RLS is the actual guard, not the
-- key being secret.

-- --- profiles ---------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id); -- a player can only read their own profile row

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id); -- can only ever create a profile for themselves

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id); -- e.g. setting display_name

-- --- progress (one synced row per user) -------------------------------------

create table if not exists public.progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  level integer not null default 1,
  cleared text[] not null default '{}',
  practiced_cues text[] not null default '{}',
  games_played integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.progress enable row level security;

drop policy if exists "progress_select_own" on public.progress;
create policy "progress_select_own" on public.progress
  for select using (auth.uid() = user_id); -- can only read their own progress

drop policy if exists "progress_insert_own" on public.progress;
create policy "progress_insert_own" on public.progress
  for insert with check (auth.uid() = user_id); -- can only create a progress row for themselves

drop policy if exists "progress_update_own" on public.progress;
create policy "progress_update_own" on public.progress
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id); -- merge-duplicates upsert needs this

-- --- plays (append-only history - insert + select only, no update/delete) --

create table if not exists public.plays (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null, -- client-generated dedupe key (js/storage.js enqueuePlay) - a retried
                            -- flush upserts with Prefer: resolution=ignore-duplicates instead of inserting twice
  played_at timestamptz not null default now(),
  game_id text not null,
  level integer not null,
  seed text,
  accuracy real not null,
  perfect integer not null default 0,
  good integer not null default 0,
  miss integer not null default 0,
  avoided integer not null default 0,
  median_timing_ms real,
  device_label text
);

-- A named table CONSTRAINT (not a bare unique index) is required here: PostgREST's
-- upsert (Prefer: resolution=ignore-duplicates + ?on_conflict=user_id,client_id,
-- see js/net/sync.js buildPlaysInsertRequest) resolves ON CONFLICT by column list,
-- which works against a plain unique index too - but a named constraint is what the
-- Supabase docs call out as the safe/supported target, and it self-documents intent.
-- Wrapped in a DO block (not `add constraint ... if not exists`, which Postgres
-- doesn't support for constraints) so re-running this file is a no-op once applied.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'plays_user_client_unique'
      and conrelid = 'public.plays'::regclass
  ) then
    alter table public.plays
      add constraint plays_user_client_unique unique (user_id, client_id);
  end if;
end $$;

alter table public.plays enable row level security;

drop policy if exists "plays_select_own" on public.plays;
create policy "plays_select_own" on public.plays
  for select using (auth.uid() = user_id); -- can only read their own play history

drop policy if exists "plays_insert_own" on public.plays;
create policy "plays_insert_own" on public.plays
  for insert with check (auth.uid() = user_id); -- can only insert plays for themselves
-- Deliberately NO update/delete policy: plays is append-only. This is also
-- why pushPlays() (js/net/sync.js) upserts with `Prefer: resolution=
-- ignore-duplicates`, not `merge-duplicates` - a merge would attempt an
-- UPDATE on conflict, which RLS would reject outright with no policy to
-- allow it.

-- --- profiles auto-create trigger -------------------------------------------
-- Fires once per new auth.users row (i.e. once per sign-up, whichever route)
-- so a profiles row always exists before the client ever tries to read/patch
-- display_name.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --- updated_at maintenance triggers -----------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists progress_set_updated_at on public.progress;
create trigger progress_set_updated_at
  before update on public.progress
  for each row execute function public.set_updated_at();
