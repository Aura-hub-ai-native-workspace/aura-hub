"""ArtifactGenerator — produce real DOCX, XLSX, and PDF files locally.

Design rules:
- No cloud rendering: every byte is produced on the operator's machine
- Graceful degradation: missing library → ArtifactResult.status = "missing_dep"
  with installation instructions; never a silent markdown fallback
- Honest error propagation: generation errors are never hidden

Section schema (dict per section in ArtifactSpec.sections):
  {
    "heading": str,          // optional section heading
    "body": str,             // optional paragraph text (multiline OK)
    "rows": [[str, ...]],    // optional table rows (first row = header)
    "image_path": str,       // optional local image path (DOCX/PDF only)
    "list_items": [str],     // optional bulleted list
  }
Multiple keys may appear together in one section dict.
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class ArtifactType(str, Enum):
    DOCX = "docx"
    XLSX = "xlsx"
    PDF = "pdf"


@dataclass
class ArtifactSpec:
    """Declarative description of a document to generate.

    Fields:
        artifact_type: target format
        title:         document title (used as heading + metadata)
        author:        optional author name for document metadata
        sections:      list of section dicts (see module docstring)
        subject:       optional subject string for document metadata
    """

    artifact_type: ArtifactType
    title: str
    sections: list[dict] = field(default_factory=list)
    author: str = "AURA"
    subject: str = ""


@dataclass
class ArtifactResult:
    """Outcome of a generation request.

    Fields:
        path:         absolute path to the generated file (empty on failure)
        artifact_type: format generated
        status:       "ok" | "missing_dep" | "error"
        note:         human-readable message (install instructions or error)
        size_bytes:   file size; 0 when status != "ok"
        generated_at: monotonic timestamp
    """

    path: str
    artifact_type: str
    status: str = "ok"
    note: str = ""
    size_bytes: int = 0
    generated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "artifactType": self.artifact_type,
            "status": self.status,
            "note": self.note or None,
            "sizeBytes": self.size_bytes,
            "generatedAt": self.generated_at,
        }


class ArtifactGenerator:
    """Generate real document artifacts locally."""

    def generate(self, spec: ArtifactSpec,
                 output_path: str | Path) -> ArtifactResult:
        """Generate the artifact described by spec, writing to output_path.

        Never raises. Returns ArtifactResult with status != 'ok' on failure.
        """
        out = Path(output_path).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)

        try:
            if spec.artifact_type == ArtifactType.DOCX:
                return self._generate_docx(spec, out)
            elif spec.artifact_type == ArtifactType.XLSX:
                return self._generate_xlsx(spec, out)
            elif spec.artifact_type == ArtifactType.PDF:
                return self._generate_pdf(spec, out)
            else:
                return ArtifactResult(
                    path="", artifact_type=spec.artifact_type.value,
                    status="error",
                    note=f"Unknown artifact type: {spec.artifact_type}")
        except Exception as exc:
            return ArtifactResult(
                path="", artifact_type=spec.artifact_type.value,
                status="error",
                note=f"Generation failed: {str(exc)[:300]}")

    # ------------------------------------------------------------------
    # DOCX
    # ------------------------------------------------------------------

    def _generate_docx(self, spec: ArtifactSpec, out: Path) -> ArtifactResult:
        try:
            import docx
            from docx.shared import Pt, RGBColor
            from docx.enum.text import WD_ALIGN_PARAGRAPH
        except ImportError:
            return ArtifactResult(
                path="", artifact_type="docx", status="missing_dep",
                note="python-docx not installed. Run: pip install aura-backend[artifacts]")

        doc = docx.Document()

        # Metadata
        props = doc.core_properties
        props.title = spec.title
        props.author = spec.author
        if spec.subject:
            props.subject = spec.subject

        # Title heading
        doc.add_heading(spec.title, level=0)

        for section in spec.sections:
            if heading := section.get("heading"):
                doc.add_heading(str(heading), level=1)
            if body := section.get("body"):
                doc.add_paragraph(str(body))
            if items := section.get("list_items"):
                for item in items:
                    doc.add_paragraph(str(item), style="List Bullet")
            if rows := section.get("rows"):
                if rows:
                    table = doc.add_table(rows=0,
                                          cols=max(len(r) for r in rows))
                    table.style = "Table Grid"
                    for i, row_data in enumerate(rows):
                        row = table.add_row()
                        for j, cell_text in enumerate(row_data):
                            cell = row.cells[j]
                            cell.text = str(cell_text)
                            if i == 0:  # header row — bold
                                for para in cell.paragraphs:
                                    for run in para.runs:
                                        run.bold = True
            if img_path := section.get("image_path"):
                try:
                    doc.add_picture(str(img_path))
                except Exception:
                    doc.add_paragraph(f"[image: {img_path}]")

        doc.save(str(out))
        size = out.stat().st_size
        return ArtifactResult(path=str(out), artifact_type="docx",
                              status="ok", size_bytes=size)

    # ------------------------------------------------------------------
    # XLSX
    # ------------------------------------------------------------------

    def _generate_xlsx(self, spec: ArtifactSpec, out: Path) -> ArtifactResult:
        try:
            import openpyxl
            from openpyxl.styles import Font, PatternFill, Alignment
        except ImportError:
            return ArtifactResult(
                path="", artifact_type="xlsx", status="missing_dep",
                note="openpyxl not installed. Run: pip install aura-backend[artifacts]")

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = spec.title[:31] if spec.title else "Sheet1"  # Excel limit

        row_num = 1

        # Title row
        ws.cell(row=row_num, column=1, value=spec.title).font = Font(bold=True, size=14)
        row_num += 2

        for section in spec.sections:
            if heading := section.get("heading"):
                ws.cell(row=row_num, column=1, value=str(heading)).font = Font(bold=True)
                row_num += 1
            if body := section.get("body"):
                ws.cell(row=row_num, column=1, value=str(body))
                row_num += 1
            if items := section.get("list_items"):
                for item in items:
                    ws.cell(row=row_num, column=1, value=f"• {item}")
                    row_num += 1
            if rows := section.get("rows"):
                header_fill = PatternFill("solid", fgColor="4472C4")
                header_font = Font(bold=True, color="FFFFFF")
                for i, row_data in enumerate(rows):
                    for j, val in enumerate(row_data, start=1):
                        cell = ws.cell(row=row_num, column=j, value=str(val))
                        if i == 0:
                            cell.fill = header_fill
                            cell.font = header_font
                    row_num += 1
            row_num += 1  # blank row between sections

        # Auto-fit columns
        for col in ws.columns:
            max_len = max(
                (len(str(cell.value)) for cell in col if cell.value), default=8)
            ws.column_dimensions[col[0].column_letter].width = min(max_len + 2, 60)

        wb.save(str(out))
        size = out.stat().st_size
        return ArtifactResult(path=str(out), artifact_type="xlsx",
                              status="ok", size_bytes=size)

    # ------------------------------------------------------------------
    # PDF
    # ------------------------------------------------------------------

    def _generate_pdf(self, spec: ArtifactSpec, out: Path) -> ArtifactResult:
        try:
            from reportlab.lib.pagesizes import A4
            from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
            from reportlab.lib.units import cm
            from reportlab.lib import colors
            from reportlab.platypus import (
                SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                ListFlowable, ListItem, Image as RLImage)
        except ImportError:
            return ArtifactResult(
                path="", artifact_type="pdf", status="missing_dep",
                note="reportlab not installed. Run: pip install aura-backend[artifacts]")

        doc = SimpleDocTemplate(
            str(out), pagesize=A4,
            rightMargin=2 * cm, leftMargin=2 * cm,
            topMargin=2 * cm, bottomMargin=2 * cm,
            title=spec.title, author=spec.author, subject=spec.subject)

        styles = getSampleStyleSheet()
        story = []

        # Title
        story.append(Paragraph(spec.title, styles["Title"]))
        story.append(Spacer(1, 0.4 * cm))

        for section in spec.sections:
            if heading := section.get("heading"):
                story.append(Paragraph(str(heading), styles["Heading1"]))
            if body := section.get("body"):
                for para in str(body).split("\n\n"):
                    if para.strip():
                        story.append(Paragraph(para.strip(), styles["BodyText"]))
                story.append(Spacer(1, 0.3 * cm))
            if items := section.get("list_items"):
                li = ListFlowable(
                    [ListItem(Paragraph(str(i), styles["BodyText"]))
                     for i in items],
                    bulletType="bullet")
                story.append(li)
                story.append(Spacer(1, 0.3 * cm))
            if rows := section.get("rows"):
                if rows:
                    max_cols = max(len(r) for r in rows)
                    # Pad short rows
                    table_data = [
                        [str(c) for c in row] + [""] * (max_cols - len(row))
                        for row in rows]
                    tbl = Table(table_data, repeatRows=1)
                    tbl.setStyle(TableStyle([
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#4472C4")),
                        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                        ("FONTSIZE", (0, 0), (-1, -1), 9),
                        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
                         [colors.white, colors.HexColor("#EBF0F8")]),
                        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 4),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ]))
                    story.append(tbl)
                    story.append(Spacer(1, 0.4 * cm))
            if img_path := section.get("image_path"):
                try:
                    story.append(RLImage(str(img_path), width=14 * cm))
                    story.append(Spacer(1, 0.3 * cm))
                except Exception:
                    story.append(Paragraph(f"[image: {img_path}]",
                                           styles["BodyText"]))

        doc.build(story)
        size = out.stat().st_size
        return ArtifactResult(path=str(out), artifact_type="pdf",
                              status="ok", size_bytes=size)
