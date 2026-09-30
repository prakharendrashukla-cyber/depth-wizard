-- Run in the Supabase SQL Editor as project owner. Safe to re-run for this schema.
-- This creates Depth Wizard resources only; it does not delete existing rows/files.
begin;
create schema if not exists depth_wizard_private;
revoke all on schema depth_wizard_private from public, anon, authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 100),
  created_at timestamptz not null default now()
);
create table if not exists public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  filename text not null check (length(filename) between 1 and 255),
  model_id text not null check (length(model_id) between 1 and 100),
  image_path text not null,
  depth_path text not null,
  preview_path text not null,
  cloud_path text not null,
  ply_path text,
  scale_preset text not null default 'relative' check (scale_preset in ('relative','planetary','urban','architecture','macro','custom')),
  scale_factor double precision not null default 1 check (scale_factor > 0 and scale_factor <= 1000000),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object' and octet_length(metrics::text) <= 65536),
  report jsonb not null check (jsonb_typeof(report) = 'object' and octet_length(report::text) <= 65536),
  status text not null default 'uploading' check (status in ('uploading','ready','deleting')),
  created_at timestamptz not null default now(),
  constraint analysis_paths check (
    image_path in (user_id::text || '/' || id::text || '/input.png', user_id::text || '/' || id::text || '/input.jpg', user_id::text || '/' || id::text || '/input.webp', user_id::text || '/' || id::text || '/input.tif')
    and depth_path = user_id::text || '/' || id::text || '/depth.png'
    and preview_path = user_id::text || '/' || id::text || '/preview.jpg'
    and cloud_path = user_id::text || '/' || id::text || '/cloud.json'
    and (ply_path is null or ply_path = user_id::text || '/' || id::text || '/cloud.ply')
  )
);
create index if not exists analyses_owner_created_idx on public.analyses(user_id, created_at desc, id);

-- Only Auth can create profiles. Display names are cosmetic, never permissions.
create or replace function depth_wizard_private.create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'display_name',''),100))
  on conflict (id) do nothing;
  return new;
end; $$;
revoke all on function depth_wizard_private.create_profile() from public, anon, authenticated;
drop trigger if exists depth_wizard_profile on auth.users;
create trigger depth_wizard_profile after insert on auth.users
for each row execute function depth_wizard_private.create_profile();
insert into public.profiles(id,display_name)
select id, left(coalesce(raw_user_meta_data->>'display_name',''),100) from auth.users
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.analyses enable row level security;
revoke all on public.profiles, public.analyses from anon, authenticated;
grant select on public.profiles to authenticated;
grant update(display_name) on public.profiles to authenticated;
grant select, insert, delete on public.analyses to authenticated;
-- IDs, ownership, paths, and creation dates are immutable after reservation.
grant update(scale_preset,scale_factor,metrics,report,status) on public.analyses to authenticated;
drop policy if exists dw_profile_read on public.profiles;
create policy dw_profile_read on public.profiles for select to authenticated using ((select auth.uid()) = id);
drop policy if exists dw_profile_edit on public.profiles;
create policy dw_profile_edit on public.profiles for update to authenticated
using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
drop policy if exists dw_analysis_read on public.analyses;
create policy dw_analysis_read on public.analyses for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists dw_analysis_insert on public.analyses;
create policy dw_analysis_insert on public.analyses for insert to authenticated
with check ((select auth.uid()) = user_id and status = 'uploading' and not coalesce((select auth.jwt())->>'is_anonymous','false')::boolean);
drop policy if exists dw_analysis_edit on public.analyses;
create policy dw_analysis_edit on public.analyses for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists dw_analysis_delete on public.analyses;
create policy dw_analysis_delete on public.analyses for delete to authenticated using ((select auth.uid()) = user_id);

-- Serialize reservations per owner so concurrent tabs cannot exceed 20 rows.
create or replace function depth_wizard_private.limit_analyses() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or new.user_id <> auth.uid() then raise exception 'Owner mismatch'; end if;
  perform 1 from public.profiles where id = new.user_id for update;
  if (select count(*) from public.analyses where user_id = new.user_id) >= 20 then
    raise exception 'Keep at most 20 analyses. Delete an older analysis and retry.';
  end if;
  return new;
end; $$;
revoke all on function depth_wizard_private.limit_analyses() from public, anon, authenticated;
drop trigger if exists dw_analysis_limit on public.analyses;
create trigger dw_analysis_limit before insert on public.analyses for each row execute function depth_wizard_private.limit_analyses();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('depth-wizard','depth-wizard',false,2097152,
 array['image/png','image/jpeg','image/webp','image/tiff','application/json','application/octet-stream'])
on conflict(id) do update set public=false, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
-- No UPDATE policy: files are immutable; the client always uses upsert:false.
drop policy if exists dw_files_read on storage.objects;
create policy dw_files_read on storage.objects for select to authenticated using (
 bucket_id='depth-wizard' and (storage.foldername(name))[1]=(select auth.uid())::text
 and exists(select 1 from public.analyses a where a.user_id=(select auth.uid()) and name in (a.image_path,a.depth_path,a.preview_path,a.cloud_path,a.ply_path))
);
drop policy if exists dw_files_insert on storage.objects;
create policy dw_files_insert on storage.objects for insert to authenticated with check (
 bucket_id='depth-wizard' and (storage.foldername(name))[1]=(select auth.uid())::text
 and exists(select 1 from public.analyses a where a.user_id=(select auth.uid()) and a.status='uploading' and name in (a.image_path,a.depth_path,a.preview_path,a.cloud_path,a.ply_path))
);
drop policy if exists dw_files_delete on storage.objects;
create policy dw_files_delete on storage.objects for delete to authenticated using (
 bucket_id='depth-wizard' and (storage.foldername(name))[1]=(select auth.uid())::text
 and exists(select 1 from public.analyses a where a.user_id=(select auth.uid()) and name in (a.image_path,a.depth_path,a.preview_path,a.cloud_path,a.ply_path))
);
-- Require the Storage API to remove bytes BEFORE deleting the row.
create or replace function depth_wizard_private.require_empty_files() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from storage.objects where bucket_id='depth-wizard'
    and name in (old.image_path,old.depth_path,old.preview_path,old.cloud_path,old.ply_path)) then
    raise exception 'Delete analysis files through the Storage API first';
  end if;
  return old;
end; $$;
revoke all on function depth_wizard_private.require_empty_files() from public, anon, authenticated;
drop trigger if exists dw_files_before_row on public.analyses;
create trigger dw_files_before_row before delete on public.analyses for each row execute function depth_wizard_private.require_empty_files();

-- Minimal scheduled health probe: no user data, no privileged execution.
create or replace function public.depth_wizard_health() returns integer
language sql stable security invoker set search_path = '' as 'select 1';
revoke all on function public.depth_wizard_health() from public;
grant execute on function public.depth_wizard_health() to anon, authenticated;
commit;
