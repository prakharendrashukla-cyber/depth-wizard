-- Additive public-analysis safeguards. Do not edit the already-applied setup.sql.
begin;

create table if not exists depth_wizard_private.quota_counters (
  scope text not null check (scope in ('analysis_user_day', 'analysis_ip_minute', 'analysis_global_day')),
  subject text not null,
  period_start timestamptz not null,
  used integer not null check (used >= 0),
  primary key (scope, subject, period_start)
);
alter table depth_wizard_private.quota_counters enable row level security;
revoke all on depth_wizard_private.quota_counters from public, anon, authenticated;

create table if not exists depth_wizard_private.runtime_limits (
  singleton boolean primary key default true check (singleton),
  user_storage_bytes bigint not null check (user_storage_bytes between 1048576 and 1099511627776),
  retention_days integer not null check (retention_days between 1 and 3650),
  updated_at timestamptz not null default now()
);
alter table depth_wizard_private.runtime_limits enable row level security;
revoke all on depth_wizard_private.runtime_limits from public, anon, authenticated;
insert into depth_wizard_private.runtime_limits(singleton, user_storage_bytes, retention_days)
values (true, 20971520, 30)
on conflict (singleton) do nothing;

create table if not exists depth_wizard_private.storage_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  used_bytes bigint not null default 0 check (used_bytes >= 0),
  updated_at timestamptz not null default now()
);
alter table depth_wizard_private.storage_usage enable row level security;
revoke all on depth_wizard_private.storage_usage from public, anon, authenticated;

insert into depth_wizard_private.storage_usage(user_id, used_bytes)
select u.id,
       sum(case when o.metadata->>'size' ~ '^[0-9]+$' then (o.metadata->>'size')::bigint else 0 end)
from storage.objects o
join auth.users u on lower(u.id::text) = lower(split_part(o.name, '/', 1))
where o.bucket_id = 'depth-wizard'
group by u.id
on conflict (user_id) do update
set used_bytes = excluded.used_bytes, updated_at = now();

create or replace function depth_wizard_private.track_storage_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_bytes bigint;
  v_limit bigint;
  v_used bigint;
begin
  if tg_op = 'DELETE' then
    if old.bucket_id <> 'depth-wizard' then return old; end if;
    begin
      v_user_id := split_part(old.name, '/', 1)::uuid;
    exception when invalid_text_representation then
      return old;
    end;
    if old.metadata->>'size' is null or old.metadata->>'size' !~ '^[0-9]+$' then return old; end if;
    v_bytes := (old.metadata->>'size')::bigint;
    update depth_wizard_private.storage_usage
       set used_bytes = greatest(0, used_bytes - v_bytes), updated_at = now()
     where user_id = v_user_id;
    return old;
  end if;

  if new.bucket_id <> 'depth-wizard' then return new; end if;
  if tg_op = 'UPDATE' then
    raise exception 'Depth Wizard objects are immutable';
  end if;
  if auth.uid() is null then
    raise exception 'A verified user is required to add a Depth Wizard object';
  end if;
  begin
    v_user_id := split_part(new.name, '/', 1)::uuid;
  exception when invalid_text_representation then
    raise exception 'Invalid Depth Wizard object owner';
  end;
  if v_user_id <> auth.uid() then
    raise exception 'Depth Wizard object owner mismatch';
  end if;
  if new.metadata->>'size' is null or new.metadata->>'size' !~ '^[0-9]+$' then
    raise exception 'Storage size metadata is required';
  end if;
  v_bytes := (new.metadata->>'size')::bigint;
  select l.user_storage_bytes into v_limit
    from depth_wizard_private.runtime_limits l where l.singleton = true;
  if v_limit is null then raise exception 'Storage quota is not configured'; end if;
  insert into depth_wizard_private.storage_usage(user_id, used_bytes)
  values (v_user_id, 0) on conflict (user_id) do nothing;
  update depth_wizard_private.storage_usage
     set used_bytes = used_bytes + v_bytes, updated_at = now()
   where user_id = v_user_id and used_bytes + v_bytes <= v_limit
   returning used_bytes into v_used;
  if not found then raise exception 'User storage limit reached'; end if;
  return new;
end;
$$;
revoke all on function depth_wizard_private.track_storage_usage() from public, anon, authenticated;
drop trigger if exists dw_storage_usage_insert on storage.objects;
create trigger dw_storage_usage_insert before insert or update on storage.objects
for each row execute function depth_wizard_private.track_storage_usage();
drop trigger if exists dw_storage_usage_delete on storage.objects;
create trigger dw_storage_usage_delete after delete on storage.objects
for each row execute function depth_wizard_private.track_storage_usage();

create table if not exists depth_wizard_private.maintenance_state (
  job_name text primary key check (job_name = 'retention'),
  last_started_at timestamptz
);
alter table depth_wizard_private.maintenance_state enable row level security;
revoke all on depth_wizard_private.maintenance_state from public, anon, authenticated;
insert into depth_wizard_private.maintenance_state(job_name, last_started_at)
values ('retention', null)
on conflict (job_name) do nothing;

create or replace function public.reserve_depth_wizard_quota(
  p_user_id uuid, p_ip_hash text, p_user_daily_limit integer,
  p_ip_minute_limit integer, p_global_daily_limit integer,
  p_user_storage_bytes bigint, p_retention_days integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_day timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_minute timestamptz := date_trunc('minute', now() at time zone 'UTC') at time zone 'UTC';
  v_user_used integer;
  v_ip_used integer;
  v_global_used integer;
  v_error text;
begin
  if p_user_id is null or p_ip_hash is null or length(p_ip_hash) <> 64
     or p_user_daily_limit < 1 or p_user_daily_limit > 1000000
     or p_ip_minute_limit < 1 or p_ip_minute_limit > 1000000
     or p_global_daily_limit < 1 or p_global_daily_limit > 1000000
     or p_user_storage_bytes < 1048576 or p_user_storage_bytes > 1099511627776
     or p_retention_days < 1 or p_retention_days > 3650 then
    raise exception 'Invalid quota configuration';
  end if;
  update depth_wizard_private.runtime_limits
     set user_storage_bytes = p_user_storage_bytes, retention_days = p_retention_days, updated_at = now()
   where singleton = true;
  delete from depth_wizard_private.quota_counters where period_start < now() - interval '2 days';

  begin
    insert into depth_wizard_private.quota_counters(scope, subject, period_start, used)
    values ('analysis_global_day', 'global', v_day, 1)
    on conflict (scope, subject, period_start) do update
      set used = depth_wizard_private.quota_counters.used + 1
      where depth_wizard_private.quota_counters.used < p_global_daily_limit
    returning used into v_global_used;
    if not found then raise exception using errcode = 'P0001', message = 'capacity_reached'; end if;

    insert into depth_wizard_private.quota_counters(scope, subject, period_start, used)
    values ('analysis_ip_minute', p_ip_hash, v_minute, 1)
    on conflict (scope, subject, period_start) do update
      set used = depth_wizard_private.quota_counters.used + 1
      where depth_wizard_private.quota_counters.used < p_ip_minute_limit
    returning used into v_ip_used;
    if not found then raise exception using errcode = 'P0001', message = 'ip_rate_limited'; end if;

    insert into depth_wizard_private.quota_counters(scope, subject, period_start, used)
    values ('analysis_user_day', p_user_id::text, v_day, 1)
    on conflict (scope, subject, period_start) do update
      set used = depth_wizard_private.quota_counters.used + 1
      where depth_wizard_private.quota_counters.used < p_user_daily_limit
    returning used into v_user_used;
    if not found then raise exception using errcode = 'P0001', message = 'daily_limit_reached'; end if;
  exception when raise_exception then
    get stacked diagnostics v_error = message_text;
    if v_error not in ('capacity_reached', 'ip_rate_limited', 'daily_limit_reached') then raise; end if;
    return jsonb_build_object('allowed', false, 'code', v_error, 'daily_limit', p_user_daily_limit,
      'daily_remaining', 0, 'daily_reset_at', v_day + interval '1 day');
  end;

  return jsonb_build_object('allowed', true, 'code', 'ok', 'daily_limit', p_user_daily_limit,
    'daily_used', v_user_used, 'daily_remaining', greatest(0, p_user_daily_limit - v_user_used),
    'daily_reset_at', v_day + interval '1 day', 'storage_limit_bytes', p_user_storage_bytes);
end;
$$;

create or replace function public.get_depth_wizard_quota(
  p_user_id uuid, p_user_daily_limit integer,
  p_user_storage_bytes bigint, p_retention_days integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_day timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_used integer := 0;
  v_storage bigint := 0;
begin
  if p_user_id is null or p_user_daily_limit < 1 or p_user_storage_bytes < 1048576
     or p_retention_days < 1 or p_retention_days > 3650 then
    raise exception 'Invalid quota configuration';
  end if;
  update depth_wizard_private.runtime_limits
     set user_storage_bytes = p_user_storage_bytes, retention_days = p_retention_days, updated_at = now()
   where singleton = true;
  select c.used into v_used from depth_wizard_private.quota_counters c
   where c.scope = 'analysis_user_day' and c.subject = p_user_id::text and c.period_start = v_day;
  select u.used_bytes into v_storage from depth_wizard_private.storage_usage u where u.user_id = p_user_id;
  return jsonb_build_object('daily_limit', p_user_daily_limit, 'daily_used', coalesce(v_used, 0),
    'daily_remaining', greatest(0, p_user_daily_limit - coalesce(v_used, 0)),
    'daily_reset_at', v_day + interval '1 day', 'storage_used_bytes', coalesce(v_storage, 0),
    'storage_limit_bytes', p_user_storage_bytes, 'retention_days', p_retention_days);
end;
$$;

create or replace function public.claim_depth_wizard_retention(p_cooldown_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_claimed integer;
begin
  if p_cooldown_seconds < 3600 or p_cooldown_seconds > 31536000 then
    raise exception 'Invalid retention cooldown';
  end if;
  update depth_wizard_private.maintenance_state
     set last_started_at = now()
   where job_name = 'retention'
     and (last_started_at is null or last_started_at < now() - make_interval(secs => p_cooldown_seconds));
  get diagnostics v_claimed = row_count;
  return v_claimed = 1;
end;
$$;

create or replace function public.finish_depth_wizard_retention(p_succeeded boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not p_succeeded then
    update depth_wizard_private.maintenance_state set last_started_at = null where job_name = 'retention';
  end if;
end;
$$;

revoke all on function public.reserve_depth_wizard_quota(uuid,text,integer,integer,integer,bigint,integer) from public, anon, authenticated;
revoke all on function public.get_depth_wizard_quota(uuid,integer,bigint,integer) from public, anon, authenticated;
revoke all on function public.claim_depth_wizard_retention(integer) from public, anon, authenticated;
revoke all on function public.finish_depth_wizard_retention(boolean) from public, anon, authenticated;
grant execute on function public.reserve_depth_wizard_quota(uuid,text,integer,integer,integer,bigint,integer) to service_role;
grant execute on function public.get_depth_wizard_quota(uuid,integer,bigint,integer) to service_role;
grant execute on function public.claim_depth_wizard_retention(integer) to service_role;
grant execute on function public.finish_depth_wizard_retention(boolean) to service_role;

commit;
