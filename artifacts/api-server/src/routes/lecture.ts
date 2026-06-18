import { Router, type IRouter } from "express";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
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
  try {
    const url = req.query.url as string;
    if (!url) { res.status(400).json({ error: "Missing url" }); return; }
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const resp = await fetch(oembedUrl);
    if (!resp.ok) { res.status(404).json({ error: "Video not found or unavailable" }); return; }
    const data = (await resp.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    res.json({ title: data.title ?? "", channel: data.author_name ?? "", thumbnail: data.thumbnail_url ?? "" });
  } catch (err) {
    req.log.error({ err }, "youtube meta failed");
    res.status(500).json({ error: "Failed to fetch video metadata" });
  }
});

// ─── YouTube video stream proxy ───────────────────────────────────────────────
// Downloads via yt-dlp and pipes through ffmpeg → fragmented MP4 the browser
// can play and from which canvas frame extraction works on all browsers.

router.get("/youtube/stream", (req, res) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: "Missing url" }); return; }

  const ytRx = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/;
  if (!ytRx.test(url)) { res.status(400).json({ error: "Invalid YouTube URL" }); return; }

  // yt-dlp downloads video+audio and writes to stdout
  const ytdlp = spawn("yt-dlp", [
    "-o", "-",
    "--no-playlist",
    "--no-check-certificate",
    // prefer a single progressive stream; fall back to best merged
    "--format",
    "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/bestvideo[ext=mp4]+bestaudio/best",
    "--merge-output-format", "mp4",
    url,
  ]);

  // ffmpeg remuxes to a fragmented MP4 that browsers can stream & seek
  const ff = spawn("ffmpeg", [
    "-loglevel", "error",
    "-i", "pipe:0",
    "-c", "copy",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+faststart",
    "pipe:1",
  ]);

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  ytdlp.stdout.pipe(ff.stdin);
  ff.stdout.pipe(res);

  // Cleanup on client disconnect
  const cleanup = () => {
    try { ytdlp.kill("SIGKILL"); } catch { /* already gone */ }
    try { ff.kill("SIGKILL"); } catch { /* already gone */ }
  };
  req.on("close", cleanup);

  ytdlp.stderr.on("data", (d: Buffer) => {
    const msg = d.toString();
    if (/ERROR|private|unavailable|age.?restrict/i.test(msg)) {
      req.log.warn({ msg }, "yt-dlp stderr");
    }
  });

  ytdlp.on("error", (err) => {
    req.log.error({ err }, "yt-dlp spawn error");
    if (!res.headersSent) res.status(500).json({ error: "Failed to start downloader" });
  });

  ff.on("error", (err) => {
    req.log.error({ err }, "ffmpeg spawn error");
    if (!res.headersSent) res.status(500).json({ error: "Failed to process video" });
  });

  ytdlp.on("close", (code) => {
    if (code !== 0 && code !== null) {
      req.log.warn({ code }, "yt-dlp exited with non-zero code");
    }
    ff.stdin.end();
  });

  ff.on("close", () => {
    res.end();
  });
});

// ─── Assistant chat ───────────────────────────────────────────────────────────

const ASSISTANT_SYSTEM = `You are an AI assistant inside a Smart Lecture Notes Generator web app.
Help users navigate the app, answer questions about their generated notes, and explain study concepts.
App workflow:
1. Upload a video file OR paste a YouTube URL (which the app will stream directly).
2. Select a capture interval (default 5s).
3. Optionally set a Custom Time Range.
4. Click Start Processing — the app captures frames, preprocesses for OCR, and deduplicates.
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
