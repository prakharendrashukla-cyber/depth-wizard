import { apiFetch } from "../api";
import React, { useState, useEffect, useMemo } from "react";
import { normalizeModelRegistry } from "./modelRegistry";
import "./ModelSelector.css";

/**
 * Model catalog metadata for monocular depth estimation models.
 */
export const MODEL_CATALOG = [
  {
    id: "depth-anything-v2-small",
    name: "Depth Anything V2 Small",
    family: "Depth Anything V2",
    variant: "ViT-S",
    params: "24.8M",
    speed: "fast",
    speedIcon: "⚡",
    speedText: "Fastest neural model",
    accuracyText: "Relative depth",
    architecture: "Vision Transformer (ViT-Small) + DPT Head",
    bestFor: "Fast previews and general scene depth estimation",
    description: "Compact monocular depth model intended for responsive previews. Output is relative and depends on the input image.",
    hardwareReq: "CPU or GPU; weights download on first use",
    isDefault: true,
  },
  {
    id: "depth-anything-v2-base",
    name: "Depth Anything V2 Base",
    family: "Depth Anything V2",
    variant: "ViT-B",
    params: "97.5M",
    speed: "medium",
    speedIcon: "🔄",
    speedText: "Balanced",
    accuracyText: "Relative depth",
    architecture: "Vision Transformer (ViT-Base) + Multi-scale Neck",
    bestFor: "General scenes where a larger model is acceptable",
    description: "Medium-sized monocular depth model. Output is relative and depends on the input image.",
    hardwareReq: "CPU or GPU; weights download on first use",
    isDefault: false,
  },
  {
    id: "depth-anything-v2-large",
    name: "Depth Anything V2 Large",
    family: "Depth Anything V2",
    variant: "ViT-L",
    params: "335.3M",
    speed: "slow",
    speedIcon: "🐢",
    speedText: "Slowest neural model",
    accuracyText: "Relative depth",
    architecture: "Vision Transformer (ViT-Large) + DPT",
    bestFor: "General scenes where the largest Depth Anything V2 variant is desired",
    description: "Large monocular depth model. Its output is relative and is not a survey-grade elevation product.",
    hardwareReq: "CPU or GPU; needs a larger memory limit and model download",
    isDefault: false,
  },
  {
    id: "midas-small",
    name: "MiDaS v3.1 Small",
    family: "MiDaS",
    variant: "MobileNet-v2",
    params: "21.4M",
    speed: "fast",
    speedIcon: "⚡",
    speedText: "Fast",
    accuracyText: "Relative depth",
    architecture: "MobileNetV2 + DPT Residual Head",
    bestFor: "Edge devices, ultra-low resource environments, quick rough contours",
    description: "Classical monocular depth estimator trained on diverse multi-dataset mixtures for general scenes.",
    hardwareReq: "CPU or GPU; weights download on first use",
    isDefault: false,
  },
  {
    id: "midas-large",
    name: "MiDaS v3.1 Large",
    family: "MiDaS",
    variant: "BEiT-L-512",
    params: "345M",
    speed: "slow",
    speedIcon: "🐢",
    speedText: "Slow",
    accuracyText: "Relative depth",
    architecture: "BEiT-Large + Multi-scale Decoder",
    bestFor: "Complex scenes with mixed indoor/outdoor depth ranges and urban structures",
    description: "Robust multi-domain relative depth estimation using large-scale transformer backbone.",
    hardwareReq: "CPU or GPU; needs a larger memory limit and model download",
    isDefault: false,
  },
  {
    id: "zoedepth",
    name: "ZoeDepth (Metric)",
    family: "ZoeDepth",
    variant: "NK (Metric)",
    params: "348M",
    speed: "slow",
    speedIcon: "🐢",
    speedText: "Slow",
    accuracyText: "Metric depth estimate",
    architecture: "Metric ZoeDepth ViT + Multi-bin Head",
    bestFor: "Scenes suited to its metric-depth training domains",
    description: "Predicts metric-scale depth for supported scene types. Results still depend on the scene and input image.",
    hardwareReq: "CPU or GPU; needs a larger memory limit and model download",
    isDefault: false,
  },
  {
    id: "metric3d",
    name: "Metric3D (not available)",
    family: "Metric3D",
    variant: "ViT-g Large",
    params: "450M",
    speed: "slow",
    speedIcon: "🐢",
    speedText: "Slow (~380ms)",
    accuracyText: "Metric depth estimate",
    architecture: "Canonical Camera Space Transformation",
    bestFor: "Not implemented by this server",
    description: "This model is not available in the current server build. Choose another enabled model.",
    hardwareReq: "Unavailable",
    isDefault: false,
  },
  {
    id: "procedural-fallback",
    name: "Procedural Fallback",
    family: "Procedural",
    variant: "Sobel + FFT",
    params: "0M (CPU)",
    speed: "fast",
    speedIcon: "⚡",
    speedText: "Instant heuristic",
    accuracyText: "Synthetic depth",
    architecture: "Luminance Gradient + Multi-frequency FFT",
    bestFor: "Offline mode without GPU/model weights, hardware testing, instant feedback",
    description: "Mathematical shading-to-depth heuristic for instant feedback without downloading neural weights.",
    hardwareReq: "No GPU Required (Instant CPU)",
    isDefault: false,
  },
];

/**
 * ModelSelector Component
 * 
 * Provides model selection dropdown, backend availability, and model details,
 * backend availability status synchronization, and model comparison triggering.
 *
 * @param {Object} props
 * @param {string} props.currentModel - Currently selected model ID
 * @param {Function} props.onModelChange - Callback triggered when model changes (modelId, modelObj) => void
 * @param {Function} props.onCompareRequest - Callback to trigger side-by-side comparison modal/view
 */
function ModelSelector({ currentModel = "depth-anything-v2-small", onModelChange, onCompareRequest, disabled = false }) {
  const [selectedId, setSelectedId] = useState(currentModel);
  const [availableModelIds, setAvailableModelIds] = useState(new Set());
  const [modelDetails, setModelDetails] = useState(new Map());
  const [recommendedId, setRecommendedId] = useState("depth-anything-v2-small");
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredModel, setHoveredModel] = useState(null);
  const [backendStatus, setBackendStatus] = useState("checking"); // 'checking' | 'loaded' | 'offline'
  const [switching, setSwitching] = useState(false);

  // Sync external currentModel changes with internal state
  useEffect(() => {
    if (currentModel && currentModel !== selectedId) {
      setSelectedId(currentModel);
    }
  }, [currentModel]);

  // Query the backend model registry. The API returns { models, current_model }.
  useEffect(() => {
    let isMounted = true;
    const fetchAvailableModels = async () => {
      try {
        const res = await apiFetch("/api/models");
        if (res.ok) {
          const data = await res.json();
          if (isMounted) {
            const registry = normalizeModelRegistry(data);
            setAvailableModelIds(registry.availableModelIds);
            setModelDetails(registry.modelDetails);
            if (registry.recommendedModel) setRecommendedId(registry.recommendedModel);
            setBackendStatus("loaded");
          }
        } else {
          // If /api/models is not explicitly implemented, check /health
          const healthRes = await apiFetch("/api/health");
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            if (isMounted) {
              setBackendStatus("loaded");
              const healthModelId = healthData.model_id;
              if (typeof healthModelId === "string" && MODEL_CATALOG.some((model) => model.id === healthModelId)) {
                setAvailableModelIds(new Set([healthModelId]));
                setModelDetails(new Map([[healthModelId, { available: true, weights_cached: true }]]));
              }
            }
          } else {
            if (isMounted) setBackendStatus("offline");
          }
        }
      } catch (err) {
        if (isMounted) {
          setBackendStatus("offline");
          // Leave unavailable choices disabled when the registry cannot be read.
        }
      }
    };

    fetchAvailableModels();
    return () => {
      isMounted = false;
    };
  }, []);

  // Find active model details
  const activeModel = useMemo(() => {
    return MODEL_CATALOG.find((m) => m.id === selectedId) || MODEL_CATALOG[0];
  }, [selectedId]);

  // Handle selection
  const handleSelect = async (model) => {
    if (disabled || switching || !availableModelIds.has(model.id) || model.id === selectedId) return;
    setSwitching(true);
    try {
      const succeeded = onModelChange ? await onModelChange(model.id, model) : true;
      if (succeeded !== false) {
        setSelectedId(model.id);
        setIsOpen(false);
      }
    } finally {
      setSwitching(false);
    }
  };

  const handleCompareClick = () => {
    if (onCompareRequest) {
      onCompareRequest(selectedId, activeModel);
    }
  };

  return (
    <div className="model-selector-container">
      {/* ── Main Bar ── */}
      <div className="model-selector-bar">
        <div className="model-selector-left">
          <span className="selector-label">
            <span className="sparkle-icon">✨</span> Depth Model:
          </span>

          {/* Custom Styled Dropdown trigger */}
          <div className="custom-select-wrapper">
            <button
              type="button"
              className={`select-trigger ${isOpen ? "open" : ""}`}
              disabled={disabled || switching || backendStatus !== "loaded"}
              onClick={() => setIsOpen(!isOpen)}
              aria-expanded={isOpen}
              aria-haspopup="listbox"
            >
              <div className="trigger-content">
                <span className="model-speed-badge" title={`Inference Speed: ${activeModel.speedText}`}>
                  {activeModel.speedIcon}
                </span>
                <span className="model-active-name">{activeModel.name}</span>
                <span className="model-accuracy-stars" title="Depth output type">
                  {activeModel.accuracyText}
                </span>
                {activeModel.id === recommendedId && (
                  <span className="recommended-pill" title="Recommended for this system">
                    ★ Recommended
                  </span>
                )}
              </div>
              <span className="select-arrow">{isOpen ? "▲" : "▼"}</span>
            </button>

            {/* Dropdown Menu */}
            {isOpen && (
              <>
                <div className="select-backdrop" onClick={() => setIsOpen(false)} />
                <div className="dropdown-menu" role="listbox">
                  <div className="dropdown-header">
                    <span>Depth model options</span>
                    <span className="dropdown-count">{MODEL_CATALOG.length} options</span>
                  </div>

                  <div className="dropdown-items-list">
                    {MODEL_CATALOG.map((model) => {
                      const isAvailable = availableModelIds.has(model.id);
                      const isSelected = model.id === selectedId;
                      const isRec = model.id === recommendedId;

                      return (
                        <button
                          type="button"
                          key={model.id}
                          role="option"
                          aria-selected={isSelected}
                          className={`dropdown-option ${isSelected ? "selected" : ""} ${
                            !isAvailable || disabled || switching ? "disabled" : ""
                          }`}
                          aria-disabled={!isAvailable || disabled || switching}
                          disabled={!isAvailable || disabled || switching}
                          onClick={() => handleSelect(model)}
                          onMouseEnter={() => setHoveredModel(model)}
                          onMouseLeave={() => setHoveredModel(null)}
                        >
                          <div className="option-primary">
                            <div className="option-name-row">
                              <span className="option-speed-icon">{model.speedIcon}</span>
                              <span className="option-name">{model.name}</span>
                              {isRec && <span className="option-badge rec">Best Pick</span>}
                              {!isAvailable && <span className="option-badge unavail">Unavailable</span>}
                              {isAvailable && modelDetails.get(model.id)?.weights_cached === false && (
                                <span className="option-badge">Download on first use</span>
                              )}
                            </div>
                            <div className="option-desc">
                              {isAvailable
                                ? model.bestFor
                                : modelDetails.get(model.id)?.unavailable_reason || "Unavailable on this server."}
                            </div>
                          </div>

                          <div className="option-meta">
                            <span className="option-params">{model.params}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Compare Models Action ── */}
        <div className="model-selector-actions">
          <button
            type="button"
            className="compare-models-btn"
            onClick={handleCompareClick}
            disabled={disabled || !onCompareRequest}
            title="Compare inference output across multiple depth models side-by-side"
          >
            <span className="compare-icon">⚡</span>
            <span>Compare Models</span>
          </button>
        </div>
      </div>

      {switching && (
        <p className="model-switch-status" role="status">
          Loading the selected model and processing this image. First use may take a few minutes while model weights download.
        </p>
      )}

      {/* ── Active / Hovered Model Info Card (Rich Details) ── */}
      {(() => {
        const displayed = hoveredModel || activeModel;
        return (
          <div className="model-info-card">
            <div className="info-card-header">
              <div className="info-title-group">
                <span className="info-family">{displayed.family}</span>
                <h4 className="info-title">{displayed.name}</h4>
                <span className="info-variant-tag">{displayed.variant}</span>
              </div>

              <div className="info-badges-group">
                <span className={`speed-pill speed-${displayed.speed}`}>
                  {displayed.speedIcon} {displayed.speedText}
                </span>
                <span className="stars-pill" title="Depth output type">
                  {displayed.accuracyText}
                </span>
                <span className="params-pill">⚙ {displayed.params}</span>
              </div>
            </div>

            <p className="info-description">{displayed.description}</p>

            <div className="info-footer">
              <div className="info-spec">
                <strong>Architecture:</strong> <span>{displayed.architecture}</span>
              </div>
              <div className="info-spec">
                <strong>Optimal For:</strong> <span>{displayed.bestFor}</span>
              </div>
              <div className="info-spec">
                <strong>Hardware:</strong> <span>{displayed.hardwareReq}</span>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default ModelSelector;
