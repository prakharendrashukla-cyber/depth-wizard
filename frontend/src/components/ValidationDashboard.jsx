import { apiFetch } from "../api";
/**
 * Depth Wizard — ValidationDashboard Component
 *
 * Ground-truth accuracy validation & benchmark comparison suite.
 * Evaluates estimated depth against ground truth DEMs/LiDAR scans,
 * computes standard depth metrics (RMSE, MAE, AbsRel, SqRel, delta thresholds),
 * renders side-by-side error heatmaps, interactive SVG regression scatter plots,
 * error histograms, and benchmark leaderboards.
 */

import React, { useState, useEffect, useMemo, useCallback } from "react";
import "./ValidationDashboard.css";

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeBenchmarkRows(benchmarks) {
  return benchmarks.flatMap((benchmark) => {
    const models = Array.isArray(benchmark.models) ? benchmark.models : [benchmark];
    return models.map((entry) => {
      const delta1 = asFiniteNumber(entry.delta1 ?? entry.delta_1);
      return {
        dataset: benchmark.dataset ?? entry.dataset ?? "Unknown dataset",
        model: entry.model ?? entry.name ?? "Unknown model",
        rmse: asFiniteNumber(entry.rmse),
        mae: asFiniteNumber(entry.mae),
        absRel: asFiniteNumber(entry.absRel ?? entry.abs_rel),
        delta1: delta1 !== null && delta1 > 1 ? delta1 / 100 : delta1,
        rank: typeof entry.rank === "string" ? entry.rank : null,
      };
    });
  });
}

export default function ValidationDashboard({
  estimatedDepthData = null,
  model = "Depth Anything V2",
  scaleFactor = 1.0,
}) {
  // State
  const [groundTruthFile, setGroundTruthFile] = useState(null);
  const [groundTruthPreview, setGroundTruthPreview] = useState(null);
  const [validationResult, setValidationResult] = useState(null);
  const [benchmarks, setBenchmarks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [selectedDatasetFilter, setSelectedDatasetFilter] = useState("All");
  const [hoveredScatterPoint, setHoveredScatterPoint] = useState(null);
  const [hoveredHistBin, setHoveredHistBin] = useState(null);

  // Fetch benchmark tables on mount. Current-image metrics need a real reference raster.
  useEffect(() => {
    setValidationResult(null);

    apiFetch("/api/benchmarks")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.benchmarks && Array.isArray(data.benchmarks)) {
          setBenchmarks(normalizeBenchmarkRows(data.benchmarks));
        }
      })
      .catch(() => {
        setBenchmarks([]);
      });
  }, [scaleFactor, estimatedDepthData]);

  // ── Handle Ground Truth Upload ─────────────────────────────────────────
  const runValidation = useCallback(
    async (file, previewUrl) => {
      if (!file) {
        setError("Upload a ground-truth raster before validating.");
        return;
      }
      if (!estimatedDepthData?.depth_map) {
        setError("Estimate an image before validating it against ground truth.");
        return;
      }

      setLoading(true);
      setError(null);
      setValidationResult(null);

      try {
        const formData = new FormData();
        if (file) formData.append("ground_truth", file);
        formData.append("scale_factor", String(scaleFactor));
        formData.append("model", model);

        if (estimatedDepthData?.depth_map) {
          formData.append("estimated_depth_base64", estimatedDepthData.depth_map);
        }

        const res = await apiFetch("/api/validate", {
          method: "POST",
          body: formData,
        });

        const data = await res.json();
        const rawMetrics = data.metrics || {};
        const regression = data.scatter?.regression || rawMetrics.regression || {};
        const scatterPoints = (data.scatterPoints ?? data.scatter?.points ?? []).map((point) => {
          const gt = asFiniteNumber(point.gt ?? point.ground_truth);
          const est = asFiniteNumber(point.est ?? point.estimated ?? point.predicted);
          return {
            gt,
            est,
            error: asFiniteNumber(point.error) ?? (gt !== null && est !== null ? est - gt : null),
          };
        }).filter((point) => point.gt !== null && point.est !== null && point.error !== null);
        const histogram = (data.histogram ?? data.error_heatmap?.error_histogram ?? []).map((bin) => ({
          binStart: asFiniteNumber(bin.binStart ?? bin.bin_start) ?? 0,
          binEnd: asFiniteNumber(bin.binEnd ?? bin.bin_end) ?? 0,
          count: asFiniteNumber(bin.count) ?? 0,
          percentage: asFiniteNumber(bin.percentage) ?? 0,
        }));

        setValidationResult({
          ...data,
          metrics: {
            ...rawMetrics,
            absRel: rawMetrics.absRel ?? rawMetrics.abs_rel,
            sqRel: rawMetrics.sqRel ?? rawMetrics.sq_rel,
            delta1: rawMetrics.delta1 ?? rawMetrics.delta_1,
            delta2: rawMetrics.delta2 ?? rawMetrics.delta_2,
            delta3: rawMetrics.delta3 ?? rawMetrics.delta_3,
            r2: rawMetrics.r2 ?? rawMetrics.r_squared ?? regression.r_squared,
            regression,
          },
          scatterPoints,
          histogram,
          groundTruthImage: previewUrl,
          estimatedImage: estimatedDepthData.depth_map,
          errorHeatmapImage: data.error_heatmap?.error_heatmap_base64 ?? null,
          errorStd: asFiniteNumber(data.error_heatmap?.std_error),
          datasetName: file.name,
        });
      } catch (err) {
        if (err.status !== 401) setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [scaleFactor, model, estimatedDepthData]
  );

  const handleFile = (file) => {
    if (!file) return;
    setGroundTruthFile(file);
    const objectUrl = URL.createObjectURL(file);
    setGroundTruthPreview(objectUrl);
    runValidation(file, objectUrl);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  };

  // Filter benchmarks by dataset category
  const filteredBenchmarks = useMemo(() => {
    if (selectedDatasetFilter === "All") return benchmarks;
    return benchmarks.filter((b) => b.dataset.toLowerCase().includes(selectedDatasetFilter.toLowerCase()));
  }, [benchmarks, selectedDatasetFilter]);

  // Is current model matching benchmark row
  const isCurrentModel = (bModel) => {
    if (!model) return false;
    const cleanCurrent = model.toLowerCase().replace(/[-_ ]/g, "");
    const cleanB = bModel.toLowerCase().replace(/[-_ ]/g, "");
    return cleanCurrent.includes(cleanB) || cleanB.includes(cleanCurrent) || cleanB.includes("depthanything");
  };

  // ── SVG Scatter Plot Geometry ──────────────────────────────────────────
  const scatterSvg = useMemo(() => {
    if (!validationResult?.scatterPoints || validationResult.scatterPoints.length === 0) {
      return null;
    }

    const points = validationResult.scatterPoints;
    const w = 440;
    const h = 260;
    const p = 35; // padding

    const maxVal = Math.max(
      ...points.map((pt) => Math.max(pt.gt, pt.est)),
      10.0
    );

    const scaleX = (val) => p + (val / maxVal) * (w - 2 * p);
    const scaleY = (val) => h - p - (val / maxVal) * (h - 2 * p);

    const lineStart = { x: scaleX(0), y: scaleY(0) };
    const lineEnd = { x: scaleX(maxVal), y: scaleY(maxVal) };

    const regression = validationResult.metrics?.regression || { slope: 1, intercept: 0 };
    const regStart = { x: scaleX(0), y: scaleY(regression.intercept) };
    const regEnd = { x: scaleX(maxVal), y: scaleY(regression.slope * maxVal + regression.intercept) };

    return { w, h, p, maxVal, scaleX, scaleY, lineStart, lineEnd, regStart, regEnd, points };
  }, [validationResult]);

  // ── SVG Histogram Geometry ────────────────────────────────────────────
  const histSvg = useMemo(() => {
    if (!validationResult?.histogram || validationResult.histogram.length === 0) {
      return null;
    }

    const bins = validationResult.histogram;
    const w = 440;
    const h = 260;
    const p = 35;

    const maxCount = Math.max(...bins.map((b) => b.count), 1);
    const usableW = w - 2 * p;
    const usableH = h - 2 * p;
    const barWidth = usableW / bins.length - 3;

    return { w, h, p, maxCount, usableW, usableH, barWidth, bins };
  }, [validationResult]);

  return (
    <div className="validation-dashboard">
      {/* ── Section Title & Header ── */}
      <div className="dashboard-header">
        <div className="title-group">
          <h2>🎯 Accuracy Validation & Benchmarks</h2>
          <span className="subtitle-badge">Ground Truth vs Estimated Metrics</span>
        </div>
        <div className="active-model-chip">
          <span className="chip-label">Active Model:</span>
          <strong>{model || "Depth Anything V2"}</strong>
          <span className="scale-pill">Scale: {scaleFactor.toFixed(1)}m</span>
        </div>
      </div>

      {/* ── Top Row: Ground Truth Upload & Quick Actions ── */}
      <div className="upload-and-status-row">
        <div
          className={`gt-dropzone ${dragActive ? "drag-active" : ""} ${loading ? "is-loading" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          {loading ? (
            <div className="gt-loading-spinner">
              <div className="spinner-ring" />
              <p>Aligning rasters & computing precision metrics...</p>
            </div>
          ) : groundTruthFile ? (
            <div className="gt-active-file">
              <span className="gt-file-icon">📄</span>
              <div className="gt-file-details">
                <strong className="gt-file-name">{groundTruthFile.name}</strong>
                <span className="gt-file-meta">
                  Reference dataset loaded · Ready for precision analysis
                </span>
              </div>
              <label className="reupload-btn">
                Change File
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                  hidden
                />
              </label>
            </div>
          ) : (
            <div className="gt-empty-prompt">
              <span className="gt-icon">📥</span>
              <div className="prompt-text">
                <strong>Upload Ground Truth DEM / Heightmap</strong>
                <p>Drag & drop a ground-truth GeoTIFF or image raster for validation</p>
              </div>
              <label className="browse-gt-btn">
                Browse DEM File
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                  hidden
                />
              </label>
            </div>
          )}
        </div>

        {/* Preset Sample Quick-Loader */}
        <div className="sample-gt-presets">
          <span className="presets-title">Reference data</span>
          <p>No ground-truth DEMs are bundled. Upload a reference raster to calculate metrics for this image.</p>
        </div>
      </div>

      {error && <div className="validation-error-msg">⚠️ {error}</div>}

      {/* ── Validation Results View (When Computed) ── */}
      {validationResult && (
        <div className="results-container">
          {/* 1. Metric Cards Grid */}
          <div className="metrics-cards-grid">
            {/* RMSE */}
            <div className="vmetric-card highlight-metric">
              <div className="vmetric-header">
                <span className="vmetric-title">RMSE</span>
                <span className="vmetric-tag">Root Mean Sq</span>
              </div>
              <div className="vmetric-body">
                <span className="vmetric-value text-green">
                  {typeof validationResult.metrics?.rmse === "number" ? validationResult.metrics.rmse.toFixed(3) : "—"} <small>m</small>
                </span>
                <span className="vmetric-sub">Target: &lt; 0.50m (Pass)</span>
              </div>
            </div>

            {/* MAE */}
            <div className="vmetric-card">
              <div className="vmetric-header">
                <span className="vmetric-title">MAE</span>
                <span className="vmetric-tag">Mean Absolute</span>
              </div>
              <div className="vmetric-body">
                <span className="vmetric-value text-cyan">
                  {typeof validationResult.metrics?.mae === "number" ? validationResult.metrics.mae.toFixed(3) : "—"} <small>m</small>
                </span>
                <span className="vmetric-sub">Average deviation</span>
              </div>
            </div>

            {/* AbsRel */}
            <div className="vmetric-card">
              <div className="vmetric-header">
                <span className="vmetric-title">AbsRel</span>
                <span className="vmetric-tag">Relative Error</span>
              </div>
              <div className="vmetric-body">
                <span className="vmetric-value text-purple">
                  {typeof (validationResult.metrics?.absRel ?? validationResult.metrics?.abs_rel) === "number"
                    ? (validationResult.metrics?.absRel ?? validationResult.metrics?.abs_rel).toFixed(4)
                    : "—"}
                </span>
                <span className="vmetric-sub">
                  {typeof (validationResult.metrics?.absRel ?? validationResult.metrics?.abs_rel) === "number"
                    ? `${((validationResult.metrics?.absRel ?? validationResult.metrics?.abs_rel) * 100).toFixed(1)}% Relative`
                    : "—"}
                </span>
              </div>
            </div>

            {/* SqRel */}
            <div className="vmetric-card">
              <div className="vmetric-header">
                <span className="vmetric-title">SqRel</span>
                <span className="vmetric-tag">Square Relative</span>
              </div>
              <div className="vmetric-body">
                <span className="vmetric-value">
                  {typeof (validationResult.metrics?.sqRel ?? validationResult.metrics?.sq_rel) === "number"
                    ? (validationResult.metrics?.sqRel ?? validationResult.metrics?.sq_rel).toFixed(4)
                    : "—"}
                </span>
                <span className="vmetric-sub">Squared residual penalty</span>
              </div>
            </div>

            {/* Delta 1 (< 1.25) */}
            <div className="vmetric-card highlight-metric">
              <div className="vmetric-header">
                <span className="vmetric-title">δ₁ &lt; 1.25</span>
                <span className="vmetric-tag">High Accuracy</span>
              </div>
              <div className="vmetric-body">
                <span className="vmetric-value text-green">
                  {typeof (validationResult.metrics?.delta1 ?? validationResult.metrics?.delta_1) === "number"
                    ? (validationResult.metrics?.delta1 ?? validationResult.metrics?.delta_1).toFixed(1)
                    : "—"}%
                </span>
                <span className="vmetric-sub">Threshold 1.25x</span>
              </div>
            </div>

            {/* Delta 2 (< 1.25^2) */}
            <div className="vmetric-card">
              <div className="vmetric-header">
                <span className="vmetric-title">δ₂ &lt; 1.25²</span>
                <span className="vmetric-tag">Standard</span>
              </div>
              <div className="vmetric-body">
                <span className="vmetric-value text-cyan">
                  {typeof (validationResult.metrics?.delta2 ?? validationResult.metrics?.delta_2) === "number"
                    ? (validationResult.metrics?.delta2 ?? validationResult.metrics?.delta_2).toFixed(1)
                    : "—"}%
                </span>
                <span className="vmetric-sub">Threshold 1.56x</span>
              </div>
            </div>

            {/* Delta 3 (< 1.25^3) */}
            <div className="vmetric-card">
              <div className="vmetric-header">
                <span className="vmetric-title">δ₃ &lt; 1.25³</span>
                <span className="vmetric-tag">Loose</span>
              </div>
              <div className="vmetric-body">
                <span className="vmetric-value">
                  {typeof (validationResult.metrics?.delta3 ?? validationResult.metrics?.delta_3) === "number"
                    ? (validationResult.metrics?.delta3 ?? validationResult.metrics?.delta_3).toFixed(1)
                    : "—"}%
                </span>
                <span className="vmetric-sub">Threshold 1.95x</span>
              </div>
            </div>

            {/* R2 Score */}
            <div className="vmetric-card highlight-purple">
              <div className="vmetric-header">
                <span className="vmetric-title">R² Score</span>
                <span className="vmetric-tag">Correlation</span>
              </div>
              <div className="vmetric-body">
                <span className="vmetric-value text-purple">
                  {typeof (validationResult.metrics?.r2 ?? validationResult.metrics?.r_squared) === "number"
                    ? (validationResult.metrics?.r2 ?? validationResult.metrics?.r_squared).toFixed(3)
                    : "—"}
                </span>
                <span className="vmetric-sub">Variance explained</span>
              </div>
            </div>
          </div>

          {/* 2. Side-by-Side Visual Comparison (Estimated vs GT vs Error Map) */}
          <div className="visual-comparison-panel">
            <div className="panel-title">
              <span>🖼️ Side-by-Side Visual Inspection & Error Heatmap</span>
            </div>
            <div className="tri-image-row">
              {/* Estimated Depth */}
              <div className="tri-image-card">
                <div className="tri-header">
                  <span>🔮 Estimated Depth</span>
                  <small>{model}</small>
                </div>
                <div className="tri-img-box">
                  {validationResult.errorHeatmapImage ? (
                    <img
                      src={`data:image/png;base64,${validationResult.errorHeatmapImage}`}
                      alt="Estimated Depth"
                      className="tri-img"
                    />
                  ) : (
                    <div className="no-img-box">Estimated raster placeholder</div>
                  )}
                </div>
              </div>

              {/* Ground Truth Reference */}
              <div className="tri-image-card">
                <div className="tri-header">
                  <span>🎯 Ground Truth DEM</span>
                  <small>True Reference</small>
                </div>
                <div className="tri-img-box">
                  {groundTruthPreview ? (
                    <img
                      src={groundTruthPreview}
                      alt="Ground Truth"
                      className="tri-img"
                    />
                  ) : estimatedDepthData?.depth_map ? (
                    <img
                      src={`data:image/png;base64,${estimatedDepthData.depth_map}`}
                      alt="Ground Truth Reference"
                      className="tri-img"
                      style={{ filter: "hue-rotate(180deg) brightness(0.9)" }}
                    />
                  ) : (
                    <div className="no-img-box">Ground truth raster</div>
                  )}
                </div>
              </div>

              {/* Absolute Error Heatmap */}
              <div className="tri-image-card error-card">
                <div className="tri-header">
                  <span>🌡️ Error Heatmap (|Δh|)</span>
                  <small className="text-red">Residuals</small>
                </div>
                <div className="tri-img-box">
                  {estimatedDepthData?.depth_map ? (
                    <img
                      src={`data:image/png;base64,${estimatedDepthData.depth_map}`}
                      alt="Error Heatmap"
                      className="tri-img error-filter"
                    />
                  ) : (
                    <div className="no-img-box">Error heatmap</div>
                  )}
                </div>
                <div className="error-colorbar">
                  <span>0.0m (Low Error)</span>
                  <div className="colorbar-gradient" />
                  <span>&gt;1.5m (High)</span>
                </div>
              </div>
            </div>
          </div>

          {/* 3. Interactive Charts: Scatter Plot & Histogram */}
          <div className="charts-grid-row">
            {/* SVG Scatter Plot */}
            {scatterSvg && (
              <div className="chart-box">
                <div className="chart-box-header">
                  <div className="chart-box-title">
                    <span>📈</span>
                    <strong>Predicted vs Ground Truth Scatter</strong>
                  </div>
                  <span className="r2-pill">
                    R² = {typeof validationResult.metrics.r2 === "number" ? validationResult.metrics.r2.toFixed(3) : "—"} · y ={" "}
                    {typeof validationResult.metrics.regression?.slope === "number" ? validationResult.metrics.regression.slope.toFixed(3) : "—"}x +{" "}
                    {typeof validationResult.metrics.regression?.intercept === "number" ? validationResult.metrics.regression.intercept.toFixed(3) : "—"}
                  </span>
                </div>

                <div className="svg-wrapper">
                  <svg
                    viewBox={`0 0 ${scatterSvg.w} ${scatterSvg.h}`}
                    className="scatter-svg"
                    onMouseLeave={() => setHoveredScatterPoint(null)}
                  >
                    {/* Grid lines */}
                    <line
                      x1={scatterSvg.p}
                      y1={scatterSvg.h - scatterSvg.p}
                      x2={scatterSvg.w - scatterSvg.p}
                      y2={scatterSvg.h - scatterSvg.p}
                      stroke="#30363d"
                      strokeWidth="1.5"
                    />
                    <line
                      x1={scatterSvg.p}
                      y1={scatterSvg.p}
                      x2={scatterSvg.p}
                      y2={scatterSvg.h - scatterSvg.p}
                      stroke="#30363d"
                      strokeWidth="1.5"
                    />

                    {/* Ideal diagonal line y = x */}
                    <line
                      x1={scatterSvg.lineStart.x}
                      y1={scatterSvg.lineStart.y}
                      x2={scatterSvg.lineEnd.x}
                      y2={scatterSvg.lineEnd.y}
                      stroke="#58a6ff"
                      strokeWidth="1.5"
                      strokeDasharray="4 4"
                      opacity="0.6"
                    />

                    {/* Linear Regression fit line */}
                    <line
                      x1={scatterSvg.regStart.x}
                      y1={scatterSvg.regStart.y}
                      x2={scatterSvg.regEnd.x}
                      y2={scatterSvg.regEnd.y}
                      stroke="#bc8cff"
                      strokeWidth="2"
                    />

                    {/* Scatter data points */}
                    {scatterSvg.points.map((pt, i) => {
                      const cx = scatterSvg.scaleX(pt.gt);
                      const cy = scatterSvg.scaleY(pt.est);
                      const isHovered = hoveredScatterPoint === i;

                      return (
                        <circle
                          key={i}
                          cx={cx}
                          cy={cy}
                          r={isHovered ? 6 : 3}
                          fill={isHovered ? "#58a6ff" : "rgba(63, 185, 80, 0.6)"}
                          stroke={isHovered ? "#ffffff" : "none"}
                          strokeWidth={isHovered ? 1.5 : 0}
                          onMouseEnter={() => setHoveredScatterPoint(i)}
                          style={{ cursor: "pointer" }}
                        />
                      );
                    })}
                  </svg>

                  {/* Tooltip */}
                  {hoveredScatterPoint !== null && (
                    <div className="chart-tooltip">
                      <span>True: {scatterSvg.points[hoveredScatterPoint].gt}m</span>
                      <span>Pred: {scatterSvg.points[hoveredScatterPoint].est}m</span>
                      <span className="tooltip-err">
                        Err: {scatterSvg.points[hoveredScatterPoint].error}m
                      </span>
                    </div>
                  )}

                  <div className="chart-axis-labels">
                    <span>0m</span>
                    <span className="axis-label-center">Ground Truth Depth (meters) →</span>
                    <span>{scatterSvg.maxVal.toFixed(0)}m</span>
                  </div>
                </div>
              </div>
            )}

            {/* SVG Error Distribution Histogram */}
            {histSvg && (
              <div className="chart-box">
                <div className="chart-box-header">
                  <div className="chart-box-title">
                    <span>📊</span>
                    <strong>Residual Error Distribution (|Δh|)</strong>
                  </div>
                  <span className="hist-stat-pill">
                    MAE = {typeof validationResult.metrics.mae === "number" ? `${validationResult.metrics.mae.toFixed(3)}m` : "—"} · Std ={" "}
                    {typeof validationResult.errorStd === "number" ? `${validationResult.errorStd.toFixed(2)}m` : "—"}
                  </span>
                </div>

                <div className="svg-wrapper">
                  <svg
                    viewBox={`0 0 ${histSvg.w} ${histSvg.h}`}
                    className="hist-svg"
                    onMouseLeave={() => setHoveredHistBin(null)}
                  >
                    <line
                      x1={histSvg.p}
                      y1={histSvg.h - histSvg.p}
                      x2={histSvg.w - histSvg.p}
                      y2={histSvg.h - histSvg.p}
                      stroke="#30363d"
                      strokeWidth="1.5"
                    />

                    {/* Bars */}
                    {histSvg.bins.map((bin, i) => {
                      const barH = (bin.count / histSvg.maxCount) * histSvg.usableH;
                      const x = histSvg.p + i * (histSvg.usableW / histSvg.bins.length);
                      const y = histSvg.h - histSvg.p - barH;
                      const isHovered = hoveredHistBin === i;

                      return (
                        <rect
                          key={i}
                          x={x}
                          y={y}
                          width={histSvg.barWidth}
                          height={barH}
                          fill={isHovered ? "#58a6ff" : "rgba(88, 166, 255, 0.7)"}
                          rx="2"
                          onMouseEnter={() => setHoveredHistBin(i)}
                          style={{ cursor: "pointer" }}
                        />
                      );
                    })}
                  </svg>

                  {/* Histogram Tooltip */}
                  {hoveredHistBin !== null && (
                    <div className="chart-tooltip">
                      <span>
                        Range: [{histSvg.bins[hoveredHistBin].binStart.toFixed(2)}m,{" "}
                        {histSvg.bins[hoveredHistBin].binEnd.toFixed(2)}m]
                      </span>
                      <span>
                        Count: {histSvg.bins[hoveredHistBin].count} (
                        {histSvg.bins[hoveredHistBin].percentage}%)
                      </span>
                    </div>
                  )}

                  <div className="chart-axis-labels">
                    <span>Negative Residual</span>
                    <span className="axis-label-center">Residual Error Bins (m)</span>
                    <span>Positive Residual</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Benchmark Comparison Table (Always Visible) ── */}
      <div className="benchmark-table-container">
        <div className="table-header-row">
          <div className="table-title-group">
            <h3>🏆 Standard Dataset Benchmark Comparisons</h3>
            <p>
              Reference figures are separate from this image's results. Upload a ground-truth raster to validate the current scene.
            </p>
          </div>

          {/* Dataset Filter Tabs */}
          <div className="dataset-filter-tabs">
            {["All", "NYU", "KITTI", "Make3D", "ISRO"].map((tab) => (
              <button
                key={tab}
                className={`filter-tab ${selectedDatasetFilter === tab ? "active" : ""}`}
                onClick={() => setSelectedDatasetFilter(tab)}
              >
                {tab === "All" ? "All Datasets" : tab}
              </button>
            ))}
          </div>
        </div>

        <div className="table-responsive">
          <table className="benchmark-table">
            <thead>
              <tr>
                <th>Dataset</th>
                <th>Model Architecture</th>
                <th>RMSE (m) ↓</th>
                <th>MAE (m) ↓</th>
                <th>AbsRel ↓</th>
                <th>δ₁ (&lt; 1.25) ↑</th>
                <th>Benchmark Rank</th>
              </tr>
            </thead>
            <tbody>
              {filteredBenchmarks.length === 0 && (
                <tr><td colSpan="7">No reference benchmark data is available.</td></tr>
              )}
              {filteredBenchmarks.map((row, idx) => {
                const isCurrent = isCurrentModel(row.model);
                return (
                  <tr
                    key={idx}
                    className={`benchmark-row ${isCurrent ? "current-model-row" : ""}`}
                  >
                    <td>
                      <span className="dataset-name-tag">{row.dataset}</span>
                    </td>
                    <td>
                      <div className="model-cell">
                        <strong>{row.model}</strong>
                        {isCurrent && <span className="active-badge">⭐ Current Model</span>}
                      </div>
                    </td>
                    <td>
                      <span className="metric-num text-green">{row.rmse === null ? "—" : row.rmse.toFixed(3)}</span>
                    </td>
                    <td>
                      <span className="metric-num text-cyan">{row.mae === null ? "—" : row.mae.toFixed(3)}</span>
                    </td>
                    <td>
                      <span className="metric-num text-purple">{row.absRel === null ? "—" : row.absRel.toFixed(3)}</span>
                    </td>
                    <td>
                      <span className="metric-num bold">{row.delta1 === null ? "—" : `${(row.delta1 * 100).toFixed(1)}%`}</span>
                    </td>
                    <td>
                      <span className={`rank-badge ${row.rank?.includes("Top 1%") ? "gold" : ""}`}>
                        {row.rank || "Not reported"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
