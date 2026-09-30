import test from "node:test";
import assert from "node:assert/strict";
import { base64Blob, makePly, saveAnalysis, deleteAnalysis } from "../src/supabase/analyses.js";
import { escapeHtml } from "../src/safeHtml.js";

test("Report values cannot break out into HTML or attributes", () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test("Binary cloud export preserves geometry and bounds colors", async () => {
  const encode = values => Buffer.from(new Float32Array(values).buffer).toString("base64");
  const blob = makePly({ count:1, positions:encode([1,2,3]), colors:encode([1,0.5,0]) });
  const data = Buffer.from(await blob.arrayBuffer());
  assert.match(data.toString(), /^ply\nformat binary_little_endian/);
  assert.equal(data.readFloatLE(data.length-15),1);
  assert.deepEqual([...data.subarray(-3)],[255,128,0]);
  assert.equal((await base64Blob("aGVsbG8=","text/plain").text()),"hello");
});

test("Oversized original is rejected before any row is removed", async () => {
  let called = false;
  await assert.rejects(saveAnalysis({ userId:"test",original:new File([new Uint8Array(2097153)],"large.png",{type:"image/png"}),
    result:{ original_image:"",depth_map:"",point_cloud:{},height_analysis:{},model_id:"demo" } }, { from:() => { called=true; throw new Error("unexpected"); } }), /2 MiB/);
  assert.equal(called,false);
});

test("Failed file deletion retains the row for retry", async () => {
  const events=[];
  const client={from:() => ({
    select:() => ({eq:() => ({single:async()=>({data:{image_path:"own/image.png"},error:null})})}),
    update:() => ({eq:() => ({select:() => ({single:async()=>{events.push("deleting"); return {data:{id:"test"},error:null};}})})}),
    delete:() => {events.push("row-delete"); throw new Error("must retain row");},
  }), storage:{from:()=>({remove:async()=>{events.push("files");return {error:new Error("Network failure")};}})}};
  await assert.rejects(deleteAnalysis("test",client), /Network failure/);
  assert.deepEqual(events,["deleting","files"]);
});
