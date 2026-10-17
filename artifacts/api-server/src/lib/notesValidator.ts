export interface ValidationResult {
  isValid: boolean;
  score: number; // 0 to 100
  errors: string[];
  warnings: string[];
}

/**
 * Validates generated lecture notes to ensure they meet quality, readability,
 * and structural standards, preventing raw frame dumps or corrupted outputs
 * from being marked as successful.
 */
export function validateLectureNotes(
  notes: string,
  _title: string = "Lecture Notes"
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!notes || notes.trim().length === 0) {
    return {
      isValid: false,
      score: 0,
      errors: ["Notes are empty."],
      warnings: [],
    };
  }

  const trimmed = notes.trim();

  // 1. Minimum Length Check
  if (trimmed.length < 300) {
    errors.push("Notes are too short to provide meaningful study material.");
  }

  // 2. Structural Heading Check
  const headings = (trimmed.match(/^#{1,3}\s+.+/gm) || []).map((h) => h.trim());
  if (headings.length < 3) {
    errors.push("Notes lack proper structural headings (need at least title and 2 sections).");
  }

  // 3. Raw Frame Dump Detection
  // Reject template dumps like "### 1. Topic Segment [0:05]" or "### Frame 1"
  const rawSegmentDumps = trimmed.match(/###\s*(?:\d+\.\s*)?Topic Segment\s*\[\d+:\d+\]/gi) || [];
  const rawFrameDumps = trimmed.match(/###\s*Frame\s*\d+\s*\[\d+:\d+\]/gi) || [];
  if (rawSegmentDumps.length >= 5 || rawFrameDumps.length >= 5) {
    errors.push(
      `Detected raw frame dump with ${rawSegmentDumps.length + rawFrameDumps.length} frame markers. Notes must be synthesized, not a raw frame-by-frame dump.`
    );
  }

  // Reject fake "Extracted N main lecture segment(s)" takeaway
  if (/Extracted \d+ main lecture segment\(s\)/i.test(trimmed)) {
    warnings.push("Contains placeholder segment count in takeaways instead of actual concept summary.");
  }

  // 4. Excessive Repetition Detection
  // Check if identical content blocks / matrices repeat excessively in prose
  const rawLines = trimmed.split(/\r?\n/).map((l) => l.trim());
  const lineFrequencies = new Map<string, number>();
  let inCodeBlock = false;

  for (const line of rawLines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    // Skip code block lines, horizontal rules, markdown headings, or very short lines
    if (inCodeBlock || line.length <= 15) continue;
    if (/^[-*=_]{3,}$|^##?#?\s+/.test(line)) continue;

    const norm = line.toLowerCase();
    lineFrequencies.set(norm, (lineFrequencies.get(norm) || 0) + 1);
  }

  let maxRepetitions = 0;
  let mostRepeatedLine = "";
  for (const [line, count] of lineFrequencies.entries()) {
    if (count > maxRepetitions) {
      maxRepetitions = count;
      mostRepeatedLine = line;
    }
  }

  if (maxRepetitions >= 4) {
    errors.push(
      `Excessive repetition detected: line/block repeated ${maxRepetitions} times ("${mostRepeatedLine.slice(0, 40)}...").`
    );
  } else if (maxRepetitions === 3) {
    warnings.push(
      `Moderate repetition detected: line repeated 3 times ("${mostRepeatedLine.slice(0, 40)}...").`
    );
  }

  // 5. Code Block Integrity Check
  const codeFences = trimmed.match(/```/g) || [];
  if (codeFences.length % 2 !== 0) {
    errors.push("Unclosed code block fence detected in markdown.");
  }

  // Check for obvious OCR corruption tokens in code
  const ocrCorruptionTokens = [
    /#\|nclude/i,
    /<std1o\.h>/i,
    /\bpr1ntf\b/i,
    /\bsc&nf\b/i,
    /\b1nt\s+main\b/i,
    /\brelurn\b/i,
    /\bvecto[rn]<vector<1nt/i,
  ];
  for (const token of ocrCorruptionTokens) {
    if (token.test(trimmed)) {
      warnings.push(`Unrepaired OCR code corruption detected matching ${token.source}.`);
    }
  }

  // 6. Watermark / Promo Leak Check
  const promoLeaks = [
    /\b(?:subscribe\s+to\s+channel|bell\s+icon|discount\s+code\s+in\s+description)\b/i,
    /\b(?:coding\s+ninjas|unacademy|scaler\s+academy)\s+is\s+the\s+largest\b/i,
  ];
  for (const leak of promoLeaks) {
    if (leak.test(trimmed)) {
      warnings.push("Sponsor or video platform promotion text leaked into study notes.");
    }
  }

  // Calculate score
  let score = 100;
  score -= errors.length * 30;
  score -= warnings.length * 10;
  score = Math.max(0, Math.min(100, score));

  return {
    isValid: errors.length === 0,
    score,
    errors,
    warnings,
  };
}

/**
 * Cleans and repairs markdown formatting, closing unclosed code blocks
 * and stripping repeated consecutive blocks.
 */
export function sanitizeMarkdown(notes: string): string {
  if (!notes) return "";

  let cleaned = notes.replace(/\r\n/g, "\n");

  // Fix unclosed code fences
  const fences = cleaned.match(/```/g) || [];
  if (fences.length % 2 !== 0) {
    cleaned += "\n```\n";
  }

  // Deduplicate exact consecutive paragraphs
  const paragraphs = cleaned.split(/\n\s*\n/);
  const deduped: string[] = [];
  let prevPara = "";

  for (const p of paragraphs) {
    const trimmedP = p.trim();
    if (!trimmedP) continue;
    if (trimmedP.toLowerCase() === prevPara.toLowerCase()) continue;
    deduped.push(trimmedP);
    prevPara = trimmedP;
  }

  return deduped.join("\n\n");
}
