export interface FrameInput {
  timestamp: number;
  text: string;
}

/**
 * Common video platform & watermark patterns to drop
 */
const WATERMARK_PATTERNS = [
  /\b(?:youtube|subscribe|subscribed|like\s*(?:&|and)\s*share|bell\s*icon)\b/i,
  /\b(?:follow\s*on|instagram|telegram|discord|twitter|facebook|linkedin)\b/i,
  /\b(?:coding\s*ninjas|geeksforgeeks|gfg|codehelp|apna\s*college|unacademy|scaler)\b/i,
  /\b(?:https?:\/\/\S+|www\.\S+|\.com|\.in|\.org)\b/i,
  /^\s*(?:\d{1,2}:\d{2}\s*(?:\/\s*\d{1,2}:\d{2})?|\d{3,4}p|hd|4k|cc|subtitles?|fullscreen|settings)\s*$/i,
  /\b(?:discount\s*code|link\s*in\s*(?:the\s*)?description|paid\s*courses?)\b/i,
];

/**
 * Cleans individual OCR lines, removing platform watermarks and repairing
 * common C/C++ programming OCR corruptions.
 */
export function cleanOcrLine(line: string): string {
  let cleaned = line.trim();
  if (!cleaned) return "";

  // Drop lines matching platform watermarks / UI chrome
  for (const pattern of WATERMARK_PATTERNS) {
    if (pattern.test(cleaned)) {
      return "";
    }
  }

  // Remove lines that are mostly garbage symbols unless they look like valid code brackets
  const lettersAndDigits = (cleaned.match(/[a-zA-Z0-9]/g) || []).length;
  if (cleaned.length > 3 && lettersAndDigits / cleaned.length < 0.35 && !/[{}[\]();=#<>]/.test(cleaned)) {
    return "";
  }
  if (cleaned.length <= 2 && !/^[a-zA-Z0-9{};()=+#<>-]$/.test(cleaned)) {
    return "";
  }

  // Repair common matrix OCR corruptions (e.g. '1 O O O' -> '1 0 0 0')
  cleaned = cleaned.replace(/\b([01])\s+([01O])\s+([01O])\s+([01O])\b/g, (_m, a, b, c, d) => {
    const toBit = (x: string) => (x === "O" || x === "o" ? "0" : x);
    return `${toBit(a)} ${toBit(b)} ${toBit(c)} ${toBit(d)}`;
  });

  // Common C / C++ / DSA OCR repairs
  cleaned = cleaned
    .replace(/^\|?\s*nclude/i, "#include")
    .replace(/^1nclude/i, "#include")
    .replace(/^#\s+include/i, "#include")
    .replace(/<std1o\.h>/gi, "<stdio.h>")
    .replace(/<std10\.h>/gi, "<stdio.h>")
    .replace(/<con1o\.h>/gi, "<conio.h>")
    .replace(/<1ostream>/gi, "<iostream>")
    .replace(/<vector>/gi, "<vector>")
    .replace(/<str1ng>/gi, "<string>")
    .replace(/<algor1thm>/gi, "<algorithm>")
    .replace(/\bvecto[rn]\s*<\s*vector\s*<\s*1?nt\s*>\s*>/gi, "vector<vector<int>>")
    .replace(/\bvecto[rn]\s*<\s*1?nt\s*>/gi, "vector<int>")
    .replace(/\bvecto[rn]\s*<\s*str1ng\s*>/gi, "vector<string>")
    .replace(/\bvecto[rn]\s*<\s*bool\s*>/gi, "vector<bool>")
    .replace(/\b1nt\b/g, "int")
    .replace(/\bpr1ntf\b/gi, "printf")
    .replace(/\bsc&nf\b/gi, "scanf")
    .replace(/\bma1n\b/gi, "main")
    .replace(/\bscrx\b/gi, "srcx")
    .replace(/\bscry\b/gi, "srcy")
    .replace(/\bnews\b/gi, "newx")
    .replace(/\b1sSafe\b/g, "isSafe")
    .replace(/\bso1ve\b/g, "solve")
    .replace(/\breturn0\b/gi, "return 0")
    .replace(/\brelurn\b/gi, "return")
    .replace(/\bretum\b/gi, "return")
    .replace(/\bvis1ted\b/gi, "visited")
    .replace(/\bvlsited\b/gi, "visited")
    .replace(/\bvlslted\b/gi, "visited")
    .replace(/\bstr1ng\b/gi, "string")
    .replace(/\bb00l\b/gi, "bool")
    .replace(/=\s*=\s*/g, " == ")
    .replace(/!\s*=\s*/g, " != ")
    .replace(/<\s*=\s*/g, " <= ")
    .replace(/>\s*=\s*/g, " >= ")
    .replace(/&\s*&\s*/g, " && ")
    .replace(/\|\s*\|\s*/g, " || ")
    .replace(/<\s*<\s*/g, " << ")
    .replace(/>\s*>\s*/g, " >> ");

  return cleaned.trim();
}

/**
 * Cleans multi-line OCR text, removing empty and duplicate lines.
 */
export function cleanOcrText(rawText: string): string {
  if (!rawText) return "";

  const lines = rawText.split(/\r?\n/);
  const cleanedLines: string[] = [];
  let prevLine = "";

  for (const line of lines) {
    const cleaned = cleanOcrLine(line);
    if (!cleaned) continue;

    // Skip consecutive identical lines within the same frame
    if (cleaned.toLowerCase() === prevLine.toLowerCase()) continue;

    cleanedLines.push(cleaned);
    prevLine = cleaned;
  }

  return cleanedLines.join("\n");
}

/**
 * Computes token-level Jaccard similarity between two texts.
 */
export function tokenJaccardSimilarity(textA: string, textB: string): number {
  const getTokens = (t: string) =>
    new Set(t.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter((w) => w.length > 1));

  const setA = getTokens(textA);
  const setB = getTokens(textB);

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extracts persistent header/watermark lines that repeat in more than 35%
 * of all frames, so they can be removed from body repetitions.
 */
export function findPersistentHeaderLines(frames: FrameInput[]): Set<string> {
  if (frames.length < 3) return new Set();

  const lineCounts = new Map<string, number>();

  for (const f of frames) {
    const lines = f.text.split("\n").map((l) => l.trim().toLowerCase());
    const uniqueInFrame = new Set(lines.filter((l) => l.length >= 3));
    for (const l of uniqueInFrame) {
      lineCounts.set(l, (lineCounts.get(l) || 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.floor(frames.length * 0.35));
  const persistent = new Set<string>();

  for (const [line, count] of lineCounts.entries()) {
    // If a line appears in >35% of frames and is not a core matrix row or code line
    if (count >= threshold && !/^[01\s]{3,}$/.test(line) && !/solve|isSafe|int|void|vector|return/.test(line)) {
      persistent.add(line);
    }
  }

  return persistent;
}

/**
 * Smart deduplication of consecutive and global frames:
 * 1. Strips persistent slide titles/watermarks that appear across dozens of frames.
 * 2. Compares consecutive frames using Jaccard token similarity (threshold 0.70).
 * 3. Keeps richer frame updates and discards jittery OCR duplicates.
 */
export function deduplicateAndCleanFrames(frames: FrameInput[]): FrameInput[] {
  if (!frames || frames.length === 0) return [];

  // Pass 1: Clean OCR text of each frame
  const cleanedFrames: FrameInput[] = [];
  for (const f of frames) {
    const cleaned = cleanOcrText(f.text);
    if (cleaned && cleaned.trim().length >= 8) {
      cleanedFrames.push({ timestamp: f.timestamp, text: cleaned });
    }
  }

  if (cleanedFrames.length === 0) return [];

  // Pass 2: Detect persistent repetitive header/banner lines
  const persistentLines = findPersistentHeaderLines(cleanedFrames);

  const strippedFrames: FrameInput[] = [];
  for (const f of cleanedFrames) {
    const filteredLines = f.text
      .split("\n")
      .filter((line) => !persistentLines.has(line.trim().toLowerCase()));

    const text = filteredLines.join("\n").trim();
    if (text.length >= 8) {
      strippedFrames.push({ timestamp: f.timestamp, text });
    }
  }

  const framesToDedupe = strippedFrames.length > 0 ? strippedFrames : cleanedFrames;

  // Pass 3: Fuzzy token similarity deduplication across consecutive frames
  const result: FrameInput[] = [];

  for (const current of framesToDedupe) {
    if (result.length === 0) {
      result.push(current);
      continue;
    }

    const prev = result[result.length - 1];
    const similarity = tokenJaccardSimilarity(prev.text, current.text);

    // If similarity >= 0.70, it's essentially the same slide/content
    if (similarity >= 0.70) {
      // If current frame has more detail or longer code, replace previous frame
      if (current.text.length > prev.text.length + 15) {
        result[result.length - 1] = current;
      }
      // Otherwise, drop current frame as near-duplicate
      continue;
    }

    // Check if the current frame is completely contained within the previous frame
    const curNorm = current.text.replace(/\s+/g, " ").toLowerCase();
    const prevNorm = prev.text.replace(/\s+/g, " ").toLowerCase();

    if (prevNorm.includes(curNorm)) {
      continue;
    }
    if (curNorm.includes(prevNorm)) {
      result[result.length - 1] = current;
      continue;
    }

    result.push(current);
  }

  return result;
}
