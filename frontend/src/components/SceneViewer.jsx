import React, { useMemo, useRef, useState, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Stars, Html } from "@react-three/drei";
import * as THREE from "three";
import "./SceneViewer.css";

// ── Base64 decoding helper ───────────────────────────────────────────────
function base64ToFloat32Array(base64) {
  if (!base64) return new Float32Array(0);
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

// ── Colormap Generator Helpers ───────────────────────────────────────────
function getColormappedColors(positions, colormapType, originalColors) {
  const count = positions.length / 3;
  if (colormapType === "rgb" && originalColors && originalColors.length > 0) {
    return originalColors;
  }

  const out = new Float32Array(positions.length);

  // Find elevation range (Z values)
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const z = positions[i * 3 + 2];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const rangeZ = maxZ - minZ > 1e-5 ? maxZ - minZ : 1.0;

  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const z = positions[i * 3 + 2];
    const t = Math.max(0, Math.min(1, (z - minZ) / rangeZ)); // 0 (far) to 1 (near/elevated)

    if (colormapType === "inferno") {
      // Inferno: black/purple -> red -> orange -> yellow
      if (t < 0.25) {
        color.setRGB(t * 2, 0.05, 0.3 + t * 2);
      } else if (t < 0.5) {
        color.setRGB(0.5 + (t - 0.25) * 2, 0.1 + (t - 0.25) * 1.2, 0.5 - (t - 0.25) * 1.5);
      } else if (t < 0.75) {
        color.setRGB(0.9 + (t - 0.5) * 0.4, 0.4 + (t - 0.5) * 1.8, 0.1);
      } else {
        color.setRGB(1.0, 0.85 + (t - 0.75) * 0.6, 0.3 + (t - 0.75) * 2.8);
      }
    } else if (colormapType === "viridis") {
      color.setHSL(0.8 - t * 0.65, 0.85, 0.2 + t * 0.55);
    } else if (colormapType === "elevation") {
      if (t < 0.2) color.setRGB(0.1, 0.2 + t * 3, 0.8);
      else if (t < 0.4) color.setRGB(0.1, 0.8, 0.8 - (t - 0.2) * 3);
      else if (t < 0.7) color.setRGB(0.2 + (t - 0.4) * 2.6, 0.9, 0.1);
      else if (t < 0.9) color.setRGB(1.0, 0.9 - (t - 0.7) * 3, 0.1);
      else color.setRGB(1.0, 0.5 + (t - 0.9) * 5, 0.5 + (t - 0.9) * 5);
    } else if (colormapType === "turbo") {
      color.setHSL((1.0 - t) * 0.7, 0.9, 0.5);
    } else {
      color.setRGB(t, t, t);
    }

    out[i * 3] = color.r;
    out[i * 3 + 1] = color.g;
    out[i * 3 + 2] = color.b;
  }

  return out;
}

// ── Polygon Area Calculation (Shoelace formula in 3D projection) ─────────
function calculatePolygonArea3D(points, scaleFactor) {
  if (points.length < 3) return 0;
  // Scaled coordinates
  const scaled = points.map((p) => ({
    x: p.x * scaleFactor,
    y: p.y * scaleFactor,
    z: p.z * scaleFactor,
  }));

  // Approximate 2D horizontal area using Shoelace formula
  let area2D = 0;
  for (let i = 0; i < scaled.length; i++) {
    const j = (i + 1) % scaled.length;
    area2D += scaled[i].x * scaled[j].y;
    area2D -= scaled[j].x * scaled[i].y;
  }
  area2D = Math.abs(area2D) / 2.0;

  // Compute 3D surface area via triangulation from centroid
  let cx = 0, cy = 0, cz = 0;
  scaled.forEach((p) => { cx += p.x; cy += p.y; cz += p.z; });
  cx /= scaled.length; cy /= scaled.length; cz /= scaled.length;

  let area3D = 0;
  for (let i = 0; i < scaled.length; i++) {
    const p1 = scaled[i];
    const p2 = scaled[(i + 1) % scaled.length];
    const v1 = new THREE.Vector3(p1.x - cx, p1.y - cy, p1.z - cz);
    const v2 = new THREE.Vector3(p2.x - cx, p2.y - cy, p2.z - cz);
    const cross = new THREE.Vector3().crossVectors(v1, v2);
    area3D += cross.length() / 2.0;
  }

  return { area2D: area2D.toFixed(1), area3D: area3D.toFixed(1) };
}

// ── Point Cloud Three.js Component ─────────────────────────────────────────
function PointCloudObject({
  positions,
  colors,
  pointSize,
  isToolActive,
  onPointClick,
}) {
  const pointsRef = useRef();

  const geometry = useMemo(() => {
    if (!positions || positions.length === 0) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }, [positions, colors]);

  if (!geometry) return null;

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      onPointerDown={(e) => {
        if (!isToolActive) return;
        e.stopPropagation();
        if (e.point) {
          onPointClick(e.point.clone());
        }
      }}
    >
      <pointsMaterial
        size={pointSize}
        vertexColors
        sizeAttenuation
        transparent
        opacity={0.95}
      />
    </points>
  );
}

// ── 3D Visualizers: Distance, Polygon & Annotations ───────────────────────
function SceneOverlays({
  mode,
  pointA,
  pointB,
  polyPoints,
  annotations,
  scaleFactor,
  onDeleteAnnotation,
}) {
  // Line Geometry for Distance
  const distLineGeom = useMemo(() => {
    if (!pointA || !pointB) return null;
    return new THREE.BufferGeometry().setFromPoints([pointA, pointB]);
  }, [pointA, pointB]);

  // Polygon Line Loop Geometry
  const polyGeom = useMemo(() => {
    if (polyPoints.length < 2) return null;
    const pts = [...polyPoints];
    if (polyPoints.length >= 3) pts.push(polyPoints[0]); // close loop
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [polyPoints]);

  // Distance Stats
  const distStats = useMemo(() => {
    if (!pointA || !pointB) return null;
    const dx = (pointB.x - pointA.x) * scaleFactor;
    const dy = (pointB.y - pointA.y) * scaleFactor;
    const dz = (pointB.z - pointA.z) * scaleFactor;
    const dist3d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const horizDist = Math.sqrt(dx * dx + dy * dy);
    const heightDelta = Math.abs(dz);
    const midPoint = new THREE.Vector3(
      (pointA.x + pointB.x) / 2,
      (pointA.y + pointB.y) / 2,
      (pointA.z + pointB.z) / 2
    );
    return {
      dist3d: dist3d.toFixed(2),
      horizDist: horizDist.toFixed(2),
      heightDelta: heightDelta.toFixed(2),
      midPoint,
    };
  }, [pointA, pointB, scaleFactor]);

  // Polygon Stats
  const polyStats = useMemo(() => {
    if (polyPoints.length < 3) return null;
    const areas = calculatePolygonArea3D(polyPoints, scaleFactor);
    let cx = 0, cy = 0, cz = 0;
    polyPoints.forEach((p) => { cx += p.x; cy += p.y; cz += p.z; });
    return {
      ...areas,
      center: new THREE.Vector3(cx / polyPoints.length, cy / polyPoints.length, cz / polyPoints.length),
    };
  }, [polyPoints, scaleFactor]);

  return (
    <group>
      {/* ── Distance Measurement ── */}
      {pointA && (
        <mesh position={pointA}>
          <sphereGeometry args={[0.08, 16, 16]} />
          <meshBasicMaterial color="#00ff88" />
        </mesh>
      )}
      {pointB && (
        <mesh position={pointB}>
          <sphereGeometry args={[0.08, 16, 16]} />
          <meshBasicMaterial color="#ff4444" />
        </mesh>
      )}
      {distLineGeom && (
        <line geometry={distLineGeom}>
          <lineBasicMaterial color="#58a6ff" linewidth={3} />
        </line>
      )}
      {distStats && (
        <Html position={distStats.midPoint} center distanceFactor={12}>
          <div className="measurement-badge">
            <div className="badge-title">📏 3D Distance: <strong>{distStats.dist3d}m</strong></div>
            <div className="badge-row"><span>Height ΔH:</span> <strong>{distStats.heightDelta}m</strong></div>
            <div className="badge-row"><span>Horizontal:</span> <strong>{distStats.horizDist}m</strong></div>
          </div>
        </Html>
      )}

      {/* ── Polygon Area Tool ── */}
      {polyPoints.map((pt, idx) => (
        <mesh key={idx} position={pt}>
          <sphereGeometry args={[0.07, 12, 12]} />
          <meshBasicMaterial color="#bc8cff" />
        </mesh>
      ))}
      {polyGeom && (
        <line geometry={polyGeom}>
          <lineBasicMaterial color="#bc8cff" linewidth={2} />
        </line>
      )}
      {polyStats && (
        <Html position={polyStats.center} center distanceFactor={12}>
          <div className="measurement-badge polygon-badge">
            <div className="badge-title" style={{ color: "#bc8cff" }}>📐 Enclosed Area</div>
            <div className="badge-row"><span>Footprint:</span> <strong>{polyStats.area2D} m²</strong></div>
            <div className="badge-row"><span>3D Surface:</span> <strong>{polyStats.area3D} m²</strong></div>
            <div className="badge-row"><span>Vertices:</span> <strong>{polyPoints.length}</strong></div>
          </div>
        </Html>
      )}

      {/* ── 3D Annotation Pins ── */}
      {annotations.map((ann) => (
        <group key={ann.id} position={ann.position}>
          <mesh position={[0, 0, 0]}>
            <sphereGeometry args={[0.06, 12, 12]} />
            <meshBasicMaterial color="#f0883e" />
          </mesh>
          <Html position={[0, 0.15, 0]} center distanceFactor={10}>
            <div className="annotation-pin">
              <div className="pin-header">
                <span>📍 {ann.label}</span>
                <button className="pin-del" onClick={() => onDeleteAnnotation(ann.id)}>✕</button>
              </div>
              {ann.note && <div className="pin-body">{ann.note}</div>}
              <div className="pin-elev">Elev: {(ann.position.z * scaleFactor).toFixed(1)}m</div>
            </div>
          </Html>
        </group>
      ))}
    </group>
  );
}

// ── Cinematic Flythrough Camera Controller ─────────────────────────────────
function FlythroughController({ isFlying, flySpeed, targetView }) {
  const { camera } = useThree();
  const progressRef = useRef(0);

  useEffect(() => {
    if (!targetView) return;
    if (targetView === "top") {
      camera.position.set(0, 0, 7);
      camera.lookAt(0, 0, 0);
    } else if (targetView === "front") {
      camera.position.set(0, -6, 2);
      camera.lookAt(0, 0, 0);
    } else if (targetView === "iso") {
      camera.position.set(4, -4, 4);
      camera.lookAt(0, 0, 0);
    } else if (targetView === "ground") {
      camera.position.set(0, -5, 0.5);
      camera.lookAt(0, 0, 0);
    }
  }, [targetView, camera]);

  useFrame((state, delta) => {
    if (!isFlying) return;
    progressRef.current += delta * 0.25 * flySpeed;
    const t = progressRef.current;
    const radiusX = 4.5;
    const radiusY = 3.5;
    const camX = Math.sin(t) * radiusX;
    const camY = Math.cos(t) * radiusY;
    const camZ = 2.0 + Math.sin(t * 2) * 1.5;
    camera.position.set(camX, camY, camZ);
    camera.lookAt(Math.sin(t + 0.3) * 0.8, Math.cos(t + 0.3) * 0.8, 0);
  });

  return null;
}

// ── Main SceneViewer Component ─────────────────────────────────────────────
function SceneViewer({ data, scaleFactor = 1.0, onMeasurementChange }) {
  const [colormap, setColormap] = useState("rgb");
  const [pointSize, setPointSize] = useState(0.045);
  const [isFlying, setIsFlying] = useState(false);
  const [flySpeed, setFlySpeed] = useState(1.0);
  const [targetView, setTargetView] = useState(null);
  const [activeTool, setActiveTool] = useState("none"); // "none" | "measure" | "polygon" | "annotate"
  const [showGrid, setShowGrid] = useState(true);

  // Tool states
  const [pointA, setPointA] = useState(null);
  const [pointB, setPointB] = useState(null);
  const [polyPoints, setPolyPoints] = useState([]);
  const [annotations, setAnnotations] = useState([]);
  const [gpuInfo, setGpuInfo] = useState("WebGL");

  // Decode raw Point Cloud buffers from backend
  const { rawPositions, originalColors } = useMemo(() => {
    if (!data?.point_cloud) return { rawPositions: null, originalColors: null };
    const pos = base64ToFloat32Array(data.point_cloud.positions);
    const col = base64ToFloat32Array(data.point_cloud.colors);
    return { rawPositions: pos, originalColors: col };
  }, [data]);

  // Center positions for smooth 3D orbiting around [0,0,0]
  const centeredPositions = useMemo(() => {
    if (!rawPositions || rawPositions.length === 0) return null;
    const count = rawPositions.length / 3;
    let sumX = 0, sumY = 0, sumZ = 0;
    for (let i = 0; i < count; i++) {
      sumX += rawPositions[i * 3];
      sumY += rawPositions[i * 3 + 1];
      sumZ += rawPositions[i * 3 + 2];
    }
    const avgX = sumX / count;
    const avgY = sumY / count;
    const avgZ = sumZ / count;

    const out = new Float32Array(rawPositions.length);
    for (let i = 0; i < count; i++) {
      out[i * 3] = rawPositions[i * 3] - avgX;
      out[i * 3 + 1] = rawPositions[i * 3 + 1] - avgY;
      out[i * 3 + 2] = rawPositions[i * 3 + 2] - avgZ;
    }
    return out;
  }, [rawPositions]);

  // Compute active vertex colors based on colormap mode
  const activeColors = useMemo(() => {
    if (!centeredPositions) return null;
    return getColormappedColors(centeredPositions, colormap, originalColors);
  }, [centeredPositions, colormap, originalColors]);

  // Detect GPU / WebGL
  useEffect(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (gl) {
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        if (debugInfo) {
          const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          const shortName = renderer.replace(/ANGLE \(/, "").split(",")[0].replace(/\)/, "");
          setGpuInfo(shortName.length > 25 ? shortName.substring(0, 25) + "…" : shortName);
        }
      }
    } catch {}
  }, []);

  // Handle Point Clicking across all interactive tools
  const handlePointClick = (point) => {
    if (activeTool === "measure") {
      if (!pointA || (pointA && pointB)) {
        setPointA(point);
        setPointB(null);
        if (onMeasurementChange) onMeasurementChange({ pointA: point, pointB: null, distance: null });
      } else {
        setPointB(point);
        const dx = (point.x - pointA.x) * scaleFactor;
        const dy = (point.y - pointA.y) * scaleFactor;
        const dz = (point.z - pointA.z) * scaleFactor;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (onMeasurementChange) {
          onMeasurementChange({
            pointA,
            pointB: point,
            distance: dist,
            heightDelta: Math.abs(dz),
          });
        }
      }
    } else if (activeTool === "polygon") {
      setPolyPoints((prev) => [...prev, point]);
    } else if (activeTool === "annotate") {
      const label = prompt("Enter annotation title:", `Spot #${annotations.length + 1}`);
      if (label) {
        const note = prompt("Enter optional notes/description:") || "";
        setAnnotations((prev) => [
          ...prev,
          { id: Date.now(), position: point, label, note },
        ]);
      }
    }
  };

  const clearAllTools = () => {
    setPointA(null);
    setPointB(null);
    setPolyPoints([]);
    if (onMeasurementChange) onMeasurementChange(null);
  };

  const deleteAnnotation = (id) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="scene-viewer-wrapper">
      {/* ── Floating 3D Control Toolbar ── */}
      <div className="viewer-toolbar">
        <div className="toolbar-group">
          <label className="toolbar-label">🎨 Colormap:</label>
          <select
            value={colormap}
            onChange={(e) => setColormap(e.target.value)}
            className="viewer-select"
          >
            <option value="rgb">Photo RGB (Original)</option>
            <option value="inferno">Inferno Heatmap</option>
            <option value="elevation">Topographic Rainbow</option>
            <option value="viridis">Viridis Spectrum</option>
            <option value="turbo">Turbo Gradient</option>
          </select>
        </div>

        <div className="toolbar-group">
          <label className="toolbar-label">
            Dot: <span>{(pointSize * 100).toFixed(0)}</span>
          </label>
          <input
            type="range"
            min="0.015"
            max="0.12"
            step="0.005"
            value={pointSize}
            onChange={(e) => setPointSize(parseFloat(e.target.value))}
            className="viewer-slider"
          />
        </div>

        <div className="toolbar-group">
          <button
            className={`toolbar-btn ${isFlying ? "active-fly" : ""}`}
            onClick={() => setIsFlying(!isFlying)}
            title="Cinematic Camera Flythrough"
          >
            {isFlying ? "⏹ Stop Fly" : "▶ 3D Fly"}
          </button>
        </div>

        {/* ── Tool Selectors ── */}
        <div className="toolbar-group tool-buttons">
          <button
            className={`toolbar-btn ${activeTool === "measure" ? "active-measure" : ""}`}
            onClick={() => {
              const next = activeTool === "measure" ? "none" : "measure";
              setActiveTool(next);
              if (next === "none") clearAllTools();
            }}
            title="Measure 3D Distance & Height Delta"
          >
            📏 Distance
          </button>

          <button
            className={`toolbar-btn ${activeTool === "polygon" ? "active-poly" : ""}`}
            onClick={() => {
              const next = activeTool === "polygon" ? "none" : "polygon";
              setActiveTool(next);
              if (next === "none") clearAllTools();
            }}
            title="Area measurement: Click 3+ points to calculate enclosed area"
          >
            📐 Area ({polyPoints.length})
          </button>

          <button
            className={`toolbar-btn ${activeTool === "annotate" ? "active-pin" : ""}`}
            onClick={() => {
              setActiveTool(activeTool === "annotate" ? "none" : "annotate");
            }}
            title="Click anywhere to drop 3D annotation pins"
          >
            📍 Pin ({annotations.length})
          </button>

          {activeTool !== "none" && (
            <button className="toolbar-btn-sm" onClick={clearAllTools} title="Clear all active markers">
              Reset
            </button>
          )}
        </div>

        {/* ── Camera Presets ── */}
        <div className="toolbar-group camera-presets">
          <button className="preset-btn" onClick={() => setTargetView("iso")} title="Isometric 45°">45°</button>
          <button className="preset-btn" onClick={() => setTargetView("top")} title="Top-Down Satellite View">Top</button>
          <button className="preset-btn" onClick={() => setTargetView("front")} title="Front Elevation">Front</button>
          <button className="preset-btn" onClick={() => setTargetView("ground")} title="Ground Level">Ground</button>
        </div>

        <div className="toolbar-group">
          <button className="toolbar-btn-icon" onClick={() => setShowGrid(!showGrid)} title="Toggle Grid">
            {showGrid ? "🌐 Grid" : "🌐 Off"}
          </button>
          <span className="gpu-badge" title="Active Hardware Renderer">⚡ {gpuInfo}</span>
        </div>
      </div>

      {/* ── Tool Helper Instructions ── */}
      {activeTool === "measure" && (
        <div className="measure-helper-pill">
          {!pointA
            ? "👉 Click on the first point (e.g. Ground Base)"
            : !pointB
            ? "👉 Click on the second point (e.g. Peak / Roof)"
            : "✓ Measurement Active. Click anywhere to start a new distance line."}
        </div>
      )}
      {activeTool === "polygon" && (
        <div className="measure-helper-pill poly-pill">
          {polyPoints.length < 3
            ? `👉 Click ${3 - polyPoints.length} more point(s) to close the area polygon`
            : `✓ Enclosed area calculated (${polyPoints.length} vertices). Click to add more points.`}
        </div>
      )}
      {activeTool === "annotate" && (
        <div className="measure-helper-pill pin-pill">
          👉 Click anywhere on the 3D surface to place an annotation pin with notes.
        </div>
      )}

      {/* ── 3D Canvas ── */}
      <Canvas
        camera={{ position: [3.5, -3.5, 3.5], fov: 55, near: 0.1, far: 1000 }}
        style={{ width: "100%", height: "100%" }}
      >
        <color attach="background" args={["#080a10"]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[10, 10, 10]} intensity={1.2} />
        <directionalLight position={[-10, -10, -5]} intensity={0.4} />

        {/* Reference Grid */}
        {showGrid && (
          <gridHelper
            args={[15, 30, "#30363d", "#161b22"]}
            rotation={[Math.PI / 2, 0, 0]}
            position={[0, 0, -1.2]}
          />
        )}

        {/* 3D Point Cloud */}
        {centeredPositions && (
          <PointCloudObject
            positions={centeredPositions}
            colors={activeColors}
            pointSize={pointSize}
            isToolActive={activeTool !== "none"}
            onPointClick={handlePointClick}
          />
        )}

        {/* 3D Interactive Overlays */}
        <SceneOverlays
          mode={activeTool}
          pointA={pointA}
          pointB={pointB}
          polyPoints={polyPoints}
          annotations={annotations}
          scaleFactor={scaleFactor}
          onDeleteAnnotation={deleteAnnotation}
        />

        {/* Flythrough & Camera Controllers */}
        <FlythroughController
          isFlying={isFlying}
          flySpeed={flySpeed}
          targetView={targetView}
        />

        <Stars radius={40} depth={30} count={1200} factor={3} fade speed={0.8} />
        <OrbitControls
          enableDamping
          dampingFactor={0.06}
          enabled={!isFlying}
          maxDistance={35}
          minDistance={0.5}
        />
      </Canvas>
    </div>
  );
}

export default SceneViewer;
