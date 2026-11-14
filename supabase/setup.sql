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

-- Run in Supabase SQL Editor for the existing ACEat project.
-- Adds chat history without changing existing account/progress tables.
begin;

create table if not exists public.aceat_chat_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  conversation_id uuid not null,
  topic text not null check (topic in ('algebra', 'advanced', 'data', 'geometry', 'reading')),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 80000),
  answer jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  check (
    (role = 'user' and char_length(content) between 1 and 3000 and answer is null)
    or (role = 'assistant' and jsonb_typeof(answer) = 'object' and answer is not null
        and octet_length(answer::text) <= 524288)
  )
);

create index if not exists aceat_chat_messages_topic_time
  on public.aceat_chat_messages (user_id, topic, created_at desc, id desc);
alter table public.aceat_chat_messages enable row level security;
revoke all on public.aceat_chat_messages from anon, authenticated;
grant select, insert on public.aceat_chat_messages to authenticated;
drop policy if exists aceat_chat_read on public.aceat_chat_messages;
create policy aceat_chat_read on public.aceat_chat_messages for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists aceat_chat_insert on public.aceat_chat_messages;
create policy aceat_chat_insert on public.aceat_chat_messages for insert to authenticated
  with check ((select auth.uid()) = user_id);

commit;

-- Run once in the ACEat Supabase SQL Editor. Safe to rerun.
begin;
create table if not exists public.aceat_exam_results (
 user_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null,
 exam_id text not null check (exam_id ~ '^[a-z][a-z0-9-]{0,63}$'),
 completed_at timestamptz not null,
 score integer not null check (score between 400 and 1600),
 is_demo boolean not null default false,
 result jsonb not null check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 131072),
 primary key (user_id, id)
);
create index if not exists aceat_exam_results_time on public.aceat_exam_results(user_id, completed_at desc, id desc);
alter table public.aceat_exam_results enable row level security;
revoke all on public.aceat_exam_results from anon, authenticated;
grant select, insert on public.aceat_exam_results to authenticated;
drop policy if exists aceat_results_read on public.aceat_exam_results;
create policy aceat_results_read on public.aceat_exam_results for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists aceat_results_insert on public.aceat_exam_results;
create policy aceat_results_insert on public.aceat_exam_results for insert to authenticated with check ((select auth.uid()) = user_id and is_demo = false);
commit;
