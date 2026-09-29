import test from "node:test";
import assert from "node:assert/strict";
import { apiFetch, ApiError } from "../src/api.js";

test("API wrapper includes cookies, parses JSON and handles 401", async () => {
  let captured;
  globalThis.window = new EventTarget();
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ value: 42 }), { headers: { "Content-Type": "application/json" } });
  };
  const result = await apiFetch("/api/health");
  assert.deepEqual(await result.json(), { value: 42 });
  assert.equal(captured.url, "/api/health");
  assert.equal(captured.options.credentials, "include");
  let unauthorized = false;
  window.addEventListener("depthwizard:unauthorized", () => { unauthorized = true; });
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Please log in" }),
    { status: 401, headers: { "Content-Type": "application/json" } });
  await assert.rejects(apiFetch("/estimate"), error => error instanceof ApiError && error.message === "Please log in");
  assert.equal(unauthorized, true);
});

test("binary downloads are preserved", async () => {
  globalThis.fetch = async () => new Response("binary");
  assert.equal(await (await apiFetch("/export/ply")).text(), "binary");
});
