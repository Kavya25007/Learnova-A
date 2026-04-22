import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

const NOTES_SYSTEM_EXACT = `You are a precise note-taking AI inside a Smart Lecture Notes Generator.

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

Output ONLY the markdown notes. No preamble.`;

const NOTES_SYSTEM_SMART = `You are a smart note-taking AI inside a Smart Lecture Notes Generator.

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

Output ONLY the markdown notes. No preamble.`;

router.post("/notes/generate", async (req, res) => {
  try {
    const body = req.body as {
      mode?: "exact" | "smart";
      frames?: { timestamp: number; text: string }[];
      title?: string;
    };
    const mode = body.mode === "exact" ? "exact" : "smart";
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

    const userPrompt = `Lecture title (optional): ${body.title || "Untitled lecture"}\n\nBelow is OCR text extracted from sequential frames of the video. Convert it into structured notes per the rules.\n\n${joined}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: [
        {
          role: "system",
          content: mode === "exact" ? NOTES_SYSTEM_EXACT : NOTES_SYSTEM_SMART,
        },
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

const ASSISTANT_SYSTEM = `You are an AI assistant inside a Smart Lecture Notes Generator web app.

Your job is to help users navigate the app, solve small issues, and explain features simply.

App workflow the user follows:
1. Upload a video file (or paste a YouTube link as reference).
2. Select a capture interval (3s, 5s, or 10s). 5s is recommended.
3. Click Start Processing. The app pauses the video at each interval, captures frames, runs OCR, and removes duplicates.
4. Choose Exact Notes Mode (preserves all detail) or Smart Notes Mode (concise, deduplicated).
5. Click Generate Notes to produce structured markdown notes.

Behavior rules:
- Be friendly and helpful.
- Keep answers short, clear, and step-by-step.
- Focus only on this app and its features.
- If notes look repetitive, suggest a longer interval (5–10s) and Smart Mode.
- If OCR misses text, suggest videos with clearer on-screen text and a higher interval.
- Recommend 5s interval for most videos. Exact Mode for deep study, Smart Mode for revision.
- Do not repeat the same response. Do not give long explanations unless asked.
- No emojis.`;

router.post("/assistant/chat", async (req, res) => {
  try {
    const body = req.body as {
      messages?: { role: "user" | "assistant"; content: string }[];
    };
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (msgs.length === 0) {
      res.status(400).json({ error: "No messages provided" });
      return;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: ASSISTANT_SYSTEM },
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
