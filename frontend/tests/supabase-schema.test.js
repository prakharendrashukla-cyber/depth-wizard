// Real PostgreSQL engine with minimal Auth/Storage schema stubs.
// This validates SQL/RLS, not hosted Auth, email delivery or the Storage HTTP API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("Supabase setup reruns; roles, ownership, paths, quota and cleanup are enforced", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
      grant usage on schema auth,storage to anon,authenticated;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb default '{}');
      alter table storage.objects enable row level security;
      grant select,insert,update,delete on storage.objects to authenticated;
      create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
    `);
    const sql = await readFile(new URL("../../supabase/setup.sql", import.meta.url), "utf8");
    await db.exec(sql); await db.exec(sql);
    const safetySql = await readFile(new URL("../../supabase/migrations/20261003164056_public_analysis_safety.sql", import.meta.url), "utf8");
    await db.exec(safetySql);
    const a = "00000000-0000-0000-0000-000000000001", b = "00000000-0000-0000-0000-000000000002";
    await db.exec(`insert into auth.users(id) values('${a}'),('${b}');`);
    const asUser = async uid => { await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false);`); };
    const reserve = async (id, uid = a) => db.query(`insert into public.analyses(id,user_id,filename,model_id,image_path,depth_path,preview_path,cloud_path,metrics,report)
      values($1,$2,'scene.png','model',$3||'/input.png',$3||'/depth.png',$3||'/preview.jpg',$3||'/cloud.json','{}','{}')`, [id, uid, `${uid}/${id}`]);
    await asUser(a);
    const id = crypto.randomUUID(); await reserve(id);
    assert.equal((await db.query("select count(*)::int n from profiles")).rows[0].n, 1);
    await db.query("update profiles set display_name='Judge A' where id=$1", [a]);
    await assert.rejects(db.query("update profiles set id=$1 where id=$2", [b, a]), /permission denied/);
    await assert.rejects(db.query("update analyses set user_id=$1 where id=$2", [b, id]), /permission denied/);
    await assert.rejects(db.query("update analyses set scale_factor=-1 where id=$1", [id]), /check constraint/);
    await assert.rejects(db.query("update analyses set metrics='[]' where id=$1", [id]), /check constraint/);
    const file = `${a}/${id}/input.png`;
    await db.query("insert into storage.objects(bucket_id,name,metadata) values('depth-wizard',$1,'{\"size\":\"10\"}')", [file]);
    await assert.rejects(db.query("delete from analyses where id=$1", [id]), /Storage API first/);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name,metadata) values('depth-wizard',$1,'{\"size\":\"1\"}')", [`${a}/${id}/unexpected.txt`]), /row-level security/);
    await asUser(b);
    assert.equal((await db.query("select * from analyses")).rows.length, 0);
    assert.equal((await db.query("select * from storage.objects")).rows.length, 0);
    assert.equal((await db.query("update analyses set status='deleting' where id=$1 returning id", [id])).rows.length, 0);
    assert.equal((await db.query("delete from storage.objects returning name")).rows.length, 0);
    await assert.rejects(reserve(crypto.randomUUID(), a), /Owner mismatch|row-level security/);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name,metadata) values('depth-wizard',$1,'{\"size\":\"1\"}')", [file]), /owner mismatch/);
    await asUser(a);
    await assert.rejects(db.query("select * from depth_wizard_private.storage_usage"), /permission denied/);
    await db.exec("reset role; set role service_role;");
    const quotaRpc = (uid, ip, userLimit, globalLimit=1000) => db.query(
      "select public.reserve_depth_wizard_quota($1,$2,$3,100,$4,52428800,365) as result",
      [uid, ip, userLimit, globalLimit]);
    const ownQuota = await db.query("select public.get_depth_wizard_quota($1,5,52428800,365) as result", [a]);
    assert.equal(ownQuota.rows[0].result.storage_used_bytes, 10);
    assert.equal(ownQuota.rows[0].result.retention_days, 365);
    const concurrent = await Promise.all(Array.from({length: 3}, () => quotaRpc(b, "c".repeat(64), 2)));
    assert.equal(concurrent.filter(item => item.rows[0].result.allowed).length, 2);
    assert.equal(concurrent.filter(item => item.rows[0].result.code === "daily_limit_reached").length, 1);
    await db.exec("reset role; set role authenticated; select set_config('request.jwt.claim.sub','" + a + "',false);");
    const largeId = crypto.randomUUID(); await reserve(largeId);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name,metadata) values('depth-wizard',$1,'{\"size\":\"52428800\"}')", [`${a}/${largeId}/input.png`]), /User storage limit reached/);
    await db.query("delete from analyses where id=$1", [largeId]);
    for (let i=1; i<20; i++) await reserve(crypto.randomUUID());
    await assert.rejects(reserve(crypto.randomUUID()), /at most 20/);
    await db.query("delete from storage.objects where name=$1", [file]);
    await db.query("delete from analyses where id=$1", [id]);
    await reserve(crypto.randomUUID());
    await db.exec("reset role; set role anon;");
    await assert.rejects(db.query("select * from analyses"), /permission denied/);
    assert.equal((await db.query("select depth_wizard_health() n")).rows[0].n, 1);
  } finally { await db.close(); }
});
