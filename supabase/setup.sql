-- Run once in the ACEat project's SQL Editor. Rerunning is safe.
begin;

create table if not exists public.aceat_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  target_score integer check (target_score between 400 and 1600),
  updated_at timestamptz not null default now()
);

create table if not exists public.aceat_exam_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  exam_id text not null check (exam_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  revision integer not null default 1 check (revision > 0),
  state jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 65536),
  updated_at timestamptz not null default now(),
  primary key (user_id, exam_id)
);

create table if not exists public.aceat_book_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id text not null check (book_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  chapter_index integer not null default 0 check (chapter_index between 0 and 10000),
  subject text not null check (subject in ('math', 'english')),
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

alter table public.aceat_profiles enable row level security;
alter table public.aceat_exam_attempts enable row level security;
alter table public.aceat_book_progress enable row level security;

revoke all on public.aceat_profiles, public.aceat_exam_attempts, public.aceat_book_progress from anon;
grant select, insert, update, delete on public.aceat_profiles, public.aceat_exam_attempts, public.aceat_book_progress to authenticated;

drop policy if exists aceat_owner on public.aceat_profiles;
create policy aceat_owner on public.aceat_profiles for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists aceat_owner on public.aceat_exam_attempts;
create policy aceat_owner on public.aceat_exam_attempts for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists aceat_owner on public.aceat_book_progress;
create policy aceat_owner on public.aceat_book_progress for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

commit;
