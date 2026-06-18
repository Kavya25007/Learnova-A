import { Router, type IRouter } from "express";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { mkdir, rm, readdir, readFile } from "fs/promises";
import { openai } from "@workspace/integrations-openai-ai-server";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();

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

// ─── Notes generation ────────────────────────────────────────────────────────

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
    req.log.info({ videoId }, "Fetching YouTube metadata via oEmbed");
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const resp = await fetch(oembedUrl);
    if (!resp.ok) {
      req.log.warn({ videoId, status: resp.status }, "oEmbed returned non-OK status");
      res.status(404).json({ error: "Video not found or unavailable", step: "metadata", videoId });
      return;
    }
    const data = (await resp.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    req.log.info({ videoId, title: data.title }, "YouTube metadata fetched");
    res.json({ title: data.title ?? "", channel: data.author_name ?? "", thumbnail: data.thumbnail_url ?? "", videoId });
  } catch (err) {
    req.log.error({ err }, "youtube meta failed");
    res.status(500).json({ error: "Failed to fetch video metadata", step: "metadata" });
  }
});

// ─── YouTube server-side frame extraction ────────────────────────────────────
// Downloads video with yt-dlp, extracts frames with ffmpeg, returns base64.
// The client feeds these frames directly into its Tesseract OCR pipeline —
// no browser video element or streaming proxy needed.

router.post("/youtube/frames", async (req, res) => {
  const { url, interval: rawInterval, startTime: rawStart, endTime: rawEnd } = req.body as {
    url?: string;
    interval?: number;
    startTime?: number;
    endTime?: number;
  };

  // Step 1: URL validation
  if (!url) {
    req.log.warn("youtube/frames: missing url");
    res.status(400).json({ error: "Missing url", step: "url_validation" });
    return;
  }
  const ytRx = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/;
  const m = url.match(ytRx);
  if (!m) {
    req.log.warn({ url }, "youtube/frames: invalid URL");
    res.status(400).json({ error: "Invalid YouTube URL", step: "url_validation" });
    return;
  }
  const videoId = m[1];
  const effectiveInterval = Math.max(1, Math.round(Number(rawInterval) || 10));
  const startSec = Math.max(0, Number(rawStart) || 0);
  const endSec = rawEnd != null ? Math.max(startSec + 1, Number(rawEnd)) : null;

  req.log.info({ videoId, effectiveInterval, startSec, endSec }, "YouTube frame extraction requested");

  const tmpDir = `/tmp/yt-${videoId}-${Date.now()}`;
  const videoPath = `${tmpDir}/video.mp4`;
  const framesDir = `${tmpDir}/frames`;

  try {
    await mkdir(framesDir, { recursive: true });

    // Step 2: Download video
    req.log.info({ videoId }, "Starting yt-dlp download");
    try {
      await execFileAsync("yt-dlp", [
        "--no-playlist",
        "--no-check-certificate",
        "--format",
        "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]/best",
        "--merge-output-format", "mp4",
        "--output", videoPath,
        url,
      ], { timeout: 300_000 });
      req.log.info({ videoId }, "yt-dlp download complete");
    } catch (err: unknown) {
      const raw = err as { stderr?: string; stdout?: string; message?: string };
      const msg = String(raw.stderr || raw.message || err);
      req.log.error({ videoId, msg: msg.slice(0, 500) }, "yt-dlp download failed");
      if (/private video|video is private/i.test(msg)) {
        res.status(403).json({ error: "This video is private", step: "download", videoId });
      } else if (/age.?restrict|confirm your age|sign in/i.test(msg)) {
        res.status(403).json({ error: "This video is age-restricted", step: "download", videoId });
      } else if (/unavailable|not available|removed|banned/i.test(msg)) {
        res.status(404).json({ error: "This video is unavailable or has been removed", step: "download", videoId });
      } else if (/copyright/i.test(msg)) {
        res.status(451).json({ error: "This video is blocked due to copyright", step: "download", videoId });
      } else {
        res.status(500).json({
          error: `Download failed. yt-dlp output: ${msg.slice(0, 300)}`,
          step: "download",
          videoId,
        });
      }
      return;
    }

    // Step 3: Get video duration via ffprobe
    let duration = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        videoPath,
      ], { timeout: 15_000 });
      const probe = JSON.parse(stdout) as { format?: { duration?: string } };
      duration = parseFloat(probe.format?.duration ?? "0") || 0;
      req.log.info({ videoId, duration }, "ffprobe duration");
    } catch (err) {
      req.log.warn({ err }, "ffprobe failed; duration unknown");
    }

    // Step 4: Extract frames
    const actualEnd = endSec != null ? Math.min(endSec, duration || endSec) : duration;
    const seekArg = startSec > 0 ? ["-ss", String(startSec)] : [];
    const durationArg =
      actualEnd > startSec ? ["-t", String(actualEnd - startSec)] : [];

    const ffmpegArgs = [
      "-loglevel", "warning",
      ...seekArg,
      "-i", videoPath,
      ...durationArg,
      "-vf", `fps=1/${effectiveInterval},scale='min(960\\,iw)':-2`,
      "-qscale:v", "5",
      "-f", "image2",
      `${framesDir}/frame_%04d.jpg`,
    ];

    req.log.info({ videoId, ffmpegArgs: ffmpegArgs.join(" ") }, "Starting ffmpeg frame extraction");
    try {
      const { stderr } = await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 120_000 });
      if (stderr) req.log.debug({ videoId, stderr: stderr.slice(0, 500) }, "ffmpeg stderr");
      req.log.info({ videoId }, "ffmpeg frame extraction complete");
    } catch (err: unknown) {
      const raw = err as { stderr?: string; message?: string };
      const msg = String(raw.stderr || raw.message || err);
      req.log.error({ videoId, msg: msg.slice(0, 500) }, "ffmpeg frame extraction failed");
      res.status(500).json({
        error: `Frame extraction failed: ${msg.slice(0, 200)}`,
        step: "frame_extraction",
        videoId,
      });
      return;
    }

    // Step 5: Read frames and encode as base64
    let frameFiles: string[] = [];
    try {
      frameFiles = (await readdir(framesDir))
        .filter((f) => f.endsWith(".jpg"))
        .sort();
    } catch (err) {
      req.log.error({ err }, "Failed to read frames directory");
      res.status(500).json({ error: "Could not read extracted frames", step: "frame_read", videoId });
      return;
    }

    if (frameFiles.length === 0) {
      req.log.warn({ videoId }, "No frames extracted — video may have no visual content");
      res.status(422).json({
        error: "No frames could be extracted from this video. Try a shorter time range or different interval.",
        step: "frame_extraction",
        videoId,
        duration,
      });
      return;
    }

    req.log.info({ videoId, frameCount: frameFiles.length }, "Encoding frames to base64");
    const frames = await Promise.all(
      frameFiles.map(async (file, i) => {
        const data = await readFile(`${framesDir}/${file}`);
        const timestamp = startSec + i * effectiveInterval;
        return {
          timestamp,
          data: `data:image/jpeg;base64,${data.toString("base64")}`,
        };
      }),
    );

    req.log.info({ videoId, frameCount: frames.length }, "YouTube frames ready");
    res.json({ frames, videoId, duration, frameCount: frames.length });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in youtube/frames");
    if (!res.headersSent) {
      res.status(500).json({ error: "Unexpected server error", step: "unknown", videoId });
    }
  } finally {
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ─── YouTube stream (legacy — kept for reference, no longer used by client) ──
router.get("/youtube/stream", (_req, res) => {
  res.status(410).json({ error: "YouTube streaming is no longer used. Use POST /api/youtube/frames instead." });
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
