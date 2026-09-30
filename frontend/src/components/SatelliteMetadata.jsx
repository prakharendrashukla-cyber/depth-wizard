import React, { useState, useMemo } from "react";
import "./SatelliteMetadata.css";

/**
 * Built-in benchmark sample metadata presets for demonstration and evaluation
 * when optical images without embedded TIFF tags are inspected.
 */
const SAMPLE_ISRO_PRESETS = {
  chandrayaan2: {
    name: "Chandrayaan-2 TMC-2 (ISRO Lunar)",
    platform: "Chandrayaan-2 Orbiter",
    sensor: "TMC-2 (Terrain Mapping Camera 2)",
    gsd_m: 0.32,
    dimensions: "2048 × 2048 px",
    bands: "1 Band (Panchromatic 0.5 - 0.85 µm)",
    dtype: "uint16 / Normalized Float32",
    capture_date: "2023-08-23 12:34:56 UTC",
    sun_elevation: 32.4,
    sun_azimuth: 145.2,
    incidence_angle: 14.8,
    crs: "IAU 2000 Moon / Equidistant Cylindrical (EPSG: Moon_2000)",
    orbit: "Orbit #4812 (Lunar Polar 100km)",
    look_angle: "0.0° (Nadir Stereo Fore-Aft)",
    processing_level: "Level-1C (Radiometrically & Geometrically Calibrated)",
    agency: "ISRO / ISSDC Bangalore",
    bounds: {
      min_x: 19.4521,
      max_x: 19.6842,
      min_y: -69.3789,
      max_y: -69.1432,
      corners: {
        top_left: [19.4521, -69.1432],
        top_right: [19.6842, -69.1432],
        bottom_right: [19.6842, -69.3789],
        bottom_left: [19.4521, -69.3789],
      },
    },
  },
  cartosat3: {
    name: "Cartosat-3 PAN (ISRO Earth Observation)",
    platform: "Cartosat-3",
    sensor: "Panchromatic (PAN) High Resolution",
    gsd_m: 0.28,
    dimensions: "3000 × 3000 px",
    bands: "1 Band (High-Res Panchromatic)",
    dtype: "uint16 / GeoTIFF",
    capture_date: "2024-02-18 05:12:30 UTC",
    sun_elevation: 54.8,
    sun_azimuth: 138.6,
    incidence_angle: 8.2,
    crs: "WGS 84 / UTM Zone 43N (EPSG:32643)",
    orbit: "Pass #1290 (SSO 505 km)",
    look_angle: "5.4° (Off-Nadir Pitch)",
    processing_level: "Level-2A (Ortho-rectified Standard DEM ready)",
    agency: "ISRO / NRSC Shadnagar",
    bounds: {
      min_x: 77.5812,
      max_x: 77.6254,
      min_y: 12.9641,
      max_y: 13.0125,
      corners: {
        top_left: [77.5812, 13.0125],
        top_right: [77.6254, 13.0125],
        bottom_right: [77.6254, 12.9641],
        bottom_left: [77.5812, 12.9641],
      },
    },
  },
  sentinel2: {
    name: "Sentinel-2 MSI (Copernicus)",
    platform: "Sentinel-2B",
    sensor: "MSI (MultiSpectral Instrument)",
    gsd_m: 10.0,
    dimensions: "10980 × 10980 px",
    bands: "13 Multispectral Bands (VNIR/SWIR)",
    dtype: "uint16 (Reflectance)",
    capture_date: "2024-04-10 09:45:00 UTC",
    sun_elevation: 58.2,
    sun_azimuth: 152.0,
    incidence_angle: 4.1,
    crs: "WGS 84 / UTM Zone 44N (EPSG:32644)",
    orbit: "Relative Orbit R062 (SSO 786 km)",
    look_angle: "2.1°",
    processing_level: "Level-2A (Bottom of Atmosphere BOA)",
    agency: "ESA / Copernicus Programme",
    bounds: {
      min_x: 78.452,
      max_x: 79.548,
      min_y: 17.214,
      max_y: 18.298,
      corners: {
        top_left: [78.452, 18.298],
        top_right: [79.548, 18.298],
        bottom_right: [79.548, 17.214],
        bottom_left: [78.452, 17.214],
      },
    },
  },
};

/**
 * SatelliteMetadata Component
 *
 * Satellite, Sensor, Orbit, Solar Geometry & Geospatial Metadata Display Panel.
 * Includes interactive ISRO branding, processing pipeline diagram, and sample preview modes.
 *
 * Props:
 *   - geoMetadata: object | null -> Parsed GeoTIFF/satellite metadata from backend or props
 *   - model: string -> Current active depth estimator model name
 *   - processingTime: number -> Total pipeline processing latency in milliseconds
 */
function SatelliteMetadata({
  geoMetadata = null,
  model = "Depth Anything V2 (ViT-S)",
  processingTime = 85,
}) {
  // ── State ────────────────────────────────────────────────────────────────
  const [isExpanded, setIsExpanded] = useState(true);
  const [showIsroBranding, setShowIsroBranding] = useState(true);
  const [showSamplePreset, setShowSamplePreset] = useState(true);
  const [selectedPresetKey, setSelectedPresetKey] = useState("chandrayaan2");
  const [copiedKey, setCopiedKey] = useState(null);

  // ── Active Metadata Resolution ───────────────────────────────────────────
  // If actual geoMetadata is supplied, use it; otherwise, use selected preset
  const activeMeta = useMemo(() => {
    if (geoMetadata && Object.keys(geoMetadata).length > 0) {
      const sensorInfo = geoMetadata.sensor_info || {};
      const bounds = geoMetadata.bounds;

      return {
        isReal: true,
        platform:
          sensorInfo.mission ||
          sensorInfo.satellite ||
          geoMetadata.mission ||
          "Earth Observation / Aerial Satellite",
        sensor:
          sensorInfo.sensor ||
          geoMetadata.sensor ||
          "Optical High-Resolution Sensor",
        gsd_m:
          geoMetadata.gsd_m ??
          sensorInfo.spatial_resolution_m ??
          null,
        dimensions:
          geoMetadata.width && geoMetadata.height
            ? `${geoMetadata.width} × ${geoMetadata.height} px`
            : null,
        bands: geoMetadata.bands ? `${geoMetadata.bands} Band(s)` : "Single Band",
        dtype: geoMetadata.dtype || "Float32 / GeoTIFF",
        capture_date:
          geoMetadata.capture_date ||
          sensorInfo.acquisition_date ||
          "Not specified in TIFF tags",
        sun_elevation:
          sensorInfo.sun_elevation ??
          geoMetadata.sun_elevation ??
          null,
        sun_azimuth:
          sensorInfo.sun_azimuth ??
          geoMetadata.sun_azimuth ??
          null,
        incidence_angle:
          sensorInfo.incidence_angle ??
          geoMetadata.incidence_angle ??
          null,
        crs: geoMetadata.crs || "EPSG:4326 (WGS 84 / Geographic)",
        orbit:
          sensorInfo.orbit_number ||
          geoMetadata.orbit ||
          "Polar Synchronous Orbit",
        look_angle:
          sensorInfo.look_angle != null
            ? `${sensorInfo.look_angle}°`
            : "Nadir (0°)",
        processing_level:
          sensorInfo.processing_level ||
          geoMetadata.processing_level ||
          "Level-1C Ortho",
        agency:
          sensorInfo.is_isro || String(geoMetadata.crs).includes("Moon")
            ? "ISRO / SAC / ISSDC"
            : "Remote Sensing Agency",
        bounds: bounds || null,
      };
    }

    const preset = SAMPLE_ISRO_PRESETS[selectedPresetKey] || SAMPLE_ISRO_PRESETS.chandrayaan2;
    return {
      isReal: false,
      isPreset: true,
      ...preset,
    };
  }, [geoMetadata, selectedPresetKey]);

  // ── Solar Condition Evaluator ────────────────────────────────────────────
  const solarCondition = useMemo(() => {
    if (!activeMeta || activeMeta.sun_elevation == null) return null;
    const elev = Number(activeMeta.sun_elevation);
    if (elev >= 60) return { label: "High Solar Altitude (Minimal Shadows)", color: "#3fb950" };
    if (elev >= 35) return { label: "Optimal Terrain Illumination (Standard)", color: "#58a6ff" };
    if (elev >= 15) return { label: "Low Solar Elevation (Pronounced Shadows)", color: "#d29922" };
    return { label: "Graze Angle / Deep Polar Shadows", color: "#bc8cff" };
  }, [activeMeta]);

  // ── Calculated Pipeline Stage Timings ────────────────────────────────────
  const pipelineStages = useMemo(() => {
    let totalMs = 85;
    let dMs = 45;
    let pcMs = 15;
    let hMs = 10;

    if (typeof processingTime === "object" && processingTime !== null) {
      dMs = Math.round((processingTime.depth || 0.045) * 1000);
      pcMs = Math.round((processingTime.pointcloud || 0.015) * 1000);
      hMs = Math.round((processingTime.height || 0.010) * 1000);
      totalMs = Math.max(20, dMs + pcMs + hMs);
    } else {
      const num = Number(processingTime) || 85;
      totalMs = num > 20 ? num : Math.round(num * 1000);
      dMs = Math.round(totalMs * 0.55);
      pcMs = Math.round(totalMs * 0.20);
      hMs = Math.round(totalMs * 0.15);
    }

    const tIngest = Math.max(5, Math.round(totalMs * 0.10));

    return [
      {
        id: "input",
        stepNum: "01",
        name: "Image / GeoTIFF",
        subtitle: "Raster Ingestion & Tags",
        timeMs: tIngest,
        icon: "📷",
        status: "Active",
        tag: "Input",
      },
      {
        id: "model",
        stepNum: "02",
        name: model || "Depth Anything V2",
        subtitle: "Dense Disparity Neural Net",
        timeMs: dMs,
        icon: "🧠",
        status: "Inference",
        tag: "AI Core",
      },
      {
        id: "mesh",
        stepNum: "03",
        name: "3D Point Cloud",
        subtitle: "Mesh & Surface Normals",
        timeMs: pcMs,
        icon: "🌐",
        status: "Computed",
        tag: "WebGL 3D",
      },
      {
        id: "height",
        stepNum: "04",
        name: "Height & Topography",
        subtitle: "GCP Metric Scaling & GIS",
        timeMs: hMs,
        icon: "📐",
        status: "Calibrated",
        tag: "Analytics",
      },
    ];
  }, [processingTime, model]);
  const totalLatencyMs = pipelineStages.reduce((total, stage) => total + stage.timeMs, 0);

  // ── Copy helper ──────────────────────────────────────────────────────────
  const copyToClipboard = (text, key) => {
    if (!text) return;
    navigator.clipboard.writeText(String(text));
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <div className="satellite-meta-card">
      {/* ── Collapsible Card Header ───────────────────────────────────────── */}
      <div className="sat-header" onClick={() => setIsExpanded((prev) => !prev)}>
        <div className="sat-title-group">
          <span className="sat-icon-badge">🛰️</span>
          <div>
            <div className="sat-title-row">
              <h3 className="sat-main-title">Satellite & Sensor Metadata</h3>
              {activeMeta?.isReal && (
                <span className="sat-badge sat-badge-real">✓ GeoTIFF Active</span>
              )}
              {activeMeta?.isPreset && (
                <span className="sat-badge sat-badge-preset">🔬 Sample Preset</span>
              )}
              {!activeMeta && (
                <span className="sat-badge sat-badge-uncalibrated">Standard Raster</span>
              )}
            </div>
            <p className="sat-subtitle">
              ISRO Cartosat / Chandrayaan orbital telemetry, sensor geometry & GIS bounds
            </p>
          </div>
        </div>

        <div className="sat-header-right" onClick={(e) => e.stopPropagation()}>
          {/* Toggle ISRO Branding Button */}
          <button
            type="button"
            className={`sat-mini-toggle-btn ${showIsroBranding ? "active" : ""}`}
            onClick={() => setShowIsroBranding((prev) => !prev)}
            title="Toggle ISRO / SIH 2026 details"
          >
            🇮🇳 ISRO Banner
          </button>

          {/* Accordion Expand/Collapse Indicator */}
          <button
            type="button"
            className="sat-collapse-btn"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-label={isExpanded ? "Collapse metadata" : "Expand metadata"}
          >
            <span className={`chevron-icon ${isExpanded ? "open" : ""}`}>▼</span>
          </button>
        </div>
      </div>

      {/* ── Collapsible Body Container ────────────────────────────────────── */}
      {isExpanded && (
        <div className="sat-body">
          {/* ── 1. ISRO & SIH 2026 Branding Ribbon ────────────────────────── */}
          {showIsroBranding && (
            <div className="isro-branding-section">
              {/* Saffron, White, Green Tricolor Strip */}
              <div className="isro-tricolor-strip" />

              <div className="isro-branding-content">
                <div className="isro-badge-row">
                  <div className="sih-badge">
                    <span className="sih-icon">🇮🇳</span>
                    <span className="sih-text">Smart India Hackathon 2026</span>
                  </div>
                  <div className="isro-ps-tag">
                    <span className="isro-tag-label">ISRO Challenge:</span>
                    <span className="isro-tag-val">Monocular 3D Topography & Height Estimation</span>
                  </div>
                </div>

                <div className="isro-team-info">
                  <div className="isro-info-item">
                    <span className="isro-label">Nodal Organization:</span>
                    <span className="isro-value">ISRO Space Applications Centre (SAC) & NRSC</span>
                  </div>
                  <div className="isro-info-item">
                    <span className="isro-label">GIS Standard:</span>
                    <span className="isro-value">ISRO Bhuvan / VEDAS / IAU Planetary Dem Specs</span>
                  </div>
                  <div className="isro-info-item">
                    <span className="isro-label">Inference Engine:</span>
                    <span className="isro-value">{model} (Depth Wizard Monocular Core)</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── 2. Processing Pipeline Diagram ────────────────────────────── */}
          <div className="sat-pipeline-section">
            <div className="pipeline-section-header">
              <span className="pipeline-title">⚡ Monocular Processing Pipeline Architecture</span>
              <span className="pipeline-total-latency">
                Total Latency: <strong>{totalLatencyMs} ms</strong>
              </span>
            </div>

            <div className="sat-pipeline-flow">
              {pipelineStages.map((stage, idx) => (
                <React.Fragment key={stage.id}>
                  <div className="pipeline-box">
                    <div className="pipeline-box-top">
                      <span className="pipeline-step-badge">{stage.stepNum}</span>
                      <span className="pipeline-stage-tag">{stage.tag}</span>
                    </div>
                    <div className="pipeline-box-main">
                      <span className="pipeline-box-icon">{stage.icon}</span>
                      <div className="pipeline-box-info">
                        <span className="pipeline-box-name">{stage.name}</span>
                        <span className="pipeline-box-sub">{stage.subtitle}</span>
                      </div>
                    </div>
                    <div className="pipeline-box-footer">
                      <span className="pipeline-time-badge">⏱️ {stage.timeMs} ms</span>
                      <span className="pipeline-status-badge">{stage.status}</span>
                    </div>
                  </div>

                  {idx < pipelineStages.length - 1 && (
                    <div className="pipeline-arrow-connector">
                      <div className="arrow-line" />
                      <span className="arrow-head">▶</span>
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* ── 3. Metadata Display OR Placeholder ────────────────────────── */}
          {activeMeta ? (
            <div className="sat-metadata-grid">
              {/* Section A: Sensor & Mission Info */}
              <div className="sat-meta-block">
                <div className="meta-block-header">
                  <span className="block-icon">🛰️</span>
                  <h4>Sensor & Satellite Platform</h4>
                </div>
                <div className="meta-block-content">
                  <div className="meta-field">
                    <span className="field-label">Satellite Platform:</span>
                    <span className="field-value highlight-blue">{activeMeta.platform}</span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Sensor Instrument:</span>
                    <span className="field-value">{activeMeta.sensor}</span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Spatial Resolution (GSD):</span>
                    <span className="field-value highlight-green">
                      {activeMeta.gsd_m != null ? `${activeMeta.gsd_m} m / pixel` : "Relative (Unscaled)"}
                    </span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Spectral Bands & Dtype:</span>
                    <span className="field-value">{activeMeta.bands} • {activeMeta.dtype}</span>
                  </div>
                </div>
              </div>

              {/* Section B: Solar & Acquisition Geometry */}
              <div className="sat-meta-block">
                <div className="meta-block-header">
                  <span className="block-icon">☀️</span>
                  <h4>Acquisition & Solar Geometry</h4>
                </div>
                <div className="meta-block-content">
                  <div className="meta-field">
                    <span className="field-label">Capture Timestamp:</span>
                    <span className="field-value">{activeMeta.capture_date}</span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Sun Elevation Angle:</span>
                    <span className="field-value">
                      {activeMeta.sun_elevation != null ? `${activeMeta.sun_elevation}°` : "N/A"}
                    </span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Sun Azimuth Angle:</span>
                    <span className="field-value">
                      {activeMeta.sun_azimuth != null ? `${activeMeta.sun_azimuth}° (from North)` : "N/A"}
                    </span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Incidence / Look Angle:</span>
                    <span className="field-value">
                      {activeMeta.incidence_angle != null ? `${activeMeta.incidence_angle}°` : "N/A"}
                    </span>
                  </div>
                  {solarCondition && (
                    <div className="solar-condition-pill" style={{ borderColor: solarCondition.color }}>
                      <span className="solar-dot" style={{ backgroundColor: solarCondition.color }} />
                      <span>{solarCondition.label}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Section C: Geospatial & Projection Bounds */}
              <div className="sat-meta-block">
                <div className="meta-block-header">
                  <span className="block-icon">🗺️</span>
                  <h4>Geospatial Reference & Bounds</h4>
                </div>
                <div className="meta-block-content">
                  <div className="meta-field">
                    <span className="field-label">Coordinate System (CRS):</span>
                    <span className="field-value highlight-purple" title={activeMeta.crs}>
                      {activeMeta.crs}
                    </span>
                  </div>
                  {activeMeta.dimensions && (
                    <div className="meta-field">
                      <span className="field-label">Raster Dimensions:</span>
                      <span className="field-value">{activeMeta.dimensions}</span>
                    </div>
                  )}
                  {activeMeta.bounds && (
                    <div className="bounds-subcard">
                      <div className="bounds-header">
                        <span className="bounds-title">Bounding Box Extents:</span>
                        <button
                          type="button"
                          className="copy-bounds-btn"
                          onClick={() =>
                            copyToClipboard(
                              JSON.stringify(activeMeta.bounds, null, 2),
                              "bounds"
                            )
                          }
                        >
                          {copiedKey === "bounds" ? "✓ Copied" : "📋 Copy GeoJSON"}
                        </button>
                      </div>
                      <div className="bounds-grid">
                        <div className="bound-point">
                          <span className="pt-tag">Top-Left:</span>
                          <span className="pt-val">
                            {activeMeta.bounds.corners?.top_left
                              ? `${activeMeta.bounds.corners.top_left[0]}, ${activeMeta.bounds.corners.top_left[1]}`
                              : `[${activeMeta.bounds.min_x}, ${activeMeta.bounds.max_y}]`}
                          </span>
                        </div>
                        <div className="bound-point">
                          <span className="pt-tag">Bottom-Right:</span>
                          <span className="pt-val">
                            {activeMeta.bounds.corners?.bottom_right
                              ? `${activeMeta.bounds.corners.bottom_right[0]}, ${activeMeta.bounds.corners.bottom_right[1]}`
                              : `[${activeMeta.bounds.max_x}, ${activeMeta.bounds.min_y}]`}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Section D: Orbit & Processing Lineage */}
              <div className="sat-meta-block">
                <div className="meta-block-header">
                  <span className="block-icon">🛰️</span>
                  <h4>Orbit, Telemetry & Lineage</h4>
                </div>
                <div className="meta-block-content">
                  <div className="meta-field">
                    <span className="field-label">Orbit / Pass Identifier:</span>
                    <span className="field-value">{activeMeta.orbit}</span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Sensor Look Angle:</span>
                    <span className="field-value">{activeMeta.look_angle}</span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Data Processing Level:</span>
                    <span className="field-value highlight-yellow">{activeMeta.processing_level}</span>
                  </div>
                  <div className="meta-field">
                    <span className="field-label">Data Archive Authority:</span>
                    <span className="field-value">{activeMeta.agency}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* ── Placeholder when no GeoTIFF metadata present ─────────────── */
            <div className="sat-placeholder-card">
              <div className="placeholder-icon-box">
                <span className="placeholder-icon">🛰️</span>
              </div>
              <div className="placeholder-text-block">
                <h4 className="placeholder-title">
                  Upload a GeoTIFF to view satellite metadata
                </h4>
                <p className="placeholder-desc">
                  Georeferenced GeoTIFFs containing standard GDAL / ISRO tags will automatically
                  populate spatial resolution, solar azimuth, sun elevation, and CRS bounds here.
                </p>
                <div className="placeholder-actions">
                  <button
                    type="button"
                    className="preset-explore-btn"
                    onClick={() => {
                      setShowSamplePreset(true);
                      setSelectedPresetKey("chandrayaan2");
                    }}
                  >
                    🔬 Preview Sample ISRO Chandrayaan-2 Metadata
                  </button>
                  <button
                    type="button"
                    className="preset-explore-btn secondary"
                    onClick={() => {
                      setShowSamplePreset(true);
                      setSelectedPresetKey("cartosat3");
                    }}
                  >
                    🛰️ Cartosat-3 Sample
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Sample Preset Selector Bar (If previewing samples) ─────────── */}
          {showSamplePreset && (
            <div className="preset-selector-bar">
              <span className="preset-bar-title">Switch Sample ISRO / Satellite Preset:</span>
              <div className="preset-pill-group">
                {Object.keys(SAMPLE_ISRO_PRESETS).map((key) => {
                  const item = SAMPLE_ISRO_PRESETS[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`preset-pill-btn ${selectedPresetKey === key ? "active" : ""}`}
                      onClick={() => setSelectedPresetKey(key)}
                    >
                      {item.name}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="preset-dismiss-btn"
                onClick={() => setShowSamplePreset(false)}
                title="Hide sample preview"
              >
                ✕ Dismiss Preview
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SatelliteMetadata;
