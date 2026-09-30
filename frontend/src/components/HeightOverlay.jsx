import React, { useState, useMemo } from "react";
import "./HeightOverlay.css";

// ── Preset Environments for Scale Calibration ────────────────────────────
const SCALE_PRESETS = [
  { id: "planetary", name: "🚀 ISRO / Lunar Crater", scale: 250.0, desc: "Large terrain & impact crater relief (50m - 500m)" },
  { id: "urban", name: "🏙 Urban Aerial / Drone", scale: 45.0, desc: "City structures & multi-story buildings (5m - 50m)" },
  { id: "architecture", name: "🏛 Architecture / Facade", scale: 12.0, desc: "Ground-level street & building facades (1m - 15m)" },
  { id: "macro", name: "🔬 Close-up / Macro", scale: 1.0, desc: "Tabletop or small object geometry (0.1m - 1m)" },
];

function HeightOverlay({ data, scaleFactor = 1.0, onScaleChange, measurement }) {
  const [activeTransect, setActiveTransect] = useState("horizontal");
  const [hoverIndex, setHoverIndex] = useState(null);

  const heightAnalysis = data?.height_analysis;
  const relMetrics = heightAnalysis?.relative_metrics;
  const transects = heightAnalysis?.transects;

  // Calibrated values based on active scaleFactor
  const calibrated = useMemo(() => {
    if (!relMetrics) return null;
    const maxRelief = relMetrics.relative_relief * scaleFactor;
    const groundLevel = relMetrics.ground_baseline * scaleFactor;
    const peakLevel = relMetrics.peak_elevation * scaleFactor;
    const meanHeight = relMetrics.mean_elevation * scaleFactor;
    const elevStd = relMetrics.elevation_std * scaleFactor;

    return {
      maxRelief: maxRelief.toFixed(1),
      groundLevel: groundLevel.toFixed(1),
      peakLevel: peakLevel.toFixed(1),
      meanHeight: meanHeight.toFixed(1),
      elevStd: elevStd.toFixed(2),
      coverage: relMetrics.elevated_coverage_percent?.toFixed(1) || "0.0",
    };
  }, [relMetrics, scaleFactor]);

  // Elevation Profile points for active transect slice
  const profilePoints = useMemo(() => {
    if (!transects || !transects[activeTransect]) return [];
    return transects[activeTransect].map((normVal) => normVal * scaleFactor);
  }, [transects, activeTransect, scaleFactor]);

  if (!data || !heightAnalysis) {
    return (
      <div className="height-overlay-card">
        <div className="empty-height-placeholder">
          <span>📏</span>
          <p>Height and topography analysis will appear once an image is processed.</p>
        </div>
      </div>
    );
  }

  // Generate SVG path for elevation transect graph
  const svgWidth = 480;
  const svgHeight = 120;
  const padding = 20;

  let pathD = "";
  let areaD = "";
  if (profilePoints.length > 0) {
    const minH = 0;
    const maxH = Math.max(...profilePoints, 1.0);
    const usableW = svgWidth - padding * 2;
    const usableH = svgHeight - padding * 2;

    const coords = profilePoints.map((val, i) => {
      const x = padding + (i / (profilePoints.length - 1)) * usableW;
      const y = svgHeight - padding - ((val - minH) / (maxH - minH)) * usableH;
      return [x, y];
    });

    pathD = coords.reduce((acc, [x, y], idx) => `${acc} ${idx === 0 ? "M" : "L"} ${x.toFixed(1)},${y.toFixed(1)}`, "");
    areaD = `${pathD} L ${coords[coords.length - 1][0].toFixed(1)},${(svgHeight - padding).toFixed(1)} L ${coords[0][0].toFixed(1)},${(svgHeight - padding).toFixed(1)} Z`;
  }

  return (
    <div className="height-overlay-card">
      {/* ── Header ── */}
      <div className="overlay-header">
        <div className="header-title-group">
          <h3>📊 Topography & Height Analysis</h3>
          <span className="model-pill">{data.model || "Depth Model"}</span>
        </div>

        {/* ── Metric Calibration Presets ── */}
        <div className="scale-controls">
          <span className="scale-label">Scale Preset:</span>
          <div className="preset-buttons">
            {SCALE_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`preset-pill-btn ${Math.abs(scaleFactor - p.scale) < 0.1 ? "active" : ""}`}
                onClick={() => onScaleChange && onScaleChange(p.scale, p.id)}
                title={p.desc}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Custom Metric Scale Slider ── */}
      <div className="custom-scale-bar">
        <label>
          📐 Calibrated Vertical Scale: <strong>{scaleFactor.toFixed(1)} meters / unit</strong>
        </label>
        <div className="slider-row">
          <span>0.5m</span>
          <input
            type="range"
            min="0.5"
            max="300"
            step="0.5"
            value={scaleFactor}
            onChange={(e) => onScaleChange && onScaleChange(parseFloat(e.target.value))}
            className="scale-slider"
          />
          <span>300m</span>
          <input
            type="number"
            min="0.1"
            max="5000"
            step="1"
            value={scaleFactor}
            onChange={(e) => onScaleChange && onScaleChange(Math.max(0.1, parseFloat(e.target.value) || 1))}
            className="scale-number-input"
          />
          <span className="unit-label">meters</span>
        </div>
      </div>

      {/* ── Key Metrics Cards ── */}
      {calibrated && (
        <div className="metrics-grid">
          <div className="metric-box highlight">
            <span className="metric-icon">🏔</span>
            <div className="metric-info">
              <span className="metric-title">Max Relief (ΔH)</span>
              <span className="metric-val">{calibrated.maxRelief} <small>m</small></span>
              <span className="metric-sub">Base-to-peak height</span>
            </div>
          </div>

          <div className="metric-box">
            <span className="metric-icon">🔝</span>
            <div className="metric-info">
              <span className="metric-title">Peak Elevation</span>
              <span className="metric-val">{calibrated.peakLevel} <small>m</small></span>
              <span className="metric-sub">99th percentile</span>
            </div>
          </div>

          <div className="metric-box">
            <span className="metric-icon">🏕</span>
            <div className="metric-info">
              <span className="metric-title">Ground Baseline</span>
              <span className="metric-val">{calibrated.groundLevel} <small>m</small></span>
              <span className="metric-sub">Estimated terrain base</span>
            </div>
          </div>

          <div className="metric-box">
            <span className="metric-icon">🏢</span>
            <div className="metric-info">
              <span className="metric-title">Structure Area</span>
              <span className="metric-val">{calibrated.coverage}%</span>
              <span className="metric-sub">Elevated features</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Elevation Transect Cross-Section Graph ── */}
      {profilePoints.length > 0 && (
        <div className="transect-section">
          <div className="transect-header">
            <div className="transect-title">
              <span>📈</span> Elevation Profile Slice
            </div>
            <div className="transect-tabs">
              <button
                className={`transect-tab ${activeTransect === "horizontal" ? "active" : ""}`}
                onClick={() => setActiveTransect("horizontal")}
              >
                Horizontal (W → E)
              </button>
              <button
                className={`transect-tab ${activeTransect === "vertical" ? "active" : ""}`}
                onClick={() => setActiveTransect("vertical")}
              >
                Vertical (N → S)
              </button>
              <button
                className={`transect-tab ${activeTransect === "diagonal" ? "active" : ""}`}
                onClick={() => setActiveTransect("diagonal")}
              >
                Diagonal ↘
              </button>
            </div>
          </div>

          <div className="svg-chart-container">
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="elevation-svg"
              onMouseLeave={() => setHoverIndex(null)}
            >
              <defs>
                <linearGradient id="elevGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#58a6ff" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#58a6ff" stopOpacity="0.02" />
                </linearGradient>
              </defs>

              {/* Grid Lines */}
              <line x1={padding} y1={svgHeight - padding} x2={svgWidth - padding} y2={svgHeight - padding} stroke="#30363d" strokeWidth="1" />
              <line x1={padding} y1={padding} x2={svgWidth - padding} y2={padding} stroke="#21262d" strokeWidth="1" strokeDasharray="4" />
              <line x1={padding} y1={svgHeight / 2} x2={svgWidth - padding} y2={svgHeight / 2} stroke="#21262d" strokeWidth="1" strokeDasharray="4" />

              {/* Area Fill & Path Line */}
              <path d={areaD} fill="url(#elevGrad)" />
              <path d={pathD} fill="none" stroke="#58a6ff" strokeWidth="2.5" strokeLinecap="round" />

              {/* Hover point indicator */}
              {hoverIndex !== null && (
                <circle
                  cx={padding + (hoverIndex / (profilePoints.length - 1)) * (svgWidth - padding * 2)}
                  cy={
                    svgHeight -
                    padding -
                    ((profilePoints[hoverIndex] || 0) / Math.max(...profilePoints, 1.0)) * (svgHeight - padding * 2)
                  }
                  r="5"
                  fill="#ff7b72"
                  stroke="#ffffff"
                  strokeWidth="2"
                />
              )}
            </svg>

            <div className="chart-legend">
              <span>Start (0%)</span>
              <span className="legend-center">
                Peak: {Math.max(...profilePoints).toFixed(1)}m | Min: {Math.min(...profilePoints).toFixed(1)}m
              </span>
              <span>End (100%)</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Active 3D Measurement Results Card (if measuring) ── */}
      {measurement && measurement.pointB && (
        <div className="active-measure-summary">
          <div className="measure-icon">📐</div>
          <div className="measure-details">
            <span className="measure-main">
              3D Span: <strong>{measurement.distance?.toFixed(2)} meters</strong>
            </span>
            <div className="measure-chips">
              <span className="measure-chip">Height ΔH: <strong>{measurement.heightDelta?.toFixed(2)}m</strong></span>
              <span className="measure-chip">Point A → Point B</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default HeightOverlay;

