import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelRegistry } from "../src/components/modelRegistry.js";

test("normalizes the current backend /models response and excludes unavailable models", () => {
  const registry = normalizeModelRegistry({
    models: [
      { id: "depth-anything-v2-small", available: true },
      { id: "depth-anything-v2-large", available: true, weights_cached: false },
      { id: "metric3d", available: false, unavailable_reason: "Required model class is unsupported." },
      { id: "procedural-fallback", available: true },
    ],
    current_model: "depth-anything-v2-small",
  });

  assert.deepEqual([...registry.availableModelIds], ["depth-anything-v2-small", "depth-anything-v2-large", "procedural-fallback"]);
  assert.equal(registry.currentModel, "depth-anything-v2-small");
  assert.equal(registry.modelDetails.get("depth-anything-v2-large").weights_cached, false);
  assert.equal(registry.modelDetails.get("metric3d").unavailable_reason, "Required model class is unsupported.");
});

test("returns an empty registry for malformed model payloads", () => {
  const registry = normalizeModelRegistry({ models: [{ name: "missing id", available: true }] });
  assert.deepEqual([...registry.availableModelIds], []);
  assert.equal(registry.currentModel, null);
});
