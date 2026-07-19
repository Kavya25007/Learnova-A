import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, rm, readdir, readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { openai } from "@workspace/integrations-openai-ai-server";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();

// ─── In-memory job store ─────────────────────────────────────────────────────
// Each job accumulates SSE event strings. Active SSE connections register a
// listener function so they get events pushed immediately. Late connections
// replay the full event log from the start.

interface YtJob {
  status: "queued" | "downloading" | "extracting" | "done" | "error";
  events: string[]; // accumulated SSE event strings (replayed to late connections)
  listeners: Set<(ev: string) => void>;
  tmpDir: string;
  createdAt: number;
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
  exact: `You are a precise note-taking AI inside a Smart Lecture Notes Generator.
Convert OCR text extracted from frames of a lecture/tutorial video into clean, structured study notes in MARKDOWN.
EXACT MODE rules:
- Preserve every meaningful detail. Do not skip information.
- Keep code blocks exactly as seen (fenced code blocks with a language hint when obvious).
- Maintain the original order of steps.
- Merge duplicates and OCR noise but never lose unique content.
- Use clear ## and ### headings, bullet points, and numbered lists for steps.
- Highlight formulas using inline math style or fenced math blocks.
- Do not invent content. Do not add filler explanations.
Output ONLY the markdown notes. No preamble.`,

  smart: `You are a smart note-taking AI inside a Smart Lecture Notes Generator.
Convert OCR text extracted from frames of a lecture/tutorial video into clean, structured study notes in MARKDOWN.
SMART MODE rules:
- Remove repetition and OCR noise.
- Merge similar concepts into one clear explanation.
- Keep only important and useful information.
- Improve readability while staying faithful to the source.
- Use clear ## and ### headings, bullet points, numbered steps, and fenced code blocks where relevant.
- Highlight formulas if present.
- Output should be concise, structured, and easy to revise from.
- Do not invent facts; only reorganize and clarify what is in the OCR.
Output ONLY the markdown notes. No preamble.`,

  detailed: `You are a thorough note-taking AI inside a Smart Lecture Notes Generator.
Convert OCR text from lecture video frames into comprehensive, detailed study notes in MARKDOWN.
DETAILED MODE rules:
- Start with a ## Summary section (3-5 sentences overview).
- Add a ## Key Concepts section (bullet list of important terms, each with a 1-2 sentence explanation).
- Add a ## Important Formulas or Definitions section if any are present.
- Add a ## Interview Questions section with 5 likely questions and concise answers.
- Then produce full ## section notes in order, with all details preserved.
- Include code blocks with language hints.
- End with a ## Action Items / Takeaways section.
- Use ## for major topics, ### for subtopics.
- Do not invent content.
Output ONLY the markdown notes. No preamble.`,

  exam: `You are an exam-prep AI inside a Smart Lecture Notes Generator.
Convert OCR text from lecture video frames into structured exam revision notes in MARKDOWN.
EXAM REVISION MODE rules:
- Start with a ## Quick Summary (2-4 sentences, the absolute essentials).
- Add a ## Key Concepts to Know section (most testable ideas, each defined clearly).
- Add a ## Formulas and Definitions section if any are present.
- Add a ## Common Exam Questions section: 5-8 likely exam questions with concise answers.
- Add a ## Practice Questions section: 3-5 short-answer questions (no answers, for self-testing).
- Add a ## Things to Remember / Watch Out For section: common mistakes or tricky points.
- Use bold for critical terms, code blocks for code and formulas.
- Be concise and exam-focused.
- Do not invent content.
Output ONLY the markdown notes. No preamble.`,

  flashcards: `You are a flashcard-generation AI inside a Smart Lecture Notes Generator.
Convert OCR text from lecture video frames into a set of study flashcards in MARKDOWN.
FLASHCARDS MODE rules:
- Generate 10-25 flashcards depending on content volume.
- Format EVERY card exactly like this:

---
**Q:** [concise question]
**A:** [clear, direct answer]

- Questions should test one concept, formula, term, or step.
- Cover all major topics from the lecture.
- Use code blocks inside answers for code or formulas when needed.
- Do not invent content.
- Start with a ## Flashcards heading then list all cards.
Output ONLY the flashcards in the format above. No preamble.`,

  quiz: `You are a quiz-generation AI inside a Smart Lecture Notes Generator.
Convert OCR text from lecture video frames into a multiple-choice quiz in MARKDOWN.
QUIZ MODE rules:
- Generate 8-15 multiple-choice questions.
- Format EVERY question exactly like this:

---
**Q[n].** [question text]
- A) [option]
- B) [option]
- C) [option]
- D) [option]
**Answer:** [letter] — [1-sentence explanation]

- Questions should range from easy to hard.
- Cover all major topics.
- Distractors should be plausible but clearly wrong on reflection.
- Do not invent content.
- Start with a ## Quiz heading.
Output ONLY the quiz in the format above. No preamble.`,
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
    const frames = Array.isArray(body.frames) ? body.frames : [];

    if (frames.length === 0) {
      res.status(400).json({ error: "No frames provided" });
      return;
    }

    const joined = frames
      .map(
        (f, i) =>
          `--- Frame ${i + 1} (t=${Math.round(f.timestamp)}s) ---\n${(f.text || "").trim()}`,
      )
      .join("\n\n");

    const userPrompt = `Lecture title: ${body.title || "Untitled"}\n\nOCR text from sequential video frames:\n\n${joined}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: NOTES_SYSTEM[mode] },
        { role: "user", content: userPrompt },
      ],
    });

    const notes = completion.choices[0]?.message?.content ?? "";
    res.json({ notes, mode });
  } catch (err) {
    req.log.error({ err }, "notes generation failed");
    res.status(500).json({ error: "Failed to generate notes" });
  }
});

// ─── YouTube metadata ─────────────────────────────────────────────────────────
router.get("/youtube/meta", async (req, res) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: "Missing url", step: "url_validation" }); return; }

  const ytRx = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/;
  const m = url.match(ytRx);
  if (!m) { res.status(400).json({ error: "Invalid YouTube URL", step: "url_validation" }); return; }
  const videoId = m[1];

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const resp = await fetch(oembedUrl);
    if (!resp.ok) {
      res.status(404).json({ error: "Video not found or unavailable", step: "metadata", videoId });
      return;
    }
    const data = (await resp.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    res.json({ title: data.title ?? "", channel: data.author_name ?? "", thumbnail: data.thumbnail_url ?? "", videoId });
  } catch (err) {
    req.log.error({ err }, "youtube meta failed");
    res.status(500).json({ error: "Failed to fetch video metadata", step: "metadata" });
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

  if (!url) { res.status(400).json({ error: "Missing url", step: "url_validation" }); return; }

  const ytRx = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/;
  const m = url.match(ytRx);
  if (!m) { res.status(400).json({ error: "Invalid YouTube URL", step: "url_validation" }); return; }
  const videoId = m[1];

  // interval=0 means Auto — the job will compute it from ffprobe duration after download
  const requestedInterval = Number(rawInterval ?? -1);
  const autoInterval = requestedInterval === 0 || requestedInterval < 0;
  // Use -1 as the sentinel value through to the job runner
  const resolvedInterval = autoInterval ? 0 : Math.max(1, Math.round(requestedInterval));
  const startSec = Math.max(0, Number(rawStart) || 0);
  const endSec: number | null = rawEnd != null && rawEnd !== undefined ? Math.max(startSec + 1, Number(rawEnd)) : null;

  const jobId = randomUUID();
  const tmpDir = `/tmp/yt-${videoId}-${jobId.slice(0, 8)}`;
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
  runYouTubeJob(jobId, job, { url, videoId, requestedInterval: resolvedInterval, autoInterval, startSec, endSec }, req.log).catch(
    (err) => req.log.error({ err, jobId }, "Unhandled error in YouTube job"),
  );
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

  // Register for future events
  const listener = (ev: string) => { res.write(ev); };
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

// ─── Background job runner ────────────────────────────────────────────────────
async function runYouTubeJob(
  jobId: string,
  job: YtJob,
  opts: { url: string; videoId: string; requestedInterval: number; autoInterval: boolean; startSec: number; endSec: number | null },
  log: Request["log"],
) {
  const { url, videoId, requestedInterval, autoInterval, startSec, endSec } = opts;
  let effectiveInterval = requestedInterval > 0 ? requestedInterval : 10;
  const framesDir = `${job.tmpDir}/frames`;

  try {
    await mkdir(framesDir, { recursive: true });

    // ── Phase 1: Resolve direct stream URL via yt-dlp android client ─────────
    // The android client bypasses YouTube's datacenter-IP restrictions.
    // We only extract the stream URL — no full video download needed.
    job.status = "downloading";
    pushEvent(job, "status", { step: "downloading", message: "Resolving YouTube stream..." });

    let streamUrl: string;
    try {
      const { stdout, stderr } = await execFileAsync("yt-dlp", [
        "--no-playlist",
        "--no-check-certificate",
        "--extractor-args", "youtube:player_client=android",
        "--format", "best[height<=480][ext=mp4]/best[height<=480]/best",
        "--get-url",
        url,
      ], { timeout: 30_000 });

      // stdout may contain warnings on separate lines before the URL
      const urlLine = stdout.trim().split("\n").find((l) => l.startsWith("http"));
      if (!urlLine) {
        throw new Error(stderr?.trim() || "No stream URL returned by yt-dlp");
      }
      streamUrl = urlLine;
      log.info({ jobId, videoId }, "Stream URL resolved");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      let userMsg: string;
      if (/private video|video is private/i.test(msg)) userMsg = "This video is private.";
      else if (/age.?restrict|confirm your age|sign in/i.test(msg)) userMsg = "This video is age-restricted.";
      else if (/unavailable|not available|removed|banned/i.test(msg)) userMsg = "This video is unavailable or has been removed.";
      else if (/copyright/i.test(msg)) userMsg = "This video is blocked due to copyright.";
      else if (/no video formats/i.test(msg)) userMsg = "Could not resolve a playable format. The video may be restricted.";
      else userMsg = `Could not access video: ${msg.slice(0, 200)}`;
      pushEvent(job, "error", { step: "download", message: userMsg });
      job.status = "error";
      return;
    }

    // ── Phase 2: Get duration via ffprobe on the stream URL ───────────────────
    let duration = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet", "-print_format", "json", "-show_format", streamUrl,
      ], { timeout: 20_000 });
      const probe = JSON.parse(stdout) as { format?: { duration?: string } };
      duration = parseFloat(probe.format?.duration ?? "0") || 0;
    } catch { /* non-fatal: duration stays 0 */ }

    // Resolve adaptive interval now that we know the duration
    if (autoInterval && duration > 0) {
      effectiveInterval = getAdaptiveInterval(duration);
      log.info({ jobId, duration, effectiveInterval }, "Adaptive interval resolved");
    }

    // ── Phase 3: Extract frames directly from the stream URL ──────────────────
    // ffmpeg streams from the CDN URL — no intermediate file download.
    job.status = "extracting";
    pushEvent(job, "status", {
      step: "extracting",
      message: `Extracting frames every ${effectiveInterval}s${autoInterval && duration > 0 ? ` (auto, ${Math.round(duration / 60)} min)` : ""}...`,
    });

    const actualEnd = endSec != null ? (duration > 0 ? Math.min(endSec, duration) : endSec) : duration;
    const seekArg = startSec > 0 ? ["-ss", String(startSec)] : [];
    const durArg = actualEnd > startSec ? ["-t", String(actualEnd - startSec)] : [];

    const ffmpegArgs = [
      "-loglevel", "warning",
      ...seekArg,
      "-i", streamUrl,
      ...durArg,
      "-vf", `fps=1/${effectiveInterval},scale='min(960\\,iw)':-2`,
      "-qscale:v", "5",
      "-f", "image2",
      `${framesDir}/frame_%04d.jpg`,
    ];

    await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 300_000 }).catch((err: Error) => {
      pushEvent(job, "error", { step: "frame_extraction", message: `Frame extraction failed: ${err.message.slice(0, 200)}` });
      job.status = "error";
      throw new Error("__handled__");
    });

    // ── Phase 4: Stream frames to SSE clients ─────────────────────────────────
    const frameFiles = (await readdir(framesDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    if (frameFiles.length === 0) {
      pushEvent(job, "error", {
        step: "frame_extraction",
        message: "No frames could be extracted. Try a different interval or time range.",
      });
      job.status = "error";
      return;
    }

    pushEvent(job, "frame_count", { count: frameFiles.length, duration });
    log.info({ jobId, videoId, frameCount: frameFiles.length }, "Streaming frames to clients");

    for (let i = 0; i < frameFiles.length; i++) {
      const data = await readFile(`${framesDir}/${frameFiles[i]}`);
      const timestamp = startSec + i * effectiveInterval;
      pushEvent(job, "frame", {
        index: i,
        timestamp,
        data: `data:image/jpeg;base64,${data.toString("base64")}`,
      });
      // Yield the event loop briefly every 5 frames to avoid blocking
      if (i % 5 === 4) await new Promise((r) => setImmediate(r));
    }

    // ── Done ─────────────────────────────────────────────────────────────────
    job.status = "done";
    pushEvent(job, "done", { frameCount: frameFiles.length, duration });
    log.info({ jobId, videoId, frameCount: frameFiles.length }, "YouTube job complete");
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "__handled__") return;
    log.error({ err, jobId }, "Unexpected error in YouTube job");
    if (job.status !== "error") {
      pushEvent(job, "error", { step: "unknown", message: "An unexpected server error occurred." });
      job.status = "error";
    }
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
   - *YouTube*: The server uses yt-dlp (android client) to extract a direct CDN stream URL without downloading the full video, then ffmpeg extracts frames from that URL. Frames are sent to the browser as Server-Sent Events (SSE).
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
- yt-dlp extracts a direct playback URL using the android player client (bypasses datacenter IP restrictions that block standard downloads).
- ffmpeg streams frames directly from the CDN URL — the full video is never stored on the server.
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
      model: "gpt-5.4",
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
    if (!res.headersSent) {
      res.status(500).json({ error: "Assistant failed" });
    } else {
      res.write(`data: ${JSON.stringify({ t: "\n\n*Error: could not complete response.*" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
});

export default router;
