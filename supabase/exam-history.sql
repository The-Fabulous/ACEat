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
