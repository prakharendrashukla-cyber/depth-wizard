import { useAuth } from "./AuthContext";
import { apiFetch } from "./api";
import { cloudMode } from "./supabase/client";
import { saveAnalysis, saveScale } from "./supabase/analyses";
import { useState, useEffect, useLayoutEffect, useCallback, useRef, lazy, Suspense } from "react";
const AnalysisHistory = lazy(() => import("./components/AnalysisHistory"));
import ImageUpload from "./components/ImageUpload";
const SceneViewer = lazy(() => import("./components/SceneViewer"));
import HeightOverlay from "./components/HeightOverlay";
import GCPCalibration from "./components/GCPCalibration";
const ContourOverlay = lazy(() => import("./components/ContourOverlay"));
const VolumePanel = lazy(() => import("./components/VolumePanel"));
const ValidationDashboard = lazy(() => import("./components/ValidationDashboard"));
const UncertaintyView = lazy(() => import("./components/UncertaintyView"));
import ModelSelector from "./components/ModelSelector";
const VideoProcessor = lazy(() => import("./components/VideoProcessor"));
const BatchProcessor = lazy(() => import("./components/BatchProcessor"));
const PDFExport = lazy(() => import("./components/PDFExport"));
import DemoTour from "./components/DemoTour";
const SatelliteMetadata = lazy(() => import("./components/SatelliteMetadata"));
import "./App.css";

// ── Tab Configuration ────────────────────────────────────────────────────
const RESULT_TABS = [
  { id: "3d",          label: "🌐 3D View",       icon: "🌐" },
  { id: "contour",     label: "🗺️ Contour",       icon: "🗺️" },
  { id: "volume",      label: "🏗️ Volume",        icon: "🏗️" },
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
  const { user, logout, guest, leaveGuest } = useAuth();
  const [showHistory, setShowHistory] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [savedId, setSavedId] = useState(null);
  const [includePly, setIncludePly] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [sourceFile, setSourceFile] = useState(null);
  const [scalePreset, setScalePreset] = useState("relative");
  const [offlineDemo, setOfflineDemo] = useState(false);
  async function openOfflineDemo() {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/demo/crater-analysis.json");
      if (!response.ok) throw new Error("Offline demo file is unavailable. Keep the local frontend running.");
      setResult(await response.json()); setScaleFactor(1); setScalePreset("relative");
      setSavedId(null); setSourceFile(null); setOfflineDemo(true); setSaveMessage("");
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  async function saveCurrent(data, file) {
    setSaveBusy(true); setSaveMessage("Saving private analysis...");
    try { setSavedId(await saveAnalysis({ result: data, original: file, userId: user.id, includePly })); setSaveMessage("Saved to your private history."); }
    catch (err) { setSaveMessage("Could not save: " + err.message); }
    finally { setSaveBusy(false); }
  }
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
  const analysisTabsRef = useRef(null);
  const tabAnchorTopRef = useRef(null);
  const [showCalibration, setShowCalibration] = useState(false);
  const [showPdfExport, setShowPdfExport] = useState(false);
  const [showDemoTour, setShowDemoTour] = useState(false);
  const [showVideoProcessor, setShowVideoProcessor] = useState(false);
  const [showBatchProcessor, setShowBatchProcessor] = useState(false);

  const handleAnalysisTabChange = (tabId) => {
    tabAnchorTopRef.current = analysisTabsRef.current?.getBoundingClientRect().top ?? null;
    setActiveTab(tabId);
  };

  useLayoutEffect(() => {
    const previousTop = tabAnchorTopRef.current;
    const tabs = analysisTabsRef.current;
    if (previousTop === null || !tabs) return;
    const movement = tabs.getBoundingClientRect().top - previousTop;
    if (Math.abs(movement) > 1) window.scrollBy(0, movement);
    tabAnchorTopRef.current = null;
  }, [activeTab]);

  // ── Model state ────────────────────────────────────────────────────────
  const [currentModel, setCurrentModel] = useState("depth-anything-v2-small");

  // ── Check backend health on mount ──────────────────────────────────────
  useEffect(() => {
    apiFetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setBackendHealth(data);
        if (data?.model_id && data.model_id !== "loading") setCurrentModel(data.model_id);
      })
      .catch(() => setBackendHealth({ status: "offline", model: "unknown" }));
  }, []);

  // ── Image upload handler ───────────────────────────────────────────────
  const handleUpload = async (file, modelOverride = null, { preserveResult = false } = {}) => {
    setLoading(true);
    setError(null);
    if (!preserveResult) {
      setResult(null);
      setSavedId(null); setSaveMessage(""); setSourceFile(file); setScalePreset("relative");
      setOfflineDemo(false);
      setMeasurement(null);
      setShowCalibration(false);
      setActiveTab("3d");
      setScaleFactor(1.0);
    }

    try {
      // Compress huge camera photos in browser (e.g. 20MB -> 150KB) in ~20ms
      const uploadFile = await compressImageForUpload(file);

      const formData = new FormData();
      formData.append("image", uploadFile);
      if (modelOverride || currentModel) {
        formData.append("model", modelOverride || currentModel);
      }

      const res = await apiFetch("/api/estimate", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      const data = await res.json();
      setResult(data);
      if (data.model_id || modelOverride) setCurrentModel(data.model_id || modelOverride);
      setSavedId(null); setSaveMessage(""); setSourceFile(file); setScalePreset("relative");
      setOfflineDemo(false); setMeasurement(null); setShowCalibration(false); setActiveTab("3d");
      setScaleFactor(1.0);
      if (cloudMode && user) await saveCurrent(data, file);
      return true;
    } catch (err) {
      setError(err.message || "Failed to process image.");
      return false;
    } finally {
      setLoading(false);
    }
  };

  // ── Model change handler ───────────────────────────────────────────────
  const handleModelChange = async (modelId) => {
    // Keep the prior result and model selected until the requested model
    // finishes successfully, so a failed download never strands the user.
    if (!sourceFile) {
      if (result) {
        setError("This result has no source image attached. Upload the image again to run a different model.");
        return false;
      }
      setCurrentModel(modelId);
      return true;
    }
    return handleUpload(sourceFile, modelId, { preserveResult: true });
  };

  // ── GCP Calibration complete ───────────────────────────────────────────
  const handleCalibrationComplete = useCallback((newScale) => {
    setScaleFactor(newScale); setScalePreset("custom");
    setShowCalibration(false);
  }, []);

  // ── Demo tour sample loader ────────────────────────────────────────────
  const handleLoadDemoSample = useCallback(async (sampleId) => {
    const res = await apiFetch(`/api/samples/${encodeURIComponent(sampleId)}`);
    if (!res.ok) throw new Error(`Could not load sample image (${res.status}).`);
    const blob = await res.blob();
    const file = new File([blob], sampleId, { type: blob.type || "image/png" });
    const processed = await handleUpload(file);
    if (!processed) throw new Error("Sample processing failed. Check the error message and retry.");
    return true;
  }, [currentModel]);

  // ── Export Handlers ────────────────────────────────────────────────────
  const handleExportPly = async () => {
    if (!result?.point_cloud) return;
    try {
      setIsExporting(true);
      const res = await apiFetch("/api/export/ply", {
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
      const res = await apiFetch("/api/export/report", {
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
            <span style={{ overflowWrap: "anywhere" }}>{user?.email || user?.phone || "Guest · results are not saved"}</span>
            {user && <button className="header-btn" onClick={() => setShowHistory(true)}>My Analyses</button>}
            <button className="header-btn" onClick={() => guest ? leaveGuest() : logout().catch(err => setLogoutError(err.message))}>{guest ? "Sign in" : "Logout"}</button>
            {logoutError && <span role="alert">{logoutError}</span>}
            {cloudMode && <button className="header-btn" disabled={loading || saveBusy} onClick={openOfflineDemo}>Open offline demo (precomputed)</button>}
            {offlineDemo && <span role="status">Precomputed demo · model server not used · scale presets are illustrative</span>}
            {cloudMode && user && <label><input type="checkbox" checked={includePly} disabled={loading || saveBusy} onChange={e => setIncludePly(e.target.checked)} /> Save PLY with next analysis</label>}
            {cloudMode && user && <small>Private history keeps your last 20 analyses; older entries are removed.</small>}
            {saveMessage && <span role="status">{saveMessage}</span>}
            {cloudMode && user && result && !savedId && sourceFile && <button className="header-btn" disabled={saveBusy} onClick={() => saveCurrent(result, sourceFile)}>Retry saving</button>}
            {cloudMode && savedId && <button className="header-btn" disabled={saveBusy} onClick={async () => {
              setSaveBusy(true);
              try { await saveScale(savedId, scaleFactor, scalePreset); setSaveMessage("Current scale saved."); }
              catch (err) { setSaveMessage(err.message); }
              finally { setSaveBusy(false); }
            }}>Save current scale</button>}
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
          <>
            <div className="pre-upload-model-selector">
              <ModelSelector currentModel={currentModel} onModelChange={handleModelChange} disabled={loading} />
            </div>
            <ImageUpload onUpload={handleUpload} loading={loading} error={error} />
          </>
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
                  disabled={loading || (!!result && !sourceFile)}
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

            {error && <p className="error-msg" role="alert">Model switch failed: {error} The previous result is still available; choose another model to retry.</p>}

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
            <div className="analysis-tabs" ref={analysisTabsRef}>
              {RESULT_TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
                  onClick={() => handleAnalysisTabChange(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ── Tab Content ── */}
            <div className="tab-content">
              <Suspense fallback={<div className="panel-loading" role="status">Loading analysis panel…</div>}>
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
                    onScaleChange={(s, preset = "custom") => { setScaleFactor(s); setScalePreset(preset); }}
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
              </Suspense>
            </div>
          </div>
        )}
      </main>

      {showHistory && <Suspense fallback={null}><AnalysisHistory onClose={() => setShowHistory(false)} onOpen={data => {
        setResult(data); setOfflineDemo(false); setSavedId(data.analysis_id); setSourceFile(null); setScaleFactor(data.scale_factor || 1); setScalePreset(data.scale_preset || "relative"); setActiveTab("3d"); setShowHistory(false);
      }} /></Suspense>}
      {/* ── Modals & Overlays ── */}
      {showPdfExport && <Suspense fallback={null}>
        <PDFExport
          data={result}
          scaleFactor={scaleFactor}
          model={result?.model || currentModel}
          isOpen={showPdfExport}
          onClose={() => setShowPdfExport(false)}
        />
      </Suspense>}

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
            <Suspense fallback={<div className="panel-loading" role="status">Loading video tools…</div>}>
              <VideoProcessor onVideoProcessed={() => setShowVideoProcessor(false)} />
            </Suspense>
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
            <Suspense fallback={<div className="panel-loading" role="status">Loading batch tools…</div>}>
              <BatchProcessor onBatchComplete={(data) => { setResult(data); setScaleFactor(1); setShowBatchProcessor(false); }} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
