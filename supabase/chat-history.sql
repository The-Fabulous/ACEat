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

