import React, { useState, useEffect, useCallback, useRef } from "react";
import "./DemoTour.css";

/**
 * Tour step definition list detailing the 8 guided tour stages.
 */
const TOUR_STEPS = [
  {
    id: "welcome",
    stepNumber: 1,
    tag: "SIH 2026 / ISRO Challenge",
    emoji: "🛰️",
    title: "Welcome to Depth Wizard",
    subtitle: "AI Monocular Elevation & 3D Topography Suite",
    description:
      "Depth Wizard transforms single 2D satellite, aerial, and drone imagery into metric 3D elevation models, digital elevation models (DEMs), and interactive point clouds using state-of-the-art vision transformers.",
    keyPoints: [
      "Zero-shot monocular depth estimation without stereo pairs",
      "Sub-meter GCP metric calibration & sensor GSD scaling",
      "Interactive 3D WebGL point cloud & mesh visualization",
      "Longitudinal elevation transects, contour generation & volume analysis",
    ],
    badgeColor: "#58a6ff",
    spotlightTarget: "center",
  },
  {
    id: "upload",
    stepNumber: 2,
    tag: "Step 1: Input Ingestion",
    emoji: "📤",
    title: "Upload Any Satellite or Drone Image",
    subtitle: "GeoTIFF, Optical UAV, or Planetary Rasters",
    description:
      "Drag and drop any optical satellite scene (Cartosat, Sentinel, Landsat, WorldView), UAV drone photo, or planetary GeoTIFF. Multi-band rasters and single-band elevation maps are automatically parsed.",
    keyPoints: [
      "Automatic GeoTIFF affine transform & CRS parsing",
      "Supports 16-bit, 32-bit float, and standard 8-bit RGB rasters",
      "Pre-loaded ISRO Chandrayaan & Urban Drone benchmark samples",
    ],
    badgeColor: "#3fb950",
    spotlightTarget: "upload",
  },
  {
    id: "depth",
    stepNumber: 3,
    tag: "Step 2: AI Disparity Estimation",
    emoji: "🗺️",
    title: "View Your High-Fidelity Depth Map",
    subtitle: "Transformer-based Dense Disparity Maps",
    description:
      "Foundation depth models (Depth Anything V2, ZoeDepth, MiDaS) extract sharp relative elevation gradients, capturing minute terrain variations, crater rims, and building boundaries in under 100ms.",
    keyPoints: [
      "Colormap options: Magma, Viridis, Turbo, Plasma, and Terrain",
      "Epistemic uncertainty & confidence error heatmaps",
      "Interactive side-by-side split view with swipe slider comparison",
    ],
    badgeColor: "#bc8cff",
    spotlightTarget: "depth-map",
  },
  {
    id: "viewer3d",
    stepNumber: 4,
    tag: "Step 3: 3D Visualization",
    emoji: "🌐",
    title: "Explore in Interactive 3D",
    subtitle: "Point Cloud & Mesh WebGL Viewer",
    description:
      "Freely pan, rotate, and zoom around the reconstructed 3D surface. Adjust height extrusion scaling, inspect wireframe topology, and simulate dynamic solar illumination angles.",
    keyPoints: [
      "Full orbit, pan, and first-person camera controls",
      "Dynamic directional sun lighting with realistic ray-traced shadows",
      "Point cloud particle density, size, and mesh normal shaders",
    ],
    badgeColor: "#58a6ff",
    spotlightTarget: "viewer3d",
  },
  {
    id: "calibration",
    stepNumber: 5,
    tag: "Step 4: Metric Calibration",
    emoji: "📐",
    title: "Calibrate Heights with Ground Control Points",
    subtitle: "From Relative Disparity to Physical Meters",
    description:
      "Convert relative depth values into true metric heights (meters) by placing Ground Control Points (GCPs), specifying sensor GSD (m/px), or providing camera flight altitude.",
    keyPoints: [
      "Sub-meter elevation accuracy with single or multi-point GCPs",
      "Least-squares affine regression calibration",
      "Pre-calibrated presets for Cartosat-3, Drone 50m, and Lunar TMC-2",
    ],
    badgeColor: "#d29922",
    spotlightTarget: "calibration",
  },
  {
    id: "topography",
    stepNumber: 6,
    tag: "Step 5: Topographic Analytics",
    emoji: "📊",
    title: "Analyze Topography & Elevation Profiles",
    subtitle: "Cross-Sectional Transects & Volume Calculation",
    description:
      "Draw 2D transect lines across craters, valleys, or buildings to extract cross-sectional elevation profiles, measure rim-to-floor depth, and calculate cut/fill earthwork volumes.",
    keyPoints: [
      "Interactive SVG elevation profile charts with slope markers",
      "Volumetric cut/fill and above-ground terrain calculations",
      "Peak, mean, floor baseline, and relative relief statistical summaries",
    ],
    badgeColor: "#3fb950",
    spotlightTarget: "topography",
  },
  {
    id: "contours",
    stepNumber: 7,
    tag: "Step 6: Terrain Hazards",
    emoji: "🏔️",
    title: "Generate Iso-Contours & Slope Hazard Maps",
    subtitle: "Automated Vector Topography & Steepness Analytics",
    description:
      "Generate iso-elevation contour lines at custom step intervals and calculate 2D slope steepness maps to identify safe lunar landing zones or detect landslide risk zones.",
    keyPoints: [
      "Marching squares vector contour line extraction",
      "Slope gradient heatmaps (0° to 90° slope angle)",
      "Threshold filters for planetary lander safety assessment",
    ],
    badgeColor: "#f85149",
    spotlightTarget: "contours",
  },
  {
    id: "export",
    stepNumber: 8,
    tag: "Step 7: Production Deliverables",
    emoji: "💾",
    title: "Export Your Results & Engineering Reports",
    subtitle: "Geospatial GIS & 3D Deliverables",
    description:
      "Download georeferenced GeoTIFF DEMs, 3D Point Clouds (.ply, .obj, .gltf), high-resolution depth colormaps, interactive standalone 3D HTML reports, and complete engineering PDFs.",
    keyPoints: [
      "Standard 3D formats (.ply, .obj, .gltf) for GIS & CAD tools",
      "32-bit Float GeoTIFF elevation rasters with CRS metadata",
      "Automated PDF Topographic Dossiers with SIH/ISRO branding",
    ],
    badgeColor: "#bc8cff",
    spotlightTarget: "export",
  },
];

/**
 * Pre-loaded demo sample gallery dataset.
 * Matches filenames in backend/sample_images/ exactly.
 */
const DEMO_GALLERY_SAMPLES = [
  {
    id: "isro_crater_terrain.png",
    title: "Chandrayaan Lunar Surface",
    subtitle: "ISRO TMC-2 / OHRC • Moon South Pole",
    description:
      "Impact crater topography with steep rim walls, central peak relief, and shadowed floor elevation profiling.",
    badge: "ISRO Planetary",
    badgeType: "purple",
    stats: "GSD: 0.32m/px • Relief: 420m",
    gradient: "linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #0f172a 100%)",
    icon: "🌕",
  },
  {
    id: "urban_center.png",
    title: "Indian Urban Drone Survey",
    subtitle: "UAV Photogrammetry • Bengaluru Metro",
    description:
      "Dense commercial skyscrapers, multi-tier rooftop structures, and street corridor height extraction.",
    badge: "Drone Survey",
    badgeType: "blue",
    stats: "GSD: 0.05m/px • Altitude: 80m",
    gradient: "linear-gradient(135deg, #082f49 0%, #0369a1 50%, #0f172a 100%)",
    icon: "🏙️",
  },
  {
    id: "disaster_area.png",
    title: "Disaster & Landslide Assessment",
    subtitle: "Uttarakhand Himalayan Valley",
    description:
      "Post-landslide slope failure mapping, debris flow volume calculation, and flood inundation hazard modeling.",
    badge: "Hazard Analysis",
    badgeType: "red",
    stats: "Slope: 48° • Volume: 1.2M m³",
    gradient: "linear-gradient(135deg, #431407 0%, #9a3412 50%, #1c1917 100%)",
    icon: "⚠️",
  },
  {
    id: "mountain_terrain.png",
    title: "Himalayan Mountain Terrain",
    subtitle: "Cartosat-3 • Karakoram Alpine Ridge",
    description:
      "Rugged alpine ridgelines, glacial moraines, valley gradients, and high-altitude contour extraction.",
    badge: "Geomorphology",
    badgeType: "green",
    stats: "Elevation: 4,800m • GSD: 0.28m",
    gradient: "linear-gradient(135deg, #052e16 0%, #15803d 50%, #022c22 100%)",
    icon: "🏔️",
  },
  {
    id: "chandrayaan_lunar_surface.png",
    title: "Lunar High-Res South Pole",
    subtitle: "ISRO Chandrayaan-2 TMC-2 Benchmark",
    description:
      "High-contrast shadowed lunar terrain for permanent shadow region (PSR) elevation mapping.",
    badge: "Planetary DEM",
    badgeType: "purple",
    stats: "GSD: 0.25m/px • Sun Angle: 12°",
    gradient: "linear-gradient(135deg, #18181b 0%, #27272a 50%, #09090b 100%)",
    icon: "🚀",
  },
  {
    id: "indian_cityscape_drone.png",
    title: "Aerial Rooftop Infrastructure",
    subtitle: "Smart City Infrastructure 3D Modeling",
    description:
      "Precision urban block layout with rooftop installations, street corridors, and vertical building facades.",
    badge: "Smart City",
    badgeType: "blue",
    stats: "GSD: 0.08m/px • Altitude: 120m",
    gradient: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #020617 100%)",
    icon: "🏢",
  },
];

/**
 * DemoTour Component
 *
 * Guided interactive walkthrough overlay & pre-loaded demo showcase.
 */
function DemoTour({ onLoadSample, isVisible = false, onClose }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [autoPlay, setAutoPlay] = useState(false);
  const [autoPlayProgress, setAutoPlayProgress] = useState(0);
  const [loadingSampleId, setLoadingSampleId] = useState(null);
  const [activeTab, setActiveTab] = useState("guide"); // "guide" | "samples"

  const autoPlayTimerRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const totalSteps = TOUR_STEPS.length;
  const currentStep = TOUR_STEPS[currentStepIndex];

  // ── Auto-play interval handling (5 seconds per step) ─────────────────────
  const clearAutoPlayTimers = useCallback(() => {
    if (autoPlayTimerRef.current) {
      clearInterval(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    setAutoPlayProgress(0);
  }, []);

  const handleNext = useCallback(() => {
    setCurrentStepIndex((prev) => (prev + 1 < totalSteps ? prev + 1 : 0));
    setAutoPlayProgress(0);
  }, [totalSteps]);

  const handlePrev = useCallback(() => {
    setCurrentStepIndex((prev) => (prev - 1 >= 0 ? prev - 1 : totalSteps - 1));
    setAutoPlayProgress(0);
  }, [totalSteps]);

  const handleJumpToStep = useCallback((idx) => {
    if (idx >= 0 && idx < totalSteps) {
      setCurrentStepIndex(idx);
      setAutoPlayProgress(0);
    }
  }, [totalSteps]);

  // Handle auto-advance timer
  useEffect(() => {
    if (!isVisible || !autoPlay) {
      clearAutoPlayTimers();
      return;
    }

    const stepDurationMs = 5000;
    const intervalTickMs = 50;
    const progressStep = (intervalTickMs / stepDurationMs) * 100;

    progressIntervalRef.current = setInterval(() => {
      setAutoPlayProgress((prev) => {
        if (prev >= 100) {
          handleNext();
          return 0;
        }
        return prev + progressStep;
      });
    }, intervalTickMs);

    return () => {
      clearAutoPlayTimers();
    };
  }, [isVisible, autoPlay, handleNext, clearAutoPlayTimers]);

  // ── Keyboard Navigation (Escape, ArrowRight, ArrowLeft) ──────────────────
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        if (onClose) onClose();
      } else if (e.key === "ArrowRight") {
        handleNext();
      } else if (e.key === "ArrowLeft") {
        handlePrev();
      } else if (e.key === " ") {
        e.preventDefault();
        setAutoPlay((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isVisible, handleNext, handlePrev, onClose]);

  // ── Sample Load Trigger ──────────────────────────────────────────────────
  const handleLoadSample = async (sample) => {
    if (!onLoadSample) return;
    try {
      setLoadingSampleId(sample.id);
      await onLoadSample(sample.id);
      if (onClose) {
        onClose();
      }
    } catch (err) {
      console.error("Error loading demo sample:", err);
    } finally {
      setLoadingSampleId(null);
    }
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className="demo-tour-overlay" role="dialog" aria-modal="true">
      {/* Background Dim Backdrop */}
      <div className="demo-tour-backdrop" onClick={onClose} />

      {/* Main Glassmorphic Modal Dialog */}
      <div className="demo-tour-modal">
        {/* Modal Top Ribbon Header */}
        <div className="tour-modal-header">
          <div className="tour-brand-group">
            <span className="tour-brand-icon">🪄</span>
            <div>
              <h2 className="tour-modal-title">Depth Wizard Feature Tour</h2>
              <p className="tour-modal-subtitle">
                Smart India Hackathon 2026 • ISRO Monocular Topography Challenge
              </p>
            </div>
          </div>

          <div className="tour-header-actions">
            {/* Nav Tabs */}
            <div className="tour-tabs-segmented">
              <button
                type="button"
                className={`tour-tab-btn ${activeTab === "guide" ? "active" : ""}`}
                onClick={() => setActiveTab("guide")}
              >
                🧭 Guided Tour
              </button>
              <button
                type="button"
                className={`tour-tab-btn ${activeTab === "samples" ? "active" : ""}`}
                onClick={() => setActiveTab("samples")}
              >
                🖼️ Demo Gallery ({DEMO_GALLERY_SAMPLES.length})
              </button>
            </div>

            {/* Skip / Close Tour Button */}
            <button
              type="button"
              className="tour-close-btn"
              onClick={onClose}
              title="Close tour (Esc)"
              aria-label="Close tour"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── View Mode: Guided Walkthrough ──────────────────────────────── */}
        {activeTab === "guide" && (
          <div className="tour-guide-container">
            {/* Step Content Card with Fade+Slide Keyframe */}
            <div className="tour-step-card" key={currentStep.id}>
              {/* Step Header Badge & Counter */}
              <div className="tour-step-meta">
                <div className="tour-step-tag" style={{ borderColor: currentStep.badgeColor }}>
                  <span className="tour-tag-dot" style={{ backgroundColor: currentStep.badgeColor }} />
                  {currentStep.tag}
                </div>
                <div className="tour-counter-badge">
                  Step {currentStep.stepNumber} of {totalSteps}
                </div>
              </div>

              {/* Step Hero Section */}
              <div className="tour-step-hero">
                <div className="tour-step-emoji-box">
                  <span className="tour-step-emoji">{currentStep.emoji}</span>
                </div>
                <div className="tour-step-headings">
                  <h3 className="tour-step-title">{currentStep.title}</h3>
                  <h4 className="tour-step-subtitle">{currentStep.subtitle}</h4>
                </div>
              </div>

              {/* Step Description */}
              <p className="tour-step-description">{currentStep.description}</p>

              {/* Step Keypoints Checklist */}
              <div className="tour-keypoints-grid">
                {currentStep.keyPoints.map((point, idx) => (
                  <div key={idx} className="tour-keypoint-item">
                    <span className="tour-check-icon">✓</span>
                    <span className="tour-keypoint-text">{point}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Quick Demo Previews at bottom of step guide */}
            <div className="tour-bottom-dock">
              <div className="tour-dock-header">
                <span className="dock-title">⚡ Instant Demo Samples</span>
                <span className="dock-hint">Click to load and process directly:</span>
              </div>
              <div className="tour-dock-grid">
                {DEMO_GALLERY_SAMPLES.map((sample) => (
                  <div
                    key={sample.id}
                    className="dock-sample-chip"
                    onClick={() => handleLoadSample(sample)}
                  >
                    <span className="dock-chip-icon">{sample.icon}</span>
                    <div className="dock-chip-text">
                      <span className="dock-chip-name">{sample.title}</span>
                      <span className="dock-chip-tag">{sample.badge}</span>
                    </div>
                    <button
                      type="button"
                      className="dock-chip-btn"
                      disabled={loadingSampleId === sample.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleLoadSample(sample);
                      }}
                    >
                      {loadingSampleId === sample.id ? "Loading..." : "Load ➔"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── View Mode: Full Pre-loaded Demo Gallery ────────────────────── */}
        {activeTab === "samples" && (
          <div className="tour-gallery-container">
            <div className="gallery-header-block">
              <h3>🚀 Ready-to-Test ISRO & Aerial Datasets</h3>
              <p>
                Experience Depth Wizard with calibrated high-resolution datasets representing
                planetary craters, urban structures, hazard mitigation, and mountainous terrain.
              </p>
            </div>

            <div className="demo-cards-grid">
              {DEMO_GALLERY_SAMPLES.map((sample) => (
                <div
                  key={sample.id}
                  className="demo-card"
                  onClick={() => handleLoadSample(sample)}
                  style={{ cursor: "pointer" }}
                >
                  {/* Thumbnail Banner with Gradient */}
                  <div
                    className="demo-card-thumb"
                    style={{ background: sample.gradient }}
                  >
                    <div className="demo-thumb-overlay-pattern" />
                    <span className="demo-thumb-icon">{sample.icon}</span>
                    <span className={`demo-thumb-badge badge-${sample.badgeType}`}>
                      {sample.badge}
                    </span>
                  </div>

                  {/* Card Body */}
                  <div className="demo-card-body">
                    <h4 className="demo-card-title">{sample.title}</h4>
                    <span className="demo-card-subtitle">{sample.subtitle}</span>
                    <p className="demo-card-desc">{sample.description}</p>
                    <div className="demo-card-stats">{sample.stats}</div>
                  </div>

                  {/* Card Action Button */}
                  <div className="demo-card-footer">
                    <button
                      type="button"
                      className="demo-load-btn"
                      disabled={loadingSampleId === sample.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleLoadSample(sample);
                      }}
                    >
                      {loadingSampleId === sample.id ? (
                        <>
                          <span className="btn-spinner" /> Loading Sample...
                        </>
                      ) : (
                        <>⚡ Load & Process Scene</>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Modal Footer Controls ───────────────────────────────────────── */}
        <div className="tour-modal-footer">
          {/* Auto-play Checkbox & Timer Progress Bar */}
          <div className="tour-autoplay-group">
            <label className="tour-autoplay-label" title="Automatically advance every 5 seconds">
              <input
                type="checkbox"
                checked={autoPlay}
                onChange={(e) => setAutoPlay(e.target.checked)}
              />
              <span className="autoplay-text">Auto-play tour</span>
            </label>
            {autoPlay && (
              <div className="autoplay-progress-bar" title="Time to next step">
                <div
                  className="autoplay-progress-fill"
                  style={{ width: `${autoPlayProgress}%` }}
                />
              </div>
            )}
          </div>

          {/* Progress Dot Indicators */}
          <div className="tour-dots-indicator" aria-label="Step progress">
            {TOUR_STEPS.map((step, idx) => (
              <button
                key={step.id}
                type="button"
                className={`tour-dot ${idx === currentStepIndex ? "active" : ""} ${
                  idx < currentStepIndex ? "completed" : ""
                }`}
                onClick={() => handleJumpToStep(idx)}
                title={`Jump to step ${idx + 1}: ${step.title}`}
                aria-label={`Step ${idx + 1}`}
              />
            ))}
          </div>

          {/* Navigation Buttons (Prev, Skip, Next/Finish) */}
          <div className="tour-nav-buttons">
            <button
              type="button"
              className="tour-btn tour-btn-secondary"
              onClick={handlePrev}
              disabled={currentStepIndex === 0}
            >
              ← Previous
            </button>

            <button
              type="button"
              className="tour-btn tour-btn-outline"
              onClick={onClose}
            >
              Skip Tour
            </button>

            {currentStepIndex + 1 < totalSteps ? (
              <button
                type="button"
                className="tour-btn tour-btn-primary"
                onClick={handleNext}
              >
                Next Step →
              </button>
            ) : (
              <button
                type="button"
                className="tour-btn tour-btn-finish"
                onClick={onClose}
              >
                ✓ Finish Tour
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default DemoTour;
