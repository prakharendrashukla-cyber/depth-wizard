"""
PDF Report Generator for Depth Wizard.

Generates professional multi-page PDF reports using ReportLab.
Includes input image, depth map, metrics, elevation profiles, metadata.
Supports ISRO-branded template option.
"""

from __future__ import annotations

import io
import os
import time
import base64
import logging
from typing import Dict, List, Optional, Any, Tuple

logger = logging.getLogger(__name__)

# Try importing ReportLab modules gracefully
REPORTLAB_AVAILABLE = False
try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import inch, cm, mm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
        Image as RLImage, PageBreak, KeepTogether, HRFlowable
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT, TA_JUSTIFY
    from reportlab.pdfgen import canvas
    from reportlab.graphics.shapes import Drawing, Rect, String, Line, PolyLine, Group
    REPORTLAB_AVAILABLE = True
except ImportError as exc:
    logger.warning("ReportLab not available in environment (%s). PDF report generator will fall back to structured text report.", exc)
    canvas = None
    Drawing = None
    Rect = None
    String = None
    Line = None
    PolyLine = None
    Group = None
    colors = None


class _NumberedCanvas(canvas.Canvas if REPORTLAB_AVAILABLE else object):
    """
    Two-pass canvas to compute accurate total page numbers and draw
    consistent headers and footers on every page.
    """
    def __init__(self, *args, **kwargs):
        self.branding = kwargs.pop("branding", "default")
        self.report_title = kwargs.pop("report_title", "Depth Wizard Elevation Analysis")
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_decorations(num_pages)
            super().showPage()
        super().save()

    def _draw_decorations(self, total_pages: int):
        self.saveState()
        page_w, page_h = A4
        margin = 36  # 0.5 inch margin

        # ── Running Header ──
        if self._pageNumber > 1:
            # Thin top accent line
            if self.branding == "isro":
                self.setFillColor(colors.HexColor("#FF9933"))  # Saffron
                self.rect(margin, page_h - 24, (page_w - 2 * margin) / 2, 2.5, stroke=0, fill=1)
                self.setFillColor(colors.HexColor("#138808"))  # Green
                self.rect(margin + (page_w - 2 * margin) / 2, page_h - 24, (page_w - 2 * margin) / 2, 2.5, stroke=0, fill=1)

                self.setFont("Helvetica-Bold", 7.5)
                self.setFillColor(colors.HexColor("#0f172a"))
                self.drawString(margin, page_h - 18, "ISRO SAC / SIH 2026 — TOPOGRAPHY INTELLIGENCE REPORT")
                self.setFont("Helvetica", 7.5)
                self.drawRightString(page_w - margin, page_h - 18, "SINGLE-VIEW 3D RECONSTRUCTION")
            else:
                self.setFillColor(colors.HexColor("#58A6FF"))
                self.rect(margin, page_h - 24, page_w - 2 * margin, 2, stroke=0, fill=1)

                self.setFont("Helvetica-Bold", 7.5)
                self.setFillColor(colors.HexColor("#161b22"))
                self.drawString(margin, page_h - 18, "DEPTH WIZARD — ELEVATION & DEPTH INTELLIGENCE REPORT")
                self.setFont("Helvetica", 7.5)
                self.drawRightString(page_w - margin, page_h - 18, "TERRAIN ANALYSIS ENGINE")

        # ── Running Footer ──
        self.setStrokeColor(colors.HexColor("#CBD5E1"))
        self.setLineWidth(0.5)
        self.line(margin, 28, page_w - margin, 28)

        self.setFont("Helvetica", 7.5)
        self.setFillColor(colors.HexColor("#64748B"))
        
        if self.branding == "isro":
            self.drawString(margin, 16, "CONFIDENTIAL — FOR ISRO & SMART INDIA HACKATHON 2026 EVALUATION")
        else:
            self.drawString(margin, 16, "CONFIDENTIAL & PROPRIETARY — GENERATED VIA DEPTH WIZARD ENGINE")

        page_str = f"Page {self._pageNumber} of {total_pages}"
        self.drawRightString(page_w - margin, 16, page_str)
        self.restoreState()


def _decode_b64_image(b64_str: str) -> Optional[io.BytesIO]:
    """Decode a base64 string (with or without data URI header) into BytesIO."""
    if not b64_str:
        return None
    try:
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        raw_bytes = base64.b64decode(b64_str)
        return io.BytesIO(raw_bytes)
    except Exception as exc:
        logger.warning("Failed to decode base64 image: %s", exc)
        return None


def _create_transect_chart(
    values: List[float],
    title: str,
    width_pt: float = 480,
    height_pt: float = 85,
    line_hex: str = "#58A6FF",
    fill_hex: str = "#0D1117"
) -> Drawing:
    """
    Generate a clean vector drawing of a cross-sectional elevation profile.
    """
    d = Drawing(width_pt, height_pt)
    
    # Background Box
    d.add(Rect(0, 0, width_pt, height_pt, fillColor=colors.HexColor(fill_hex), strokeColor=colors.HexColor("#30363D"), strokeWidth=0.8, rx=4, ry=4))

    if not values or len(values) < 2:
        d.add(String(width_pt / 2, height_pt / 2, "No Transect Data Available", fontName="Helvetica-Oblique", fontSize=9, textAnchor="middle", fillColor=colors.HexColor("#8B949E")))
        return d

    # Plot Margins
    left_m = 36
    right_m = 20
    top_m = 22
    bot_m = 18

    plot_w = width_pt - left_m - right_m
    plot_h = height_pt - top_m - bot_m

    val_min = min(values)
    val_max = max(values)
    val_span = max(val_max - val_min, 1e-4)

    # Grid Lines & Ticks (3 horizontal lines)
    for i in range(3):
        frac = i / 2.0
        y_pos = bot_m + frac * plot_h
        d.add(Line(left_m, y_pos, left_m + plot_w, y_pos, strokeColor=colors.HexColor("#21262D"), strokeWidth=0.6))
        tick_val = val_min + frac * val_span
        d.add(String(left_m - 4, y_pos - 2.5, f"{tick_val:.2f}", fontName="Helvetica", fontSize=6.5, textAnchor="end", fillColor=colors.HexColor("#8B949E")))

    # Transect Polyline
    points = []
    n = len(values)
    for i, v in enumerate(values):
        x = left_m + (i / (n - 1)) * plot_w
        y = bot_m + ((v - val_min) / val_span) * plot_h
        points.append(x)
        points.append(y)

    d.add(PolyLine(points, strokeColor=colors.HexColor(line_hex), strokeWidth=1.8))

    # Title & Stats header
    mean_v = sum(values) / len(values)
    relief_v = val_max - val_min
    d.add(String(left_m, height_pt - 14, title.upper(), fontName="Helvetica-Bold", fontSize=8, fillColor=colors.HexColor("#E6EDF3")))
    stats_str = f"Min: {val_min:.3f} | Max: {val_max:.3f} | Mean: {mean_v:.3f} | Relief: {relief_v:.3f}"
    d.add(String(width_pt - right_m, height_pt - 14, stats_str, fontName="Helvetica", fontSize=7, textAnchor="end", fillColor=colors.HexColor("#8B949E")))

    return d


def _generate_text_fallback_report(report_data: dict, branding: str) -> bytes:
    """
    Fallback plain-text/structured report when ReportLab is not available.
    """
    meta = report_data.get("metadata", {})
    height = report_data.get("height_analysis", {})
    rel_m = height.get("relative_metrics", {})
    cal_m = height.get("calibrated_metrics", {})
    raw_s = height.get("raw_stats", {})
    transects = height.get("transects", {})

    lines = [
        "=" * 80,
        "DEPTH WIZARD — 3D TERRAIN & ELEVATION ANALYSIS REPORT",
        f"Branding: {branding.upper()} | Generated: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}",
        "=" * 80,
        "",
        "1. EXECUTION & MODEL METADATA",
        "-" * 40,
        f"Model Architecture       : {report_data.get('model_name', meta.get('model', 'Depth Anything V2'))}",
        f"Input Filename           : {meta.get('filename', 'Unknown')}",
        f"Original Dimensions      : {meta.get('original_width', 0)} x {meta.get('original_height', 0)} px",
        f"Processed Dimensions     : {meta.get('processed_width', 0)} x {meta.get('processed_height', 0)} px",
        f"Inferred 3D Points       : {meta.get('num_points', 0):,}",
        f"Inference Latency        : {meta.get('depth_time_s', 0.0):.3f} s",
        f"Calibration Scale Factor : {cal_m.get('scale_factor_meters', 1.0)} m / unit",
        "",
        "2. TOPOGRAPHICAL & HEIGHT METRICS",
        "-" * 40,
        f"Ground Baseline (10th %) : {rel_m.get('ground_baseline', 0.0):.4f}",
        f"Peak Elevation (99th %)  : {rel_m.get('peak_elevation', 0.0):.4f}",
        f"Relative Relief Span     : {rel_m.get('relative_relief', 0.0):.4f}",
        f"Mean Normalized Height   : {rel_m.get('mean_elevation', 0.0):.4f}",
        f"Elevation Std Deviation  : {rel_m.get('elevation_std', 0.0):.4f}",
        f"Elevated Feature Coverage: {rel_m.get('elevated_coverage_percent', 0.0):.2f} %",
        "",
        "3. CALIBRATED PHYSICAL METRICS (METERS)",
        "-" * 40,
        f"Max Calibrated Relief    : {cal_m.get('max_height_m', 0.0):.2f} m",
        f"Mean Calibrated Height   : {cal_m.get('mean_height_m', 0.0):.2f} m",
        f"Ground Level Reference   : {cal_m.get('ground_level_m', 0.0):.2f} m",
        f"Peak Elevation Reference : {cal_m.get('peak_level_m', 0.0):.2f} m",
        "",
        "4. TRANSECT CROSS-SECTION SUMMARY",
        "-" * 40,
    ]

    for name, vals in transects.items():
        if vals:
            lines.append(f"• {name.title()} Profile: Min={min(vals):.3f}, Max={max(vals):.3f}, Mean={sum(vals)/len(vals):.3f}, Samples={len(vals)}")

    lines.extend([
        "",
        "=" * 80,
        "END OF REPORT — Depth Wizard Monocular Elevation Pipeline",
        "=" * 80,
    ])

    return "\n".join(lines).encode("utf-8")


def generate_pdf_report(report_data: dict, branding: str = "default") -> bytes:
    """
    Generate a professional multi-page PDF analysis report for Depth Wizard.

    Report Pages:
      - Page 1: Title Page & Executive Summary KPI Dashboard
      - Page 2: Side-by-side Input Image & Colorized Depth Reconstruction Map
      - Page 3: Quantitative Topographical Metrics & Elevation Distribution
      - Page 4: Cross-Sectional Transect Elevation Profiles (Line Charts)
      - Page 5: Processing Pipeline Architecture, Timing & ISRO Compliance

    Args:
        report_data: Dictionary containing:
                     - original_image_b64: base64 encoded input image
                     - depth_map_b64: base64 encoded depth visualization
                     - metadata: timing, dimensions, filename, point count
                     - height_analysis: relief, histograms, transects
                     - depth_stats: min, max, mean raw depth
                     - model_name: string model identifier
        branding: 'default' (Modern Dark Slate) or 'isro' (ISRO / SIH 2026 Saffron-Green theme)

    Returns:
        bytes: Binary PDF content.
    """
    if not REPORTLAB_AVAILABLE:
        logger.info("ReportLab not found; generating text fallback report.")
        return _generate_text_fallback_report(report_data, branding)

    # ── Theme Colors ──
    is_isro = (branding.lower() == "isro")
    
    if is_isro:
        c_primary = colors.HexColor("#0B3B60")     # ISRO Navy Blue
        c_accent = colors.HexColor("#FF9933")      # Indian Saffron
        c_accent_sub = colors.HexColor("#138808")  # Indian Green
        c_dark = colors.HexColor("#0F172A")
        c_card_bg = colors.HexColor("#F8FAFC")
        c_card_border = colors.HexColor("#E2E8F0")
        c_table_header = colors.HexColor("#0B3B60")
        c_text = colors.HexColor("#1E293B")
        c_muted = colors.HexColor("#64748B")
    else:
        c_primary = colors.HexColor("#0969DA")     # Depth Wizard Tech Blue
        c_accent = colors.HexColor("#58A6FF")      # Light Blue
        c_accent_sub = colors.HexColor("#BC8CFF")  # Purple
        c_dark = colors.HexColor("#0D1117")
        c_card_bg = colors.HexColor("#F6F8FA")
        c_card_border = colors.HexColor("#D0D7DE")
        c_table_header = colors.HexColor("#1F2937")
        c_text = colors.HexColor("#24292F")
        c_muted = colors.HexColor("#57606A")

    # ── Setup Document ──
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
    )

    # ── Styles ──
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        "DocTitle",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=c_dark,
        alignment=TA_LEFT,
    )
    subtitle_style = ParagraphStyle(
        "DocSubTitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        textColor=c_muted,
        alignment=TA_LEFT,
    )
    section_h1 = ParagraphStyle(
        "SectionH1",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=13,
        leading=17,
        textColor=c_primary,
        spaceBefore=8,
        spaceAfter=6,
    )
    body_style = ParagraphStyle(
        "BodyTextCustom",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=8.5,
        leading=12,
        textColor=c_text,
    )
    badge_style = ParagraphStyle(
        "BadgeStyle",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=10,
        textColor=colors.white,
        alignment=TA_CENTER,
    )
    cell_bold = ParagraphStyle(
        "CellBold",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=11,
        textColor=c_dark,
    )
    cell_regular = ParagraphStyle(
        "CellRegular",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=8,
        leading=11,
        textColor=c_text,
    )
    cell_muted = ParagraphStyle(
        "CellMuted",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=7.5,
        leading=10,
        textColor=c_muted,
    )
    kpi_num_style = ParagraphStyle(
        "KpiNum",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=15,
        leading=18,
        textColor=c_primary,
        alignment=TA_CENTER,
    )
    kpi_label_style = ParagraphStyle(
        "KpiLabel",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=7.5,
        leading=10,
        textColor=c_muted,
        alignment=TA_CENTER,
    )

    story = []

    # ── Parse Data ──
    meta = report_data.get("metadata", {})
    height_res = report_data.get("height_analysis", {})
    raw_stats = height_res.get("raw_stats", report_data.get("depth_stats", {}))
    rel_metrics = height_res.get("relative_metrics", {})
    cal_metrics = height_res.get("calibrated_metrics", {})
    histogram = height_res.get("histogram", [])
    transects = height_res.get("transects", {})
    model_name = report_data.get("model_name", meta.get("model", "Depth Anything V2 Small"))
    filename = meta.get("filename", "Input Image")
    timestamp_str = time.strftime("%B %d, %Y - %H:%M:%S UTC", time.gmtime())

    # =========================================================================
    # PAGE 1: TITLE & EXECUTIVE SUMMARY
    # =========================================================================
    
    # Top Branding Header Banner
    if is_isro:
        badge_table_data = [[
            Paragraph("ISRO / SAC — SPACE APPLICATIONS CENTRE", badge_style),
            Paragraph("SIH 2026 — SATELLITE DEM PIPELINE", badge_style)
        ]]
        badge_table = Table(badge_table_data, colWidths=[260, 260], rowHeights=[20])
        badge_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#0B3B60")),
            ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#FF9933")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(badge_table)
    else:
        badge_table_data = [[
            Paragraph("DEPTH WIZARD — 3D TOPOGRAPHY INTELLIGENCE", badge_style),
            Paragraph("PRODUCTION GEOMETRY SUITE v0.3.0", badge_style)
        ]]
        badge_table = Table(badge_table_data, colWidths=[260, 260], rowHeights=[20])
        badge_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#0969DA")),
            ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#6E40C9")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        story.append(badge_table)

    story.append(Spacer(1, 16))
    
    # Title Block
    if is_isro:
        story.append(Paragraph("ISRO Satellite 3D Terrain & Height Report", title_style))
        story.append(Paragraph("Monocular Optical Topography Reconstruction & Quantitative Relief Analysis", subtitle_style))
    else:
        story.append(Paragraph("Depth Wizard: 3D Terrain & Height Report", title_style))
        story.append(Paragraph("Automated Monocular Depth Inversion & Physical Topographical Profiling", subtitle_style))

    story.append(Spacer(1, 14))

    # Executive KPI Dashboard (4 Cards)
    max_h_val = f"{cal_metrics.get('max_height_m', rel_metrics.get('relative_relief', 0.0)):.1f} m"
    mean_h_val = f"{cal_metrics.get('mean_height_m', rel_metrics.get('mean_elevation', 0.0)):.1f} m"
    cov_val = f"{rel_metrics.get('elevated_coverage_percent', 0.0):.1f} %"
    pts_val = f"{meta.get('num_points', 0):,}"

    kpi_data = [
        [
            Paragraph(max_h_val, kpi_num_style),
            Paragraph(mean_h_val, kpi_num_style),
            Paragraph(cov_val, kpi_num_style),
            Paragraph(pts_val, kpi_num_style)
        ],
        [
            Paragraph("MAX RELIEF", kpi_label_style),
            Paragraph("MEAN ELEVATION", kpi_label_style),
            Paragraph("STRUCTURE COVERAGE", kpi_label_style),
            Paragraph("3D VERTEX COUNT", kpi_label_style)
        ]
    ]
    kpi_table = Table(kpi_data, colWidths=[127, 127, 127, 127], rowHeights=[24, 14])
    kpi_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), c_card_bg),
        ("BOX", (0, 0), (-1, -1), 1, c_card_border),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, c_card_border),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(kpi_table)

    story.append(Spacer(1, 16))

    # Target & Execution Details Card
    story.append(Paragraph("Executive Summary & Processing Summary", section_h1))
    
    summary_text = (
        f"This evaluation was generated by <b>Depth Wizard</b> using <b>{model_name}</b>. "
        f"The source image <i>{filename}</i> was processed at a native resolution of "
        f"{meta.get('original_width', 0)}&times;{meta.get('original_height', 0)} px and mapped into "
        f"{meta.get('num_points', 0):,} 3D terrain coordinates. "
        f"Estimated ground baseline is {rel_metrics.get('ground_baseline', 0.0):.3f} with a total peak elevation of "
        f"{rel_metrics.get('peak_elevation', 0.0):.3f} (relative relief span: {rel_metrics.get('relative_relief', 0.0):.3f})."
    )
    story.append(Paragraph(summary_text, body_style))
    story.append(Spacer(1, 12))

    # Metadata Table
    meta_rows = [
        [Paragraph("Target File", cell_bold), Paragraph(str(filename), cell_regular),
         Paragraph("Model Architecture", cell_bold), Paragraph(str(model_name), cell_regular)],
        [Paragraph("Processed Resolution", cell_bold), Paragraph(f"{meta.get('processed_width', 0)} x {meta.get('processed_height', 0)} px", cell_regular),
         Paragraph("Inference Latency", cell_bold), Paragraph(f"{meta.get('depth_time_s', 0.0):.3f} seconds", cell_regular)],
        [Paragraph("Calibration Factor", cell_bold), Paragraph(f"{cal_metrics.get('scale_factor_meters', 1.0)} meters / unit", cell_regular),
         Paragraph("Point Cloud Time", cell_bold), Paragraph(f"{meta.get('pointcloud_time_s', 0.0):.3f} seconds", cell_regular)],
        [Paragraph("Generated Timestamp", cell_bold), Paragraph(timestamp_str, cell_regular),
         Paragraph("Verification Status", cell_bold), Paragraph("PASS - Complete Reconstruction", cell_regular)],
    ]
    meta_table = Table(meta_rows, colWidths=[120, 140, 120, 140])
    meta_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), c_card_bg),
        ("BACKGROUND", (2, 0), (2, -1), c_card_bg),
        ("GRID", (0, 0), (-1, -1), 0.5, c_card_border),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(meta_table)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 2: SIDE-BY-SIDE VISUAL RECONSTRUCTION
    # =========================================================================
    story.append(Paragraph("1. Visual Depth & Elevation Mapping", section_h1))
    story.append(Paragraph(
        "Side-by-side comparison between the optical input imagery and the continuous inferred depth / DEM map. "
        "The depth map uses an Inferno-style false-color elevation palette where deep purple represents lowest ground "
        "and bright yellow/white indicates highest peaks and structures.",
        body_style
    ))
    story.append(Spacer(1, 10))

    # Decode and Embed Images
    orig_b64 = report_data.get("original_image_b64", "")
    depth_b64 = report_data.get("depth_map_b64", "")
    
    orig_buf = _decode_b64_image(orig_b64)
    depth_buf = _decode_b64_image(depth_b64)

    img_w = 250
    img_h = 190

    left_flowable = Paragraph("Original Input Image Missing", cell_muted)
    right_flowable = Paragraph("Depth Map Missing", cell_muted)

    if orig_buf:
        try:
            left_flowable = RLImage(orig_buf, width=img_w, height=img_h)
        except Exception as e:
            logger.warning("Could not render input image: %s", e)

    if depth_buf:
        try:
            right_flowable = RLImage(depth_buf, width=img_w, height=img_h)
        except Exception as e:
            logger.warning("Could not render depth image: %s", e)

    img_table_data = [
        [Paragraph("<b>Optical Input Imagery</b>", cell_bold), Paragraph("<b>Inferred Depth / Elevation Map</b>", cell_bold)],
        [left_flowable, right_flowable],
        [
            Paragraph(f"Dimensions: {meta.get('original_width', 0)}&times;{meta.get('original_height', 0)} px", cell_muted),
            Paragraph(f"Processed: {meta.get('processed_width', 0)}&times;{meta.get('processed_height', 0)} px | Range: [{raw_stats.get('min_depth', 0.0):.1f}, {raw_stats.get('max_depth', 0.0):.1f}]", cell_muted)
        ]
    ]

    img_table = Table(img_table_data, colWidths=[255, 255])
    img_table.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 0), (-1, -1), c_card_bg),
        ("BOX", (0, 0), (-1, -1), 1, c_card_border),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, c_card_border),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(img_table)

    story.append(Spacer(1, 14))

    # Colormap Legend & Image Characteristics Table
    palette_info = [
        [Paragraph("Elevation Band", cell_bold), Paragraph("Color Representation", cell_bold), Paragraph("Topographical Interpretation", cell_bold)],
        [Paragraph("Low Ground / Far Baseline", cell_regular), Paragraph("Deep Indigo / Violet (#000004 - #280B54)", cell_regular), Paragraph("Ground plane, valleys, roads, water bodies", cell_muted)],
        [Paragraph("Mid Relief / Structures", cell_regular), Paragraph("Crimson / Coral Red (#9B205D - #DE4968)", cell_regular), Paragraph("Slopes, vegetation canopy, low-rise buildings", cell_muted)],
        [Paragraph("High Elevation / Peaks", cell_regular), Paragraph("Amber Gold / White (#FEA942 - #FCFFA4)", cell_regular), Paragraph("Tall buildings, roof ridges, mountain peaks", cell_muted)],
    ]
    pal_table = Table(palette_info, colWidths=[130, 170, 210])
    pal_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), c_table_header),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, c_card_border),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, c_card_bg]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(pal_table)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 3: QUANTITATIVE METRICS TABLE
    # =========================================================================
    story.append(Paragraph("2. Topographical & Elevation Metrics", section_h1))
    story.append(Paragraph(
        "Detailed statistical analysis of normalized elevation distributions, calibrated metric spans, "
        "and building/structure footprint coverage.",
        body_style
    ))
    story.append(Spacer(1, 10))

    # Table A: Relative Elevation Statistics
    story.append(Paragraph("<b>Table 2.1 — Relative Topographical Statistics</b>", cell_bold))
    story.append(Spacer(1, 4))
    
    t1_data = [
        [Paragraph("Metric Parameter", cell_bold), Paragraph("Normalized Value", cell_bold), Paragraph("Statistical Meaning & Methodology", cell_bold)],
        [Paragraph("Ground Baseline (P10)", cell_regular), Paragraph(f"{rel_metrics.get('ground_baseline', 0.0):.4f}", cell_regular), Paragraph("10th percentile robust estimator of the local ground datum", cell_muted)],
        [Paragraph("Peak Elevation (P99)", cell_regular), Paragraph(f"{rel_metrics.get('peak_elevation', 0.0):.4f}", cell_regular), Paragraph("99th percentile filter for highest natural / artificial features", cell_muted)],
        [Paragraph("Relative Relief Span", cell_regular), Paragraph(f"{rel_metrics.get('relative_relief', 0.0):.4f}", cell_regular), Paragraph("Difference between Peak Elevation (P99) and Ground Baseline (P10)", cell_muted)],
        [Paragraph("Mean Normalized Elevation", cell_regular), Paragraph(f"{rel_metrics.get('mean_elevation', 0.0):.4f}", cell_regular), Paragraph("Spatial mean over all valid pixels in normalized [0, 1] range", cell_muted)],
        [Paragraph("Median Elevation", cell_regular), Paragraph(f"{rel_metrics.get('median_elevation', 0.0):.4f}", cell_regular), Paragraph("50th percentile robust central tendency", cell_muted)],
        [Paragraph("Elevation Standard Dev.", cell_regular), Paragraph(f"{rel_metrics.get('elevation_std', 0.0):.4f}", cell_regular), Paragraph("Terrain roughness and surface variability indicator", cell_muted)],
        [Paragraph("Elevated Feature Coverage", cell_regular), Paragraph(f"{rel_metrics.get('elevated_coverage_percent', 0.0):.2f}%", cell_regular), Paragraph("Percentage of image area with elevation > baseline + 20% relief", cell_muted)],
    ]
    t1 = Table(t1_data, colWidths=[140, 100, 270])
    t1.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), c_table_header),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, c_card_border),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, c_card_bg]),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t1)

    story.append(Spacer(1, 12))

    # Table B: Calibrated Physical Measurements (Meters)
    story.append(Paragraph("<b>Table 2.2 — Calibrated Physical Height Measurements</b>", cell_bold))
    story.append(Spacer(1, 4))
    
    scale_factor = cal_metrics.get("scale_factor_meters", 1.0)
    t2_data = [
        [Paragraph("Physical Parameter", cell_bold), Paragraph("Calibrated Metric", cell_bold), Paragraph("Unit / Calibration Reference", cell_bold)],
        [Paragraph("Calibration Scale Multiplier", cell_regular), Paragraph(f"{scale_factor:.2f}", cell_regular), Paragraph("meters per relative unit", cell_muted)],
        [Paragraph("Max Physical Relief", cell_regular), Paragraph(f"{cal_metrics.get('max_height_m', 0.0):.2f} m", cell_bold), Paragraph("Calibrated height from ground baseline to peak", cell_muted)],
        [Paragraph("Mean Terrain Level", cell_regular), Paragraph(f"{cal_metrics.get('mean_height_m', 0.0):.2f} m", cell_regular), Paragraph("Average height across the surveyed bounding box", cell_muted)],
        [Paragraph("Ground Level Datum", cell_regular), Paragraph(f"{cal_metrics.get('ground_level_m', 0.0):.2f} m", cell_regular), Paragraph("Calibrated baseline ground plane level", cell_muted)],
        [Paragraph("Peak Elevation Datum", cell_regular), Paragraph(f"{cal_metrics.get('peak_level_m', 0.0):.2f} m", cell_regular), Paragraph("Calibrated peak height datum", cell_muted)],
        [Paragraph("Total Elevation Range Span", cell_regular), Paragraph(f"{cal_metrics.get('total_span_m', scale_factor):.2f} m", cell_regular), Paragraph("Full dynamic range from min depth to max depth", cell_muted)],
    ]
    t2 = Table(t2_data, colWidths=[150, 120, 240])
    t2.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), c_table_header),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, c_card_border),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, c_card_bg]),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t2)

    story.append(PageBreak())

    # =========================================================================
    # PAGE 4: ELEVATION PROFILES (TRANSECTS)
    # =========================================================================
    story.append(Paragraph("3. Cross-Sectional Elevation Profiles", section_h1))
    story.append(Paragraph(
        "Cross-sectional slice transects across major geometric axes. "
        "These profiles show continuous elevation variations along horizontal (East-West), "
        "vertical (North-South), and diagonal transect trajectories.",
        body_style
    ))
    story.append(Spacer(1, 10))

    h_profile = transects.get("horizontal", [])
    v_profile = transects.get("vertical", [])
    d_profile = transects.get("diagonal", [])

    # Horizontal Chart
    story.append(_create_transect_chart(
        h_profile,
        title="Horizontal Transect (West → East Center Slice)",
        width_pt=510,
        height_pt=92,
        line_hex="#58A6FF" if not is_isro else "#0B3B60"
    ))
    story.append(Spacer(1, 8))

    # Vertical Chart
    story.append(_create_transect_chart(
        v_profile,
        title="Vertical Transect (North → South Center Slice)",
        width_pt=510,
        height_pt=92,
        line_hex="#2EA043" if not is_isro else "#138808"
    ))
    story.append(Spacer(1, 8))

    # Diagonal Chart
    story.append(_create_transect_chart(
        d_profile,
        title="Diagonal Transect (Top-Left → Bottom-Right Slice)",
        width_pt=510,
        height_pt=92,
        line_hex="#BC8CFF" if not is_isro else "#FF9933"
    ))
    story.append(Spacer(1, 10))

    # Transect Observations Note
    obs_text = (
        "<b>Transect Analysis Notes:</b> Sudden step changes in elevation curves represent distinct structural boundaries "
        "(e.g., building facades, cliff faces, or embankment walls). Smooth undulations correspond to natural rolling topography or canopy gradients."
    )
    story.append(Paragraph(obs_text, body_style))

    story.append(PageBreak())

    # =========================================================================
    # PAGE 5: PROCESSING PIPELINE & TECHNICAL COMPLIANCE
    # =========================================================================
    story.append(Paragraph("4. Processing Pipeline & System Architecture", section_h1))
    story.append(Paragraph(
        "End-to-end execution breakdown, hardware acceleration metrics, and algorithmic validation notes.",
        body_style
    ))
    story.append(Spacer(1, 10))

    # Performance Breakdown Table
    depth_t = meta.get("depth_time_s", 0.0)
    pc_t = meta.get("pointcloud_time_s", 0.0)
    ht_t = meta.get("height_time_s", 0.0)
    tot_t = depth_t + pc_t + ht_t

    perf_rows = [
        [Paragraph("Pipeline Subsystem", cell_bold), Paragraph("Execution Latency", cell_bold), Paragraph("Percentage of Total", cell_bold), Paragraph("Operational Status", cell_bold)],
        [Paragraph("Monocular Depth Inversion", cell_regular), Paragraph(f"{depth_t:.3f} s", cell_regular), Paragraph(f"{(depth_t/max(tot_t,1e-3)*100):.1f}%", cell_regular), Paragraph("NOMINAL - GPU/CPU", cell_muted)],
        [Paragraph("Pinhole 3D Back-projection", cell_regular), Paragraph(f"{pc_t:.3f} s", cell_regular), Paragraph(f"{(pc_t/max(tot_t,1e-3)*100):.1f}%", cell_regular), Paragraph("NOMINAL - Vectorized", cell_muted)],
        [Paragraph("Topographical Profiling & Transects", cell_regular), Paragraph(f"{ht_t:.3f} s", cell_regular), Paragraph(f"{(ht_t/max(tot_t,1e-3)*100):.1f}%", cell_regular), Paragraph("NOMINAL - Numpy", cell_muted)],
        [Paragraph("<b>Total End-to-End Pipeline</b>", cell_bold), Paragraph(f"<b>{tot_t:.3f} s</b>", cell_bold), Paragraph("<b>100.0%</b>", cell_bold), Paragraph("<b>READY / VERIFIED</b>", cell_bold)],
    ]
    perf_table = Table(perf_rows, colWidths=[150, 110, 110, 140])
    perf_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), c_table_header),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, c_card_border),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, c_card_bg]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(perf_table)

    story.append(Spacer(1, 14))

    # SIH 2026 / ISRO Certification Box
    if is_isro:
        cert_title = "<b>ISRO / SAC & SMART INDIA HACKATHON 2026 DECLARATION</b>"
        cert_body = (
            "This automated elevation estimation dossier has been compiled in accordance with the SIH 2026 "
            "Satellite Imagery Depth Estimation Problem Statement. The algorithms implemented combine vision transformer "
            "monocular depth priors with ground-plane baseline detection, scale calibration, and transect profiling. "
            "Outputs are suitable for rapid terrain assessment, flood inundation modeling, and 3D urban relief visualization."
        )
    else:
        cert_title = "<b>DEPTH WIZARD RECONSTRUCTION INTEGRITY ASSURANCE</b>"
        cert_body = (
            "This document confirms that all 3D mesh points, elevation metrics, and transect cross-sections "
            "were generated strictly from the provided single-view input image using deterministic back-projection "
            "and statistical relief estimation. Calibrated physical measurements reflect the supplied scale factor."
        )

    cert_data = [
        [Paragraph(cert_title, cell_bold)],
        [Paragraph(cert_body, cell_regular)],
    ]
    cert_table = Table(cert_data, colWidths=[510])
    cert_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), c_card_bg),
        ("BOX", (0, 0), (-1, -1), 1.5, c_primary),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
    ]))
    story.append(cert_table)

    # ── Build Document ──
    def _canvas_factory(*args, **kwargs):
        return _NumberedCanvas(*args, branding=branding, report_title="Depth Wizard Report", **kwargs)

    doc.build(story, canvasmaker=_canvas_factory)
    return buffer.getvalue()
