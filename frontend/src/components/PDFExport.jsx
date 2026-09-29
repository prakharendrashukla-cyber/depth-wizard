import React, { useState, useMemo } from "react";
import "./PDFExport.css";

/**
 * PDFExport Component
 * 
 * Configurable PDF Export Modal Dialog for generating official topographic reports,
 * elevation transects, point cloud metadata, and ISRO / default branded PDF documents.
 *
 * @param {Object} props
 * @param {Object} props.data - Analysis and image result data object
 * @param {number} props.scaleFactor - Metric elevation calibration factor
 * @param {string} props.model - Model name string
 * @param {boolean} props.isOpen - Whether modal is visible
 * @param {Function} props.onClose - Modal close handler: () => void
 */
function PDFExport({ data, scaleFactor = 1.0, model = "Depth Anything V2", isOpen, onClose }) {
  // Form Configuration State
  const defaultTitle = useMemo(() => {
    const fn = data?.metadata?.filename || "Scene";
    return `Topographic Elevation Analysis Report — ${fn.replace(/\.[^/.]+$/, "")}`;
  }, [data]);

  const [reportTitle, setReportTitle] = useState(defaultTitle);
  const [authorName, setAuthorName] = useState("ISRO Topographic Intelligence Cell");
  const [branding, setBranding] = useState("isro"); // 'default' | 'isro'

  // Section Checkbox Toggles
  const [sections, setSections] = useState({
    inputAndDepth: true,
    elevationMetrics: true,
    elevationProfiles: true,
    processingMetadata: true,
    calibrationData: false,
    contourMap: false,
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState("");
  const [error, setError] = useState(null);

  // Sync title when data changes
  React.useEffect(() => {
    setReportTitle(defaultTitle);
  }, [defaultTitle]);

  if (!isOpen) return null;

  // Toggle checkbox handler
  const handleToggleSection = (key) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Calibrated metrics
  const relMetrics = data?.height_analysis?.relative_metrics;
  const metrics = {
    relief: relMetrics ? (relMetrics.relative_relief * scaleFactor).toFixed(1) : "0.0",
    ground: relMetrics ? (relMetrics.ground_baseline * scaleFactor).toFixed(1) : "0.0",
    peak: relMetrics ? (relMetrics.peak_elevation * scaleFactor).toFixed(1) : "0.0",
    mean: relMetrics ? (relMetrics.mean_elevation * scaleFactor).toFixed(1) : "0.0",
    std: relMetrics ? (relMetrics.elevation_std * scaleFactor).toFixed(2) : "0.00",
  };

  /**
   * Fallback client-side PDF / Printable Document Generator
   * Produces an HTML-to-PDF downloadable document if backend /api/export/pdf is offline.
   */
  const generateClientFallbackPdf = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      throw new Error("Pop-up blocked. Please allow pop-ups to download PDF.");
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${reportTitle}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 30px;
            color: #1a1a1a;
            background: #fff;
          }
          .header-banner {
            border-bottom: 2px solid ${branding === "isro" ? "#ff9933" : "#0969da"};
            padding-bottom: 12px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .brand-title {
            font-size: 22px;
            font-weight: 800;
            color: ${branding === "isro" ? "#138808" : "#0969da"};
          }
          .badge {
            background: #f0f3f6;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
          }
          h1 { font-size: 18px; margin: 10px 0; color: #24292f; }
          .meta-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin-bottom: 20px;
            background: #f6f8fa;
            padding: 12px;
            border-radius: 6px;
            font-size: 12px;
          }
          .images-container {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-bottom: 20px;
          }
          .img-card {
            border: 1px solid #d0d7de;
            border-radius: 6px;
            padding: 8px;
            text-align: center;
          }
          .img-card img { max-width: 100%; height: 200px; object-fit: contain; }
          .img-label { font-size: 12px; font-weight: 600; margin-top: 6px; color: #57606a; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
          th, td { border: 1px solid #d0d7de; padding: 8px 10px; text-align: left; }
          th { background: #f6f8fa; }
          .footer {
            margin-top: 30px;
            padding-top: 10px;
            border-top: 1px solid #d0d7de;
            font-size: 10px;
            color: #57606a;
            display: flex;
            justify-content: space-between;
          }
          @media print {
            body { padding: 0; }
            .no-print { display: none; }
          }
        </style>
      </head>
      <body>
        <div class="header-banner">
          <div>
            <div class="brand-title">
              ${branding === "isro" ? "🇮🇳 ISRO SATELLITE TOPOGRAPHY CELL" : "🧙‍♂️ DEPTH WIZARD ANALYTICS"}
            </div>
            <small style="color: #57606a;">Single-View Monocular Height & 3D Surface Elevation Report</small>
          </div>
          <div class="badge">Scale: ${scaleFactor}x Metric</div>
        </div>

        <h1>${reportTitle}</h1>

        <div class="meta-grid">
          <div><strong>Model:</strong> ${model}</div>
          <div><strong>Filename:</strong> ${data?.metadata?.filename || "scene.png"}</div>
          <div><strong>Generated:</strong> ${new Date().toUTCString()}</div>
          <div><strong>Resolution:</strong> ${data?.metadata?.original_width || 0}x${data?.metadata?.original_height || 0}px</div>
          <div><strong>Author:</strong> ${authorName}</div>
          <div><strong>Point Count:</strong> ${data?.point_cloud?.count || data?.metadata?.num_points || "N/A"}</div>
        </div>

        ${sections.inputAndDepth ? `
          <div class="images-container">
            <div class="img-card">
              <img src="data:image/png;base64,${data?.original_image || ""}" alt="Input Monocular Image" />
              <div class="img-label">Original Monocular 2D Input</div>
            </div>
            <div class="img-card">
              <img src="data:image/png;base64,${data?.depth_map || ""}" alt="Estimated Depth Heatmap" />
              <div class="img-label">Neural Topographic Depth Heatmap</div>
            </div>
          </div>
        ` : ""}

        ${sections.elevationMetrics ? `
          <h3>Topographic Elevation Metrics</h3>
          <table>
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Calibrated Value (m)</th>
                <th>Standard Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Maximum Relative Relief (ΔH)</strong></td>
                <td>${metrics.relief} m</td>
                <td>Total vertical difference between deepest crater/valley and highest crest</td>
              </tr>
              <tr>
                <td><strong>Peak Elevation</strong></td>
                <td>${metrics.peak} m</td>
                <td>Highest structural altitude above baseline</td>
              </tr>
              <tr>
                <td><strong>Ground Baseline Datum</strong></td>
                <td>${metrics.ground} m</td>
                <td>Estimated base reference datum surface</td>
              </tr>
              <tr>
                <td><strong>Mean Elevation</strong></td>
                <td>${metrics.mean} m</td>
                <td>Volumetric average scene elevation</td>
              </tr>
              <tr>
                <td><strong>Elevation Standard Deviation (σ)</strong></td>
                <td>${metrics.std} m</td>
                <td>Topographic surface roughness & slope variance</td>
              </tr>
            </tbody>
          </table>
        ` : ""}

        ${sections.processingMetadata ? `
          <h3>Inference & Processing Diagnostics</h3>
          <table>
            <tbody>
              <tr><td>Depth Model Inference Time</td><td>${data?.metadata?.depth_time_s || "0.0"} s</td></tr>
              <tr><td>Point Cloud Triangulation Time</td><td>${data?.metadata?.pointcloud_time_s || "0.0"} s</td></tr>
              <tr><td>Height & Transect Analysis Time</td><td>${data?.metadata?.height_time_s || "0.0"} s</td></tr>
            </tbody>
          </table>
        ` : ""}

        <div class="footer">
          <span>Depth Wizard Monocular 3D Reconstruction System · SIH 2026</span>
          <span>Confidential & Proprietary Topographic Data</span>
        </div>

        <script>
          window.onload = function() {
            setTimeout(function() {
              window.print();
            }, 300);
          };
        </script>
      </body>
      </html>
    `;

    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  // ── Handle Generate PDF ───────────────────────────────────────────────────
  const handleGeneratePdf = async () => {
    setIsGenerating(true);
    setError(null);
    setGenerationStep("Compiling topographic metrics & raster charts...");

    const reportPayload = {
      title: reportTitle,
      author: authorName,
      branding: branding,
      sections: sections,
      scale_factor: scaleFactor,
      model: model,
      metadata: data?.metadata || {},
      height_analysis: data?.height_analysis || {},
      depth_stats: data?.depth_stats || {},
      original_image: sections.inputAndDepth ? data?.original_image : null,
      depth_map: sections.inputAndDepth ? data?.depth_map : null,
    };

    try {
      setGenerationStep("Calling neural PDF report rendering service...");
      const response = await fetch("/api/export/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reportPayload),
      });

      if (response.ok) {
        setGenerationStep("Downloading compiled PDF document...");
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${data?.metadata?.filename || "scene"}_topographic_report.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        onClose();
      } else {
        // Fallback to client print PDF engine
        setGenerationStep("Opening print-ready high resolution report layout...");
        generateClientFallbackPdf();
        onClose();
      }
    } catch (err) {
      // If server unreachable, use fallback
      try {
        generateClientFallbackPdf();
        onClose();
      } catch (fallbackErr) {
        setError(fallbackErr.message || "Failed to generate PDF report.");
      }
    } finally {
      setIsGenerating(false);
      setGenerationStep("");
    }
  };

  return (
    <div className="pdf-modal-overlay" onClick={onClose}>
      <div className="pdf-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* ── Modal Header ── */}
        <div className="pdf-modal-header">
          <div className="modal-title-group">
            <span className="pdf-header-icon">📄</span>
            <div>
              <h3>Topographic PDF Report Export</h3>
              <p className="modal-subtitle">
                Configure document sections, scale calibration, and official space agency branding
              </p>
            </div>
          </div>
          <button type="button" className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        {/* ── Modal Body (2 Columns: Form Controls & Mini Layout Preview) ── */}
        <div className="pdf-modal-body">
          {/* Left Column: Form Settings */}
          <div className="pdf-settings-col">
            {/* Title Input */}
            <div className="form-group">
              <label htmlFor="report-title">Report Title</label>
              <input
                id="report-title"
                type="text"
                value={reportTitle}
                onChange={(e) => setReportTitle(e.target.value)}
                placeholder="Enter report title..."
                className="text-input"
              />
            </div>

            {/* Author / Cell Input */}
            <div className="form-group">
              <label htmlFor="author-name">Organization / Author</label>
              <input
                id="author-name"
                type="text"
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                className="text-input"
              />
            </div>

            {/* Branding Selector */}
            <div className="form-group">
              <label>Report Theme & Branding</label>
              <div className="branding-radios">
                <label className={`radio-label ${branding === "isro" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="branding"
                    value="isro"
                    checked={branding === "isro"}
                    onChange={(e) => setBranding(e.target.value)}
                  />
                  <span>🇮🇳 ISRO Branded (Official Space DEM)</span>
                </label>

                <label className={`radio-label ${branding === "default" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="branding"
                    value="default"
                    checked={branding === "default"}
                    onChange={(e) => setBranding(e.target.value)}
                  />
                  <span>🧙‍♂️ Depth Wizard (Modern Clean)</span>
                </label>
              </div>
            </div>

            {/* Checkbox Sections */}
            <div className="form-group">
              <label>Include Report Sections</label>
              <div className="checkboxes-grid">
                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={sections.inputAndDepth}
                    onChange={() => handleToggleSection("inputAndDepth")}
                  />
                  <span>☑ Input Image + Depth Heatmap</span>
                </label>

                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={sections.elevationMetrics}
                    onChange={() => handleToggleSection("elevationMetrics")}
                  />
                  <span>☑ Elevation Metrics & Topography</span>
                </label>

                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={sections.elevationProfiles}
                    onChange={() => handleToggleSection("elevationProfiles")}
                  />
                  <span>☑ Elevation Transects & Cross-sections</span>
                </label>

                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={sections.processingMetadata}
                    onChange={() => handleToggleSection("processingMetadata")}
                  />
                  <span>☑ Neural Processing Diagnostics</span>
                </label>

                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={sections.calibrationData}
                    onChange={() => handleToggleSection("calibrationData")}
                  />
                  <span>☐ Ground Calibration Parameters</span>
                </label>

                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={sections.contourMap}
                    onChange={() => handleToggleSection("contourMap")}
                  />
                  <span>☐ Isoline Contour Map</span>
                </label>
              </div>
            </div>
          </div>

          {/* Right Column: Dynamic Miniature Page Preview */}
          <div className="pdf-preview-col">
            <span className="preview-heading">Live Layout Preview (A4)</span>

            <div className="mini-page-mockup">
              {/* Header stripe */}
              <div className={`mini-header ${branding === "isro" ? "isro-theme" : "default-theme"}`}>
                <span className="mini-brand-tag">
                  {branding === "isro" ? "ISRO / LUNAR TOPOGRAPHY" : "DEPTH WIZARD"}
                </span>
                <span className="mini-scale-tag">{scaleFactor}x</span>
              </div>

              {/* Title */}
              <div className="mini-title-line">{reportTitle}</div>
              <div className="mini-author-line">{authorName}</div>

              {/* Mini Content Blocks */}
              {sections.inputAndDepth && (
                <div className="mini-images-block">
                  <div className="mini-img-box input-box">2D Input</div>
                  <div className="mini-img-box depth-box">Depth Map</div>
                </div>
              )}

              {sections.elevationMetrics && (
                <div className="mini-table-block">
                  <div className="mini-table-header">
                    <span>Relief: {metrics.relief}m</span>
                    <span>Peak: {metrics.peak}m</span>
                  </div>
                  <div className="mini-table-row" />
                  <div className="mini-table-row" />
                </div>
              )}

              {sections.elevationProfiles && (
                <div className="mini-graph-block">
                  <div className="mini-graph-line" />
                  <span className="mini-graph-label">Cross-Section Transect Profile</span>
                </div>
              )}

              {sections.processingMetadata && (
                <div className="mini-meta-block">
                  <span>Model: {model}</span>
                  <span>Points: {data?.point_cloud?.count || "38.4K"}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {error && <div className="pdf-error-banner">⚠ {error}</div>}

        {/* ── Modal Footer ── */}
        <div className="pdf-modal-footer">
          <button type="button" className="cancel-modal-btn" onClick={onClose} disabled={isGenerating}>
            Cancel
          </button>

          <button
            type="button"
            className="generate-pdf-btn"
            onClick={handleGeneratePdf}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <>
                <span className="pdf-spinner" />
                <span>{generationStep || "Generating PDF..."}</span>
              </>
            ) : (
              <>
                <span>📥 Generate & Download PDF</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PDFExport;
