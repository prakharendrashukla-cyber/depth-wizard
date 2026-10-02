import { lazy, Suspense, useEffect, useState } from "react";
import { useAuth } from "./AuthContext";
import LoginPage from "./components/LoginPage";
import HeightOverlay from "./components/HeightOverlay";
import "./App.css";

const SceneViewer = lazy(() => import("./components/SceneViewer"));
const AnalysisHistory = lazy(() => import("./components/AnalysisHistory"));

// Reuse the existing browser viewer; this page never calls the analysis API.
export default function PublicDemoApp() {
  const { user, guest, logout, leaveGuest, recovering } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState("split");
  const [scale, setScale] = useState(1);
  const [measurement, setMeasurement] = useState(null);
  const [savedView, setSavedView] = useState(false);

  async function loadDemo(signal) {
    setError("");
    try {
      const response = await fetch("/demo/crater-analysis.json", { signal });
      if (!response.ok) throw new Error("The offline demo is unavailable. Please retry.");
      const result = await response.json();
      setData(result); setScale(1); setMeasurement(null); setSavedView(false);
    } catch (err) { if (err.name !== "AbortError") setError(err.message); }
  }
  useEffect(() => {
    const controller = new AbortController();
    loadDemo(controller.signal);
    return () => controller.abort();
  }, []);

  if (recovering || (showLogin && !user && !guest)) return <LoginPage />;

  return <div className="app">
    <header className="app-header"><div className="header-inner">
      <div className="brand-group"><h1>🧙‍♂️ Depth Wizard</h1><span className="version-tag">Public demo</span></div>
      <p className="subtitle">Single-View Monocular Height Estimation · 3D Reconstruction · Geospatial Intelligence</p>
      <div className="header-actions">
        {user ? <>
          <span style={{ overflowWrap: "anywhere" }}>{user.email}</span>
          <button className="header-btn" onClick={() => setShowHistory(true)}>My Analyses</button>
          <button className="header-btn" onClick={() => logout().catch(err => setError(err.message))}>Logout</button>
        </> : <button className="header-btn" onClick={() => { if (guest) leaveGuest(); setShowLogin(true); }}>Sign in</button>}
        <button className="header-btn" onClick={() => loadDemo()}>Open offline demo (precomputed)</button>
        <span role="status">{savedView ? "Your saved analysis · view only" : "Precomputed demo · no live image processing"}</span>
      </div>
    </div></header>
    <main className="app-main">
      <p>Explore the depth map and interactive 3D viewer. New image, batch, and video analysis are disabled on this website.</p>
      <p>Sign in to view your own saved history. Demo scale presets are illustrative, not measured heights.</p>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {!data ? <p role="status">Loading offline demo…</p> : <div className="result-view">
        <div className="actions-bar">
          <div className="view-mode-tabs">
            <button className={`mode-btn ${viewMode === "split" ? "active" : ""}`} onClick={() => setViewMode("split")}>🖼 Dual View</button>
            <button className={`mode-btn ${viewMode === "3d" ? "active" : ""}`} onClick={() => setViewMode("3d")}>🌐 Full 3D</button>
          </div>
          <span>{data.model} · {savedView ? "saved result" : "offline sample"}</span>
          <a className="export-btn" href={`data:image/png;base64,${data.depth_map}`} download="depth-demo.png">📥 Depth (.PNG)</a>
        </div>
        {viewMode === "split" && <div className="comparison-strip">
          <div className="strip-card"><div className="strip-header"><span>📷 Input 2D Image</span></div><div className="strip-img-wrapper"><img className="strip-img" src={`data:image/png;base64,${data.original_image}`} alt="Original" /></div></div>
          <div className="strip-card"><div className="strip-header"><span>🔥 Precomputed Depth Map</span></div><div className="strip-img-wrapper"><img className="strip-img" src={`data:image/png;base64,${data.depth_map}`} alt="Depth Map" /></div></div>
        </div>}
        <Suspense fallback={<p role="status">Loading 3D viewer…</p>}>
          <div className={`viewer-container ${viewMode === "3d" ? "full-height" : ""}`}><SceneViewer data={data} scaleFactor={scale} onMeasurementChange={setMeasurement} /></div>
        </Suspense>
        <HeightOverlay data={data} scaleFactor={scale} onScaleChange={setScale} measurement={measurement} />
      </div>}
    </main>
    {showHistory && user && <Suspense fallback={<p role="status">Loading private history…</p>}>
      <AnalysisHistory onClose={() => setShowHistory(false)} onOpen={result => {
        setData(result); setScale(result.scale_factor || 1); setMeasurement(null); setSavedView(true); setShowHistory(false);
      }} />
    </Suspense>}
  </div>;
}
