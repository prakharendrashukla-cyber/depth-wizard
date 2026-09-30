// Use two disposable, already-confirmed demo accounts. Creates/deletes one test row.
// Run: node --env-file=.env.test.local scripts/test-supabase-live.mjs
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { saveAnalysis, deleteAnalysis, BUCKET } from "../src/supabase/analyses.js";
const env = process.env;
for (const name of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "TEST_A_EMAIL", "TEST_A_PASSWORD", "TEST_B_EMAIL", "TEST_B_PASSWORD"])
  if (!env[name]) throw new Error("Missing " + name);
async function login(prefix) {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession:false, autoRefreshToken:false } });
  const { data, error } = await client.auth.signInWithPassword({ email:env[`TEST_${prefix}_EMAIL`],password:env[`TEST_${prefix}_PASSWORD`] });
  if (error) throw error;
  return { client, user:data.user };
}
const a = await login("A"), b = await login("B");
assert.notEqual(a.user.id,b.user.id,"Use two different accounts");
const count = await a.client.from("analyses").select("id",{ count:"exact", head:true });
if (count.error) throw count.error;
assert.ok(count.count < 19, "Use an empty disposable account; this test must not prune history.");
let id;
try {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=";
  const floats = Buffer.from(new Float32Array([0,0,0]).buffer).toString("base64");
  id = await saveAnalysis({ userId:a.user.id,original:new File([Buffer.from(png,"base64")],"isolation-test.png",{type:"image/png"}),
    result:{model_id:"rls-test",original_image:png,depth_map:png,point_cloud:{count:1,positions:floats,colors:floats},height_analysis:{}} },a.client);
  const own = await a.client.from("analyses").select("*").eq("id",id).single();
  assert.ifError(own.error);
  const path = own.data.image_path;
  const read = await b.client.from("analyses").select("*").eq("id",id);
  assert.ifError(read.error); assert.equal(read.data.length,0);
  for (const query of [b.client.from("analyses").update({status:"deleting"}).eq("id",id).select("id"), b.client.from("analyses").delete().eq("id",id).select("id")]) {
    const response = await query; assert.ifError(response.error); assert.equal(response.data.length,0);
  }
  assert.ok((await b.client.storage.from(BUCKET).download(path)).error);
  assert.ok((await b.client.storage.from(BUCKET).createSignedUrl(path,60)).error);
  const removed = await b.client.storage.from(BUCKET).remove([path]);
  assert.ok(removed.error || removed.data.length === 0);
  assert.ifError((await a.client.storage.from(BUCKET).download(path)).error);
  assert.ok((await a.client.from("analyses").update({user_id:b.user.id}).eq("id",id)).error);
  console.log("PASS: owner save/read; cross-user row and file isolation; immutable owner.");
} finally {
  if (id) await deleteAnalysis(id,a.client);
  await Promise.all([a.client.auth.signOut(),b.client.auth.signOut()]);
}
