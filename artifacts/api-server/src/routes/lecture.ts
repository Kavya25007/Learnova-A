import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

type NoteMode = "smart" | "exact" | "detailed" | "exam" | "flashcards" | "quiz";

const NOTES_SYSTEM: Record<NoteMode, string> = {
  exact: `You are a precise note-taking AI inside a Smart Lecture Notes Generator.

Convert OCR text extracted from frames of a lecture/tutorial video into clean, structured study notes in MARKDOWN.

EXACT MODE rules:
- Preserve every meaningful detail. Do not skip information.
- Keep code blocks exactly as seen (use fenced code blocks with a language hint when obvious).
- Maintain the original order of steps.
- Merge duplicates and OCR noise (typos in repeated text), but never lose unique content.
- Use clear ## and ### headings, bullet points, and numbered lists for steps.
- Highlight formulas using inline math style or fenced math blocks.
- Do not invent content that is not in the OCR text.
- Do not add filler explanations.

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

Convert OCR text extracted from lecture video frames into comprehensive, detailed study notes in MARKDOWN.

DETAILED MODE rules:
- Produce the most complete notes possible.
- Start with a ## Summary section (3–5 sentences overview of the whole lecture).
- Add a ## Key Concepts section (bullet list of the most important terms and ideas, each with a 1–2 sentence explanation).
- Add a ## Important Formulas or Definitions section if any are present.
- Then produce full ## section notes in order, with all details preserved.
- Include code blocks with language hints.
- End with a ## Action Items / Takeaways section listing what to study or practise next.
- Use ## for major topics, ### for subtopics, bullet points for details.
- Do not invent content; only elaborate on what the OCR text contains.

Output ONLY the markdown notes. No preamble.`,

  exam: `You are an exam-prep AI inside a Smart Lecture Notes Generator.

Convert OCR text from lecture video frames into structured exam revision notes in MARKDOWN.

EXAM REVISION MODE rules:
- Start with a ## Quick Summary (2–4 sentences, the absolute essentials).
- Add a ## Key Concepts to Know section (the most testable ideas, each defined clearly).
- Add a ## Formulas and Definitions section if any are present.
- Add a ## Common Exam Questions section: list 5–8 likely exam questions with concise answers.
- Add a ## Things to Remember / Watch Out For section: common mistakes or tricky points.
- Use bold for critical terms, code blocks for code and formulas.
- Be concise and exam-focused. Remove anything unlikely to be tested.
- Do not invent content; only work from the OCR text.

Output ONLY the markdown notes. No preamble.`,

  flashcards: `You are a flashcard-generation AI inside a Smart Lecture Notes Generator.

Convert OCR text from lecture video frames into a set of study flashcards in MARKDOWN.

FLASHCARDS MODE rules:
- Generate 10–25 flashcards depending on content volume.
- Format EVERY card exactly like this (no deviation):

---
**Q:** [concise question]
**A:** [clear, direct answer]

- Questions should test one concept, formula, term, or step.
- Cover all major topics from the lecture.
- Use code blocks inside answers for code or formulas when needed.
- Do not invent content; base every card on the OCR text.
- Start with a ## Flashcards heading then list all cards.

Output ONLY the flashcards in the format above. No preamble.`,

  quiz: `You are a quiz-generation AI inside a Smart Lecture Notes Generator.

Convert OCR text from lecture video frames into a multiple-choice quiz in MARKDOWN.

QUIZ MODE rules:
- Generate 8–15 multiple-choice questions depending on content volume.
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
- Do not invent content; base every question on the OCR text.
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

    const userPrompt = `Lecture title (optional): ${body.title || "Untitled lecture"}\n\nBelow is OCR text extracted from sequential frames of the video. Convert it per the rules.\n\n${joined}`;

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

router.get("/youtube/meta", async (req, res) => {
  try {
    const url = req.query.url as string;
    if (!url) {
      res.status(400).json({ error: "Missing url query param" });
      return;
    }
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const resp = await fetch(oembedUrl);
    if (!resp.ok) {
      res.status(404).json({ error: "Video not found or unavailable" });
      return;
    }
    const data = (await resp.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    res.json({
      title: data.title ?? "",
      channel: data.author_name ?? "",
      thumbnail: data.thumbnail_url ?? "",
    });
  } catch (err) {
    req.log.error({ err }, "youtube meta failed");
    res.status(500).json({ error: "Failed to fetch video metadata" });
  }
});

const ASSISTANT_SYSTEM = `You are an AI assistant inside a Smart Lecture Notes Generator web app.

Your job is to help users navigate the app, answer questions about their generated notes, and explain study concepts.

App workflow the user follows:
1. Upload a video file (or paste a YouTube link as reference).
2. Select a capture interval (3s, 5s, or 10s). 5s is recommended.
3. Optionally set a Custom Time Range to process only a portion.
4. Click Start Processing. The app pauses the video at each interval, captures frames, preprocesses for OCR, and removes duplicates.
5. Choose a note mode: Smart (concise), Exact (full detail), Detailed (with key concepts and summary), Exam Revision, Flashcards, or Quiz.
6. Click Generate Notes to produce structured markdown output.

Behavior rules:
- Be friendly and helpful.
- Keep answers short, clear, and step-by-step.
- If the user pastes or refers to their generated notes, you can answer questions about them, explain concepts, or suggest what to study.
- If notes look repetitive, suggest a longer interval (5–10s) and Smart Mode.
- If OCR misses text, suggest videos with clearer on-screen text and a higher interval.
- Recommend 5s interval for most videos.
- No emojis.`;

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

    const systemWithNotes = body.notes
      ? `${ASSISTANT_SYSTEM}\n\nThe user has generated the following notes — use them to answer questions:\n\n${body.notes.slice(0, 6000)}`
      : ASSISTANT_SYSTEM;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: systemWithNotes },
        ...msgs.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    const content = completion.choices[0]?.message?.content ?? "";
    res.json({ content });
  } catch (err) {
    req.log.error({ err }, "assistant chat failed");
    res.status(500).json({ error: "Assistant failed" });
  }
});

export default router;
