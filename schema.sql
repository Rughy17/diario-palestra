-- Diario palestra: struttura del database
-- Incolla tutto questo file in Supabase > SQL Editor e premi "Run".

-- Aggiorna automaticamente la data di modifica (serve alla sincronizzazione)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

-- Esercizi
create table if not exists public.exercises (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

-- Schede (routine)
create table if not exists public.routines (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  items jsonb not null default '[]'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

-- Allenamenti
create table if not exists public.workouts (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  routine_id uuid,
  started_at timestamptz not null,
  ended_at timestamptz,
  notes text not null default '',
  plan jsonb not null default '[]'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

-- Serie
create table if not exists public.sets (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  workout_id uuid not null,
  exercise_id uuid not null,
  position integer not null default 0,
  weight numeric not null default 0,
  reps integer not null default 0,
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

-- Indici per la sincronizzazione
create index if not exists exercises_user_updated on public.exercises (user_id, updated_at);
create index if not exists routines_user_updated  on public.routines  (user_id, updated_at);
create index if not exists workouts_user_updated  on public.workouts  (user_id, updated_at);
create index if not exists sets_user_updated      on public.sets      (user_id, updated_at);

-- Trigger
drop trigger if exists touch_exercises on public.exercises;
create trigger touch_exercises before insert or update on public.exercises
  for each row execute function public.touch_updated_at();
drop trigger if exists touch_routines on public.routines;
create trigger touch_routines before insert or update on public.routines
  for each row execute function public.touch_updated_at();
drop trigger if exists touch_workouts on public.workouts;
create trigger touch_workouts before insert or update on public.workouts
  for each row execute function public.touch_updated_at();
drop trigger if exists touch_sets on public.sets;
create trigger touch_sets before insert or update on public.sets
  for each row execute function public.touch_updated_at();

-- Sicurezza: ognuno vede e modifica solo i propri dati
alter table public.exercises enable row level security;
alter table public.routines  enable row level security;
alter table public.workouts  enable row level security;
alter table public.sets      enable row level security;

drop policy if exists "solo i miei dati" on public.exercises;
create policy "solo i miei dati" on public.exercises for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "solo i miei dati" on public.routines;
create policy "solo i miei dati" on public.routines for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "solo i miei dati" on public.workouts;
create policy "solo i miei dati" on public.workouts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "solo i miei dati" on public.sets;
create policy "solo i miei dati" on public.sets for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.exercises, public.routines, public.workouts, public.sets to authenticated;
