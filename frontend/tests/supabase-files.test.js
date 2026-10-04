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

test("Oversized sanitized image is rejected before any row is removed", async () => {
  let called = false;
  await assert.rejects(saveAnalysis({ userId:"test",original:new File([new Uint8Array(2097153)],"large.png",{type:"image/png"}),
    result:{ original_image:btoa("x".repeat(2097153)),depth_map:"",point_cloud:{},height_analysis:{},model_id:"demo" } }, { from:() => { called=true; throw new Error("unexpected"); } }), /2 MiB/);
  assert.equal(called,false);
});

test("Cloud history stores only the sanitized server image, not the uploaded source", async () => {
  const uploads = [];
  let row;
  const client = {
    from: table => table === "analyses" ? {
      select: () => ({ order: () => ({ order: async () => ({ data: [], error: null }) }) }),
      insert: async value => { row = value; return { data: value, error: null }; },
      update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: row.id }, error: null }) }) }) }),
    } : null,
    storage: { from: () => ({ upload: async (path, blob) => { uploads.push({ path, blob }); return { data: { path }, error: null }; } }) },
  };
  const original = new File(["GPS source bytes"], "scene.png", { type: "image/png" });
  const sanitized = "resized image with metadata removed";
  await saveAnalysis({ userId: "user-id", original, result: {
    original_image: btoa(sanitized), depth_map: "", point_cloud: { count: 0, positions: "", colors: "" },
    height_analysis: {}, model_id: "depth-anything-v2-small",
  } }, client);
  assert.equal(row.image_path.endsWith("/input.jpg"), true);
  const savedInput = uploads.find(item => item.path === row.image_path);
  assert.equal(await savedInput.blob.text(), sanitized);
  assert.equal(await savedInput.blob.text().then(value => value.includes("GPS source bytes")), false);
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
