import { jsPDF } from "jspdf";

/**
 * Cleans inline markdown artifacts, formatting markers, and LaTeX formulas
 * into clean readable plain text for PDF rendering.
 */
export function cleanInline(text: string): string {
  return text
    .replace(/\\times/g, "×")
    .replace(/\$n\s*\\times\s*n\$/g, "n × n")
    .replace(/\$O\(4\^\{n\^2\}\)\$/g, "O(4^(n²))")
    .replace(/\$O\(n\^2\)\$/g, "O(n²)")
    .replace(/\$n\^2\$/g, "n²")
    .replace(/\$([a-zA-Z0-9_\^\\\{\}]+)\$/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/**
 * Builds a clean, professional multi-page study document PDF from markdown notes.
 * Formats headings, paragraphs, bullet lists, numbered lists, tables, and code blocks
 * with proper pagination, margins, and running headers/footers.
 */
export function generateNotesPdf(notes: string, title: string = "Lecture Notes"): jsPDF {
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
    orientation: "portrait",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 40;
  const marginRight = 40;
  const marginTop = 45;
  const marginBottom = 45;
  const contentWidth = pageWidth - marginLeft - marginRight;

  let y = marginTop;

  function checkPageBreak(neededHeight: number): boolean {
    if (y + neededHeight > pageHeight - marginBottom) {
      doc.addPage();
      y = marginTop;
      return true;
    }
    return false;
  }

  // ── Cover Header on Page 1 ─────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139); // slate-500
  doc.text("SMART LECTURE NOTES  •  STUDY DOCUMENT", marginLeft, y);
  y += 14;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42); // slate-900
  const cleanTitle = (title || "Lecture Study Notes").replace(/^#+\s*/, "").trim();
  const titleLines = doc.splitTextToSize(cleanTitle, contentWidth);
  doc.text(titleLines, marginLeft, y);
  y += titleLines.length * 22;

  // Metadata sub-header
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105); // slate-600
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  doc.text(`Generated on ${dateStr}  •  Comprehensive Subject Review`, marginLeft, y);
  y += 12;

  // Divider rule
  doc.setDrawColor(226, 232, 240); // slate-200
  doc.setLineWidth(1);
  doc.line(marginLeft, y, pageWidth - marginRight, y);
  y += 18;

  // ── Markdown Document Parser ───────────────────────────────────────────────
  const lines = notes.split("\n");
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let tableBuffer: string[] = [];

  function flushCodeBlock() {
    if (codeBuffer.length === 0) return;
    const lineHeight = 11;
    const boxPadding = 6;
    const fontPt = 8;

    doc.setFont("courier", "normal");
    doc.setFontSize(fontPt);

    let i = 0;
    while (i < codeBuffer.length) {
      const remainingHeight = pageHeight - marginBottom - y;
      if (remainingHeight < lineHeight * 2 + boxPadding * 2) {
        checkPageBreak(remainingHeight + 10);
      }

      const availableLines = Math.max(
        1,
        Math.floor((pageHeight - marginBottom - y - boxPadding * 2) / lineHeight),
      );
      const chunk = codeBuffer.slice(i, i + availableLines);
      const chunkHeight = chunk.length * lineHeight + boxPadding * 2;

      // Draw background box
      doc.setFillColor(248, 250, 252); // slate-50
      doc.setDrawColor(226, 232, 240); // slate-200
      doc.roundedRect(marginLeft, y, contentWidth, chunkHeight, 3, 3, "FD");

      // Draw code lines
      doc.setTextColor(30, 41, 59); // slate-800
      chunk.forEach((codeLine, idx) => {
        const truncated = codeLine.length > 95 ? codeLine.slice(0, 92) + "..." : codeLine;
        doc.text(truncated, marginLeft + boxPadding + 4, y + boxPadding + (idx + 1) * lineHeight - 2);
      });

      y += chunkHeight + 10;
      i += chunk.length;
    }

    codeBuffer = [];
    doc.setFont("helvetica", "normal");
  }

  function flushTable() {
    if (tableBuffer.length === 0) return;
    const rows = tableBuffer
      .map((r) =>
        r
          .split("|")
          .map((c) => c.trim())
          .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1),
      )
      .filter((r) => r.length > 0 && !r.every((c) => /^:?-+:?$/.test(c)));

    if (rows.length === 0) {
      tableBuffer = [];
      return;
    }

    // Dynamic column widths based on maximum character length per column
    const maxCharsPerCol: number[] = [];
    rows.forEach((row) => {
      row.forEach((cell, cIdx) => {
        maxCharsPerCol[cIdx] = Math.max(maxCharsPerCol[cIdx] || 0, cell.length);
      });
    });
    const totalChars = maxCharsPerCol.reduce((a, b) => a + b, 0) || 1;
    const colWidths = maxCharsPerCol.map((len) =>
      Math.max(80, Math.floor((len / totalChars) * contentWidth)),
    );
    const currentSum = colWidths.reduce((a, b) => a + b, 0);
    colWidths[colWidths.length - 1] += contentWidth - currentSum;

    rows.forEach((row, rowIdx) => {
      const isHeader = rowIdx === 0;
      doc.setFont("helvetica", isHeader ? "bold" : "normal");
      doc.setFontSize(8.5);

      const cellLinesArray = row.map((cell, cIdx) => {
        const cleaned = cleanInline(cell);
        return doc.splitTextToSize(cleaned, colWidths[cIdx] - 10);
      });

      const maxLines = Math.max(1, ...cellLinesArray.map((cl) => cl.length));
      const rowHeight = maxLines * 11 + 8;
      checkPageBreak(rowHeight + 2);

      if (isHeader) {
        doc.setFillColor(241, 245, 249); // slate-100
        doc.rect(marginLeft, y, contentWidth, rowHeight, "F");
        doc.setFont("helvetica", "bold");
        doc.setTextColor(15, 23, 42);
      } else {
        doc.setFillColor(
          rowIdx % 2 === 1 ? 255 : 248,
          rowIdx % 2 === 1 ? 255 : 250,
          rowIdx % 2 === 1 ? 255 : 252,
        );
        doc.rect(marginLeft, y, contentWidth, rowHeight, "F");
        doc.setFont("helvetica", "normal");
        doc.setTextColor(30, 41, 59);
      }

      // Draw table borders
      doc.setDrawColor(226, 232, 240);
      doc.rect(marginLeft, y, contentWidth, rowHeight, "S");

      let currentX = marginLeft;
      row.forEach((_, colIdx) => {
        const width = colWidths[colIdx];
        if (colIdx > 0) {
          doc.line(currentX, y, currentX, y + rowHeight);
        }
        const cellLines = cellLinesArray[colIdx];
        cellLines.forEach((lineText: string, lIdx: number) => {
          doc.text(lineText, currentX + 5, y + 10 + lIdx * 11);
        });
        currentX += width;
      });

      y += rowHeight;
    });

    y += 10;
    tableBuffer = [];
  }

  for (let l = 0; l < lines.length; l++) {
    const rawLine = lines[l];
    const trimmed = rawLine.trim();

    // Check code blocks
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        inCodeBlock = false;
        flushCodeBlock();
      } else {
        inCodeBlock = true;
        if (tableBuffer.length > 0) flushTable();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    // Check tables
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      tableBuffer.push(trimmed);
      continue;
    } else if (tableBuffer.length > 0) {
      flushTable();
    }

    // Empty line
    if (!trimmed) {
      y += 6;
      continue;
    }

    // Headings
    if (trimmed.startsWith("# ")) {
      checkPageBreak(30);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(15);
      doc.setTextColor(15, 23, 42); // slate-900
      const heading = cleanInline(trimmed.slice(2).trim());
      const hLines = doc.splitTextToSize(heading, contentWidth);
      doc.text(hLines, marginLeft, y);
      y += hLines.length * 18 + 4;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      checkPageBreak(25);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(30, 41, 59); // slate-800
      const heading = cleanInline(trimmed.slice(3).trim());
      const hLines = doc.splitTextToSize(heading, contentWidth);
      doc.text(hLines, marginLeft, y);
      y += hLines.length * 16 + 4;
      // Add subtle accent underline
      doc.setDrawColor(226, 232, 240);
      doc.line(marginLeft, y - 2, marginLeft + contentWidth, y - 2);
      y += 4;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      checkPageBreak(22);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(51, 65, 85); // slate-700
      const heading = cleanInline(trimmed.slice(4).trim());
      const hLines = doc.splitTextToSize(heading, contentWidth);
      doc.text(hLines, marginLeft, y);
      y += hLines.length * 14 + 3;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      checkPageBreak(20);
      const quoteText = cleanInline(trimmed.replace(/^>\s*/, ""));
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105);
      const qLines = doc.splitTextToSize(quoteText, contentWidth - 16);
      const qHeight = qLines.length * 12 + 6;

      // Draw left accent border
      doc.setFillColor(248, 250, 252);
      doc.rect(marginLeft, y - 2, contentWidth, qHeight, "F");
      doc.setDrawColor(16, 185, 129); // emerald-500
      doc.setLineWidth(2.5);
      doc.line(marginLeft + 1, y - 2, marginLeft + 1, y - 2 + qHeight);

      doc.text(qLines, marginLeft + 12, y + 8);
      y += qHeight + 6;
      continue;
    }

    // Bullet List
    if (/^[-*]\s+/.test(trimmed)) {
      checkPageBreak(16);
      const itemText = cleanInline(trimmed.replace(/^[-*]\s+/, ""));
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(30, 41, 59);

      // Bullet point dot
      doc.setFont("helvetica", "bold");
      doc.text("•", marginLeft + 6, y);
      doc.setFont("helvetica", "normal");

      const bLines = doc.splitTextToSize(itemText, contentWidth - 20);
      doc.text(bLines, marginLeft + 18, y);
      y += bLines.length * 13 + 3;
      continue;
    }

    // Numbered List
    if (/^\d+\.\s+/.test(trimmed)) {
      checkPageBreak(16);
      const match = trimmed.match(/^(\d+\.)\s+(.*)/);
      const numLabel = match ? match[1] : "•";
      const itemText = match ? cleanInline(match[2]) : cleanInline(trimmed);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(numLabel, marginLeft + 4, y);

      doc.setFont("helvetica", "normal");
      doc.setTextColor(30, 41, 59);
      const nLines = doc.splitTextToSize(itemText, contentWidth - 22);
      doc.text(nLines, marginLeft + 22, y);
      y += nLines.length * 13 + 3;
      continue;
    }

    // Regular paragraph
    checkPageBreak(16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 41, 59);
    const cleanParagraph = cleanInline(trimmed);
    const pLines = doc.splitTextToSize(cleanParagraph, contentWidth);
    doc.text(pLines, marginLeft, y);
    y += pLines.length * 13.5 + 4;
  }

  // Flush remaining buffers
  if (inCodeBlock) flushCodeBlock();
  if (tableBuffer.length > 0) flushTable();

  // ── Headers and Footers on All Pages ───────────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);

    // Running Header (pages 2+)
    if (p > 1) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184); // slate-400
      const truncatedHeader = cleanTitle.length > 50 ? cleanTitle.slice(0, 47) + "..." : cleanTitle;
      doc.text(truncatedHeader, marginLeft, 28);
      doc.setDrawColor(241, 245, 249);
      doc.setLineWidth(0.5);
      doc.line(marginLeft, 32, pageWidth - marginRight, 32);
    }

    // Running Footer (all pages)
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184); // slate-400

    // Footer divider line
    doc.setDrawColor(241, 245, 249);
    doc.setLineWidth(0.5);
    doc.line(marginLeft, pageHeight - 30, pageWidth - marginRight, pageHeight - 30);

    // Footer text
    doc.text("Smart Lecture Notes  •  AI Study Document", marginLeft, pageHeight - 18);
    const pageStr = `Page ${p} of ${totalPages}`;
    const pageStrWidth = doc.getTextWidth(pageStr);
    doc.text(pageStr, pageWidth - marginRight - pageStrWidth, pageHeight - 18);
  }

  return doc;
}
