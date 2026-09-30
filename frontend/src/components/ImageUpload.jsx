import { apiFetch } from "../api";
import { useCallback, useState, useEffect, useRef } from "react";
import CameraModal from "./CameraModal";
import "./ImageUpload.css";

const DEFAULT_SAMPLES = [
  {
    id: "isro_crater_terrain.png",
    name: "ISRO Lunar Crater Terrain",
    tag: "Planetary / ISRO",
    url: "/api/samples/isro_crater_terrain.png",
  },
  {
    id: "urban_center.png",
    name: "Urban Center & Buildings",
    tag: "Aerial / Structures",
    url: "/api/samples/urban_center.png",
  },
  {
    id: "test_city.png",
    name: "Cityscape Skyview",
    tag: "Architecture / Skyline",
    url: "/api/samples/test_city.png",
  },
  {
    id: "indian_cityscape_drone.png",
    name: "Indian Cityscape Drone",
    tag: "Urban / Drone",
    url: "/api/samples/indian_cityscape_drone.png",
  },
];

const ACCEPTED_FORMATS = [
  "image/png", "image/jpeg", "image/webp", "image/tiff",
  "video/mp4", "video/avi", "video/quicktime", "video/webm",
];

function ImageUpload({ onUpload, loading, error }) {
  const [dragActive, setDragActive] = useState(false);
  const [preview, setPreview] = useState(null);
  const [samples, setSamples] = useState(DEFAULT_SAMPLES);
  const [loadingSample, setLoadingSample] = useState(null);
  const [sampleError, setSampleError] = useState("");
  const [showCamera, setShowCamera] = useState(false);

  // Load every bundled sample so this gallery stays in sync with the backend.
  useEffect(() => {
    apiFetch("/api/samples")
      .then((res) => {
        if (!res.ok) throw new Error(`Sample list request failed (${res.status}).`);
        return res.json();
      })
      .then((data) => {
        if (data?.samples && data.samples.length > 0) {
          const mapped = data.samples.map((s) => ({
            id: s.filename,
            name: s.name,
            tag: s.name.toLowerCase().includes("crater") || s.name.toLowerCase().includes("lunar")
              ? "Planetary / ISRO"
              : "Urban / Aerial",
            url: `/api${s.url}`,
          }));
          // Merge backend samples with defaults (avoid duplicates)
          const ids = new Set(mapped.map((m) => m.id));
          const merged = [...mapped, ...DEFAULT_SAMPLES.filter((d) => !ids.has(d.id))];
          setSamples(merged);
        }
      })
      .catch((err) => setSampleError(err.message || "Could not load the demo datasets."));
  }, []);

  const handleFile = useCallback(
    (file) => {
      if (!file) return;
      const isVideo = file.type.startsWith("video/");
      const isImage = file.type.startsWith("image/") || file.name.endsWith(".tif") || file.name.endsWith(".tiff");

      if (!isVideo && !isImage) {
        return;
      }

      if (isVideo) {
        setPreview({ type: "video", url: URL.createObjectURL(file) });
      } else {
        setPreview({ type: "image", url: URL.createObjectURL(file) });
      }
      onUpload(file);
    },
    [onUpload]
  );

  const handleSampleClick = async (sample) => {
    try {
      setSampleError("");
      setLoadingSample(sample.id);
      const res = await apiFetch(sample.url);
      if (!res.ok) throw new Error(`Failed to fetch ${sample.name} (${res.status}).`);
      const blob = await res.blob();
      const file = new File([blob], sample.id, { type: blob.type || "image/png" });
      setPreview({ type: "image", url: URL.createObjectURL(blob) });
      await onUpload(file);
    } catch (err) {
      console.error(err);
      setSampleError(err.message || "Could not load this demo dataset. Please retry.");
    } finally {
      setLoadingSample(null);
    }
  };

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      handleFile(file);
    },
    [handleFile]
  );

  const onDragOver = (e) => {
    e.preventDefault();
    setDragActive(true);
  };

  const onDragLeave = () => setDragActive(false);

  const onFileSelect = (e) => {
    const file = e.target.files?.[0];
    handleFile(file);
  };

  return (
    <div className="upload-wrapper">
      <div
        className={`drop-zone ${dragActive ? "active" : ""} ${loading ? "loading" : ""}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        {loading ? (
          <div className="spinner-wrapper">
            <div className="spinner" />
            <p className="loading-text">
              ✨ Estimating depth & reconstructing 3D scene…
            </p>
            <span className="loading-sub">
              Running neural depth estimation & calculating elevation models
            </span>
          </div>
        ) : preview ? (
          <div className="preview-container">
            {preview.type === "video" ? (
              <video src={preview.url} className="preview-img" controls muted style={{ maxHeight: "200px" }} />
            ) : (
              <img src={preview.url} alt="Preview" className="preview-img" />
            )}
            <span className="reupload-hint">Drag another image or select below</span>
          </div>
        ) : (
          <>
            <div className="drop-icon">🛰</div>
            <h3>Upload Satellite / Drone / 2D Image or Video</h3>
            <p className="drop-desc">Drag & drop your single 2D image, GeoTIFF, or video file here</p>
            <p className="or">or</p>
            <div className="upload-buttons">
              <label className="file-label">
                📁 Browse Files
                <input
                  type="file"
                  accept="image/*,.tif,.tiff,video/mp4,video/avi,video/quicktime,video/webm"
                  onChange={onFileSelect}
                  hidden
                />
              </label>
              <button
                className="camera-btn"
                onClick={() => setShowCamera(true)}
                title="Open real-time camera viewfinder to capture photo"
              >
                📷 Live Camera
              </button>
            </div>
            <span className="format-hint">Supports PNG, JPEG, WebP, GeoTIFF (.tif), MP4, AVI, MOV & Live Camera</span>
          </>
        )}
      </div>

      {error && <p className="error-msg">⚠ {error}</p>}

      {/* ── Demo Sample Gallery ── */}
      <div className="sample-gallery">
        <div className="sample-gallery-header">
          <span>🎯 Test with bundled demo datasets:</span>
        </div>
        {sampleError && <p className="error-msg" role="alert">{sampleError}</p>}
        <div className="sample-cards">
          {samples.map((s) => (
            <button
              key={s.id}
              className={`sample-card ${loadingSample === s.id ? "loading-sample" : ""}`}
              onClick={() => handleSampleClick(s)}
              disabled={loading}
            >
              <div className="sample-thumbnail-placeholder">
                <img
                  src={s.url}
                  alt={s.name}
                  className="sample-thumb"
                  onError={(e) => {
                    e.target.style.display = "none";
                  }}
                />
              </div>
              <div className="sample-card-info">
                <span className="sample-name">{s.name}</span>
                <span className="sample-tag">{s.tag}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Real-Time Camera Viewfinder Modal ── */}
      <CameraModal
        isOpen={showCamera}
        onClose={() => setShowCamera(false)}
        onCapture={(file) => handleFile(file)}
      />
    </div>
  );
}

export default ImageUpload;
