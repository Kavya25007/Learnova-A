import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
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

  const effectiveInterval = Math.max(1, Math.round(Number(rawInterval) || 10));
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

  req.log.info({ jobId, videoId, effectiveInterval, startSec, endSec }, "YouTube job created");
  res.json({ jobId, videoId });

  // Run processing asynchronously — completely detached from the HTTP response
  runYouTubeJob(jobId, job, { url, videoId, effectiveInterval, startSec, endSec }, req.log).catch(
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

// ─── Background job runner ────────────────────────────────────────────────────
async function runYouTubeJob(
  jobId: string,
  job: YtJob,
  opts: { url: string; videoId: string; effectiveInterval: number; startSec: number; endSec: number | null },
  log: Request["log"],
) {
  const { url, videoId, effectiveInterval, startSec, endSec } = opts;
  const videoPath = `${job.tmpDir}/video.mp4`;
  const framesDir = `${job.tmpDir}/frames`;

  try {
    await mkdir(framesDir, { recursive: true });

    // ── Phase 1: Download ────────────────────────────────────────────────────
    job.status = "downloading";
    pushEvent(job, "status", { step: "downloading", message: "Downloading video from YouTube..." });

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("yt-dlp", [
        "--no-playlist",
        "--newline",
        "--no-check-certificate",
        "--format",
        "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]/best",
        "--merge-output-format", "mp4",
        "--output", videoPath,
        url,
      ]);

      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        // Parse progress lines: "[download]  45.3% of ~42.32MiB at 1.23MiB/s ETA 00:30"
        const pctM = text.match(/\[download\]\s+([\d.]+)%/);
        if (pctM) {
          const speedM = text.match(/at\s+([\d.]+\s*\S+\/s)/);
          const etaM = text.match(/ETA\s+(\S+)/);
          pushEvent(job, "download_progress", {
            pct: parseFloat(pctM[1]),
            speed: speedM?.[1],
            eta: etaM?.[1],
          });
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("close", (code) => {
        if (code === 0) { resolve(); return; }
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      });
      proc.on("error", (err) => reject(err));
    }).catch((err: Error) => {
      const msg = err.message;
      let userMsg: string;
      let step = "download";
      if (/private video|video is private/i.test(msg)) userMsg = "This video is private.";
      else if (/age.?restrict|confirm your age|sign in/i.test(msg)) userMsg = "This video is age-restricted.";
      else if (/unavailable|not available|removed|banned/i.test(msg)) userMsg = "This video is unavailable or has been removed.";
      else if (/copyright/i.test(msg)) userMsg = "This video is blocked due to copyright.";
      else userMsg = `Download failed: ${msg.slice(0, 200)}`;
      pushEvent(job, "error", { step, message: userMsg });
      job.status = "error";
      throw new Error("__handled__");
    });

    // ── Phase 2: Get duration via ffprobe ────────────────────────────────────
    let duration = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet", "-print_format", "json", "-show_format", videoPath,
      ], { timeout: 15_000 });
      const probe = JSON.parse(stdout) as { format?: { duration?: string } };
      duration = parseFloat(probe.format?.duration ?? "0") || 0;
    } catch { /* non-fatal */ }

    // ── Phase 3: Extract frames ───────────────────────────────────────────────
    job.status = "extracting";
    pushEvent(job, "status", { step: "extracting", message: "Extracting frames from video..." });

    const actualEnd = endSec != null ? Math.min(endSec, duration || endSec) : duration;
    const seekArg = startSec > 0 ? ["-ss", String(startSec)] : [];
    const durArg = actualEnd > startSec ? ["-t", String(actualEnd - startSec)] : [];

    const ffmpegArgs = [
      "-loglevel", "warning",
      ...seekArg,
      "-i", videoPath,
      ...durArg,
      "-vf", `fps=1/${effectiveInterval},scale='min(960\\,iw)':-2`,
      "-qscale:v", "5",
      "-f", "image2",
      `${framesDir}/frame_%04d.jpg`,
    ];

    await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 120_000 }).catch((err: Error) => {
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

// ─── Assistant chat ───────────────────────────────────────────────────────────
const ASSISTANT_SYSTEM = `You are an AI assistant inside a Smart Lecture Notes Generator web app.
Help users navigate the app, answer questions about their generated notes, and explain study concepts.
App workflow:
1. Upload a video file OR paste a YouTube URL (the app downloads and processes it server-side).
2. Select a capture interval (default 10s).
3. Optionally set a Custom Time Range.
4. Click Start Processing — the app downloads the video, extracts frames, runs OCR, and deduplicates.
5. Choose a note mode: Smart, Exact, Detailed, Exam Revision, Flashcards, or Quiz.
6. Click Generate Notes.
If the user pastes their notes, you can answer questions about them, explain concepts, or generate quizzes.
Be friendly, concise, and step-by-step. No emojis.`;

router.post("/assistant/chat", async (req, res) => {
  try {
    const body = req.body as {
      messages?: { role: "user" | "assistant"; content: string }[];
      notes?: string;
    };
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (msgs.length === 0) { res.status(400).json({ error: "No messages provided" }); return; }

    const systemWithNotes = body.notes
      ? `${ASSISTANT_SYSTEM}\n\nUser's generated notes:\n\n${body.notes.slice(0, 6000)}`
      : ASSISTANT_SYSTEM;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: systemWithNotes },
        ...msgs.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    res.json({ content: completion.choices[0]?.message?.content ?? "" });
  } catch (err) {
    req.log.error({ err }, "assistant chat failed");
    res.status(500).json({ error: "Assistant failed" });
  }
});

export default router;
