/**
 * Depth Wizard — MapView Component
 *
 * Geospatial visualization of depth maps and ground control points (GCPs)
 * using Leaflet.js. Supports georeferenced raster overlays, coordinate tracking,
 * metadata inspection, and layer switching without external React wrapper dependencies.
 */

import React, { useEffect, useRef, useState, useMemo } from "react";
import "./MapView.css";

import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Default center coordinates (ISRO Satellite Centre, Bengaluru)
const DEFAULT_CENTER = [12.9716, 77.5946];
const DEFAULT_ZOOM = 13;

/**
 * Format coordinates for human-readable display.
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @returns {string} Formatted lat/lon string
 */
function formatCoordinates(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number" || isNaN(lat) || isNaN(lon)) {
    return "--, --";
  }
  const latDir = lat >= 0 ? "N" : "S";
  const lonDir = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(5)}° ${latDir}, ${Math.abs(lon).toFixed(5)}° ${lonDir}`;
}

/**
 * Normalize bounds object into Leaflet LatLngBounds array [[south, west], [north, east]].
 * Supports [[s, w], [n, e]], [minLat, minLon, maxLat, maxLon], or { north, south, east, west }.
 */
function extractBounds(geoData) {
  if (!geoData) return null;

  // Format 1: geoData.bounds = [[south, west], [north, east]]
  if (Array.isArray(geoData.bounds) && geoData.bounds.length === 2 && Array.isArray(geoData.bounds[0])) {
    return geoData.bounds;
  }

  // Format 2: geoData.bounds = [minLat, minLon, maxLat, maxLon] or [west, south, east, north]
  if (Array.isArray(geoData.bounds) && geoData.bounds.length === 4) {
    const [a, b, c, d] = geoData.bounds;
    return [[Math.min(a, c), Math.min(b, d)], [Math.max(a, c), Math.max(b, d)]];
  }

  // Format 3: bbox object or bounds object with named properties
  const b = geoData.bounds || geoData.bbox || geoData.extent;
  if (b && typeof b === "object") {
    const south = b.south ?? b.minLat ?? b.min_lat ?? b.bottom;
    const north = b.north ?? b.maxLat ?? b.max_lat ?? b.top;
    const west = b.west ?? b.minLon ?? b.min_lon ?? b.left;
    const east = b.east ?? b.maxLon ?? b.max_lon ?? b.right;
    if (south !== undefined && north !== undefined && west !== undefined && east !== undefined) {
      return [[south, west], [north, east]];
    }
  }

  // Format 4: Coordinates center + GSD span estimation
  if (geoData.center && (geoData.gsd || geoData.resolution) && geoData.width && geoData.height) {
    const [cLat, cLon] = Array.isArray(geoData.center) ? geoData.center : [geoData.center.lat, geoData.center.lon];
    const gsdMeters = geoData.gsd || geoData.resolution || 0.5;
    const latSpanDeg = (geoData.height * gsdMeters) / 111320;
    const lonSpanDeg = (geoData.width * gsdMeters) / (111320 * Math.cos((cLat * Math.PI) / 180));
    return [
      [cLat - latSpanDeg / 2, cLon - lonSpanDeg / 2],
      [cLat + latSpanDeg / 2, cLon + lonSpanDeg / 2],
    ];
  }

  return null;
}

export default function MapView({
  geoData = null,
  depthMapBase64 = null,
  originalImageBase64 = null,
  gcpPoints = [],
  imageWidth = null,
  imageHeight = null,
}) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const overlayLayerRef = useRef(null);
  const gcpLayerGroupRef = useRef(null);
  const baseLayersRef = useRef({});

  // State management
  const leafletLoaded = true;
  const [cursorCoords, setCursorCoords] = useState(null);
  const [activeOverlay, setActiveOverlay] = useState("depth"); // "depth" | "original" | "none"
  const [overlayOpacity, setOverlayOpacity] = useState(0.85);
  const [baseMapStyle, setBaseMapStyle] = useState("dark"); // "dark" | "osm" | "satellite"
  const [showGCPs, setShowGCPs] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Parse bounds and geospatial readiness
  const bounds = useMemo(() => extractBounds(geoData), [geoData]);
  const hasGeoreference = !!bounds;

  // ── 2. Initialize Leaflet Map Instance ──────────────────────────────────
  useEffect(() => {
    if (!leafletLoaded || !mapContainerRef.current || mapInstanceRef.current) return;

    if (!L) return;

    try {
      // Determine initial center and zoom
      let initialCenter = DEFAULT_CENTER;
      let initialZoom = DEFAULT_ZOOM;

      if (bounds) {
        initialCenter = [
          (bounds[0][0] + bounds[1][0]) / 2,
          (bounds[0][1] + bounds[1][1]) / 2,
        ];
      }

      // Create Leaflet map instance
      const map = L.map(mapContainerRef.current, {
        center: initialCenter,
        zoom: initialZoom,
        zoomControl: false,
        attributionControl: true,
      });

      // Add Zoom Control to top-right
      L.control.zoom({ position: "topright" }).addTo(map);

      // Define Base Tile Layers
      const darkLayer = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; OpenStreetMap',
          subdomains: "abcd",
          maxZoom: 20,
        }
      );

      const osmLayer = L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 19,
        }
      );

      const satelliteLayer = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          attribution: '&copy; <a href="https://www.esri.com/">Esri</a>, Earthstar Geographics',
          maxZoom: 19,
        }
      );

      baseLayersRef.current = {
        dark: darkLayer,
        osm: osmLayer,
        satellite: satelliteLayer,
      };

      // Add default dark layer
      darkLayer.addTo(map);

      // Create layer group for GCP markers
      const gcpGroup = L.layerGroup().addTo(map);
      gcpLayerGroupRef.current = gcpGroup;

      // Mousemove listener for coordinate tracking
      map.on("mousemove", (e) => {
        setCursorCoords({
          lat: e.latlng.lat,
          lon: e.latlng.lng,
          zoom: map.getZoom(),
        });
      });

      map.on("mouseout", () => {
        setCursorCoords(null);
      });

      mapInstanceRef.current = map;

      // Fit to bounds if available
      if (bounds) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
      }
    } catch (err) {
      console.error("Error initializing Leaflet Map:", err);
      setLoadError("Could not initialize map canvas.");
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [leafletLoaded, bounds]);

  // ── 3. Handle Base Map Layer Switching ──────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !baseLayersRef.current) return;

    Object.entries(baseLayersRef.current).forEach(([key, layer]) => {
      if (key === baseMapStyle) {
        if (!map.hasLayer(layer)) layer.addTo(map);
      } else {
        if (map.hasLayer(layer)) map.removeLayer(layer);
      }
    });
  }, [baseMapStyle]);

  // ── 4. Update Raster Image Overlay (Depth / Original) ────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !L) return;

    // Remove existing overlay
    if (overlayLayerRef.current) {
      map.removeLayer(overlayLayerRef.current);
      overlayLayerRef.current = null;
    }

    if (!bounds || activeOverlay === "none") return;

    // Select image URL/base64
    let imageUrl = null;
    if (activeOverlay === "depth" && depthMapBase64) {
      imageUrl = depthMapBase64.startsWith("data:")
        ? depthMapBase64
        : `data:image/png;base64,${depthMapBase64}`;
    } else if (activeOverlay === "original" && originalImageBase64) {
      imageUrl = originalImageBase64.startsWith("data:")
        ? originalImageBase64
        : `data:image/png;base64,${originalImageBase64}`;
    } else if (activeOverlay === "depth" && !depthMapBase64 && originalImageBase64) {
      imageUrl = originalImageBase64.startsWith("data:")
        ? originalImageBase64
        : `data:image/png;base64,${originalImageBase64}`;
    }

    if (!imageUrl) return;

    try {
      const overlay = L.imageOverlay(imageUrl, bounds, {
        opacity: overlayOpacity,
        interactive: true,
        alt: `${activeOverlay} overlay`,
      });

      overlay.addTo(map);
      overlayLayerRef.current = overlay;
    } catch (err) {
      console.warn("Could not create Leaflet image overlay:", err);
    }
  }, [bounds, activeOverlay, overlayOpacity, depthMapBase64, originalImageBase64]);

  // ── 5. Update GCP Markers ───────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    const gcpGroup = gcpLayerGroupRef.current;
    if (!map || !gcpGroup || !L) return;

    gcpGroup.clearLayers();

    if (!showGCPs || !Array.isArray(gcpPoints) || gcpPoints.length === 0) {
      return;
    }

    gcpPoints.forEach((pt, index) => {
      const lat = pt.lat ?? pt.latitude ?? pt.y;
      const lon = pt.lon ?? pt.lng ?? pt.longitude ?? pt.x;
      const elevation = pt.elevation ?? pt.height ?? pt.z ?? 0;
      const label = pt.id || pt.name || pt.label || `GCP #${index + 1}`;
      const accuracy = pt.accuracy ?? pt.sigma ?? pt.error;

      if (typeof lat !== "number" || typeof lon !== "number") return;

      const marker = L.circleMarker([lat, lon], {
        radius: 8,
        fillColor: "#bc8cff",
        color: "#ffffff",
        weight: 2,
        opacity: 1,
        fillOpacity: 0.85,
        className: "gcp-circle-marker",
      });

      // Styled popup content
      const popupHtml = `
        <div class="gcp-popup-content">
          <div class="gcp-popup-header">
            <span class="gcp-badge">📍 ${label}</span>
          </div>
          <div class="gcp-popup-body">
            <div class="gcp-row">
              <span class="gcp-label">Elevation:</span>
              <strong class="gcp-val">${Number(elevation).toFixed(2)} m</strong>
            </div>
            <div class="gcp-row">
              <span class="gcp-label">Latitude:</span>
              <span class="gcp-val">${lat.toFixed(6)}°</span>
            </div>
            <div class="gcp-row">
              <span class="gcp-label">Longitude:</span>
              <span class="gcp-val">${lon.toFixed(6)}°</span>
            </div>
            ${
              accuracy !== undefined
                ? `<div class="gcp-row">
                    <span class="gcp-label">Residual:</span>
                    <span class="gcp-val">±${Number(accuracy).toFixed(3)} m</span>
                  </div>`
                : ""
            }
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml, { className: "dw-dark-popup" });
      marker.bindTooltip(`📌 ${label} (${Number(elevation).toFixed(1)}m)`, {
        direction: "top",
        offset: [0, -8],
        className: "dw-dark-tooltip",
      });

      gcpGroup.addLayer(marker);
    });
  }, [gcpPoints, showGCPs]);

  // ── Helper: Zoom to image extent ─────────────────────────────────────────
  const handleRecenter = () => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (bounds) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
    } else {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    }
  };

  // Extract metadata details
  const meta = useMemo(() => {
    return {
      gsd: geoData?.gsd || geoData?.resolution || "0.25 m/px",
      crs: geoData?.crs || geoData?.projection || "EPSG:4326 (WGS 84)",
      sensor: geoData?.sensor || geoData?.satellite || geoData?.camera || "ISRO Optical / High-Res UAV",
      captureDate: geoData?.capture_date || geoData?.date || "2026-08-31 09:30 UTC",
      width: imageWidth || geoData?.width || 640,
      height: imageHeight || geoData?.height || 480,
      boundsStr: bounds
        ? `${bounds[0][0].toFixed(4)}, ${bounds[0][1].toFixed(4)} → ${bounds[1][0].toFixed(4)}, ${bounds[1][1].toFixed(4)}`
        : "Unreferenced",
    };
  }, [geoData, bounds, imageWidth, imageHeight]);

  return (
    <div className="mapview-wrapper">
      {/* ── Top Bar Controls ── */}
      <div className="mapview-toolbar">
        <div className="toolbar-left">
          <div className="map-title-group">
            <span className="map-icon">🛰️</span>
            <span className="map-title">Geospatial Overlay & GCP Inspector</span>
          </div>

          <div className="base-style-toggles">
            <button
              className={`tool-btn ${baseMapStyle === "dark" ? "active" : ""}`}
              onClick={() => setBaseMapStyle("dark")}
              title="Dark Cartographic Map"
            >
              🌙 Dark Map
            </button>
            <button
              className={`tool-btn ${baseMapStyle === "satellite" ? "active" : ""}`}
              onClick={() => setBaseMapStyle("satellite")}
              title="High-Res Satellite Imagery"
            >
              🛰️ Satellite
            </button>
            <button
              className={`tool-btn ${baseMapStyle === "osm" ? "active" : ""}`}
              onClick={() => setBaseMapStyle("osm")}
              title="OpenStreetMap Street View"
            >
              🗺️ OSM
            </button>
          </div>
        </div>

        <div className="toolbar-right">
          {/* Overlay Selector */}
          <div className="overlay-selector">
            <span className="tool-label">Raster Overlay:</span>
            <div className="overlay-btn-group">
              <button
                className={`layer-btn ${activeOverlay === "depth" ? "active" : ""}`}
                onClick={() => setActiveOverlay("depth")}
                title="Overlay Estimated Colormapped Depth Map"
              >
                🔥 Depth Map
              </button>
              <button
                className={`layer-btn ${activeOverlay === "original" ? "active" : ""}`}
                onClick={() => setActiveOverlay("original")}
                title="Overlay Original 2D Optical Image"
              >
                📷 Optical Image
              </button>
              <button
                className={`layer-btn ${activeOverlay === "none" ? "active" : ""}`}
                onClick={() => setActiveOverlay("none")}
                title="Hide Raster Overlays"
              >
                🚫 Off
              </button>
            </div>
          </div>

          {/* Opacity Slider */}
          {activeOverlay !== "none" && (
            <div className="opacity-slider-group">
              <span className="tool-label">Alpha: {Math.round(overlayOpacity * 100)}%</span>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={overlayOpacity}
                onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                className="opacity-slider"
              />
            </div>
          )}

          {/* GCP Points Toggle */}
          <button
            className={`tool-btn ${showGCPs ? "active" : ""}`}
            onClick={() => setShowGCPs((prev) => !prev)}
            title="Toggle Ground Control Point markers"
          >
            📍 GCPs ({gcpPoints.length})
          </button>

          {/* Center Extent Button */}
          <button className="tool-btn" onClick={handleRecenter} title="Zoom to Layer Bounds">
            🎯 Recenter
          </button>

          {/* Sidebar Toggle Button */}
          <button
            className={`tool-btn sidebar-toggle ${sidebarOpen ? "active" : ""}`}
            onClick={() => setSidebarOpen((prev) => !prev)}
            title="Toggle Metadata Sidebar"
          >
            {sidebarOpen ? "Hide Details ❯" : "❮ Geo Metadata"}
          </button>
        </div>
      </div>

      {/* ── Main Map Canvas & Sidebar Layout ── */}
      <div className="mapview-body">
        {/* Leaflet Canvas Container */}
        <div className="map-canvas-container">
          <div ref={mapContainerRef} className="leaflet-dom-container" />

          {/* Banner if no georeference bounds found */}
          {!hasGeoreference && (
            <div className="no-geodata-banner">
              <div className="banner-icon">ℹ️</div>
              <div className="banner-text">
                <strong>No geospatial bounding box detected in payload</strong>
                <span>
                  Map is centered in default overview mode. Upload a GeoTIFF or supply CRS/bounds for geographic projection.
                </span>
              </div>
            </div>
          )}

          {/* Error display if leaflet failed */}
          {loadError && (
            <div className="map-error-overlay">
              <span className="error-icon">⚠️</span>
              <span>{loadError}</span>
            </div>
          )}

          {/* Dynamic Bottom Coordinate Bar */}
          <div className="map-coord-bar">
            <div className="coord-item">
              <span className="coord-icon">📍</span>
              <span className="coord-label">Cursor:</span>
              <strong className="coord-value">
                {cursorCoords ? formatCoordinates(cursorCoords.lat, cursorCoords.lon) : "--, --"}
              </strong>
            </div>

            <div className="coord-item">
              <span className="coord-label">Zoom Level:</span>
              <span className="coord-value">{cursorCoords?.zoom ?? (mapInstanceRef.current?.getZoom() || DEFAULT_ZOOM)}</span>
            </div>

            <div className="coord-item">
              <span className="coord-label">CRS:</span>
              <span className="coord-value">{meta.crs}</span>
            </div>

            {hasGeoreference && (
              <div className="coord-item badge-georef">
                <span className="status-dot-green" /> Georeferenced
              </div>
            )}
          </div>
        </div>

        {/* ── Metadata Sidebar Panel ── */}
        {sidebarOpen && (
          <aside className="map-sidebar">
            <div className="sidebar-header">
              <h4>🛰️ Geospatial Metadata</h4>
              <button className="close-btn" onClick={() => setSidebarOpen(false)} title="Close Panel">
                ✕
              </button>
            </div>

            <div className="sidebar-content">
              {/* Raster Info Box */}
              <div className="meta-card">
                <div className="meta-card-title">📐 Spatial Resolution & Grid</div>
                <div className="meta-grid">
                  <div className="meta-field">
                    <span className="label">Ground Sample Dist:</span>
                    <strong className="val text-cyan">{meta.gsd}</strong>
                  </div>
                  <div className="meta-field">
                    <span className="label">Raster Grid Size:</span>
                    <span className="val">{meta.width} × {meta.height} px</span>
                  </div>
                  <div className="meta-field">
                    <span className="label">Reference Datum:</span>
                    <span className="val">{meta.crs}</span>
                  </div>
                </div>
              </div>

              {/* Sensor & Acquisition */}
              <div className="meta-card">
                <div className="meta-card-title">📡 Sensor & Acquisition</div>
                <div className="meta-grid">
                  <div className="meta-field">
                    <span className="label">Payload / Platform:</span>
                    <strong className="val text-purple">{meta.sensor}</strong>
                  </div>
                  <div className="meta-field">
                    <span className="label">Acquisition Timestamp:</span>
                    <span className="val font-mono">{meta.captureDate}</span>
                  </div>
                </div>
              </div>

              {/* Geographic Extent Bounds */}
              <div className="meta-card">
                <div className="meta-card-title">🗺️ Geographic Bounds</div>
                {bounds ? (
                  <div className="bounds-box">
                    <div className="bound-row">
                      <span>North:</span>
                      <code>{bounds[1][0].toFixed(5)}°</code>
                    </div>
                    <div className="bound-row">
                      <span>South:</span>
                      <code>{bounds[0][0].toFixed(5)}°</code>
                    </div>
                    <div className="bound-row">
                      <span>West:</span>
                      <code>{bounds[0][1].toFixed(5)}°</code>
                    </div>
                    <div className="bound-row">
                      <span>East:</span>
                      <code>{bounds[1][1].toFixed(5)}°</code>
                    </div>
                  </div>
                ) : (
                  <p className="no-bounds-text">No bounding coordinate box supplied.</p>
                )}
              </div>

              {/* Ground Control Points (GCP) List */}
              <div className="meta-card">
                <div className="meta-card-title">
                  <span>📍 Control Points (GCPs)</span>
                  <span className="counter-badge">{gcpPoints.length}</span>
                </div>
                {gcpPoints.length > 0 ? (
                  <div className="gcp-list">
                    {gcpPoints.map((pt, i) => {
                      const elev = pt.elevation ?? pt.height ?? pt.z ?? 0;
                      const name = pt.id || pt.name || pt.label || `GCP #${i + 1}`;
                      const lat = pt.lat ?? pt.latitude ?? pt.y;
                      const lon = pt.lon ?? pt.lng ?? pt.longitude ?? pt.x;

                      return (
                        <div key={i} className="gcp-item">
                          <div className="gcp-item-header">
                            <span className="gcp-name">📍 {name}</span>
                            <span className="gcp-height">{Number(elev).toFixed(2)} m</span>
                          </div>
                          {typeof lat !== "number" || typeof lon !== "number" ? null : (
                            <div className="gcp-coords">
                              {lat.toFixed(5)}°, {lon.toFixed(5)}°
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="no-bounds-text">No GCP reference points provided for this scene.</p>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
