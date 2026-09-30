/** Convert the backend's /models response into the selector's registry state. */
export function normalizeModelRegistry(payload) {
  if (Array.isArray(payload?.models)) {
    return {
      availableModelIds: new Set(
        payload.models
          .filter((model) => model.available === true && typeof model.id === "string")
          .map((model) => model.id)
      ),
      modelDetails: new Map(payload.models.filter((model) => typeof model.id === "string").map((model) => [model.id, model])),
      currentModel: payload.current_model ?? null,
      recommendedModel: payload.recommended ?? null,
    };
  }

  // Compatibility with older deployments that returned a flat list of IDs.
  return {
    availableModelIds: new Set(Array.isArray(payload?.available_models) ? payload.available_models : []),
    modelDetails: new Map(),
    currentModel: payload?.active_model ?? null,
    recommendedModel: payload?.recommended ?? null,
  };
}
