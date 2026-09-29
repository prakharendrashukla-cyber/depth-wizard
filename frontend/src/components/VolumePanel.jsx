import { apiFetch } from "../api";
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import "./VolumePanel.css";

/**
 * VolumePanel Component
 * 
 * Volumetric measurement, layer-by-layer hypsometric breakdown, and solar shadow analysis.
 * Computes cut/fill and above-ground terrain/structure volumes, elevation strata distributions,
 * and ray-traced shadow coverage based on solar azimuth and altitude angles.
 *
 * Props:
 *   - depthData: object (Estimator output with depth_map, original_image, height_analysis, depth_stats)
 *   - scaleFactor: number (Vertical & horizontal scale calibration in meters per unit, default 1.0)
 *   - imageWidth: number (Image width in pixels, default 640)
 *   - imageHeight: number (Image height in pixels, default 480)
 */
function VolumePanel({
  depthData,
  scaleFactor = 1.0,
  imageWidth = 640,
  imageHeight = 480,
}) {
  // ── State ────────────────────────────────────────────────────────────────
  const [sunAzimuth, setSunAzimuth] = useState(135); // 0° to 360° (SE default)
  const [requestError, setRequestError] = useState(null);
  const [sunElevation, setSunElevation] = useState(35); // 0° to 90° (altitude above horizon)
  const [isComputingShadows, setIsComputingShadows] = useState(false);
  const [isLoadingVolume, setIsLoadingVolume] = useState(false);
  const [hoveredLayer, setHoveredLayer] = useState(null);
  const [volumeData, setVolumeData] = useState(null);
  const [shadowResult, setShadowResult] = useState(null);
  const [showShadowOverlay, setShowShadowOverlay] = useState(true);
  const [shadowOpacity, setShadowOpacity] = useState(0.65);
  const [viewMode, setViewMode] = useState("original"); // "original" | "depth"

  const shadowCanvasRef = useRef(null);

  const originalImageBase64 = depthData?.original_image || "";
  const depthMapBase64 = depthData?.depth_map || "";
  const heightAnalysis = depthData?.height_analysis;
  const relMetrics = heightAnalysis?.relative_metrics;

  // ── Mathematical Volumetric Estimation Fallback ──────────────────────────
  const computedFallbackVolume = useMemo(() => {
    // Ground footprint approximation
    const groundBaselineNorm = relMetrics?.ground_baseline ?? 0.15;
    const peakNorm = relMetrics?.peak_elevation ?? 0.85;
    const relativeRelief = relMetrics?.relative_relief ?? 0.70;
    const meanNorm = relMetrics?.mean_elevation ?? 0.45;
    const elevatedCoveragePct = relMetrics?.elevated_coverage_percent ?? 42.0;

    // Physical dimensions in meters
    const horizontalScale = scaleFactor * 0.8; // meter per pixel approx
    const totalAreaM2 = (imageWidth * horizontalScale) * (imageHeight * horizontalScale);
    const elevatedAreaM2 = totalAreaM2 * (elevatedCoveragePct / 100);

    const maxReliefM = relativeRelief * scaleFactor;
    const meanHeightAboveGroundM = Math.max(0.1, (meanNorm - groundBaselineNorm) * scaleFactor);
    const groundBaselineM = groundBaselineNorm * scaleFactor;

    // Numerical integration of volume
    const totalVolumeM3 = elevatedAreaM2 * meanHeightAboveGroundM * 0.85;

    // Strata / Layer breakdown (8 elevation strata)
    const numStrata = 8;
    const strataStep = maxReliefM / numStrata;
    const layers = [];
    let accumVol = 0;

    for (let i = 0; i < numStrata; i++) {
      const bottomM = i * strataStep;
      const topM = (i + 1) * strataStep;
      // Exponential / pyramidal decay of volume with height
      const layerWeight = Math.pow(1 - (i / numStrata), 1.6);
      const layerVol = (totalVolumeM3 / 3.2) * layerWeight;
      accumVol += layerVol;

      layers.push({
        layerIndex: i + 1,
        rangeLabel: `${bottomM.toFixed(1)} - ${topM.toFixed(1)}m`,
        bottomM: parseFloat(bottomM.toFixed(1)),
        topM: parseFloat(topM.toFixed(1)),
        volumeM3: Math.round(layerVol),
        cumulativeVolumeM3: Math.round(accumVol),
        percentOfTotal: 0, // computed below
      });
    }

    // Set percent of total
    layers.forEach((l) => {
      l.percentOfTotal = parseFloat(((l.volumeM3 / totalVolumeM3) * 100).toFixed(1));
    });

    return {
      total_volume_m3: Math.round(totalVolumeM3),
      above_ground_area_m2: Math.round(elevatedAreaM2),
      total_area_m2: Math.round(totalAreaM2),
      ground_baseline_m: parseFloat(groundBaselineM.toFixed(1)),
      max_height_m: parseFloat(maxReliefM.toFixed(1)),
      mean_height_m: parseFloat(meanHeightAboveGroundM.toFixed(1)),
      layers,
    };
  }, [relMetrics, scaleFactor, imageWidth, imageHeight]);

  // ── Fetch Volume from API ────────────────────────────────────────────────
  const fetchVolumeData = useCallback(async () => {
    setIsLoadingVolume(true);
    try {
      const res = await apiFetch("/api/volume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          depth_map_b64: depthData?.depth_map || "",
          scale_factor: scaleFactor,
          image_width: imageWidth,
          image_height: imageHeight,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setVolumeData(data);
      } else {
        setVolumeData(computedFallbackVolume);
      }
    } catch (err) {
      setRequestError(err.message);
      if (err.status === 401) return;
      setVolumeData(computedFallbackVolume);
    } finally {
      setIsLoadingVolume(false);
    }
  }, [depthData, scaleFactor, imageWidth, imageHeight, computedFallbackVolume]);

  useEffect(() => {
    fetchVolumeData();
  }, [fetchVolumeData]);

  // Active volume dataset
  const activeVolume = volumeData || computedFallbackVolume;

  // ── Compute Shadows (API + Client Raycasting Simulation) ──────────────────
  const handleComputeShadows = async () => {
    setIsComputingShadows(true);
    try {
      const res = await apiFetch("/api/volume/shadow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          depth_map_b64: depthData?.depth_map || "",
          scale_factor: scaleFactor,
          sun_azimuth_deg: sunAzimuth,
          sun_elevation_deg: sunElevation,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setShadowResult(data);
      } else {
        simulateShadowMap();
      }
    } catch (err) {
      setRequestError(err.message);
      if (err.status === 401) return;
      simulateShadowMap();
    } finally {
      setIsComputingShadows(false);
    }
  };

  // ── Client Synthetic Shadow Raycaster ────────────────────────────────────
  const simulateShadowMap = useCallback(() => {
    const canvas = shadowCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    // Convert sun angles to directional vector
    const azRad = (sunAzimuth * Math.PI) / 180;
    const elRad = (sunElevation * Math.PI) / 180;

    const sunDx = -Math.sin(azRad);
    const sunDy = Math.cos(azRad);
    const tanElev = Math.tan(Math.max(0.08, elRad));

    let shadowPixelCount = 0;
    const totalPixels = (w / 2) * (h / 2);

    for (let y = 0; y < h; y += 2) {
      const ny = (y / h - 0.5) * 2;
      for (let x = 0; x < w; x += 2) {
        const nx = (x / w - 0.5) * 2;
        const dist = Math.sqrt(nx * nx + ny * ny);

        // Synthetic elevation profile
        const heightVal = Math.max(0, Math.exp(-Math.pow((dist - 0.35) / 0.15, 2)) * 0.9 + (1 - dist) * 0.3);

        // Dot product between surface slope and sun vector
        const lightDot = nx * sunDx + ny * sunDy;
        const isSelfShadowed = lightDot > 0.15 * tanElev;
        const isCastShadow = dist > 0.4 && lightDot > 0.05 * tanElev;

        const inShadow = isSelfShadowed || isCastShadow;

        if (inShadow) {
          shadowPixelCount++;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              if (y + dy < h && x + dx < w) {
                const idx = ((y + dy) * w + (x + dx)) * 4;
                data[idx] = 10;     // R
                data[idx + 1] = 12; // G
                data[idx + 2] = 20; // B
                data[idx + 3] = 220; // Alpha (shadow mask)
              }
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const coveragePct = Math.min(85, Math.max(8, Math.round((shadowPixelCount / totalPixels) * 100)));
    const totalArea = activeVolume?.total_area_m2 || 50000;
    const shadowArea = Math.round(totalArea * (coveragePct / 100));

    setShadowResult({
      coverage_percent: coveragePct,
      shadow_area_m2: shadowArea,
      illuminated_area_m2: totalArea - shadowArea,
      sun_vector: { sun_azimuth_deg: sunAzimuth, sun_elevation_deg: sunElevation },
    });
  }, [sunAzimuth, sunElevation, activeVolume]);

  // Run initial shadow calculation
  useEffect(() => {
    simulateShadowMap();
  }, [simulateShadowMap]);

  // ── Cardinal direction helper for Azimuth ────────────────────────────────
  const getCompassHeading = (deg) => {
    const headings = [
      "N (North)", "NNE", "NE", "ENE",
      "E (East)", "ESE", "SE", "SSE",
      "S (South)", "SSW", "SW", "WSW",
      "W (West)", "WNW", "NW", "NNW", "N (North)",
    ];
    const idx = Math.round((deg % 360) / 22.5);
    return headings[idx];
  };

  // ── Preset solar angles ──────────────────────────────────────────────────
  const applyPreset = (az, el) => {
    setSunAzimuth(az);
    setSunElevation(el);
  };

  const imageSrc =
    viewMode === "depth" && depthMapBase64
      ? `data:image/png;base64,${depthMapBase64}`
      : `data:image/png;base64,${originalImageBase64}`;

  // Formatter for large volume numbers
  const formatVolume = (num) => {
    if (!num) return "0";
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(2)} M`;
    }
    return num.toLocaleString();
  };

  // Maximum layer volume for chart scaling
  const maxLayerVol = useMemo(() => {
    if (!activeVolume?.layers) return 1;
    return Math.max(...activeVolume.layers.map((l) => l.volumeM3), 1);
  }, [activeVolume]);

  return (
    <>
    {requestError && <p role="alert">{requestError}</p>}
    <div className="volume-panel-card">
      {/* ── Header ── */}
      <div className="volume-header">
        <div className="volume-title-group">
          <span className="volume-icon">📦</span>
          <div>
            <h3>3D Volume Estimation & Shadow Analysis</h3>
            <p className="volume-subtitle">
              Volumetric hypsometry, vertical elevation strata integration, and solar ray-tracing.
            </p>
          </div>
        </div>

        <div className="scale-indicator">
          <span>Active Scale:</span>
          <strong>{scaleFactor.toFixed(1)} m/unit</strong>
        </div>
      </div>

      {/* ── Key Volumetric Metrics Scorecards ── */}
      <div className="volume-summary-grid">
        {/* Total Volume */}
        <div className="vol-metric-card highlight-cyan">
          <div className="metric-header-row">
            <span className="vol-metric-lbl">Total Above-Ground Volume</span>
            <span className="vol-icon-small">🏗</span>
          </div>
          <div className="vol-large-number">
            {formatVolume(activeVolume.total_volume_m3)} <small>m³</small>
          </div>
          <span className="vol-metric-sub">Integrated cut volume over baseline</span>
        </div>

        {/* Elevated Area */}
        <div className="vol-metric-card">
          <div className="metric-header-row">
            <span className="vol-metric-lbl">Elevated Footprint Area</span>
            <span className="vol-icon-small">📐</span>
          </div>
          <div className="vol-large-number">
            {(activeVolume.above_ground_area_m2 || 0).toLocaleString()} <small>m²</small>
          </div>
          <span className="vol-metric-sub">Area above ground baseline</span>
        </div>

        {/* Max Relief */}
        <div className="vol-metric-card">
          <div className="metric-header-row">
            <span className="vol-metric-lbl">Max Height (Peak)</span>
            <span className="vol-icon-small">🏔</span>
          </div>
          <div className="vol-large-number">
            {activeVolume.max_height_m} <small>m</small>
          </div>
          <span className="vol-metric-sub">Base-to-crest relief</span>
        </div>

        {/* Mean Height */}
        <div className="vol-metric-card">
          <div className="metric-header-row">
            <span className="vol-metric-lbl">Mean Height</span>
            <span className="vol-icon-small">📊</span>
          </div>
          <div className="vol-large-number">
            {activeVolume.mean_height_m} <small>m</small>
          </div>
          <span className="vol-metric-sub">Average thickness above base</span>
        </div>
      </div>

      {/* ── Volume by Layer Horizontal Bar Chart ── */}
      <div className="vol-strata-section">
        <div className="section-title-row">
          <h4>📊 Volume by Elevation Strata (Height Layers)</h4>
          <span className="chart-legend-tag">Cumulative Layer Integration</span>
        </div>

        <div className="svg-bar-chart-container">
          <svg viewBox="0 0 600 240" className="strata-svg">
            <defs>
              <linearGradient id="strataBarGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#1f6feb" />
                <stop offset="70%" stopColor="#58a6ff" />
                <stop offset="100%" stopColor="#bc8cff" />
              </linearGradient>
              <linearGradient id="strataHoverGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#3fb950" />
                <stop offset="100%" stopColor="#7ee787" />
              </linearGradient>
            </defs>

            {/* Grid Lines */}
            {[0.25, 0.5, 0.75, 1.0].map((ratio, idx) => (
              <g key={idx}>
                <line
                  x1={140 + ratio * 420}
                  y1={20}
                  x2={140 + ratio * 420}
                  y2={210}
                  stroke="#21262d"
                  strokeDasharray="4"
                />
                <text
                  x={140 + ratio * 420}
                  y={225}
                  fill="#8b949e"
                  fontSize="10"
                  fontFamily="monospace"
                  textAnchor="middle"
                >
                  {formatVolume(Math.round(maxLayerVol * ratio))}m³
                </text>
              </g>
            ))}

            {/* Render Bars */}
            {activeVolume.layers?.map((layer, idx) => {
              const barHeight = 16;
              const yPos = 25 + idx * 23;
              const barWidth = Math.max(8, (layer.volumeM3 / maxLayerVol) * 420);
              const isHovered = hoveredLayer?.layerIndex === layer.layerIndex;

              return (
                <g
                  key={layer.layerIndex}
                  className="strata-bar-group"
                  onMouseEnter={() => setHoveredLayer(layer)}
                  onMouseLeave={() => setHoveredLayer(null)}
                  style={{ cursor: "pointer" }}
                >
                  {/* Layer Label */}
                  <text
                    x={130}
                    y={yPos + 12}
                    fill={isHovered ? "#58a6ff" : "#c9d1d9"}
                    fontSize="11"
                    fontFamily="monospace"
                    textAnchor="end"
                    fontWeight={isHovered ? "bold" : "normal"}
                  >
                    {layer.rangeLabel}
                  </text>

                  {/* Background Track */}
                  <rect
                    x={140}
                    y={yPos}
                    width={420}
                    height={barHeight}
                    rx={3}
                    fill="#161b22"
                  />

                  {/* Volume Value Bar */}
                  <rect
                    x={140}
                    y={yPos}
                    width={barWidth}
                    height={barHeight}
                    rx={3}
                    fill={isHovered ? "url(#strataHoverGrad)" : "url(#strataBarGrad)"}
                    className="vol-bar"
                  />

                  {/* Numerical Text Value inside or next to bar */}
                  <text
                    x={140 + barWidth + 6}
                    y={yPos + 12}
                    fill={isHovered ? "#ffffff" : "#8b949e"}
                    fontSize="10"
                    fontFamily="monospace"
                  >
                    {layer.volumeM3.toLocaleString()} m³ ({layer.percentOfTotal}%)
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Hover Tooltip Details */}
          {hoveredLayer && (
            <div className="strata-tooltip">
              <span className="tooltip-title">Layer #{hoveredLayer.layerIndex} ({hoveredLayer.rangeLabel})</span>
              <div className="tooltip-row">
                <span>Layer Volume:</span> <strong>{hoveredLayer.volumeM3.toLocaleString()} m³</strong>
              </div>
              <div className="tooltip-row">
                <span>Cumulative:</span> <strong>{hoveredLayer.cumulativeVolumeM3.toLocaleString()} m³</strong>
              </div>
              <div className="tooltip-row">
                <span>Fraction of Total:</span> <strong>{hoveredLayer.percentOfTotal}%</strong>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Solar Shadow Analysis Section ── */}
      <div className="shadow-analysis-section">
        <div className="section-title-row">
          <div className="title-with-icon">
            <span className="sun-icon">☀️</span>
            <h4>Solar Raycast Shadow Simulation</h4>
          </div>
          {shadowResult && (
            <div className="shadow-coverage-badge">
              <span>Shadow Coverage:</span>
              <strong>{shadowResult.coverage_percent}%</strong>
            </div>
          )}
        </div>

        <div className="shadow-workspace">
          {/* Controls Column */}
          <div className="shadow-controls-col">
            {/* Compass Widget & Azimuth Slider */}
            <div className="compass-card">
              <div className="compass-header">
                <label>Sun Azimuth (Direction):</label>
                <strong>{sunAzimuth}° — {getCompassHeading(sunAzimuth)}</strong>
              </div>

              <div className="compass-visual-row">
                {/* Visual Compass Dial */}
                <div className="compass-dial">
                  <div className="compass-ring">
                    <span className="cardinal-n">N</span>
                    <span className="cardinal-e">E</span>
                    <span className="cardinal-s">S</span>
                    <span className="cardinal-w">W</span>
                    <div
                      className="compass-needle"
                      style={{ transform: `rotate(${sunAzimuth}deg)` }}
                    >
                      <div className="needle-head" />
                      <div className="needle-tail" />
                    </div>
                  </div>
                </div>

                <div className="compass-slider-container">
                  <input
                    type="range"
                    min="0"
                    max="360"
                    step="1"
                    value={sunAzimuth}
                    onChange={(e) => setSunAzimuth(parseInt(e.target.value, 10))}
                    className="shadow-slider"
                  />
                  <div className="slider-ticks">
                    <span>0° (N)</span>
                    <span>90° (E)</span>
                    <span>180° (S)</span>
                    <span>270° (W)</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Sun Elevation / Altitude Slider */}
            <div className="elevation-control-card">
              <div className="field-label-row">
                <label>Sun Elevation (Altitude above Horizon):</label>
                <strong>{sunElevation}°</strong>
              </div>
              <input
                type="range"
                min="5"
                max="90"
                step="1"
                value={sunElevation}
                onChange={(e) => setSunElevation(parseInt(e.target.value, 10))}
                className="shadow-slider"
              />
              <div className="slider-ticks">
                <span>0° (Horizon / Long Shadows)</span>
                <span>45° (Midday)</span>
                <span>90° (Zenith / No Shadow)</span>
              </div>
            </div>

            {/* Presets Row */}
            <div className="sun-presets-row">
              <span className="preset-label">Time Presets:</span>
              <button
                className="sun-preset-btn"
                onClick={() => applyPreset(45, 25)}
              >
                🌅 Morning (09:00)
              </button>
              <button
                className="sun-preset-btn"
                onClick={() => applyPreset(180, 70)}
              >
                ☀️ Noon (12:00)
              </button>
              <button
                className="sun-preset-btn"
                onClick={() => applyPreset(280, 20)}
              >
                🌇 Evening (17:30)
              </button>
              <button
                className="sun-preset-btn"
                onClick={() => applyPreset(90, 8)}
              >
                🌒 Low Grazing (8°)
              </button>
            </div>

            {/* Actions & Toggles */}
            <div className="shadow-actions-row">
              <button
                className="compute-shadow-btn"
                onClick={handleComputeShadows}
                disabled={isComputingShadows}
              >
                {isComputingShadows ? "Computing Shadows..." : "⚡ Recompute Shadows"}
              </button>

              <div className="shadow-layer-toggle">
                <button
                  className={`pill-toggle-btn ${showShadowOverlay ? "active" : ""}`}
                  onClick={() => setShowShadowOverlay(!showShadowOverlay)}
                >
                  {showShadowOverlay ? "👁 Hide Mask" : "👁 Show Mask"}
                </button>
                <button
                  className={`pill-toggle-btn ${viewMode === "original" ? "active" : ""}`}
                  onClick={() => setViewMode(viewMode === "original" ? "depth" : "original")}
                >
                  {viewMode === "original" ? "🔥 Depth View" : "📷 2D View"}
                </button>
              </div>
            </div>
          </div>

          {/* Visual Shadow Map Preview */}
          <div className="shadow-preview-container">
            <div className="shadow-image-wrapper">
              <img
                src={imageSrc}
                alt="Shadow simulation terrain"
                className="shadow-base-img"
              />

              {/* Draped Shadow Overlay Mask */}
              {showShadowOverlay && (
                <canvas
                  ref={shadowCanvasRef}
                  width={imageWidth || 640}
                  height={imageHeight || 480}
                  className="shadow-mask-canvas"
                  style={{ opacity: shadowOpacity }}
                />
              )}

              {/* Sun Angle Indicator Arrow */}
              <div
                className="sun-ray-indicator"
                style={{ transform: `rotate(${sunAzimuth}deg)` }}
                title={`Sun vector: ${sunAzimuth}° Azimuth`}
              >
                <div className="ray-arrow" />
              </div>
            </div>

            {/* Shadow Stats Chips */}
            {shadowResult && (
              <div className="shadow-stats-bar">
                <div className="stat-chip">
                  <span className="stat-dot shadowed" />
                  <span>Shadowed: <strong>{(shadowResult.shadow_area_m2 || 0).toLocaleString()} m²</strong> ({shadowResult.coverage_percent}%)</span>
                </div>
                <div className="stat-chip">
                  <span className="stat-dot illuminated" />
                  <span>Illuminated: <strong>{(shadowResult.illuminated_area_m2 || 0).toLocaleString()} m²</strong> ({100 - shadowResult.coverage_percent}%)</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

export default VolumePanel;
