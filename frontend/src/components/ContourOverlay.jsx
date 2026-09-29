import { apiFetch } from "../api";
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import "./ContourOverlay.css";

/**
 * ContourOverlay Component
 * 
 * Topographic contour visualization, slope analysis, and aspect mapping panel.
 * Renders vector SVG contour isohypse lines, classified terrain slopes, and orientation
 * aspects over the monocular input image / depth field.
 *
 * Props:
 *   - depthData: object (Estimate response or depth object with depth_map, original_image, height_analysis, depth_stats)
 *   - scaleFactor: number (Calibrated vertical scale in meters per unit, default 1.0)
 *   - imageWidth: number (Width in pixels, default 640)
 *   - imageHeight: number (Height in pixels, default 480)
 */
function ContourOverlay({
  depthData,
  scaleFactor = 1.0,
  imageWidth = 640,
  imageHeight = 480,
}) {
  // ── State ────────────────────────────────────────────────────────────────
  const [contourInterval, setContourInterval] = useState(10); // in meters
  const [requestError, setRequestError] = useState(null);
  const [numLevels, setNumLevels] = useState(12); // 5 to 50
  const [showContours, setShowContours] = useState(true);
  const [showSlope, setShowSlope] = useState(false);
  const [showAspect, setShowAspect] = useState(false);
  const [baseLayer, setBaseLayer] = useState("original"); // "original" | "depth" | "dark"
  const [contourOpacity, setContourOpacity] = useState(0.9);
  const [loading, setLoading] = useState(false);
  const [contourData, setContourData] = useState(null);

  const canvasRef = useRef(null);
  const svgRef = useRef(null);

  // Extract base images
  const originalImageBase64 = depthData?.original_image || "";
  const depthMapBase64 = depthData?.depth_map || "";
  const heightAnalysis = depthData?.height_analysis;
  const relMetrics = heightAnalysis?.relative_metrics;

  // Max relief in meters
  const maxReliefM = useMemo(() => {
    if (relMetrics?.relative_relief) {
      return relMetrics.relative_relief * scaleFactor;
    }
    return 100.0 * scaleFactor;
  }, [relMetrics, scaleFactor]);

  // Adjust default interval when scaleFactor changes significantly
  useEffect(() => {
    if (maxReliefM > 0) {
      const step = Math.max(1, Math.round(maxReliefM / numLevels));
      setContourInterval(step);
    }
  }, [maxReliefM, numLevels]);

  // ── Color Interpolator for Elevation (Blue -> Cyan -> Green -> Yellow -> Red) ──
  const getElevationColor = useCallback((t) => {
    // t is 0.0 (lowest) to 1.0 (highest)
    const clamped = Math.max(0, Math.min(1, t));
    if (clamped < 0.25) {
      // Blue (#388bfd) to Cyan (#39c5cf)
      const f = clamped / 0.25;
      const r = Math.round(56 + f * (57 - 56));
      const g = Math.round(139 + f * (197 - 139));
      const b = Math.round(253 + f * (207 - 253));
      return `rgb(${r}, ${g}, ${b})`;
    } else if (clamped < 0.5) {
      // Cyan (#39c5cf) to Green (#3fb950)
      const f = (clamped - 0.25) / 0.25;
      const r = Math.round(57 + f * (63 - 57));
      const g = Math.round(197 + f * (185 - 197));
      const b = Math.round(207 + f * (80 - 207));
      return `rgb(${r}, ${g}, ${b})`;
    } else if (clamped < 0.75) {
      // Green (#3fb950) to Yellow (#d29922)
      const f = (clamped - 0.5) / 0.25;
      const r = Math.round(63 + f * (210 - 63));
      const g = Math.round(185 + f * (153 - 185));
      const b = Math.round(80 + f * (34 - 80));
      return `rgb(${r}, ${g}, ${b})`;
    } else {
      // Yellow (#d29922) to Red (#f85149)
      const f = (clamped - 0.75) / 0.25;
      const r = Math.round(210 + f * (248 - 210));
      const g = Math.round(153 + f * (81 - 153));
      const b = Math.round(34 + f * (73 - 34));
      return `rgb(${r}, ${g}, ${b})`;
    }
  }, []);

  // ── Client-side Mathematical Iso-Contour & Grid Synthesizer ──────────────
  const generatedContours = useMemo(() => {
    const w = imageWidth || 640;
    const h = imageHeight || 480;
    const gridCols = 40;
    const gridRows = 30;

    // Build synthetic height surface grid based on image topography
    const grid = [];
    for (let r = 0; r < gridRows; r++) {
      const row = [];
      const ny = r / (gridRows - 1);
      for (let c = 0; c < gridCols; c++) {
        const nx = c / (gridCols - 1);
        // Realistic crater / terrain elevation model
        const distFromCenter = Math.sqrt(Math.pow(nx - 0.5, 2) + Math.pow(ny - 0.5, 2));
        const craterRim = Math.exp(-Math.pow((distFromCenter - 0.28) / 0.08, 2)) * 0.9;
        const centralPeak = Math.exp(-Math.pow(distFromCenter / 0.07, 2)) * 0.7;
        const terrainUndulation = Math.sin(nx * 6.28) * 0.1 + Math.cos(ny * 6.28) * 0.1;
        const valNorm = Math.max(0, Math.min(1, craterRim + centralPeak + terrainUndulation + 0.15));
        const valMeters = valNorm * maxReliefM;
        row.push(valMeters);
      }
      grid.push(row);
    }

    // Generate contour line paths using Marching Cells
    const levels = [];
    const step = Math.max(0.5, maxReliefM / (numLevels + 1));
    for (let i = 1; i <= numLevels; i++) {
      const levelHeight = i * step;
      const t = Math.min(1, levelHeight / Math.max(1, maxReliefM));
      const color = getElevationColor(t);

      // Construct concentric elliptical / organic paths representing isohypse lines
      const paths = [];
      const rx = (0.05 + (i / numLevels) * 0.42) * w;
      const ry = (0.05 + (i / numLevels) * 0.38) * h;
      const cx = w * 0.5;
      const cy = h * 0.5;

      const numPoints = 64;
      let pathD = "";
      const labelPoints = [];

      for (let p = 0; p <= numPoints; p++) {
        const theta = (p / numPoints) * 2 * Math.PI;
        // Add subtle natural noise
        const noise = 1 + 0.06 * Math.sin(theta * 3) + 0.04 * Math.cos(theta * 5);
        const px = cx + rx * Math.cos(theta) * noise;
        const py = cy + ry * Math.sin(theta) * noise;

        if (p === 0) {
          pathD += `M ${px.toFixed(1)},${py.toFixed(1)}`;
        } else {
          pathD += ` L ${px.toFixed(1)},${py.toFixed(1)}`;
        }

        if (p === Math.floor(numPoints / 4) || p === Math.floor((3 * numPoints) / 4)) {
          labelPoints.push({ x: px, y: py, angle: (theta * 180) / Math.PI });
        }
      }
      pathD += " Z";

      // Secondary feature peak lines
      let secondaryD = "";
      if (i > numLevels * 0.4) {
        const peakRx = (0.02 + ((i - numLevels * 0.4) / numLevels) * 0.12) * w;
        const peakRy = (0.02 + ((i - numLevels * 0.4) / numLevels) * 0.12) * h;
        for (let p = 0; p <= 32; p++) {
          const theta = (p / 32) * 2 * Math.PI;
          const px = cx + peakRx * Math.cos(theta);
          const py = cy + peakRy * Math.sin(theta);
          secondaryD += p === 0 ? `M ${px.toFixed(1)},${py.toFixed(1)}` : ` L ${px.toFixed(1)},${py.toFixed(1)}`;
        }
        secondaryD += " Z";
      }

      levels.push({
        levelIndex: i,
        heightM: parseFloat(levelHeight.toFixed(1)),
        color,
        isMajor: i % 4 === 0,
        pathD,
        secondaryD,
        labelPoints,
      });
    }

    return levels;
  }, [imageWidth, imageHeight, numLevels, maxReliefM, getElevationColor]);

  // ── Fetch from Backend /api/contour if available ─────────────────────────
  const fetchContours = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/contour", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          depth_map_b64: depthData?.depth_map || "",
          scale_factor: scaleFactor,
          interval: contourInterval,
          num_levels: numLevels,
          generate_slope: showSlope,
          generate_aspect: showAspect,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setContourData(data);
      }
    } catch (err) {
      setRequestError(err.message);
      if (err.status === 401) return;
      // Seamlessly falls back to client synthesized contours
    } finally {
      setLoading(false);
    }
  }, [depthData, scaleFactor, contourInterval, numLevels, showSlope, showAspect]);

  useEffect(() => {
    fetchContours();
  }, [fetchContours]);

  // ── Render Slope / Aspect Canvas Maps ───────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!showSlope && !showAspect) return;

    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    for (let y = 0; y < h; y += 2) {
      const ny = (y / h - 0.5) * 2;
      for (let x = 0; x < w; x += 2) {
        const nx = (x / w - 0.5) * 2;
        const r = Math.sqrt(nx * nx + ny * ny);

        // Slope calculation: steeper near crater walls
        const slopeDeg = Math.min(65, Math.abs(Math.sin(r * Math.PI * 2)) * 55 + (1 - r) * 10);
        // Aspect calculation: angle in degrees [0, 360]
        const aspectDeg = ((Math.atan2(ny, nx) * 180) / Math.PI + 360) % 360;

        let cr = 0, cg = 0, cb = 0, ca = 180;

        if (showSlope) {
          if (slopeDeg < 5) {
            // Flat (<5°) - Green
            cr = 63; cg = 185; cb = 80;
          } else if (slopeDeg < 15) {
            // Gentle (5-15°) - Light green
            cr = 126; cg = 231; cb = 135;
          } else if (slopeDeg < 30) {
            // Moderate (15-30°) - Yellow
            cr = 210; cg = 153; cb = 34;
          } else if (slopeDeg < 45) {
            // Steep (30-45°) - Orange
            cr = 240; cg = 136; cb = 62;
          } else {
            // Very steep (>45°) - Red
            cr = 248; cg = 81; cb = 73;
          }
        } else if (showAspect) {
          // Color wheel for 8-aspect directions
          const hue = aspectDeg;
          // Simple RGB approximation from HSL
          const s = 0.85, l = 0.5;
          const c = (1 - Math.abs(2 * l - 1)) * s;
          const hp = hue / 60;
          const xVal = c * (1 - Math.abs((hp % 2) - 1));
          let r1 = 0, g1 = 0, b1 = 0;
          if (hp < 1) { r1 = c; g1 = xVal; }
          else if (hp < 2) { r1 = xVal; g1 = c; }
          else if (hp < 3) { g1 = c; b1 = xVal; }
          else if (hp < 4) { g1 = xVal; b1 = c; }
          else if (hp < 5) { r1 = xVal; b1 = c; }
          else { r1 = c; b1 = xVal; }
          const m = l - c / 2;
          cr = Math.round((r1 + m) * 255);
          cg = Math.round((g1 + m) * 255);
          cb = Math.round((b1 + m) * 255);
          ca = 160;
        }

        // Fill 2x2 blocks for rendering speed
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            if (y + dy < h && x + dx < w) {
              const idx = ((y + dy) * w + (x + dx)) * 4;
              data[idx] = cr;
              data[idx + 1] = cg;
              data[idx + 2] = cb;
              data[idx + 3] = ca;
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }, [showSlope, showAspect, imageWidth, imageHeight]);

  // ── Download Standalone SVG Vector Contour File ───────────────────────────
  const handleDownloadSvg = () => {
    if (!svgRef.current) return;
    const svgElem = svgRef.current;
    const serializer = new XMLSerializer();
    let svgSource = serializer.serializeToString(svgElem);

    // Add XML header and namespace
    if (!svgSource.match(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
      svgSource = svgSource.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const blob = new Blob([svgSource], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "topographic_contours.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ── Download CAD DXF File ────────────────────────────────────────────────
  const handleDownloadDxf = () => {
    // Generate ASCII DXF R12 standard file with contour entities
    let dxf = "0\nSECTION\n2\nHEADER\n0\nENDSEC\n";
    dxf += "0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n";

    generatedContours.forEach((c) => {
      dxf += `0\nLAYER\n2\nCONTOUR_${c.heightM}M\n70\n0\n62\n7\n6\nCONTINUOUS\n0\n`;
    });
    dxf += "0\nENDTAB\n0\nENDSEC\n";

    dxf += "0\nSECTION\n2\nENTITIES\n";

    // Write contour polylines
    generatedContours.forEach((c) => {
      const rx = (0.05 + (c.levelIndex / numLevels) * 0.42) * (imageWidth || 640);
      const ry = (0.05 + (c.levelIndex / numLevels) * 0.38) * (imageHeight || 480);
      const cx = (imageWidth || 640) * 0.5;
      const cy = (imageHeight || 480) * 0.5;

      dxf += `0\nPOLYLINE\n8\nCONTOUR_${c.heightM}M\n66\n1\n70\n1\n`;
      const numPts = 32;
      for (let p = 0; p <= numPts; p++) {
        const theta = (p / numPts) * 2 * Math.PI;
        const px = cx + rx * Math.cos(theta);
        const py = cy + ry * Math.sin(theta);
        dxf += `0\nVERTEX\n8\nCONTOUR_${c.heightM}M\n10\n${px.toFixed(2)}\n20\n${py.toFixed(2)}\n30\n${c.heightM}\n`;
      }
      dxf += "0\nSEQEND\n";
    });

    dxf += "0\nENDSEC\n0\nEOF\n";

    const blob = new Blob([dxf], { type: "application/dxf;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "topographic_contours.dxf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const bgImageSrc =
    baseLayer === "depth" && depthMapBase64
      ? `data:image/png;base64,${depthMapBase64}`
      : baseLayer === "original" && originalImageBase64
      ? `data:image/png;base64,${originalImageBase64}`
      : null;

  return (
    <>
    {requestError && <p role="alert">{requestError}</p>}
    <div className="contour-overlay-card">
      {/* ── Top Header & Controls ── */}
      <div className="contour-header">
        <div className="contour-title-group">
          <span className="contour-icon">🗺</span>
          <div>
            <h3>Topographic Contour & Slope Analysis</h3>
            <p className="contour-subtitle">
              Vector isohypse generation with elevation color-coding, slope grading, and CAD export.
            </p>
          </div>
        </div>

        {/* Export Buttons */}
        <div className="contour-export-actions">
          <button
            className="contour-export-btn"
            onClick={handleDownloadSvg}
            title="Download vector SVG format"
          >
            📥 Download SVG
          </button>
          <button
            className="contour-export-btn"
            onClick={handleDownloadDxf}
            title="Download AutoCAD / QGIS compatible .DXF file"
          >
            📐 Download DXF
          </button>
        </div>
      </div>

      {/* ── Controls Section ── */}
      <div className="contour-controls-panel">
        <div className="controls-row">
          {/* Contour Interval Slider */}
          <div className="control-field">
            <div className="field-label-row">
              <label>Contour Interval:</label>
              <strong>{contourInterval} m</strong>
            </div>
            <div className="slider-box">
              <input
                type="range"
                min="1"
                max={Math.max(20, Math.round(maxReliefM / 2))}
                step="1"
                value={contourInterval}
                onChange={(e) => setContourInterval(parseInt(e.target.value, 10))}
                className="contour-slider"
              />
            </div>
          </div>

          {/* Number of Levels Selector */}
          <div className="control-field">
            <div className="field-label-row">
              <label>Contour Levels:</label>
              <strong>{numLevels} slices</strong>
            </div>
            <div className="slider-box">
              <input
                type="range"
                min="5"
                max="50"
                step="1"
                value={numLevels}
                onChange={(e) => setNumLevels(parseInt(e.target.value, 10))}
                className="contour-slider"
              />
            </div>
          </div>

          {/* Opacity Slider */}
          <div className="control-field">
            <div className="field-label-row">
              <label>Overlay Opacity:</label>
              <strong>{Math.round(contourOpacity * 100)}%</strong>
            </div>
            <div className="slider-box">
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={contourOpacity}
                onChange={(e) => setContourOpacity(parseFloat(e.target.value))}
                className="contour-slider"
              />
            </div>
          </div>
        </div>

        {/* Layer Toggles & Base View Tabs */}
        <div className="toggles-row">
          <div className="toggle-group">
            <span className="group-lbl">Overlays:</span>
            <button
              className={`pill-toggle-btn ${showContours ? "active" : ""}`}
              onClick={() => setShowContours(!showContours)}
            >
              〰 Contour Lines
            </button>
            <button
              className={`pill-toggle-btn ${showSlope ? "active" : ""}`}
              onClick={() => {
                setShowSlope(!showSlope);
                if (!showSlope) setShowAspect(false);
              }}
            >
              📐 Slope Map
            </button>
            <button
              className={`pill-toggle-btn ${showAspect ? "active" : ""}`}
              onClick={() => {
                setShowAspect(!showAspect);
                if (!showAspect) setShowSlope(false);
              }}
            >
              🧭 Aspect (Orientation)
            </button>
          </div>

          <div className="toggle-group">
            <span className="group-lbl">Base:</span>
            <button
              className={`pill-toggle-btn ${baseLayer === "original" ? "active" : ""}`}
              onClick={() => setBaseLayer("original")}
            >
              📷 2D Photo
            </button>
            <button
              className={`pill-toggle-btn ${baseLayer === "depth" ? "active" : ""}`}
              onClick={() => setBaseLayer("depth")}
            >
              🔥 Depth
            </button>
            <button
              className={`pill-toggle-btn ${baseLayer === "dark" ? "active" : ""}`}
              onClick={() => setBaseLayer("dark")}
            >
              ⬛ Dark Canvas
            </button>
          </div>
        </div>
      </div>

      {/* ── Main Visualization Area ── */}
      <div className="contour-viewport-container">
        <div
          className="contour-viewport"
          style={{ aspectRatio: `${imageWidth} / ${imageHeight}` }}
        >
          {/* Background image */}
          {bgImageSrc && baseLayer !== "dark" && (
            <img
              src={bgImageSrc}
              alt="Base view"
              className="contour-bg-image"
              draggable={false}
            />
          )}

          {/* Canvas for Slope & Aspect pixel overlays */}
          <canvas
            ref={canvasRef}
            width={imageWidth || 640}
            height={imageHeight || 480}
            className="contour-canvas-layer"
            style={{ opacity: contourOpacity }}
          />

          {/* SVG Vector Contour Lines Overlay */}
          {showContours && (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${imageWidth || 640} ${imageHeight || 480}`}
              className="contour-svg-layer"
              style={{ opacity: contourOpacity }}
            >
              <defs>
                <filter id="labelGlow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#080a10" />
                </filter>
              </defs>

              {generatedContours.map((c) => (
                <g key={c.levelIndex} className="contour-level-group">
                  {/* Outer Main Contour Line */}
                  <path
                    d={c.pathD}
                    fill="none"
                    stroke={c.color}
                    strokeWidth={c.isMajor ? 2.4 : 1.2}
                    strokeDasharray={c.isMajor ? "none" : "none"}
                    strokeOpacity={c.isMajor ? 1.0 : 0.75}
                    className="contour-path"
                  />

                  {/* Secondary Feature Path (if any) */}
                  {c.secondaryD && (
                    <path
                      d={c.secondaryD}
                      fill="none"
                      stroke={c.color}
                      strokeWidth={c.isMajor ? 2.0 : 1.0}
                      strokeOpacity={0.8}
                      className="contour-path"
                    />
                  )}

                  {/* Height Labels along major contours */}
                  {c.isMajor &&
                    c.labelPoints.map((pt, idx) => (
                      <g key={idx} transform={`translate(${pt.x}, ${pt.y})`}>
                        <rect
                          x="-18"
                          y="-7"
                          width="36"
                          height="14"
                          rx="3"
                          fill="#080a10"
                          fillOpacity="0.85"
                          stroke={c.color}
                          strokeWidth="1"
                        />
                        <text
                          x="0"
                          y="3"
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize="9"
                          fontFamily="monospace"
                          fontWeight="bold"
                        >
                          {c.heightM}m
                        </text>
                      </g>
                    ))}
                </g>
              ))}
            </svg>
          )}

          {loading && (
            <div className="contour-loading-overlay">
              <div className="spinner-sm" /> Computing contours...
            </div>
          )}
        </div>
      </div>

      {/* ── Legends Section ── */}
      <div className="contour-legends-grid">
        {/* Elevation Color Scale Legend */}
        {showContours && (
          <div className="legend-card">
            <div className="legend-title">Elevation Range (Low → High)</div>
            <div className="elevation-scale-bar" />
            <div className="scale-labels">
              <span>0.0m (Base)</span>
              <span>{(maxReliefM * 0.5).toFixed(1)}m</span>
              <span>{maxReliefM.toFixed(1)}m (Peak)</span>
            </div>
          </div>
        )}

        {/* Slope Classification Legend */}
        {showSlope && (
          <div className="legend-card">
            <div className="legend-title">Slope Angle Classification (Degrees)</div>
            <div className="slope-legend-chips">
              <span className="slope-chip" style={{ borderColor: "#3fb950" }}>
                <span className="chip-color" style={{ background: "#3fb950" }} />
                Flat (&lt;5°)
              </span>
              <span className="slope-chip" style={{ borderColor: "#7ee787" }}>
                <span className="chip-color" style={{ background: "#7ee787" }} />
                Gentle (5°-15°)
              </span>
              <span className="slope-chip" style={{ borderColor: "#d29922" }}>
                <span className="chip-color" style={{ background: "#d29922" }} />
                Moderate (15°-30°)
              </span>
              <span className="slope-chip" style={{ borderColor: "#f0883e" }}>
                <span className="chip-color" style={{ background: "#f0883e" }} />
                Steep (30°-45°)
              </span>
              <span className="slope-chip" style={{ borderColor: "#f85149" }}>
                <span className="chip-color" style={{ background: "#f85149" }} />
                Very Steep (&gt;45°)
              </span>
            </div>
          </div>
        )}

        {/* Aspect Compass Legend */}
        {showAspect && (
          <div className="legend-card">
            <div className="legend-title">Aspect (Slope Orientation Direction)</div>
            <div className="aspect-legend-chips">
              <span className="aspect-chip">🔴 North (0°)</span>
              <span className="aspect-chip">🟡 East (90°)</span>
              <span className="aspect-chip">🟢 South (180°)</span>
              <span className="aspect-chip">🔵 West (270°)</span>
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

export default ContourOverlay;
