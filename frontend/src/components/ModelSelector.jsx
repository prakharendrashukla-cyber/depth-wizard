import React, { useState, useEffect, useMemo } from "react";
import "./ModelSelector.css";

/**
 * Model catalog metadata for monocular depth estimation models.
 */
export const MODEL_CATALOG = [
  {
    id: "depth_anything_v2_vits",
    name: "Depth Anything V2 Small",
    family: "Depth Anything V2",
    variant: "ViT-S",
    params: "24.8M",
    speed: "fast",
    speedIcon: "⚡",
    speedText: "Fast (~35ms)",
    stars: 3,
    accuracyText: "High Quality",
    architecture: "Vision Transformer (ViT-Small) + DPT Head",
    bestFor: "Real-time interactive 3D, fast preview, low-latency drone inspection",
    description: "Lightweight foundational depth model optimized for speed with exceptional boundary preservation and sharp crater rims.",
    hardwareReq: "CPU or GPU (>=2GB VRAM)",
    isDefault: true,
  },
  {
    id: "depth_anything_v2_vitb",
    name: "Depth Anything V2 Base",
    family: "Depth Anything V2",
    variant: "ViT-B",
    params: "97.5M",
    speed: "medium",
    speedIcon: "🔄",
    speedText: "Medium (~90ms)",
    stars: 4,
    accuracyText: "Very High",
    architecture: "Vision Transformer (ViT-Base) + Multi-scale Neck",
    bestFor: "Balanced topography reconstruction, satellite elevation mapping",
    description: "High-accuracy transformer model with fine structural detail, minimal artifacts, and smooth surface gradients.",
    hardwareReq: "GPU Recommended (>=4GB VRAM)",
    isDefault: false,
  },
  {
    id: "depth_anything_v2_vitl",
    name: "Depth Anything V2 Large",
    family: "Depth Anything V2",
    variant: "ViT-L",
    params: "335.3M",
    speed: "slow",
    speedIcon: "🐢",
    speedText: "Slow (~240ms)",
    stars: 5,
    accuracyText: "Ultra Resolution",
    architecture: "Vision Transformer (ViT-Large) + DPT",
    bestFor: "Maximum detail satellite lunar crater analysis, publication-grade DEM",
    description: "State-of-the-art depth fidelity with rich micro-relief and sharp edge definition for deep planetary craters.",
    hardwareReq: "NVIDIA GPU Required (>=8GB VRAM)",
    isDefault: false,
  },
  {
    id: "midas_v31_small",
    name: "MiDaS v3.1 Small",
    family: "MiDaS",
    variant: "MobileNet-v2",
    params: "21.4M",
    speed: "fast",
    speedIcon: "⚡",
    speedText: "Fast (~28ms)",
    stars: 2,
    accuracyText: "Standard",
    architecture: "MobileNetV2 + DPT Residual Head",
    bestFor: "Edge devices, ultra-low resource environments, quick rough contours",
    description: "Classical monocular depth estimator trained on diverse multi-dataset mixtures for general scenes.",
    hardwareReq: "Any CPU / Mobile / WebAssembly",
    isDefault: false,
  },
  {
    id: "midas_v31_large",
    name: "MiDaS v3.1 Large",
    family: "MiDaS",
    variant: "BEiT-L-512",
    params: "345M",
    speed: "slow",
    speedIcon: "🐢",
    speedText: "Slow (~280ms)",
    stars: 4,
    accuracyText: "High Fidelity",
    architecture: "BEiT-Large + Multi-scale Decoder",
    bestFor: "Complex scenes with mixed indoor/outdoor depth ranges and urban structures",
    description: "Robust multi-domain relative depth estimation using large-scale transformer backbone.",
    hardwareReq: "GPU (>=6GB VRAM)",
    isDefault: false,
  },
  {
    id: "zoedepth_metric",
    name: "ZoeDepth (Metric)",
    family: "ZoeDepth",
    variant: "NK (Metric)",
    params: "348M",
    speed: "slow",
    speedIcon: "🐢",
    speedText: "Slow (~310ms)",
    stars: 5,
    accuracyText: "Metric Absolute",
    architecture: "Metric ZoeDepth ViT + Multi-bin Head",
    bestFor: "Direct metric scale height measurements in meters without manual calibration",
    description: "Zero-shot metric depth estimation outputting calibrated physical distances in metric units.",
    hardwareReq: "GPU Required (>=8GB VRAM)",
    isDefault: false,
  },
  {
    id: "metric3d",
    name: "Metric3D",
    family: "Metric3D",
    variant: "ViT-g Large",
    params: "450M",
    speed: "slow",
    speedIcon: "🐢",
    speedText: "Slow (~380ms)",
    stars: 5,
    accuracyText: "Sub-millimeter",
    architecture: "Canonical Camera Space Transformation",
    bestFor: "Geodetic survey accuracy, true physical camera focal length modeling",
    description: "High-precision metric depth with explicit focal-length unprojection for geographic survey datasets.",
    hardwareReq: "High-end GPU (>=12GB VRAM)",
    isDefault: false,
  },
  {
    id: "procedural",
    name: "Procedural Fallback",
    family: "Procedural",
    variant: "Sobel + FFT",
    params: "0M (CPU)",
    speed: "fast",
    speedIcon: "⚡",
    speedText: "Instant (~5ms)",
    stars: 1,
    accuracyText: "Synthetic",
    architecture: "Luminance Gradient + Multi-frequency FFT",
    bestFor: "Offline mode without GPU/model weights, hardware testing, instant feedback",
    description: "Mathematical shading-to-depth heuristic for instant feedback without downloading neural weights.",
    hardwareReq: "No GPU Required (Instant CPU)",
    isDefault: false,
  },
];

/**
 * Renders star rating representation (e.g. ★★★☆☆).
 */
const renderStars = (count) => {
  const full = "★".repeat(Math.max(0, Math.min(5, count)));
  const empty = "☆".repeat(Math.max(0, 5 - count));
  return `${full}${empty}`;
};

/**
 * ModelSelector Component
 * 
 * Provides model selection dropdown, rich detail cards, speed/accuracy badges,
 * backend availability status synchronization, and model comparison triggering.
 *
 * @param {Object} props
 * @param {string} props.currentModel - Currently selected model ID
 * @param {Function} props.onModelChange - Callback triggered when model changes (modelId, modelObj) => void
 * @param {Function} props.onCompareRequest - Callback to trigger side-by-side comparison modal/view
 */
function ModelSelector({ currentModel = "depth_anything_v2_vits", onModelChange, onCompareRequest }) {
  const [selectedId, setSelectedId] = useState(currentModel);
  const [availableModelIds, setAvailableModelIds] = useState(new Set(MODEL_CATALOG.map((m) => m.id)));
  const [recommendedId, setRecommendedId] = useState("depth_anything_v2_vits");
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredModel, setHoveredModel] = useState(null);
  const [backendStatus, setBackendStatus] = useState("checking"); // 'checking' | 'loaded' | 'offline'

  // Sync external currentModel changes with internal state
  useEffect(() => {
    if (currentModel && currentModel !== selectedId) {
      setSelectedId(currentModel);
    }
  }, [currentModel]);

  // Query backend /api/models to detect available models & recommended model
  useEffect(() => {
    let isMounted = true;
    const fetchAvailableModels = async () => {
      try {
        const res = await fetch("/api/models");
        if (res.ok) {
          const data = await res.json();
          if (isMounted) {
            if (Array.isArray(data.available_models)) {
              setAvailableModelIds(new Set(data.available_models));
            }
            if (data.recommended) {
              setRecommendedId(data.recommended);
            }
            if (data.active_model) {
              setSelectedId(data.active_model);
            }
            setBackendStatus("loaded");
          }
        } else {
          // If /api/models is not explicitly implemented, check /health
          const healthRes = await fetch("/api/health");
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            if (isMounted) {
              setBackendStatus("loaded");
              if (healthData.model) {
                // Keep catalog models active
              }
            }
          } else {
            if (isMounted) setBackendStatus("offline");
          }
        }
      } catch (err) {
        if (isMounted) {
          setBackendStatus("offline");
          // Fallback: keep standard models available
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
  const handleSelect = (model) => {
    const isAvailable = availableModelIds.has(model.id);
    if (!isAvailable) return;
    setSelectedId(model.id);
    setIsOpen(false);
    if (onModelChange) {
      onModelChange(model.id, model);
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
              onClick={() => setIsOpen(!isOpen)}
              aria-expanded={isOpen}
              aria-haspopup="listbox"
            >
              <div className="trigger-content">
                <span className="model-speed-badge" title={`Inference Speed: ${activeModel.speedText}`}>
                  {activeModel.speedIcon}
                </span>
                <span className="model-active-name">{activeModel.name}</span>
                <span className="model-accuracy-stars" title={`Accuracy: ${activeModel.accuracyText}`}>
                  {renderStars(activeModel.stars)}
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
                    <span>Available Neural Depth Architectures</span>
                    <span className="dropdown-count">{MODEL_CATALOG.length} models</span>
                  </div>

                  <div className="dropdown-items-list">
                    {MODEL_CATALOG.map((model) => {
                      const isAvailable = availableModelIds.has(model.id);
                      const isSelected = model.id === selectedId;
                      const isRec = model.id === recommendedId;

                      return (
                        <div
                          key={model.id}
                          role="option"
                          aria-selected={isSelected}
                          className={`dropdown-option ${isSelected ? "selected" : ""} ${
                            !isAvailable ? "disabled" : ""
                          }`}
                          onClick={() => handleSelect(model)}
                          onMouseEnter={() => setHoveredModel(model)}
                          onMouseLeave={() => setHoveredModel(null)}
                        >
                          <div className="option-primary">
                            <div className="option-name-row">
                              <span className="option-speed-icon">{model.speedIcon}</span>
                              <span className="option-name">{model.name}</span>
                              {isRec && <span className="option-badge rec">Best Pick</span>}
                              {!isAvailable && <span className="option-badge unavail">Weight Missing</span>}
                            </div>
                            <div className="option-desc">{model.bestFor}</div>
                          </div>

                          <div className="option-meta">
                            <span className="option-stars">{renderStars(model.stars)}</span>
                            <span className="option-params">{model.params}</span>
                          </div>
                        </div>
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
            title="Compare inference output across multiple depth models side-by-side"
          >
            <span className="compare-icon">⚡</span>
            <span>Compare Models</span>
          </button>
        </div>
      </div>

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
                <span className="stars-pill" title={`Accuracy Rating: ${displayed.accuracyText}`}>
                  {renderStars(displayed.stars)} ({displayed.accuracyText})
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
