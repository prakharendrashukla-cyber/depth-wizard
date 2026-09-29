import { useState, useEffect, useCallback } from "react";
import ImageUpload from "./components/ImageUpload";
import SceneViewer from "./components/SceneViewer";
import HeightOverlay from "./components/HeightOverlay";
import GCPCalibration from "./components/GCPCalibration";
import ContourOverlay from "./components/ContourOverlay";
import VolumePanel from "./components/VolumePanel";
import MapView from "./components/MapView";
import ValidationDashboard from "./components/ValidationDashboard";
import UncertaintyView from "./components/UncertaintyView";
import ModelSelector from "./components/ModelSelector";
import VideoProcessor from "./components/VideoProcessor";
import BatchProcessor from "./components/BatchProcessor";
import PDFExport from "./components/PDFExport";
import DemoTour from "./components/DemoTour";
import SatelliteMetadata from "./components/SatelliteMetadata";
import "./App.css";

// ── Tab Configuration ────────────────────────────────────────────────────
const RESULT_TABS = [
  { id: "3d",          label: "🌐 3D View",       icon: "🌐" },
  { id: "contour",     label: "🗺️ Contour",       icon: "🗺️" },
  { id: "volume",      label: "🏗️ Volume",        icon: "🏗️" },
  { id: "map",         label: "🛰️ Map",           icon: "🛰️" },
  { id: "validation",  label: "📊 Validation",    icon: "📊" },
  { id: "uncertainty", label: "🔬 Uncertainty",   icon: "🔬" },
  { id: "satellite",   label: "📡 Satellite",     icon: "📡" },
];

// ── Client-side fast image pre-compression helper ────────────────────────
async function compressImageForUpload(file) {
  // Don't resize videos or GeoTIFFs
  if (
    file.type.startsWith("video/") ||
    file.name.endsWith(".tif") ||
    file.name.endsWith(".tiff")
  ) {
    return file;
  }

  // If already small (< 500KB), return as is
  if (file.size < 500 * 1024) {
    return file;
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX_DIM = 1024;
        let w = img.width;
        let h = img.height;

        if (w > MAX_DIM || h > MAX_DIM) {
          if (w > h) {
            h = Math.round((h * MAX_DIM) / w);
            w = MAX_DIM;
          } else {
            w = Math.round((w * MAX_DIM) / h);
            h = MAX_DIM;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(
          (blob) => {
            if (blob && blob.size < file.size) {
              const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, ".jpg"), {
                type: "image/jpeg",
              });
              resolve(compressedFile);
            } else {
              resolve(file);
            }
          },
          "image/jpeg",
          0.90
        );
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

function App() {
  // ── Core state ─────────────────────────────────────────────────────────
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [scaleFactor, setScaleFactor] = useState(1.0);
  const [measurement, setMeasurement] = useState(null);
  const [backendHealth, setBackendHealth] = useState(null);
  const [isExporting, setIsExporting] = useState(false);

  // ── View state ─────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState("split"); // "split" | "3d"
  const [activeTab, setActiveTab] = useState("3d");
  const [showCalibration, setShowCalibration] = useState(false);
  const [showPdfExport, setShowPdfExport] = useState(false);
  const [showDemoTour, setShowDemoTour] = useState(false);
  const [showVideoProcessor, setShowVideoProcessor] = useState(false);
  const [showBatchProcessor, setShowBatchProcessor] = useState(false);

  // ── Model state ────────────────────────────────────────────────────────
  const [currentModel, setCurrentModel] = useState("depth-anything-v2-small");

  // ── Check backend health on mount ──────────────────────────────────────
  useEffect(() => {
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setBackendHealth(data);
        if (data?.model_id) setCurrentModel(data.model_id);
      })
      .catch(() => setBackendHealth({ status: "offline", model: "unknown" }));
  }, []);

  // ── Image upload handler ───────────────────────────────────────────────
  const handleUpload = async (file, modelOverride = null) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setMeasurement(null);
    setShowCalibration(false);
    setActiveTab("3d");

    // Auto-detect good initial scale for crater images
    const fname = (file.name || "").toLowerCase();
    if (fname.includes("crater") || fname.includes("isro") || fname.includes("lunar") || fname.includes("chandrayaan")) {
      setScaleFactor(250.0);
    } else if (fname.includes("urban") || fname.includes("city") || fname.includes("drone")) {
      setScaleFactor(45.0);
    } else {
      setScaleFactor(10.0);
    }

    try {
      // Compress huge camera photos in browser (e.g. 20MB -> 150KB) in ~20ms
      const uploadFile = await compressImageForUpload(file);

      const formData = new FormData();
      formData.append("image", uploadFile);
      if (modelOverride || currentModel) {
        formData.append("model", modelOverride || currentModel);
      }

      const res = await fetch("/api/estimate", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      const data = await res.json();
      setResult(data);
      if (data.model_id) setCurrentModel(data.model_id);
    } catch (err) {
      setError(err.message || "Failed to process image.");
    } finally {
      setLoading(false);
    }
  };

  // ── Model change handler ───────────────────────────────────────────────
  const handleModelChange = useCallback(async (modelId) => {
    setCurrentModel(modelId);
    // If we have a result, user needs to re-process to use new model
  }, []);

  // ── GCP Calibration complete ───────────────────────────────────────────
  const handleCalibrationComplete = useCallback((newScale) => {
    setScaleFactor(newScale);
    setShowCalibration(false);
  }, []);

  // ── Video processing complete ──────────────────────────────────────────
  const handleVideoProcessed = useCallback((videoData) => {
    setShowVideoProcessor(false);
    // Could load first frame result into main view
  }, []);

  // ── Demo tour sample loader ────────────────────────────────────────────
  const handleLoadDemoSample = useCallback(async (sampleId) => {
    setShowDemoTour(false);
    try {
      const res = await fetch(`/api/samples/${sampleId}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const file = new File([blob], sampleId, { type: blob.type || "image/png" });
      handleUpload(file);
    } catch (err) {
      console.error("Failed to load demo sample:", err);
    }
  }, [currentModel]);

  // ── Export Handlers ────────────────────────────────────────────────────
  const handleExportPly = async () => {
    if (!result?.point_cloud) return;
    try {
      setIsExporting(true);
      const res = await fetch("/api/export/ply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: result.point_cloud.positions,
          colors: result.point_cloud.colors,
          filename: `${result.metadata?.filename || "scene"}_point_cloud.ply`,
        }),
      });
      if (!res.ok) throw new Error("Export PLY failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${result.metadata?.filename || "scene"}_point_cloud.ply`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error exporting PLY: " + err.message);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportDepthMap = () => {
    if (!result?.depth_map) return;
    const a = document.createElement("a");
    a.href = `data:image/png;base64,${result.depth_map}`;
    a.download = `${result.metadata?.filename || "depth"}_colormap.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleExportReport = async () => {
    if (!result?.height_analysis) return;
    try {
      setIsExporting(true);
      const res = await fetch("/api/export/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: result.metadata?.filename || "scene",
          metadata: result.metadata,
          height_analysis: result.height_analysis,
          scale_factor: scaleFactor,
        }),
      });
      if (!res.ok) throw new Error("Export report failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${result.metadata?.filename || "scene"}_report.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error exporting report: " + err.message);
    } finally {
      setIsExporting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* ── Top Header ── */}
      <header className="app-header">
        <div className="header-inner">
          <div className="brand-group">
            <h1>🧙‍♂️ Depth Wizard</h1>
            <span className="version-tag">v1.0 · SIH 2026 ISRO</span>
          </div>
          <p className="subtitle">
            Single-View Monocular Height Estimation · 3D Reconstruction · Geospatial Intelligence
          </p>
          <div className="header-actions">
            {backendHealth && (
              <div className="backend-badge">
                <span className={`status-dot ${backendHealth.status === "ok" ? "online" : "offline"}`} />
                <span>Model: <strong>{backendHealth.model || "Ready"}</strong></span>
              </div>
            )}
            <button className="header-btn tour-btn" onClick={() => setShowDemoTour(true)} title="Guided Demo Tour">
              🎯 Demo Tour
            </button>
            <button className="header-btn batch-btn" onClick={() => setShowBatchProcessor(true)} title="Batch Process Multiple Images">
              📦 Batch Mode
            </button>
            <button className="header-btn video-btn" onClick={() => setShowVideoProcessor(true)} title="Process Video">
              📹 Video
            </button>
          </div>
        </div>
      </header>

      {/* ── Main Workspace ── */}
      <main className="app-main">
        {!result ? (
          <ImageUpload onUpload={handleUpload} loading={loading} error={error} />
        ) : (
          <div className="result-view">
            {/* ── Actions & View Switcher Bar ── */}
            <div className="actions-bar">
              <div className="actions-left">
                <div className="view-mode-tabs">
                  <button
                    className={`mode-btn ${viewMode === "split" ? "active" : ""}`}
                    onClick={() => setViewMode("split")}
                    title="Side-by-side 2D Heatmap & 3D Viewer"
                  >
                    🖼 Dual View
                  </button>
                  <button
                    className={`mode-btn ${viewMode === "3d" ? "active" : ""}`}
                    onClick={() => setViewMode("3d")}
                    title="Expanded 3D Canvas"
                  >
                    🌐 Full 3D
                  </button>
                </div>

                <ModelSelector
                  currentModel={currentModel}
                  onModelChange={handleModelChange}
                />
              </div>

              <div className="export-actions">
                <button className="toolbar-btn calibrate-btn" onClick={() => setShowCalibration(!showCalibration)}
                  title="Ground Control Point Calibration">
                  {showCalibration ? "✕ Close GCP" : "🎯 GCP Calibrate"}
                </button>
                <button className="export-btn" onClick={handleExportPly} disabled={isExporting} title="Download 3D Point Cloud (.PLY)">
                  📥 3D (.PLY)
                </button>
                <button className="export-btn" onClick={handleExportDepthMap} title="Download Depth Heatmap (.PNG)">
                  📥 Depth (.PNG)
                </button>
                <button className="export-btn" onClick={handleExportReport} disabled={isExporting} title="Download JSON Report">
                  📊 Report (.JSON)
                </button>
                <button className="export-btn" onClick={() => setShowPdfExport(true)} title="Generate PDF Report">
                  📄 PDF Report
                </button>
                <button className="reset-btn" onClick={() => { setResult(null); setShowCalibration(false); }}>
                  ← New Image
                </button>
              </div>
            </div>

            {/* ── GCP Calibration Panel (conditionally shown) ── */}
            {showCalibration && (
              <GCPCalibration
                depthMapBase64={result.depth_map}
                originalImageBase64={result.original_image}
                imageWidth={result.metadata?.processed_width}
                imageHeight={result.metadata?.processed_height}
                onCalibrationComplete={handleCalibrationComplete}
              />
            )}

            {/* ── 2D Comparison Strip (in Split View) ── */}
            {viewMode === "split" && (
              <div className="comparison-strip">
                <div className="strip-card">
                  <div className="strip-header">
                    <span>📷 Input 2D Monocular Image</span>
                    <small>{result.metadata?.original_width}x{result.metadata?.original_height}px</small>
                  </div>
                  <div className="strip-img-wrapper">
                    <img src={`data:image/png;base64,${result.original_image}`} alt="Original" className="strip-img" />
                  </div>
                </div>
                <div className="strip-card">
                  <div className="strip-header">
                    <span>🔥 Estimated Depth Map</span>
                    <small>{result.metadata?.depth_time_s}s inference · {result.model || "model"}</small>
                  </div>
                  <div className="strip-img-wrapper">
                    <img src={`data:image/png;base64,${result.depth_map}`} alt="Depth Map" className="strip-img" />
                  </div>
                </div>
              </div>
            )}

            {/* ── Analysis Tabs ── */}
            <div className="analysis-tabs">
              {RESULT_TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ── Tab Content ── */}
            <div className="tab-content">
              {activeTab === "3d" && (
                <>
                  <div className={`viewer-container ${viewMode === "3d" ? "full-height" : ""}`}>
                    <SceneViewer
                      data={result}
                      scaleFactor={scaleFactor}
                      onMeasurementChange={(m) => setMeasurement(m)}
                    />
                  </div>
                  <HeightOverlay
                    data={result}
                    scaleFactor={scaleFactor}
                    onScaleChange={(s) => setScaleFactor(s)}
                    measurement={measurement}
                  />
                </>
              )}

              {activeTab === "contour" && (
                <ContourOverlay
                  depthData={result}
                  scaleFactor={scaleFactor}
                  imageWidth={result.metadata?.processed_width}
                  imageHeight={result.metadata?.processed_height}
                />
              )}

              {activeTab === "volume" && (
                <VolumePanel
                  depthData={result}
                  scaleFactor={scaleFactor}
                  imageWidth={result.metadata?.processed_width}
                  imageHeight={result.metadata?.processed_height}
                />
              )}

              {activeTab === "map" && (
                <MapView
                  geoData={result.geo_metadata || null}
                  depthMapBase64={result.depth_map}
                  gcpPoints={[]}
                  imageWidth={result.metadata?.processed_width}
                  imageHeight={result.metadata?.processed_height}
                />
              )}

              {activeTab === "validation" && (
                <ValidationDashboard
                  estimatedDepthData={result}
                  model={result.model_id || currentModel}
                  scaleFactor={scaleFactor}
                />
              )}

              {activeTab === "uncertainty" && (
                <UncertaintyView
                  originalImageBase64={result.original_image}
                  depthMapBase64={result.depth_map}
                />
              )}

              {activeTab === "satellite" && (
                <SatelliteMetadata
                  geoMetadata={result.geo_metadata || null}
                  model={result.model || "Depth Model"}
                  processingTime={{
                    depth: result.metadata?.depth_time_s,
                    pointcloud: result.metadata?.pointcloud_time_s,
                    height: result.metadata?.height_time_s,
                  }}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── Modals & Overlays ── */}
      {showPdfExport && (
        <PDFExport
          data={result}
          scaleFactor={scaleFactor}
          model={result?.model || currentModel}
          isOpen={showPdfExport}
          onClose={() => setShowPdfExport(false)}
        />
      )}

      {showDemoTour && (
        <DemoTour
          onLoadSample={handleLoadDemoSample}
          isVisible={showDemoTour}
          onClose={() => setShowDemoTour(false)}
        />
      )}

      {showVideoProcessor && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowVideoProcessor(false); }}>
          <div className="modal-panel modal-wide">
            <div className="modal-header">
              <h3>📹 Video / Multi-Frame Processor</h3>
              <button className="modal-close" onClick={() => setShowVideoProcessor(false)}>✕</button>
            </div>
            <VideoProcessor onVideoProcessed={handleVideoProcessed} />
          </div>
        </div>
      )}

      {showBatchProcessor && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowBatchProcessor(false); }}>
          <div className="modal-panel modal-wide">
            <div className="modal-header">
              <h3>📦 Batch Image Processor</h3>
              <button className="modal-close" onClick={() => setShowBatchProcessor(false)}>✕</button>
            </div>
            <BatchProcessor onBatchComplete={() => setShowBatchProcessor(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
