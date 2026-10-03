import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api";
import { MODEL_CATALOG } from "./ModelSelector";
import "./ModelComparisonModal.css";

export default function ModelComparisonModal({ currentModel, result, sourceFile, onClose }) {
  const [availableIds, setAvailableIds] = useState(new Set());
  const [registryLoading, setRegistryLoading] = useState(true);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [comparedResult, setComparedResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const candidates = useMemo(
    () => MODEL_CATALOG.filter((model) => availableIds.has(model.id) && model.id !== currentModel),
    [availableIds, currentModel],
  );

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/models")
      .then((response) => response.json())
      .then((payload) => {
        if (!mounted) return;
        const ids = new Set((payload.models || [])
          .filter((model) => model.available === true && typeof model.id === "string")
          .map((model) => model.id));
        setAvailableIds(ids);
      })
      .catch((requestError) => {
        if (mounted) setError(requestError.message || "Could not read model availability.");
      })
      .finally(() => {
        if (mounted) setRegistryLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (candidates.length && !candidates.some((model) => model.id === selectedModelId)) {
      setSelectedModelId(candidates[0].id);
    }
  }, [candidates, selectedModelId]);

  const compare = async () => {
    if (!sourceFile || !selectedModelId || busy) return;
    setBusy(true);
    setError("");
    setComparedResult(null);
    try {
      const body = new FormData();
      body.append("image", sourceFile);
      body.append("model", selectedModelId);
      const response = await apiFetch("/api/estimate", { method: "POST", body });
      setComparedResult(await response.json());
    } catch (requestError) {
      setError(requestError.message || "Comparison failed. Your current analysis is unchanged.");
    } finally {
      setBusy(false);
    }
  };

  const selectedModel = candidates.find((model) => model.id === selectedModelId);
  const existingModelName = result?.model || MODEL_CATALOG.find((model) => model.id === currentModel)?.name || currentModel;

  return (
    <div className="modal-overlay model-compare-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="modal-panel modal-wide model-compare-panel" role="dialog" aria-modal="true" aria-labelledby="model-compare-title">
        <header className="model-compare-header">
          <div>
            <h2 id="model-compare-title">Compare depth models</h2>
            <p>Compare the current result with one other available model. The comparison does not replace or save your analysis.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} disabled={busy} aria-label="Close model comparison">✕</button>
        </header>

        <div className="model-compare-body">
          {!sourceFile && (
            <p className="model-compare-note" role="status">
              Upload an image and run a live analysis first. Saved and offline-demo results do not retain the uploaded source file.
            </p>
          )}

          <label className="model-compare-select-label" htmlFor="compare-model-select">Model to compare</label>
          <select
            id="compare-model-select"
            value={selectedModelId}
            onChange={(event) => { setSelectedModelId(event.target.value); setComparedResult(null); setError(""); }}
            disabled={registryLoading || busy || candidates.length === 0}
          >
            {registryLoading && <option value="">Checking available models…</option>}
            {!registryLoading && candidates.length === 0 && <option value="">No other supported models are available</option>}
            {candidates.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}{availableIds.has(model.id) ? "" : " (unavailable)"}
              </option>
            ))}
          </select>

          {selectedModel?.bestFor && <p className="model-compare-note">{selectedModel.bestFor}</p>}
          {busy && <p className="model-compare-status" role="status">Running {selectedModel?.name || "selected model"}. First use may download its weights.</p>}
          {error && <p className="model-compare-error" role="alert">{error}</p>}

          {comparedResult && (
            <div className="model-compare-results" aria-live="polite">
              <figure>
                <figcaption>{existingModelName}{result?.metadata?.depth_time_s ? ` · ${result.metadata.depth_time_s}s` : ""}</figcaption>
                <img src={`data:image/png;base64,${result.depth_map}`} alt={`Depth result from ${existingModelName}`} />
              </figure>
              <figure>
                <figcaption>{comparedResult.model || selectedModel?.name}{comparedResult.metadata?.depth_time_s ? ` · ${comparedResult.metadata.depth_time_s}s` : ""}</figcaption>
                <img src={`data:image/png;base64,${comparedResult.depth_map}`} alt={`Depth result from ${comparedResult.model || selectedModel?.name}`} />
              </figure>
            </div>
          )}
        </div>

        <footer className="model-compare-footer">
          <button type="button" className="header-btn" onClick={onClose} disabled={busy}>Close</button>
          <button type="button" className="compare-models-btn" onClick={compare} disabled={!sourceFile || registryLoading || !selectedModelId || busy}>
            {busy ? "Comparing…" : comparedResult ? "Compare again" : "Run comparison"}
          </button>
        </footer>
      </section>
    </div>
  );
}
