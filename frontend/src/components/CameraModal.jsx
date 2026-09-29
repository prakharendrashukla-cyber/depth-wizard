import React, { useState, useRef, useEffect, useCallback } from "react";
import "./CameraModal.css";

function CameraModal({ isOpen, onClose, onCapture }) {
  const [stream, setStream] = useState(null);
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [capturedImage, setCapturedImage] = useState(null);
  const [error, setError] = useState(null);
  const [facingMode, setFacingMode] = useState("environment"); // "user" | "environment"
  const [flash, setFlash] = useState(false);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // ── Stop active stream helper ──────────────────────────────────────────
  const stopStream = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
  }, [stream]);

  // ── Start video stream ────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    stopStream();
    setError(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("Camera API (getUserMedia) is not supported in this browser or requires HTTPS / localhost.");
      return;
    }

    try {
      const constraints = {
        video: selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId } }
          : {
              facingMode: { ideal: facingMode },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
        audio: false,
      };

      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(mediaStream);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.play().catch(() => {});
      }

      // Enumerate cameras
      try {
        const deviceList = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = deviceList.filter((d) => d.kind === "videoinput");
        setDevices(videoInputs);
        if (!selectedDeviceId && videoInputs.length > 0) {
          const activeTrack = mediaStream.getVideoTracks()[0];
          const activeSettings = activeTrack ? activeTrack.getSettings() : null;
          if (activeSettings?.deviceId) {
            setSelectedDeviceId(activeSettings.deviceId);
          }
        }
      } catch {}
    } catch (err) {
      console.error("Camera access error:", err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setError("Camera permission denied. Please allow camera access in your browser settings.");
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        setError("No camera device detected on this system.");
      } else {
        setError(`Unable to access camera: ${err.message || err.name}`);
      }
    }
  }, [selectedDeviceId, facingMode, stopStream]);

  // ── Start camera on modal open ─────────────────────────────────────────
  useEffect(() => {
    if (isOpen) {
      setCapturedImage(null);
      startCamera();
    } else {
      stopStream();
    }
    return () => {
      stopStream();
    };
  }, [isOpen]);

  // ── Switch facing mode ─────────────────────────────────────────────────
  const toggleFacingMode = () => {
    const nextMode = facingMode === "environment" ? "user" : "environment";
    setFacingMode(nextMode);
    setSelectedDeviceId(""); // clear exact device ID to let facingMode pick
  };

  // ── Take photo snapshot ────────────────────────────────────────────────
  const handleSnap = () => {
    if (!videoRef.current || !canvasRef.current) return;

    // Trigger flash animation
    setFlash(true);
    setTimeout(() => setFlash(false), 200);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Draw frame
      ctx.drawImage(video, 0, 0, width, height);

      // Convert to blob and data URL
      canvas.toBlob(
        (blob) => {
          if (blob) {
            const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
            setCapturedImage({
              blob,
              dataUrl,
              width,
              height,
            });
          }
        },
        "image/jpeg",
        0.95
      );
    }
  };

  // ── Confirm photo and pass back ────────────────────────────────────────
  const handleUsePhoto = () => {
    if (!capturedImage) return;
    const filename = `realtime_capture_${Date.now()}.jpg`;
    const file = new File([capturedImage.blob], filename, { type: "image/jpeg" });
    stopStream();
    onCapture(file);
    onClose();
  };

  // ── Retake photo ───────────────────────────────────────────────────────
  const handleRetake = () => {
    setCapturedImage(null);
    if (videoRef.current && stream) {
      videoRef.current.play().catch(() => {});
    }
  };

  const handleClose = () => {
    stopStream();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="camera-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="camera-modal-panel">
        {/* ── Header ── */}
        <div className="camera-modal-header">
          <div className="camera-header-title">
            <span className="camera-live-dot" />
            <h3>📷 Real-Time Camera Viewfinder</h3>
          </div>
          <button className="camera-close-btn" onClick={handleClose} title="Close Camera">
            ✕
          </button>
        </div>

        {/* ── Viewfinder Body ── */}
        <div className="camera-viewfinder-container">
          {error ? (
            <div className="camera-error-box">
              <span className="error-icon">⚠️</span>
              <p className="error-title">Camera Unavailable</p>
              <p className="error-desc">{error}</p>
              <button className="camera-retry-btn" onClick={startCamera}>
                🔄 Retry Camera
              </button>
            </div>
          ) : (
            <div className="camera-viewport">
              {/* Flash effect */}
              {flash && <div className="camera-flash-overlay" />}

              {/* Live Video */}
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`camera-video-element ${capturedImage ? "hidden" : ""}`}
              />

              {/* Captured Image Preview */}
              {capturedImage && (
                <img
                  src={capturedImage.dataUrl}
                  alt="Captured snapshot"
                  className="camera-snapshot-preview"
                />
              )}

              {/* Hidden Canvas for capture */}
              <canvas ref={canvasRef} style={{ display: "none" }} />

              {/* Viewfinder HUD Target Reticle */}
              {!capturedImage && !error && (
                <div className="viewfinder-hud">
                  <div className="hud-corner top-left" />
                  <div className="hud-corner top-right" />
                  <div className="hud-corner bottom-left" />
                  <div className="hud-corner bottom-right" />
                  <div className="hud-crosshair" />
                  <div className="hud-banner">📐 Align structure or terrain inside grid</div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Camera Toolbar Controls ── */}
        <div className="camera-controls-bar">
          {!error && !capturedImage && (
            <div className="camera-tools-left">
              {devices.length > 1 ? (
                <select
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="camera-select"
                  title="Switch Video Input Device"
                >
                  {devices.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              ) : (
                <button className="camera-tool-btn" onClick={toggleFacingMode} title="Flip Camera">
                  🔄 {facingMode === "environment" ? "Back Camera" : "Front Camera"}
                </button>
              )}
            </div>
          )}

          {/* Central Action Buttons */}
          <div className="camera-actions-center">
            {!capturedImage ? (
              <button
                className="snap-shutter-btn"
                onClick={handleSnap}
                disabled={!!error || !stream}
                title="Capture Real-Time Photo"
              >
                <div className="shutter-inner" />
              </button>
            ) : (
              <div className="snapshot-decision-buttons">
                <button className="retake-btn" onClick={handleRetake}>
                  ↺ Retake
                </button>
                <button className="use-photo-btn" onClick={handleUsePhoto}>
                  ✓ Process & 3D Reconstruct
                </button>
              </div>
            )}
          </div>

          <div className="camera-tools-right">
            {!capturedImage && (
              <span className="camera-status-pill">
                {stream ? "🟢 720p HD Feed" : "Initializing..."}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CameraModal;
