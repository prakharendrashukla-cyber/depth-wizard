# Depth Wizard 🧙‍♂️ v1.0

**Single-View Height Estimation, 3D Reconstruction & Geospatial Intelligence Platform**

Given a single 2D image, Depth Wizard estimates a depth map, reconstructs a 3D scene, estimates real-world heights of structures, generates contour maps, computes volumes, and renders an interactive 3D flythrough — all in your browser.

> Built for SIH 2026 · ISRO Problem Statement

---

## ✨ Features

### Core Engine
- 🧠 **Multi-Model Depth Estimation** — Depth Anything V2 (S/B/L), MiDaS v3.1, ZoeDepth, Metric3D, procedural fallback
- 🌐 **Interactive 3D Point Cloud** — Real-time Three.js viewer with orbit controls, cinematic flythrough, and measurement tools
- 📏 **Height Estimation** — Ground baseline detection, peak elevation, relief analysis, elevation profiles
- 🎯 **GCP Calibration** — Click reference points with known heights → auto-calibrate to absolute meters with R² confidence

### Geospatial
- 🛰️ **ISRO Satellite Integration** — GeoTIFF support, Cartosat/Chandrayaan metadata parsing
- 🗺️ **Map View** — Leaflet.js map overlay with lat/long coordinates for georeferenced imagery
- 📡 **Satellite Metadata Panel** — GSD, CRS, sensor info, orbit parameters, ISRO branding

### Analysis
- 📊 **Accuracy Validation Dashboard** — Compare against ground truth DEMs with RMSE, MAE, AbsRel, δ₁ metrics
- 🔬 **Uncertainty Visualization** — Per-pixel confidence heatmap with unreliable region detection
- 🗺️ **Contour Map Generation** — Configurable contour lines + slope/aspect maps, SVG/DXF export
- 🏗️ **Volume Estimation** — Cubic meters above ground + shadow casting with sun angle controls
- 🔄 **Multi-Model Comparison** — Switch models and compare outputs side-by-side

### Processing
- 📹 **Video / Multi-Frame** — Process video frame-by-frame with temporal smoothing
- 📦 **Batch Processing** — Upload multiple images → process all → download ZIP
- 📄 **PDF Report Generation** — Professional multi-page reports with ISRO branding option
- ⚡ **PWA** — Installable on mobile/tablet with camera capture support

### UX
- 🎯 **Live Demo Tour** — Guided walkthrough with pre-loaded impressive examples
- 📐 **3D Measurement Tools** — Point-to-point distance, height difference, area measurement
- 🎨 **Multiple Colormaps** — Photo RGB, Inferno, Topographic Rainbow, Viridis, Turbo

---

## Quick Start

### Prerequisites
- **Python 3.10+** with `pip`
- **Node.js 18+** with `npm`
- A GPU is optional but recommended (CPU inference works, just slower)

### Windows: One-Click Launch
```bash
start.bat
```

### Manual Start

#### 1. Start the Backend
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

#### 2. Start the Frontend
```bash
cd frontend
npm install
npm run dev
```

The UI will be live at `http://localhost:5173`. API docs at `http://localhost:8000/docs`.

---

## Project Structure

```
depth-wizard/
├── backend/                     # FastAPI backend
│   ├── app/
│   │   ├── main.py              # FastAPI app & all routes
│   │   ├── depth.py             # Multi-model depth estimation engine
│   │   ├── mesh.py              # Depth → 3D point cloud
│   │   ├── height.py            # Height estimation & analysis
│   │   ├── calibration.py       # GCP calibration engine
│   │   ├── contour.py           # Contour map & slope/aspect
│   │   ├── volume.py            # Volume estimation & shadow casting
│   │   ├── uncertainty.py       # Confidence/uncertainty estimation
│   │   ├── validation.py        # Accuracy metrics & benchmarks
│   │   ├── video_processor.py   # Video multi-frame processing
│   │   ├── geotiff.py           # GeoTIFF & satellite metadata
│   │   ├── report.py            # PDF report generator
│   │   └── batch.py             # Batch processing engine
│   ├── requirements.txt
│   └── sample_images/
├── frontend/                    # React + Vite + Three.js
│   ├── src/
│   │   ├── App.jsx              # Main app with tabbed navigation
│   │   ├── components/
│   │   │   ├── ImageUpload.jsx       # Image/video/GeoTIFF uploader
│   │   │   ├── SceneViewer.jsx       # 3D point cloud viewer
│   │   │   ├── HeightOverlay.jsx     # Height analysis panel
│   │   │   ├── GCPCalibration.jsx    # Ground control point calibration
│   │   │   ├── ContourOverlay.jsx    # Contour map visualization
│   │   │   ├── VolumePanel.jsx       # Volume & shadow analysis
│   │   │   ├── MapView.jsx           # Leaflet geospatial map
│   │   │   ├── ValidationDashboard.jsx # Accuracy validation
│   │   │   ├── UncertaintyView.jsx   # Confidence visualization
│   │   │   ├── ModelSelector.jsx     # Multi-model switcher
│   │   │   ├── VideoProcessor.jsx    # Video processing UI
│   │   │   ├── BatchProcessor.jsx    # Batch processing UI
│   │   │   ├── PDFExport.jsx         # PDF report config
│   │   │   ├── DemoTour.jsx          # Guided demo tour
│   │   │   └── SatelliteMetadata.jsx # Satellite metadata display
│   │   └── main.jsx
│   ├── public/
│   │   ├── manifest.json        # PWA manifest
│   │   ├── sw.js                # Service worker
│   │   └── icons/
│   ├── package.json
│   └── vite.config.js
├── start.bat                    # Windows one-click launcher
├── share_online.bat             # Cloudflare tunnel sharing
└── README.md
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Server health + model info |
| GET | `/models` | List available depth models |
| GET | `/benchmarks` | Benchmark comparison data |
| GET | `/samples` | List demo images |
| POST | `/estimate` | Core depth estimation |
| POST | `/estimate/video` | Video multi-frame processing |
| POST | `/calibrate` | GCP calibration |
| POST | `/contour` | Contour map generation |
| POST | `/volume` | Volume estimation |
| POST | `/volume/shadow` | Shadow map computation |
| POST | `/uncertainty` | Uncertainty/confidence map |
| POST | `/validate` | Accuracy validation vs ground truth |
| POST | `/export/ply` | 3D point cloud PLY export |
| POST | `/export/report` | JSON analysis report |
| POST | `/export/pdf` | Professional PDF report |
| POST | `/batch` | Batch multi-image processing |
| GET | `/batch/{id}/status` | Batch job progress |
| GET | `/batch/{id}/download` | Batch results ZIP |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python, FastAPI, Uvicorn |
| Depth | Depth Anything V2, MiDaS, ZoeDepth, Metric3D |
| 3D Export | NumPy depth-to-mesh, glTF/PLY output |
| GeoTIFF | tifffile, Pillow |
| Video | OpenCV |
| PDF | ReportLab |
| Validation | SciPy, NumPy |
| Frontend | React 18, Vite, Three.js, react-three-fiber |
| Maps | Leaflet.js + OpenStreetMap |
| PWA | Service Worker, Web App Manifest |
| API | REST — stateless, no auth, no DB |

---

## License

MIT — hack away.
