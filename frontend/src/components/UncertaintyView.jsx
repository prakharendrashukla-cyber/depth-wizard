import { apiFetch } from "../api";
/**
 * Depth Wizard — UncertaintyView Component
 *
 * Epistemic & Aleatoric Uncertainty Estimation Suite for Monocular Depth Maps.
 * Computes pixel-wise confidence maps from repeated augmented image inference
 * and highlights regions with low pass-to-pass confidence.
 */

import React, { useState, useMemo, useEffect, useCallback } from "react";
import "./UncertaintyView.css";

export default function UncertaintyView({
  originalImageBase64 = null,
  depthMapBase64 = null,
  onUncertaintyComputed = null,
}) {
  // State
  const [activeTab, setActiveTab] = useState("confidence"); // "original" | "depth" | "confidence" | "unreliable" | "blend"
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const [uncertaintyData, setUncertaintyData] = useState(null);
  const [threshold, setThreshold] = useState(60); // Confidence cutoff %
  const [blendAlpha, setBlendAlpha] = useState(0.65);
  const [error, setError] = useState(null);

  // Formatted data URLs
  const originalSrc = useMemo(() => {
    if (!originalImageBase64) return null;
    return originalImageBase64.startsWith("data:")
      ? originalImageBase64
      : `data:image/png;base64,${originalImageBase64}`;
  }, [originalImageBase64]);

  const depthSrc = useMemo(() => {
    if (!depthMapBase64) return null;
    return depthMapBase64.startsWith("data:")
      ? depthMapBase64
      : `data:image/png;base64,${depthMapBase64}`;
  }, [depthMapBase64]);

  useEffect(() => {
    const valuesSrc = uncertaintyData?.confidenceValuesBase64;
    if (!valuesSrc) return;

    const confidenceImage = new Image();
    confidenceImage.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = confidenceImage.naturalWidth;
      canvas.height = confidenceImage.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(confidenceImage, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = canvas.width;
      maskCanvas.height = canvas.height;
      const maskCtx = maskCanvas.getContext("2d");
      if (!maskCtx) return;
      const mask = maskCtx.createImageData(canvas.width, canvas.height);
      let unreliablePixels = 0;
      for (let i = 0; i < pixels.data.length; i += 4) {
        if (pixels.data[i] / 255 * 100 < threshold) {
          mask.data[i] = 248;
          mask.data[i + 1] = 81;
          mask.data[i + 2] = 73;
          mask.data[i + 3] = 180;
          unreliablePixels++;
        }
      }
      maskCtx.putImageData(mask, 0, 0);
      const areaPercent = Number((unreliablePixels / (canvas.width * canvas.height) * 100).toFixed(1));
      setUncertaintyData((current) => current?.confidenceValuesBase64 === valuesSrc
        ? { ...current, unreliableMaskBase64: maskCanvas.toDataURL("image/png"), stats: { ...current.stats, unreliableAreaPercent: areaPercent } }
        : current);
    };
    confidenceImage.src = valuesSrc;
  }, [uncertaintyData?.confidenceValuesBase64, threshold]);

  // ── Compute Uncertainty Handler ─────────────────────────────────────────
  const handleComputeUncertainty = useCallback(async () => {
    if (!originalImageBase64) {
      setError("Process or upload an image before computing uncertainty.");
      return;
    }
    setLoading(true);
    setError(null);
    setLoadingStep("Preparing five augmented inference passes...");
    const step1Timer = setTimeout(() => {
      setLoadingStep("Perturbing image inputs and evaluating depth variance...");
    }, 700);
    const step2Timer = setTimeout(() => {
      setLoadingStep("Computing pixel-wise confidence distribution...");
    }, 1400);

    try {
      const source = originalImageBase64.startsWith("data:")
        ? originalImageBase64
        : `data:image/png;base64,${originalImageBase64}`;
      const imageBlob = await fetch(source).then((response) => response.blob());
      const form = new FormData();
      form.append("image", imageBlob, "scene.png");

      const res = await apiFetch("/api/uncertainty", {
        method: "POST",
        body: form,
      });

      const data = await res.json();
      if (!data.confidenceMapBase64 || !data.confidenceValuesBase64 || !data.stats) {
        throw new Error("The uncertainty service returned an incomplete result.");
      }
      setUncertaintyData(data);
      if (onUncertaintyComputed) onUncertaintyComputed(data);
    } catch (err) {
      if (err.status === 401) return;
      setError(err.message);
      setUncertaintyData(null);
    } finally {
      clearTimeout(step1Timer);
      clearTimeout(step2Timer);
      setLoading(false);
      setLoadingStep("");
    }
  }, [originalImageBase64, onUncertaintyComputed]);

  // Stats
  const stats = uncertaintyData?.stats;

  return (
    <div className="uncertainty-view-wrapper">
      {/* ── Header & Action Bar ── */}
      <div className="uncertainty-header">
        <div className="header-title-group">
          <div className="title-row">
            <span className="shield-icon">🛡️</span>
            <h3>Confidence & Uncertainty Estimation</h3>
          </div>
          <p className="header-desc">
            Five augmented inference passes show where depth predictions vary across the input.
          </p>
        </div>

        <div className="header-actions">
          <button
            className={`compute-btn ${loading ? "is-loading" : ""}`}
            onClick={handleComputeUncertainty}
            disabled={loading}
          >
            {loading ? "⏳ Computing..." : "✨ Compute Uncertainty Map"}
          </button>
        </div>
      </div>

      {/* ── Loading Animation Banner ── */}
      {loading && (
        <div className="loading-card">
          <div className="loading-spinner" />
          <div className="loading-info">
            <strong className="loading-main">Running multiple inference passes...</strong>
            <span className="loading-step">{loadingStep}</span>
          </div>
          <div className="loading-progress-bar">
            <div className="progress-bar-inner" />
          </div>
        </div>
      )}

      {error && <div className="uncertainty-error-bar">⚠️ {error}</div>}

      {/* ── Main Workspace ── */}
      {uncertaintyData ? (
        <div className="uncertainty-content">
          {/* Top Tabs & Control Bar */}
          <div className="view-mode-bar">
            <div className="tab-group">
              <button
                className={`tab-btn ${activeTab === "confidence" ? "active" : ""}`}
                onClick={() => setActiveTab("confidence")}
              >
                🎯 Confidence Map
              </button>
              <button
                className={`tab-btn ${activeTab === "unreliable" ? "active" : ""}`}
                onClick={() => setActiveTab("unreliable")}
              >
                ⚠️ Unreliable Regions
              </button>
              <button
                className={`tab-btn ${activeTab === "blend" ? "active" : ""}`}
                onClick={() => setActiveTab("blend")}
              >
                🔀 Blend Overlay
              </button>
              <button
                className={`tab-btn ${activeTab === "depth" ? "active" : ""}`}
                onClick={() => setActiveTab("depth")}
              >
                🔥 Depth Map
              </button>
              <button
                className={`tab-btn ${activeTab === "original" ? "active" : ""}`}
                onClick={() => setActiveTab("original")}
              >
                📷 Original Image
              </button>
            </div>

            {/* Threshold & Blend Controls */}
            <div className="control-group">
              {activeTab === "blend" && (
                <div className="slider-control">
                  <span className="slider-label">Blend Alpha: {Math.round(blendAlpha * 100)}%</span>
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={blendAlpha}
                    onChange={(e) => setBlendAlpha(parseFloat(e.target.value))}
                    className="slider-input"
                  />
                </div>
              )}

              <div className="slider-control">
                <span className="slider-label">Cutoff: &lt; {threshold}%</span>
                <input
                  type="range"
                  min="30"
                  max="90"
                  step="5"
                  value={threshold}
                  onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
                  className="slider-input"
                />
              </div>
            </div>
          </div>

          {/* ── Image Viewer Canvas ── */}
          <div className="image-viewer-container">
            {/* View 1: Confidence Map */}
            {activeTab === "confidence" && (
              <div className="viewer-frame">
                <img
                  src={uncertaintyData.confidenceMapBase64}
                  alt="Confidence Heatmap"
                  className="viewer-img"
                />
                <div className="viewer-badge badge-green">🎯 Pixel Confidence Heatmap</div>
              </div>
            )}

            {/* View 2: Unreliable Regions */}
            {activeTab === "unreliable" && (
              <div className="viewer-frame stacked-frame">
                {/* Background original image */}
                {originalSrc && (
                  <img src={originalSrc} alt="Base Scene" className="viewer-img base-layer" />
                )}
                {/* Red mask overlay */}
                <img
                  src={uncertaintyData.unreliableMaskBase64}
                  alt="Unreliable Mask"
                  className="viewer-img mask-layer"
                />
                <div className="viewer-badge badge-red">
                  ⚠️ Flagged High-Uncertainty Regions (&lt; {threshold}%)
                </div>
              </div>
            )}

            {/* View 3: Blend Overlay */}
            {activeTab === "blend" && (
              <div className="viewer-frame stacked-frame">
                {originalSrc && (
                  <img src={originalSrc} alt="Base Scene" className="viewer-img base-layer" />
                )}
                <img
                  src={uncertaintyData.confidenceMapBase64}
                  alt="Confidence Blend"
                  className="viewer-img overlay-layer"
                  style={{ opacity: blendAlpha }}
                />
                <div className="viewer-badge badge-blue">
                  🔀 Multi-Layer Confidence Blend ({Math.round(blendAlpha * 100)}%)
                </div>
              </div>
            )}

            {/* View 4: Depth Map */}
            {activeTab === "depth" && (
              <div className="viewer-frame">
                {depthSrc ? (
                  <img src={depthSrc} alt="Depth Map" className="viewer-img" />
                ) : (
                  <div className="no-img-msg">No depth map available</div>
                )}
                <div className="viewer-badge badge-purple">🔥 Estimated Depth Colormap</div>
              </div>
            )}

            {/* View 5: Original Image */}
            {activeTab === "original" && (
              <div className="viewer-frame">
                {originalSrc ? (
                  <img src={originalSrc} alt="Original Image" className="viewer-img" />
                ) : (
                  <div className="no-img-msg">No original image available</div>
                )}
                <div className="viewer-badge badge-gray">📷 2D Monocular Input</div>
              </div>
            )}
          </div>

          {/* ── Gradient Color Legend Bar ── */}
          <div className="legend-panel">
            <div className="legend-header">
              <span className="legend-label">Confidence Scale:</span>
              <span className="legend-status">
                Mean Reliability: <strong>{stats ? `${stats.meanConfidence}%` : "—"}</strong>
              </span>
            </div>
            <div className="gradient-bar-wrapper">
              <div className="gradient-bar" />
              <div
                className="threshold-marker"
                style={{ left: `${threshold}%` }}
                title={`Active Unreliable Cutoff (${threshold}%)`}
              >
                <span className="marker-tag">Threshold: {threshold}%</span>
                <div className="marker-pin" />
              </div>
            </div>
            <div className="legend-ticks">
              <span>0% (High Variance / Uncertain)</span>
              <span>25%</span>
              <span>50% (Moderate)</span>
              <span>75%</span>
              <span>100% (High Confidence)</span>
            </div>
          </div>

          {/* ── Stats Cards Panel ── */}
          {stats && (
            <div className="uncertainty-stats-grid">
              {/* Mean Confidence */}
              <div className="ustatt-card highlight-green">
                <span className="ustatt-icon">🛡️</span>
                <div className="ustatt-info">
                  <span className="ustatt-title">Mean Confidence</span>
                  <span className="ustatt-value text-green">{stats.meanConfidence}%</span>
                  <span className="ustatt-sub">Ensemble consensus</span>
                </div>
              </div>

              {/* Unreliable Area */}
              <div className="ustatt-card highlight-red">
                <span className="ustatt-icon">⚠️</span>
                <div className="ustatt-info">
                  <span className="ustatt-title">Unreliable Area</span>
                  <span className="ustatt-value text-red">{stats.unreliableAreaPercent}%</span>
                  <span className="ustatt-sub">Pixels &lt; {threshold}% confidence</span>
                </div>
              </div>

              {/* Min Confidence */}
              <div className="ustatt-card">
                <span className="ustatt-icon">📉</span>
                <div className="ustatt-info">
                  <span className="ustatt-title">Min Confidence</span>
                  <span className="ustatt-value">{stats.minConfidence}%</span>
                  <span className="ustatt-sub">Highest variance region</span>
                </div>
              </div>

              {/* Max Confidence */}
              <div className="ustatt-card">
                <span className="ustatt-icon">📈</span>
                <div className="ustatt-info">
                  <span className="ustatt-title">Max Confidence</span>
                  <span className="ustatt-value text-cyan">{stats.maxConfidence}%</span>
                  <span className="ustatt-sub">Planar & textured surfaces</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Region Risk Breakdown Drawer ── */}
          <div className="diagnostics-panel">
            <div className="diag-header">
              <span>🔍 Uncertainty Anomaly Diagnostics</span>
            </div>
            <div className="diag-grid">
              <div className="diag-item">
                <span className="diag-bullet text-purple">●</span>
                <div className="diag-desc">
                  <strong>Pass-to-pass disagreement:</strong> Lower confidence appears in red in the confidence map.
                </div>
              </div>
              <div className="diag-item">
                <span className="diag-bullet text-cyan">●</span>
                <div className="diag-desc">
                  <strong>Unreliable area:</strong> The red mask updates with the selected confidence cutoff.
                </div>
              </div>
              <div className="diag-item">
                <span className="diag-bullet text-green">●</span>
                <div className="diag-desc">
                  <strong>Interpretation:</strong> This measures consistency across augmented inputs; it is not a ground-truth accuracy score.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Empty State / Call to Action */
        <div className="empty-uncertainty-state">
          <div className="empty-icon">🛡️</div>
          <h4>Estimate Prediction Confidence</h4>
          <p>
            Click "Compute Uncertainty Map" to run five augmented inference passes and compare their depth predictions.
          </p>
          <button className="compute-btn large" onClick={handleComputeUncertainty}>
            ✨ Compute Uncertainty Map
          </button>
        </div>
      )}
    </div>
  );
}
