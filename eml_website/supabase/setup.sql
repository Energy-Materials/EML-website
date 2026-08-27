-- EML 홈페이지용 Supabase 초기 설정
-- Supabase Dashboard > SQL Editor에서 이 파일 전체를 한 번 실행하세요.

create schema if not exists private;
revoke all on schema private from public;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
revoke all on table public.admin_users from anon, authenticated;
grant select on table public.admin_users to authenticated;

drop policy if exists "Admins can read their own membership" on public.admin_users;
create policy "Admins can read their own membership"
on public.admin_users
for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_admin() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

create table if not exists public.site_content (
  id text primary key check (id = 'main'),
  content jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.site_content (id, content, revision)
values ('main', null, 0)
on conflict (id) do nothing;

create or replace function private.bump_site_content_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.bump_site_content_revision() from public, anon, authenticated;

drop trigger if exists site_content_revision_trigger on public.site_content;
create trigger site_content_revision_trigger
before update on public.site_content
for each row
execute function private.bump_site_content_revision();

alter table public.site_content enable row level security;
revoke all on table public.site_content from anon, authenticated;
grant select on table public.site_content to anon, authenticated;
grant update (content) on table public.site_content to authenticated;

drop policy if exists "Public can read site content" on public.site_content;
create policy "Public can read site content"
on public.site_content
for select
to anon, authenticated
using (true);

drop policy if exists "Admins can update site content" on public.site_content;
create policy "Admins can update site content"
on public.site_content
for update
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'site-media',
  'site-media',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Admins can list site media" on storage.objects;

drop policy if exists "Admins can upload site media" on storage.objects;
create policy "Admins can upload site media"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'site-media'
  and (select private.is_admin())
);

drop policy if exists "Admins can replace site media" on storage.objects;
drop policy if exists "Admins can delete site media" on storage.objects;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'site_content'
  ) then
    alter publication supabase_realtime add table public.site_content;
  end if;
end
$$;

-- 다음 단계
-- 1) Dashboard > Authentication > Users에서 관리자 계정을 만드세요.
-- 2) 내부 이메일을 eml-admin@example.com으로 만든 뒤 아래 구문을 별도로 실행하세요.
--
-- insert into public.admin_users (user_id)
-- select id from auth.users
-- where lower(email) = lower('eml-admin@example.com')
-- on conflict (user_id) do nothing;
