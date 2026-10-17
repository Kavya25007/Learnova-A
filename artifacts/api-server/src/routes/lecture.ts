import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { getYtDlpPath, getFfmpegPath, getFfprobePath } from "../lib/tools";
import { promisify } from "util";
import { mkdir, rm, readdir, readFile, stat } from "fs/promises";
import { writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { join as pathJoin } from "path";
import os from "os";
import { openai } from "@workspace/integrations-openai-ai-server";
import { classifyYouTubeError } from "../youtube/errors";
import { fetchYouTubeMetadata } from "../youtube/metadata";
import { runProcess, withBackoff } from "../youtube/subprocess";
import { extractYouTubeTranscript } from "../youtube/transcript";
import { parseYouTubeUrl, YouTubeUrlError } from "../youtube/url";

import { parseAndEnforceQuizMarkdown, generateConceptFallbackQuiz } from "../lib/quiz";
import { deduplicateAndCleanFrames, cleanOcrText } from "../lib/ocrCleaner";
import { synthesizeLectureNotes } from "../lib/lectureSynthesizer";
import { validateLectureNotes, sanitizeMarkdown } from "../lib/notesValidator";
import { generateNotesPdf } from "../lib/pdfExporter";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();

// Model to use — override via OPENAI_MODEL env var, default to gpt-4o
const OPENAI_MODEL = process.env["OPENAI_MODEL"] ?? "gpt-4o";


// ─── In-memory job store ─────────────────────────────────────────────────────
// Each job accumulates SSE event strings. Active SSE connections register a
// listener function so they get events pushed immediately. Late connections
// replay the full event log from the start.

interface YtJob {
  status: "queued" | "transcript" | "downloading" | "extracting" | "done" | "error";
  events: string[]; // accumulated SSE event strings (replayed to late connections)
  listeners: Set<(ev: string) => void>;
  tmpDir: string;
  createdAt: number;
  cleanupTimer?: NodeJS.Timeout;
}

const jobs = new Map<string, YtJob>();

// Cleanup stale jobs (older than 15 min)
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) {
      rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

function pushEvent(job: YtJob, name: string, data: unknown) {
  const str = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  job.events.push(str);
  for (const fn of job.listeners) fn(str);
}

function scheduleJobCleanup(jobId: string, job: YtJob) {
  job.cleanupTimer = setTimeout(() => {
    jobs.delete(jobId);
  }, 5 * 60 * 1000).unref();
}

function failJob(
  jobId: string,
  job: YtJob,
  step: string,
  message: string,
  log: Request["log"],
  details?: string,
) {
  if (job.status === "error" || job.status === "done") return;
  job.status = "error";
  log.error({ jobId, step, message, details }, "YouTube job failed");
  pushEvent(job, "error", { step, message });
  scheduleJobCleanup(jobId, job);
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────
function startSSE(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx/Caddy buffering
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

function heartbeat(res: Response): ReturnType<typeof setInterval> {
  // Send a comment every 20 s to keep the proxy connection alive
  return setInterval(() => { res.write(": heartbeat\n\n"); }, 20_000);
}

// ─── Notes generation ─────────────────────────────────────────────────────────
type NoteMode = "smart" | "exact" | "detailed" | "exam" | "flashcards" | "quiz";

const NOTES_SYSTEM: Record<NoteMode, string> = {
  exact: `You are an expert DSA & computer science educator and precise note-taking AI.
Convert extracted OCR frames and lecture materials into clean, highly readable, structured study notes in MARKDOWN.

EXACT MODE RULES:
1. STRUCTURE & ORGANIZATION:
   - Provide clear, professional study notes organized into logical conceptual sections.
   - DO NOT output raw frame-by-frame lists, "Frame 1..N", or "Topic Segment 1..N".
   - Start with a single '# [Lecture Title]' heading.
2. CONCEPTUAL CLARITY & DSA ACCURACY:
   - For DSA / algorithm lectures, clearly explain:
     * Problem Statement, Constraints, and State Representation (e.g. 2D grid/matrix coordinates).
     * Core Intuition: Why naive recursion fails (e.g. infinite cycles) and why state tracking (e.g. visited array) is necessary.
     * Backtracking Mechanism: Explain the choose -> explore -> unchoose (backtrack) workflow clearly.
     * Safe Move Conditions: Boundary checks, obstacle checks, unvisited checks.
     * Complexity Analysis: Detail Time and Space Complexity.
3. CODE & SYNTAX INTEGRITY:
   - Output clean, complete, and syntax-valid C++ code blocks with language hints (\`\`\`cpp).
   - Repair OCR typos in code (e.g. '#|nclude' -> '#include', '1nt' -> 'int', 'pr1ntf' -> 'printf', 'vector<vector<1nt>>' -> 'vector<vector<int>>').
   - If an OCR detail is illegible and cannot be reliably resolved, annotate it transparently with a comment rather than inventing arbitrary code.
4. CLEANLINESS:
   - Strip all repeated slide titles, platform watermarks, sponsor text, and video player UI.
Output ONLY the markdown notes. No conversational preamble.`,

  smart: `You are an expert DSA educator and smart study note creator inside a Smart Lecture Notes system.
Convert extracted lecture OCR and content into concise, elegant, beginner-friendly study notes in MARKDOWN.

SMART MODE RULES:
1. SYNTHESIS OVER DUMPING:
   - Synthesize the core concepts into a cohesive, logically ordered study guide.
   - NEVER dump raw frame-by-frame text or output "Topic Segment 1..N".
   - Merge repeated slides and identical matrices into a single, well-explained example.
2. DSA LECTURE STRUCTURE:
   - # [Lecture Title]
   - ## Problem Overview: Clear explanation of the problem, input/output, and visual representation (e.g. ASCII grid or matrix).
   - ## Intuition & The Backtracking Approach: Explain why backtracking is needed, why cycles occur without visited tracking, and how backtracking unwinds state.
   - ## Algorithm & Step-by-Step Logic: Outline base cases, recursive transitions, and 'isSafe' criteria.
   - ## Clean Implementation: Fully formatted, syntax-correct, well-commented C++ code.
   - ## Dry Run / Example Trace: Concrete walkthrough of exploring paths from source to destination.
   - ## Complexity Analysis: Time and Space Complexity with intuitive explanations.
   - ## Key Takeaways & Pitfalls: Bullet points highlighting common mistakes (e.g. forgetting to unmark visited cells).
3. TRANSPARENCY:
   - Do not invent facts or guess unreadable code silently. If source text is partially corrupted, note it transparently.
   - Eliminate all OCR noise, video player chrome, and sponsor ads.
Output ONLY the markdown notes. No conversational preamble.`,

  detailed: `You are a university DSA professor creating a comprehensive, in-depth study manual from a lecture.
Convert extracted lecture content into thorough, highly educational study notes in MARKDOWN.

DETAILED MODE RULES:
1. COMPREHENSIVE SECTIONS:
   - # [Lecture Title]
   - ## Executive Summary: 3-5 sentence conceptual overview of the lecture topic.
   - ## Problem Statement & Representation: Detailed problem definition, inputs, outputs, matrix grids, constraints.
   - ## Core Concepts & Intuition: Deep dive into recursion trees, why infinite loops occur, state-space exploration, and visited array logic.
   - ## Step-by-Step Algorithm & Safety Checks: Detailed explanation of coordinate transitions (D, L, R, U) and boundary conditions.
   - ## Complete, Production-Ready C++ Implementation: Fully commented, robust C++ code.
   - ## Detailed Dry Run / Execution Trace: Walk through step-by-step state changes on an example matrix.
   - ## Time & Space Complexity Analysis: Thorough breakdown of upper bounds and auxiliary stack space.
   - ## Interview & Exam Questions: 5 high-yield conceptual questions with concise answers.
   - ## Common Pitfalls & Debugging Tips: Subtle bugs to watch out for in backtracking.
2. CLEANLINESS & INTEGRITY:
   - Repair all OCR code corruptions and syntax errors.
   - Remove all repeated slide headers, channel watermarks, and sponsor promos.
   - Never output raw frame dumps or "Topic Segment" placeholders.
Output ONLY the markdown notes. No conversational preamble.`,

  exam: `You are an expert technical interviewer and exam-prep instructor.
Convert lecture materials into a high-yield exam revision guide in MARKDOWN.

EXAM REVISION RULES:
1. High-yield summary of definitions, formulas, and core algorithm mechanics.
2. 'Things to Remember / Watch Out For' section with common bugs (e.g. missing base cases, not resetting visited states).
3. Full syntax-correct C++ code template with comments on critical exam points.
4. Practice interview / exam questions with model answers.
5. Complexity summary table (Best, Average, Worst Time & Space).
Output ONLY the markdown notes. No conversational preamble.`,

  flashcards: `You are a flashcard-generation AI inside a Smart Lecture Notes Generator.
Convert the lecture content into a set of 8-15 high-quality conceptual flashcards in MARKDOWN.

FORMAT:
---
**Q:** [Clear, conceptual question]
**A:** [Direct, educational answer with code/formula if needed]

Start with a ## Flashcards heading. Output ONLY the flashcards. No preamble.`,

  quiz: `You are a concept-testing quiz generation AI inside a Smart Lecture Notes Generator.
Convert the lecture content into a 6-10 question conceptual multiple-choice quiz in MARKDOWN.

CRITICAL RULES:
- Test core algorithm understanding, backtracking rules, boundary conditions, and complexity.
- Exactly 4 options (A, B, C, D) per question with distributed correct answers.
- Provide an educational explanation for each answer.
- DO NOT reference video timestamps or use "Topic Segment" filler.

Format:
---
**Q[n].** [Conceptual question]
- A) [Option]
- B) [Option]
- C) [Option]
- D) [Option]
**Answer:** [A/B/C/D] — [Explanation]

Start with # Practice Quiz: [Lecture Title]. Output ONLY the quiz. No preamble.`,
};

router.post("/notes/generate", async (req, res) => {
  try {
    const body = req.body as {
      mode?: NoteMode;
      frames?: { timestamp: number; text: string }[];
      title?: string;
    };
    const validModes: NoteMode[] = ["smart", "exact", "detailed", "exam", "flashcards", "quiz"];
    const mode: NoteMode = validModes.includes(body.mode as NoteMode)
      ? (body.mode as NoteMode)
      : "smart";
    const rawFrames = Array.isArray(body.frames) ? body.frames : [];

    if (rawFrames.length === 0) {
      res.status(400).json({ error: "No frames provided" });
      return;
    }

    const title = (body.title && body.title.trim()) || "Lecture Notes";

    // Deduplicate and clean frames to remove repeated banners and jitter
    const cleanedFrames = deduplicateAndCleanFrames(rawFrames);
    const framesToUse = cleanedFrames.length > 0 ? cleanedFrames : rawFrames.map((f) => ({
      timestamp: f.timestamp,
      text: cleanOcrText(f.text),
    }));

    let notes = "";
    let generatedByAi = false;

    // Check if an AI client can be called
    try {
      const joined = framesToUse
        .slice(0, 40) // Prevent token overflow from excessive frames
        .map((f, i) => `--- Content Segment ${i + 1} (t=${Math.round(f.timestamp)}s) ---\n${f.text.trim()}`)
        .join("\n\n");

      const userPrompt = `Lecture Title: ${title}\n\nExtracted sequential lecture content:\n\n${joined}`;

      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        max_completion_tokens: 8192,
        messages: [
          { role: "system", content: NOTES_SYSTEM[mode] },
          { role: "user", content: userPrompt },
        ],
      });

      const aiResponse = completion.choices[0]?.message?.content ?? "";
      if (aiResponse && aiResponse.trim().length >= 300) {
        notes = aiResponse;
        generatedByAi = true;
      }
    } catch (aiErr) {
      req.log.warn(
        { err: aiErr instanceof Error ? aiErr.message : String(aiErr) },
        "AI completion unavailable or failed — synthesizing structured study notes"
      );
    }

    // If AI was unavailable, failed, or produced insufficient text, synthesize intelligent notes
    if (!notes || notes.trim().length < 300) {
      notes = synthesizeLectureNotes(mode, title, rawFrames);
    }

    // Sanitize markdown formatting
    notes = sanitizeMarkdown(notes);

    // Validate quality, structure, repetition, and code integrity
    const validation = validateLectureNotes(notes, title);

    // If validation fails due to raw frame dumps or excessive repetition,
    // re-synthesize cleanly to prevent degraded notes from being served
    if (!validation.isValid) {
      req.log.warn(
        { errors: validation.errors },
        "Notes failed quality validation — regenerating via structured synthesizer"
      );
      notes = sanitizeMarkdown(synthesizeLectureNotes(mode, title, rawFrames));
    }

    if (mode === "quiz" && notes) {
      notes = parseAndEnforceQuizMarkdown(notes, title);
    }

    const finalValidation = validateLectureNotes(notes, title);

    res.json({
      notes,
      mode,
      quality: {
        score: finalValidation.score,
        isValid: finalValidation.isValid,
        generatedByAi,
        warnings: finalValidation.warnings,
      },
    });
  } catch (err) {
    req.log.error({ err }, "notes generation failed");
    res.status(500).json({ error: "Failed to generate notes" });
  }
});

// ─── Direct PDF Export Endpoint (Streams attachment with Content-Disposition) ─
router.post("/notes/export/pdf", (req: Request, res: Response) => {
  try {
    const { notes, title, mode, fileName } = req.body as {
      notes?: string;
      title?: string;
      mode?: string;
      fileName?: string;
    };

    if (!notes || typeof notes !== "string" || !notes.trim()) {
      res.status(400).json({ error: "Missing or empty notes content" });
      return;
    }

    const docTitle = (title && title.trim()) || "Lecture Notes";
    const doc = generateNotesPdf(notes, docTitle);
    const arrayBuffer = doc.output("arraybuffer");
    const pdfBuffer = Buffer.from(arrayBuffer);

    let cleanName = (fileName && fileName.trim()) || "";
    if (!cleanName) {
      let raw = docTitle
        .replace(/[/\\?%*:|"<>]/g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      if (!raw) raw = "Lecture";
      let suffix = "Notes";
      if (mode === "quiz") suffix = "Quiz";
      else if (mode === "flashcards") suffix = "Flashcards";
      if (raw.toLowerCase().endsWith(suffix.toLowerCase())) {
        raw = raw.slice(0, -suffix.length).replace(/-+$/, "");
      }
      cleanName = `${raw ? `${raw}-${suffix}` : suffix}.pdf`;
    }
    if (!cleanName.endsWith(".pdf")) cleanName += ".pdf";

    // Save direct copy to Downloads folder on local system
    const userDownloads = process.env.USERPROFILE ? pathJoin(process.env.USERPROFILE, "Downloads") : null;
    if (userDownloads && existsSync(userDownloads)) {
      try {
        const dest = pathJoin(userDownloads, cleanName);
        writeFileSync(dest, pdfBuffer);
        req.log.info({ dest, bytes: pdfBuffer.length }, "Saved PDF directly to user Downloads folder");
      } catch (writeErr) {
        req.log.warn({ writeErr }, "Failed writing to user Downloads folder");
      }
    }
    // Also save in scratch/ for local validation
    try {
      const scratchDir = pathJoin(process.cwd(), "scratch");
      if (existsSync(scratchDir)) {
        writeFileSync(pathJoin(scratchDir, cleanName), pdfBuffer);
      }
    } catch { /* ignore */ }

    req.log.info({ fileName: cleanName, docTitle, byteLength: pdfBuffer.length }, "Serving PDF attachment download");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${cleanName}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`
    );
    res.setHeader("Content-Length", String(pdfBuffer.length));
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.end(pdfBuffer);
  } catch (err) {
    req.log.error({ err }, "PDF export failed");
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// ─── YouTube metadata ─────────────────────────────────────────────────────────
router.get("/youtube/meta", async (req, res) => {
  const requestId = req.id;
  req.log.info({ requestId, url: req.query.url }, "YouTube metadata request started");
  try {
    const parsed = parseYouTubeUrl(req.query.url);
    const data = await fetchYouTubeMetadata(parsed, req.log);
    req.log.info({ requestId, videoId: parsed.videoId }, "YouTube metadata request completed");
    res.json(data);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const classified = err instanceof YouTubeUrlError
      ? { code: "invalid_url", message: err.message }
      : classifyYouTubeError(raw);
    req.log.error({ requestId, error: raw, code: classified.code }, "YouTube metadata request failed");
    res.status(err instanceof YouTubeUrlError ? 400 : 502).json({
      error: classified.message,
      reason: classified.code,
      step: err instanceof YouTubeUrlError ? "url_validation" : "metadata",
      details: raw.slice(0, 500),
    });
  }
});

// ─── YouTube job start ────────────────────────────────────────────────────────
// Creates a background job, returns immediately with a jobId.
// The client then opens GET /api/youtube/events/:jobId as an SSE stream.
// This avoids any proxy timeout — SSE connections are long-lived by design.

router.post("/youtube/start", async (req: Request, res: Response) => {
  const { url, interval: rawInterval, startTime: rawStart, endTime: rawEnd } = req.body as {
    url?: string;
    interval?: number;
    startTime?: number;
    endTime?: number;
  };

  let parsedUrl;
  try {
    parsedUrl = parseYouTubeUrl(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid YouTube URL";
    res.status(400).json({ error: message, reason: "invalid_url", step: "url_validation" });
    return;
  }
  const { videoId, canonicalUrl } = parsedUrl;

  // interval=0 means Auto — the job will compute it from ffprobe duration after download
  const requestedInterval = Number(rawInterval ?? -1);
  const autoInterval = requestedInterval === 0 || requestedInterval < 0;
  // Use -1 as the sentinel value through to the job runner
  const resolvedInterval = autoInterval ? 0 : Math.max(1, Math.round(requestedInterval));
  const startSec = Math.max(0, Number(rawStart) || 0);
  const endSec: number | null = rawEnd != null && rawEnd !== undefined ? Math.max(startSec + 1, Number(rawEnd)) : null;

  const jobId = randomUUID();
  // Use path.join to avoid mixed backslash/forward-slash paths on Windows
  const tmpDir = pathJoin(os.tmpdir(), `yt-${videoId}-${jobId.slice(0, 8)}`);
  const job: YtJob = {
    status: "queued",
    events: [],
    listeners: new Set(),
    tmpDir,
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  req.log.info({ jobId, videoId, resolvedInterval, autoInterval, startSec, endSec }, "YouTube job created");
  res.json({ jobId, videoId });

  // Run processing asynchronously — completely detached from the HTTP response
  runYouTubeJob(
    jobId,
    job,
    { url: canonicalUrl, videoId, requestedInterval: resolvedInterval, autoInterval, startSec, endSec },
    req.log,
  ).catch((err) => {
    const raw = err instanceof Error ? err.message : String(err);
    const classified = classifyYouTubeError(raw);
    failJob(jobId, job, "unknown", classified.message, req.log, raw);
  });
});

// ─── YouTube SSE event stream ─────────────────────────────────────────────────
// Events emitted:
//   status          { step: string; message: string }
//   download_progress { pct: number; speed?: string; eta?: string }
//   frame_count     { count: number; duration: number }
//   frame           { index: number; timestamp: number; data: string } (base64 JPEG)
//   done            { frameCount: number; duration: number }
//   error           { step: string; message: string }

router.get("/youtube/events/:jobId", (req: Request, res: Response) => {
  const job = jobs.get(req.params["jobId"] as string);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  startSSE(res);
  const hb = heartbeat(res);

  // Replay all events queued before this connection arrived
  for (const ev of job.events) res.write(ev);

  if (job.status === "done" || job.status === "error") {
    clearInterval(hb);
    res.end();
    return;
  }

  // Register for future events
  const listener = (ev: string) => {
    res.write(ev);
    if (ev.startsWith("event: done") || ev.startsWith("event: error")) {
      clearInterval(hb);
      job.listeners.delete(listener);
      res.end();
    }
  };
  job.listeners.add(listener);

  req.on("close", () => {
    clearInterval(hb);
    job.listeners.delete(listener);
  });
});

// ─── Adaptive interval (mirrors frontend logic) ───────────────────────────────
function getAdaptiveInterval(durationSec: number): number {
  if (durationSec <= 1800) return 10;  // 0–30 min  → 10 s
  if (durationSec <= 3600) return 15;  // 30–60 min → 15 s
  return 20;                           // 60+ min   → 20 s
}

// ─── Download video with yt-dlp, streaming progress events to SSE ─────────────
// Returns the path to the downloaded video file.
async function downloadWithYtDlp(
  videoId: string,
  outputPath: string,
  job: YtJob,
  log: Request["log"],
  jobId: string,
): Promise<void> {
  const ytdlpBin = await getYtDlpPath();
  const ffmpegPath = await getFfmpegPath().catch(() => null);
  const clients = ["android", "ios", "tv_embedded"];
  let lastError = "";

  for (const client of clients) {
    const ytdlpArgs = [
      "--no-playlist",
      "--no-check-certificate",
      "--extractor-args", `youtube:player_client=${client}`,
      // Prefer a progressive/single-file format first to avoid ffmpeg merge path issues.
      // Falls back to DASH merge (with explicit mp4 container) if no single-file format exists.
      "--format", "best[height<=720][ext=mp4]/best[height<=720]/bestvideo[height<=720]+bestaudio/best",
      "--merge-output-format", "mp4",
      "--output", outputPath,
      "--newline",    // one progress line per newline (easier to parse)
      ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    log.info({ jobId, videoId, client, cmd: `${ytdlpBin} ${ytdlpArgs.join(" ")}` }, "yt-dlp command");

    try {
    const stderrOut = await withBackoff(
      async () => {
        const output = await runProcess(ytdlpBin, ytdlpArgs, {
          timeoutMs: 120_000,
          onStdout: (text) => {
            for (const line of text.split("\n")) {
              const progress = line.match(
                /\[download\]\s+([\d.]+)%\s+of\s+\S+\s+at\s+(\S+)\s+ETA\s+(\S+)/,
              );
              if (progress) {
                pushEvent(job, "download_progress", {
                  pct: parseFloat(progress[1]),
                  speed: progress[2],
                  eta: progress[3],
                });
              }
            }
          },
        });

        if (output.timedOut) {
          throw new Error(
            `yt-dlp timed out after 120 seconds.\n${output.stderr}\n${output.stdout}`.trim(),
          );
        }
        if (output.code !== 0) {
          throw new Error((output.stderr + "\n" + output.stdout).trim());
        }
        return output.stderr;
      },
      (error) => {
        const raw = error instanceof Error ? error.message : String(error);
        return classifyYouTubeError(raw).retryable;
      },
      { attempts: 2, baseDelayMs: 750 },
    );

      if (stderrOut.trim()) {
        log.warn({ jobId, videoId, client, stderr: stderrOut }, "yt-dlp stderr (non-fatal warnings)");
      }
      log.info({ jobId, videoId, client }, "yt-dlp download succeeded");
      return; // done
    } catch (clientErr: unknown) {
      lastError = clientErr instanceof Error ? clientErr.message : String(clientErr);
      log.warn({ jobId, videoId, client, err: lastError.slice(0, 600) }, "yt-dlp client failed — trying next");
      
      // Stop early for definitive blocks (no point trying other clients)
      if (/private video|video is private/i.test(lastError)) break;
      if (/age.?restrict|confirm your age/i.test(lastError)) break;
      if (/unavailable.*app|not available.*app/i.test(lastError)) {
        continue;
      }
    }
  }

  // All clients exhausted
  throw new Error(lastError || "All yt-dlp clients failed");
}

// ─── Background job runner ────────────────────────────────────────────────────
async function runYouTubeJob(
  jobId: string,
  job: YtJob,
  opts: { url: string; videoId: string; requestedInterval: number; autoInterval: boolean; startSec: number; endSec: number | null },
  log: Request["log"],
) {
  const { videoId, requestedInterval, autoInterval, startSec, endSec } = opts;
  let effectiveInterval = requestedInterval > 0 ? requestedInterval : 10;
  // Use path.join to avoid mixed path separators on Windows
  const videoFile = pathJoin(job.tmpDir, "video.mp4");
  const framesDir = pathJoin(job.tmpDir, "frames");

  try {
    await mkdir(framesDir, { recursive: true });
    log.info({ jobId, videoId, tmpDir: job.tmpDir, videoFile, framesDir }, "Job dirs created");

    // ── Phase 1: Prefer public captions before downloading the video ─────────
    job.status = "transcript";
    pushEvent(job, "status", { step: "transcript", message: "Checking for available captions..." });
    log.info({ jobId, videoId }, "Phase 1: checking YouTube transcript availability");

    const transcript = await extractYouTubeTranscript(opts.url, log);
    if (transcript.status === "available") {
      job.status = "done";
      pushEvent(job, "transcript", {
        segments: transcript.segments,
        duration: transcript.duration,
      });
      pushEvent(job, "done", {
        frameCount: transcript.segments.length,
        duration: transcript.duration,
        source: "transcript",
      });
      log.info(
        { jobId, videoId, segmentCount: transcript.segments.length },
        "YouTube transcript-first job complete",
      );
      scheduleJobCleanup(jobId, job);
      return;
    }

    log.info({ jobId, videoId }, "Transcript not available; continuing to video download & frame extraction");

    // ── Phase 2: Download video with yt-dlp ─────────────────────────────────
    job.status = "downloading";
    pushEvent(job, "status", { step: "downloading", message: "Downloading video from YouTube..." });
    log.info({ jobId, videoId }, "Phase 2: starting yt-dlp download");

    try {
      await downloadWithYtDlp(videoId, videoFile, job, log, jobId);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const classified = classifyYouTubeError(raw);
      failJob(jobId, job, "download", classified.message, log, raw);
      return;
    }

    // ── Phase 2: Verify downloaded file ─────────────────────────────────────
    log.info({ jobId, videoId, videoFile }, "Phase 2: verifying downloaded file");
    let fileSize: number;
    try {
      const s = await stat(videoFile);
      fileSize = s.size;
      log.info({ jobId, videoId, videoFile, fileSizeBytes: fileSize }, "Download file verified");
      if (fileSize === 0) throw new Error("Downloaded file is empty (0 bytes)");
    } catch (statErr: unknown) {
      const msg = statErr instanceof Error ? statErr.message : String(statErr);
      failJob(
        jobId,
        job,
        "download",
        "The downloaded video file was not created. Please try again.",
        log,
        msg,
      );
      return;
    }

    // ── Phase 3: ffprobe for duration ────────────────────────────────────────
    log.info({ jobId, videoId, videoFile }, "Phase 3: ffprobe for duration");
    let duration = 0;
    try {
      const ffprobeArgs = [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        videoFile,
      ];
      const ffprobeBin = await getFfprobePath();
      log.info({ jobId, videoId, cmd: `${ffprobeBin} ${ffprobeArgs.join(" ")}` }, "ffprobe command");
      const { stdout: probeOut } = await execFileAsync(ffprobeBin, ffprobeArgs, { timeout: 20_000 });
      const probe = JSON.parse(probeOut) as { format?: { duration?: string; size?: string } };
      duration = parseFloat(probe.format?.duration ?? "0") || 0;
      log.info({ jobId, videoId, duration, formatSize: probe.format?.size }, "ffprobe complete");
    } catch (probeErr: unknown) {
      const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
      log.warn({ jobId, videoId, err: msg }, "ffprobe failed — continuing with duration=0");
    }

    // Resolve adaptive interval now that we know duration
    if (autoInterval && duration > 0) {
      effectiveInterval = getAdaptiveInterval(duration);
      log.info({ jobId, duration, effectiveInterval }, "Adaptive interval resolved");
    }
    pushEvent(job, "status", {
      step: "downloading",
      message: `Download complete (${(fileSize! / 1_048_576).toFixed(1)} MB). Extracting frames...`,
    });

    // ── Phase 4: ffmpeg frame extraction ─────────────────────────────────────
    log.info({ jobId, videoId, effectiveInterval, startSec, endSec, videoFile }, "Phase 4: ffmpeg frame extraction");
    job.status = "extracting";
    pushEvent(job, "status", {
      step: "extracting",
      message: `Extracting frames every ${effectiveInterval}s${autoInterval && duration > 0 ? ` (auto, video is ${Math.round(duration / 60)} min)` : ""}...`,
    });

    const actualEnd = endSec != null ? (duration > 0 ? Math.min(endSec, duration) : endSec) : duration;
    const seekArg = startSec > 0 ? ["-ss", String(startSec)] : [];
    const durArg = actualEnd > startSec ? ["-t", String(actualEnd - startSec)] : [];

    const ffmpegArgs = [
      "-loglevel", "warning",
      ...seekArg,
      "-i", videoFile,
      ...durArg,
      "-vf", `fps=1/${effectiveInterval},scale='min(960\\,iw)':-2`,
      "-qscale:v", "5",
      "-f", "image2",
      pathJoin(framesDir, "frame_%04d.jpg"),
    ];
    const ffmpegBin = await getFfmpegPath();
    log.info({ jobId, videoId, cmd: `${ffmpegBin} ${ffmpegArgs.join(" ")}` }, "ffmpeg command");

    try {
      const { stderr: ffmpegStderr } = await execFileAsync(ffmpegBin, ffmpegArgs, { timeout: 300_000 });
      if (ffmpegStderr.trim()) {
        log.warn({ jobId, videoId, ffmpegStderr: ffmpegStderr.slice(0, 800) }, "ffmpeg stderr (non-fatal)");
      }
    } catch (ffmpegErr: unknown) {
      const msg = ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr);
      failJob(
        jobId,
        job,
        "frame_extraction",
        "The server could not extract frames from this video. Please try a shorter range.",
        log,
        msg,
      );
      return;
    }

    // ── Phase 5: Verify frames + stream to SSE clients ────────────────────────
    const frameFiles = (await readdir(framesDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    log.info({ jobId, videoId, frameCount: frameFiles.length }, "Phase 5: streaming frames to clients");

    if (frameFiles.length === 0) {
      failJob(
        jobId,
        job,
        "frame_extraction",
        "No frames could be extracted from the video. Try adjusting the interval or time range.",
        log,
        `No JPG files in ${framesDir}` as string,
      );
      return;
    }

    pushEvent(job, "frame_count", { count: frameFiles.length, duration });

    for (let i = 0; i < frameFiles.length; i++) {
      const framePath = pathJoin(framesDir, frameFiles[i]);
      const data = await readFile(framePath);
      const timestamp = startSec + i * effectiveInterval;
      pushEvent(job, "frame", {
        index: i,
        timestamp,
        data: `data:image/jpeg;base64,${data.toString("base64")}`,
      });
      if (i === 0) {
        log.info({ jobId, videoId, frame: framePath, timestamp }, "First frame emitted");
      }
      if (i % 10 === 0 && i > 0) {
        log.info({ jobId, videoId, frame: i + 1, total: frameFiles.length }, "Frame streaming progress");
      }
      // Yield event loop every 5 frames to keep SSE flushing
      if (i % 5 === 4) await new Promise((r) => setImmediate(r));
    }

    // ── Done ─────────────────────────────────────────────────────────────────
    job.status = "done";
    pushEvent(job, "done", { frameCount: frameFiles.length, duration });
    log.info({ jobId, videoId, frameCount: frameFiles.length }, "YouTube job complete — OCR will run client-side");
    scheduleJobCleanup(jobId, job);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const classified = classifyYouTubeError(msg);
    failJob(jobId, job, "unknown", classified.message, log, msg);
  } finally {
    rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Legacy endpoint (deprecated) ────────────────────────────────────────────
router.get("/youtube/stream", (_req, res) => {
  res.status(410).json({ error: "Use POST /api/youtube/start + GET /api/youtube/events/:jobId instead." });
});

// Compatibility: the old single-shot frames endpoint now delegates to the same job pipeline
router.post("/youtube/frames", (_req, res) => {
  res.status(410).json({
    error: "Use POST /api/youtube/start + GET /api/youtube/events/:jobId (SSE) instead.",
  });
});

// ─── Assistant chat (streaming) ───────────────────────────────────────────────
const ASSISTANT_SYSTEM = `You are a smart, helpful AI assistant built into the "Smart Lecture Notes Generator" web application. You have complete knowledge of this application's architecture, features, and limitations.

## About the Application
Smart Lecture Notes Generator converts lecture or tutorial videos into structured study notes through a pipeline of frame extraction, OCR, and AI summarization.

## Full Workflow
1. **Video Input**: Upload a local video file (MP4, WebM, MOV) OR paste a YouTube URL.
2. **Capture Interval**: Choose Auto (adaptive based on video length) or a custom interval in seconds.
3. **Frame Extraction**:
   - *Local files*: The browser seeks the video at each interval, captures frames to a canvas element, and computes a perceptual hash to skip near-duplicate frames. No data is sent to any server.
   - *YouTube*: The server first checks for public captions. When captions are available, they are sent as timestamped text segments. Otherwise, the server attempts the normal supported yt-dlp download path and then extracts frames with ffmpeg. Frames are sent to the browser as Server-Sent Events (SSE).
4. **OCR**: Tesseract.js runs in the browser using 3 parallel web workers to extract text from each unique frame.
5. **Note Generation**: All OCR text is sent to the backend, which uses OpenAI GPT to produce structured markdown notes in the chosen mode.

## Adaptive Intervals (Auto Mode)
- 0–30 min videos → 10 s interval
- 30–60 min videos → 15 s interval
- 60+ min videos → 20 s interval
- Custom: any positive number of seconds

## Note Modes
- **Smart**: Concise, deduplicated — removes repetition, focuses on key ideas. Best for most lectures.
- **Exact**: Full detail — preserves everything OCR found including all text and code snippets.
- **Detailed**: Summary + key concepts — balanced between Smart and Exact.
- **Exam Revision**: Common exam questions with answers and revision tips.
- **Flashcards**: Q&A study cards formatted for spaced repetition practice.
- **Quiz**: Multiple-choice questions generated from the video content.

## YouTube Processing Details
- Public captions are preferred because they provide timestamped text without video download or OCR.
- If captions are unavailable, yt-dlp tries a small set of supported YouTube player clients. This is not a restriction bypass; YouTube may require authentication or a PO token, and those failures are surfaced honestly.
- When a download succeeds, ffmpeg extracts temporary frames and the temporary files are removed after processing.
- Frames are delivered to the browser in real time via SSE.
- Only public, non-age-restricted, non-geo-blocked videos are supported.

## Privacy
- Local video files never leave the user's browser — all frame capture and OCR is client-side.
- YouTube: frames are temporarily processed server-side and deleted immediately after streaming.
- No notes or video data is stored persistently on any server.

## Supported Formats
- Local files: MP4, WebM, MOV (any format the browser's native video element can decode)
- YouTube: any standard public YouTube URL (youtube.com/watch?v=..., youtu.be/...)

## Common Issues & Troubleshooting
- **OCR misses text / text not detected**: Video resolution or font may be too small or stylized. HD slides with clean sans-serif fonts give best results. Handwritten notes OCR poorly.
- **Too many or too few frames**: Adjust the interval. Lower interval = more frames; higher = fewer frames.
- **Duplicate slides appearing**: Increase the interval, or use Auto mode which adapts to video length.
- **Frames being skipped**: Perceptual hash deduplication intentionally removes near-identical frames to avoid redundant notes. This is expected behavior.
- **YouTube video fails**: The video may be private, age-restricted, geo-blocked, or a livestream. These cannot be processed.
- **Processing is slow**: OCR runs on 3 parallel workers. Videos with many unique frames take more time. YouTube videos also require server-side frame extraction.
- **Notes are repetitive in Exact mode**: Switch to Smart mode — it uses AI to deduplicate and summarize content.
- **Notes are too short or incomplete**: Use Exact or Detailed mode for more comprehensive output.
- **Code snippets look garbled**: OCR sometimes misreads code characters. Use Exact mode and manually verify important code.

## Accuracy
- OCR accuracy depends on video quality. 1080p slides with high-contrast text achieve ~95%+ accuracy. Low-resolution or visually busy backgrounds reduce accuracy.
- AI note generation uses the OCR text as its input, so OCR errors can propagate into the notes. Smart mode mitigates this through AI summarization.

## Best Practices
- Coding tutorials: use a short Custom interval (e.g., 5 s) + Exact mode to capture all code
- Lecture slides: use Auto + Smart mode
- Self-testing: generate Flashcards or Quiz mode
- YouTube: videos under 30 minutes process fastest
- Best OCR results: lecture recordings with clear slide text rather than whiteboard or handwriting

## General Questions
You can answer any general question about programming, computer science, databases (DBMS), data structures and algorithms (DSA), artificial intelligence and machine learning, mathematics, studying techniques, or any other topic. Never refuse a general knowledge question — always answer it.

Maintain full conversation history context so follow-up questions make sense. Be helpful, accurate, and concise. Use markdown formatting (lists, bold, code blocks) where it improves readability.`;

router.post("/assistant/chat", async (req, res) => {
  try {
    const body = req.body as {
      messages?: { role: "user" | "assistant"; content: string }[];
      notes?: string;
    };
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (msgs.length === 0) {
      res.status(400).json({ error: "No messages provided" });
      return;
    }

    const systemContent = body.notes
      ? `${ASSISTANT_SYSTEM}\n\n---\n\n## User's Generated Notes (current session)\n\n${body.notes.slice(0, 8000)}`
      : ASSISTANT_SYSTEM;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const stream = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      max_completion_tokens: 8192,
      stream: true,
      messages: [
        { role: "system", content: systemContent },
        ...msgs.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (token) {
        res.write(`data: ${JSON.stringify({ t: token })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    req.log.error({ err }, "assistant chat failed");
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAuthError =
      (err as { status?: number }).status === 401 ||
      /invalid_api_key|Incorrect API key|AuthenticationError/i.test(errMsg);
    if (!res.headersSent) {
      res.status(isAuthError ? 401 : 500).json({
        error: isAuthError
          ? "OpenAI API key is invalid or not configured. Set OPENAI_API_KEY in artifacts/api-server/.env and restart."
          : "Assistant failed",
      });
    } else {
      res.write(`data: ${JSON.stringify({ t: "\n\n*Error: could not complete response.*" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
});

export default router;
