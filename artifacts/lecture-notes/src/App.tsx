import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Tesseract from "tesseract.js";
import {
  Upload,
  Play,
  Loader2,
  Sparkles,
  FileText,
  MessageCircle,
  Send,
  Download,
  Copy,
  Check,
  Trash2,
  Youtube,
  X,
  HelpCircle,
  Moon,
  Sun,
  Printer,
  BookOpen,
  GraduationCap,
  ClipboardList,
  HelpingHand,
} from "lucide-react";

type Mode = "smart" | "exact" | "detailed" | "exam" | "flashcards" | "quiz";

type YtMeta = { title: string; channel: string; thumbnail: string };

type Frame = {
  id: string;
  timestamp: number;
  thumb: string; // dataURL
  hash: string;
  text: string;
  ocrProgress: number;
  ocrDone: boolean;
};

type ChatMessage = { role: "user" | "assistant"; content: string };

const INTERVALS = [3, 5, 10] as const;
const MIN_INTERVAL = 2;
const MAX_INTERVAL = 15;
const apiBase = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") + "/api";

function classNames(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

// Simple perceptual-ish hash from a downscaled grayscale snapshot.
function quickHash(canvas: HTMLCanvasElement): string {
  const w = 16,
    h = 16;
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  const grays: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i] + data[i + 1] + data[i + 2]) / 3;
    grays.push(g);
    sum += g;
  }
  const avg = sum / grays.length;
  let bits = "";
  for (const g of grays) bits += g > avg ? "1" : "0";
  // pack into hex
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return d;
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function downloadFile(name: string, content: string, type = "text/markdown") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseTime(s: string): number | null {
  if (!s) return null;
  const parts = s.trim().split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || !/^\d+$/.test(p))) return null;
  let total = 0;
  if (parts.length === 1) total = Number(parts[0]);
  else if (parts.length === 2) total = Number(parts[0]) * 60 + Number(parts[1]);
  else if (parts.length === 3)
    total = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  else return null;
  return Number.isFinite(total) ? total : null;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [youtubeUrl, setYoutubeUrl] = useState<string>("");
  const [interval, setInterval] = useState<number>(5);
  const [mode, setMode] = useState<Mode>("smart");
  const [title, setTitle] = useState<string>("");
  const [rangeMode, setRangeMode] = useState<"full" | "custom">("full");
  const [startTime, setStartTime] = useState<string>("00:00");
  const [endTime, setEndTime] = useState<string>("00:30");

  const [frames, setFrames] = useState<Frame[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<string>("");
  const cancelRef = useRef(false);

  const [notes, setNotes] = useState<string>("");
  const [generatingNotes, setGeneratingNotes] = useState(false);
  const [copied, setCopied] = useState(false);

  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hi! I am your notes assistant. Ask me how to use the app, or for tips on getting better notes.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [darkMode, setDarkMode] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  const [ytMeta, setYtMeta] = useState<YtMeta | null>(null);
  const [ytMetaLoading, setYtMetaLoading] = useState(false);
  // Processing stats
  const [statFrames, setStatFrames] = useState(0);
  const [statOcr, setStatOcr] = useState(0);
  const [statElapsed, setStatElapsed] = useState(0);
  const processingStartRef = useRef<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  useEffect(() => {
    if (!videoFile) {
      setVideoUrl("");
      return;
    }
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [chat, chatLoading]);

  const ytEmbed = useMemo(() => {
    if (!youtubeUrl) return "";
    const m = youtubeUrl.match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/,
    );
    return m ? `https://www.youtube.com/embed/${m[1]}` : "";
  }, [youtubeUrl]);

  // Fetch YouTube metadata when URL changes
  useEffect(() => {
    if (!youtubeUrl) { setYtMeta(null); return; }
    const m = youtubeUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/);
    if (!m) { setYtMeta(null); return; }
    setYtMetaLoading(true);
    setYtMeta(null);
    fetch(`${apiBase}/youtube/meta?url=${encodeURIComponent(youtubeUrl)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setYtMeta(d as YtMeta); })
      .catch(() => {})
      .finally(() => setYtMetaLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [youtubeUrl]);

  function reset() {
    cancelRef.current = false;
    setFrames([]);
    setNotes("");
    setProgress(0);
    setPhase("");
    setStatFrames(0);
    setStatOcr(0);
    setStatElapsed(0);
  }

  // Enhance canvas contrast/brightness to improve OCR
  function preprocessCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d")!;
    ctx.filter = "contrast(1.4) brightness(1.05) saturate(0)";
    ctx.drawImage(src, 0, 0);
    ctx.filter = "none";
    return out;
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      reset();
      setVideoFile(f);
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    }
  }

  async function startProcessing() {
    if (!videoRef.current || !videoUrl) return;
    const video = videoRef.current;
    if (!video.duration || isNaN(video.duration)) {
      // wait briefly
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!video.duration || isNaN(video.duration)) {
      alert("Cannot read video duration. Try another file.");
      return;
    }

    reset();
    setProcessing(true);
    cancelRef.current = false;
    processingStartRef.current = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setStatElapsed(Math.round((Date.now() - processingStartRef.current) / 1000));
    }, 1000);

    const captured: Frame[] = [];
    const canvas = document.createElement("canvas");
    const w = Math.min(960, video.videoWidth || 960);
    const h = Math.round(
      ((video.videoHeight || 540) / (video.videoWidth || 960)) * w,
    );
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;

    const duration = video.duration;

    let startSec = 0;
    let endSec = duration;
    if (rangeMode === "custom") {
      const s = parseTime(startTime);
      const e = parseTime(endTime);
      if (s == null || e == null) {
        alert("Enter start and end times as mm:ss (e.g. 01:30).");
        setProcessing(false);
        return;
      }
      if (e <= s) {
        alert("End time must be greater than start time.");
        setProcessing(false);
        return;
      }
      startSec = Math.max(0, Math.min(s, duration - 0.1));
      endSec = Math.max(startSec + interval, Math.min(e, duration));
    }

    const span = Math.max(0, endSec - startSec);
    const steps = Math.max(1, Math.floor(span / interval));
    setPhase(
      rangeMode === "custom"
        ? `Capturing frames every ${interval}s from ${formatTime(startSec)} to ${formatTime(endSec)}`
        : `Capturing frames every ${interval}s`,
    );

    video.pause();
    video.muted = true;

    const seekTo = (t: number) =>
      new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        try {
          video.currentTime = Math.min(t, duration - 0.05);
        } catch {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        }
      });

    for (let i = 0; i <= steps; i++) {
      if (cancelRef.current) break;
      const t = Math.min(startSec + i * interval, endSec - 0.05, duration - 0.05);
      if (t < startSec) continue;
      await seekTo(t);
      // give the browser a tick to paint
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      ctx.drawImage(video, 0, 0, w, h);
      const hash = quickHash(canvas);

      // dedupe against last accepted frame
      const last = captured[captured.length - 1];
      if (last && hammingHex(last.hash, hash) <= 4) {
        setProgress(Math.round(((i + 1) / (steps + 1)) * 50));
        continue;
      }

      const processed = preprocessCanvas(canvas);
      const thumb = processed.toDataURL("image/jpeg", 0.78);
      captured.push({
        id: `${i}-${t.toFixed(2)}`,
        timestamp: t,
        thumb,
        hash,
        text: "",
        ocrProgress: 0,
        ocrDone: false,
      });
      setFrames([...captured]);
      setStatFrames(captured.length);
      setProgress(Math.round(((i + 1) / (steps + 1)) * 50));
    }

    if (cancelRef.current) {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      setProcessing(false);
      setPhase("Cancelled");
      return;
    }

    setPhase(`Running OCR on ${captured.length} unique frames`);

    // OCR sequentially to avoid overloading
    for (let i = 0; i < captured.length; i++) {
      if (cancelRef.current) break;
      const f = captured[i];
      try {
        const result = await Tesseract.recognize(f.thumb, "eng", {
          logger: (m) => {
            if (m.status === "recognizing text") {
              const localProg = m.progress || 0;
              captured[i] = { ...captured[i], ocrProgress: localProg };
              setFrames([...captured]);
            }
          },
        });
        captured[i] = {
          ...captured[i],
          text: (result.data.text || "").trim(),
          ocrProgress: 1,
          ocrDone: true,
        };
      } catch (e) {
        captured[i] = {
          ...captured[i],
          text: "",
          ocrProgress: 1,
          ocrDone: true,
        };
      }
      setFrames([...captured]);
      setStatOcr(i + 1);
      setProgress(50 + Math.round(((i + 1) / captured.length) * 50));
    }

    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    setStatElapsed(Math.round((Date.now() - processingStartRef.current) / 1000));

    // Drop frames with very little text (likely no slide content)
    const filtered = captured.filter((f) => f.text.replace(/\s+/g, "").length >= 8);
    setFrames(filtered);
    setStatFrames(filtered.length);
    setProcessing(false);
    setPhase(
      filtered.length
        ? `Done. ${filtered.length} frame(s) with text.`
        : "Done. No readable text was found.",
    );
  }

  function cancelProcessing() {
    cancelRef.current = true;
  }

  async function generateNotes() {
    if (frames.length === 0) return;
    setGeneratingNotes(true);
    setNotes("");
    try {
      const payload = {
        mode,
        title,
        frames: frames.map((f) => ({ timestamp: f.timestamp, text: f.text })),
      };
      const res = await fetch(`${apiBase}/notes/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNotes(data.notes || "");
    } catch (e) {
      setNotes(
        `> Failed to generate notes. Please try again.\n\n\`${(e as Error).message}\``,
      );
    } finally {
      setGeneratingNotes(false);
    }
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    const next: ChatMessage[] = [...chat, { role: "user", content: text }];
    setChat(next);
    setChatInput("");
    setChatLoading(true);
    try {
      const res = await fetch(`${apiBase}/assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, notes: notes || undefined }),
      });
      const data = await res.json();
      setChat([
        ...next,
        {
          role: "assistant",
          content: data.content || "Sorry, I could not respond. Try again.",
        },
      ]);
    } catch {
      setChat([
        ...next,
        { role: "assistant", content: "Network error. Please try again." },
      ]);
    } finally {
      setChatLoading(false);
    }
  }

  const totalText = frames.reduce((n, f) => n + f.text.length, 0);

  return (
    <div className="min-h-screen app-bg text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-30 glass">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-accent grid place-items-center text-primary-foreground shadow-md">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-semibold leading-tight">
                Smart Lecture Notes
              </h1>
              <p className="text-[11px] text-muted-foreground leading-tight">
                Video → Frames → OCR → Structured notes
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDarkMode((d) => !d)}
              className="p-2 rounded-lg border border-border bg-card hover:bg-secondary transition"
              title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setChatOpen(true)}
              className="hidden sm:inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card hover:bg-secondary text-sm transition"
            >
              <HelpCircle className="w-4 h-4" />
              Assistant
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: input + video + frames */}
        <section className="lg:col-span-7 space-y-6">
          {/* Source */}
          <div className="glass rounded-xl p-4 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">1. Add your video</h2>
              <span className="text-xs text-muted-foreground">
                Upload a file or paste a YouTube link
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label
                className={classNames(
                  "cursor-pointer group",
                  youtubeUrl && "opacity-50 pointer-events-none",
                )}
              >
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  disabled={!!youtubeUrl}
                  onChange={(e) => {
                    setYoutubeUrl("");
                    onPickFile(e);
                  }}
                />
                <div className="rounded-lg border border-dashed border-border bg-card hover:border-primary hover:bg-secondary transition p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-md bg-primary/10 grid place-items-center text-primary">
                    <Upload className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Upload video file</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {videoFile ? videoFile.name : "MP4, WebM, MOV"}
                    </p>
                  </div>
                </div>
              </label>

              <div
                className={classNames(
                  "rounded-lg border border-border bg-card p-3 flex items-center gap-2",
                  videoFile && "opacity-50 pointer-events-none",
                )}
              >
                <Youtube className="w-5 h-5 text-destructive shrink-0" />
                <input
                  type="url"
                  value={youtubeUrl}
                  disabled={!!videoFile}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  placeholder="Paste YouTube link (preview only)"
                  className="bg-transparent outline-none text-sm w-full placeholder:text-muted-foreground"
                />
                {youtubeUrl && (
                  <button
                    onClick={() => setYoutubeUrl("")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Use one source at a time — uploading a file disables the link, and vice versa.
            </p>

            {youtubeUrl && !videoUrl && (
              <>
                {ytMetaLoading && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching video info...
                  </div>
                )}
                {ytMeta && (
                  <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                    <img
                      src={ytMeta.thumbnail}
                      alt="thumbnail"
                      className="w-20 h-12 rounded object-cover shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{ytMeta.title}</p>
                      <p className="text-xs text-muted-foreground">{ytMeta.channel}</p>
                    </div>
                  </div>
                )}
                {ytEmbed && (
                  <div className="mt-3 rounded-lg overflow-hidden border border-border aspect-video bg-black">
                    <iframe
                      src={ytEmbed}
                      className="w-full h-full"
                      allow="accelerated-2d-canvas; encrypted-media; picture-in-picture"
                      allowFullScreen
                    />
                    <p className="text-[11px] text-muted-foreground p-2 bg-card">
                      YouTube embeds cannot be processed directly due to browser restrictions.
                      Download the video and upload it as a file to extract notes.
                    </p>
                  </div>
                )}
              </>
            )}

            {videoUrl && (
              <div className="mt-4">
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  className="w-full rounded-lg bg-black aspect-video"
                  crossOrigin="anonymous"
                  preload="metadata"
                />
              </div>
            )}

            <div className="mt-4">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Lecture title (optional)"
                className="w-full px-3 py-2 rounded-lg bg-card border border-border outline-none focus:ring-2 focus:ring-ring text-sm"
              />
            </div>
          </div>

          {/* Settings */}
          <div className="glass rounded-xl p-4 sm:p-5">
            <h2 className="font-semibold mb-3">2. Settings</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted-foreground">
                  Capture interval
                </label>
                <div className="mt-2 flex gap-2">
                  {INTERVALS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setInterval(s)}
                      className={classNames(
                        "px-3 py-2 rounded-lg text-sm border transition flex-1",
                        interval === s
                          ? "bg-primary text-primary-foreground border-primary shadow"
                          : "bg-card border-border hover:bg-secondary",
                      )}
                    >
                      {s}s {s === 5 && <span className="text-[10px] opacity-80">rec.</span>}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-[11px] text-muted-foreground shrink-0">
                    Custom ({MIN_INTERVAL}–{MAX_INTERVAL}s):
                  </label>
                  <input
                    type="number"
                    min={MIN_INTERVAL}
                    max={MAX_INTERVAL}
                    step={1}
                    value={interval}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) {
                        setInterval(
                          Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, Math.round(n))),
                        );
                      }
                    }}
                    className="w-20 px-2 py-1 rounded-md bg-card border border-border text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Recommended: 5 seconds
                  </span>
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs text-muted-foreground">Notes mode</label>
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {(
                    [
                      { key: "smart",      icon: <Sparkles className="w-3.5 h-3.5" />,      label: "Smart",       desc: "Concise, deduped" },
                      { key: "exact",      icon: <FileText className="w-3.5 h-3.5" />,       label: "Exact",       desc: "Full detail + code" },
                      { key: "detailed",   icon: <BookOpen className="w-3.5 h-3.5" />,       label: "Detailed",    desc: "Summary + key concepts" },
                      { key: "exam",       icon: <GraduationCap className="w-3.5 h-3.5" />,  label: "Exam Revision", desc: "Common questions + tips" },
                      { key: "flashcards", icon: <ClipboardList className="w-3.5 h-3.5" />,  label: "Flashcards",  desc: "Q&A study cards" },
                      { key: "quiz",       icon: <HelpingHand className="w-3.5 h-3.5" />,    label: "Quiz",        desc: "Multiple-choice test" },
                    ] as { key: string; icon: React.ReactNode; label: string; desc: string }[]
                  ).map(({ key, icon, label, desc }) => (
                    <button
                      key={key}
                      onClick={() => setMode(key as typeof mode)}
                      className={classNames(
                        "px-3 py-2 rounded-lg text-sm border transition text-left",
                        mode === key
                          ? "bg-primary text-primary-foreground border-primary shadow"
                          : "bg-card border-border hover:bg-secondary",
                      )}
                    >
                      <div className="flex items-center gap-1.5 font-medium">{icon} {label}</div>
                      <p className={classNames("text-[10px] mt-0.5", mode === key ? "text-primary-foreground/80" : "text-muted-foreground")}>
                        {desc}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4">
              <label className="text-xs text-muted-foreground">Video range</label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  onClick={() => setRangeMode("full")}
                  className={classNames(
                    "px-3 py-2 rounded-lg text-sm border transition text-left",
                    rangeMode === "full"
                      ? "bg-primary text-primary-foreground border-primary shadow"
                      : "bg-card border-border hover:bg-secondary",
                  )}
                >
                  <div className="font-medium">Full Video Notes</div>
                  <p
                    className={classNames(
                      "text-[11px] mt-0.5",
                      rangeMode === "full"
                        ? "text-primary-foreground/85"
                        : "text-muted-foreground",
                    )}
                  >
                    Process the entire video
                  </p>
                </button>
                <button
                  onClick={() => setRangeMode("custom")}
                  className={classNames(
                    "px-3 py-2 rounded-lg text-sm border transition text-left",
                    rangeMode === "custom"
                      ? "bg-accent text-accent-foreground border-accent shadow"
                      : "bg-card border-border hover:bg-secondary",
                  )}
                >
                  <div className="font-medium">Custom Time Range</div>
                  <p
                    className={classNames(
                      "text-[11px] mt-0.5",
                      rangeMode === "custom"
                        ? "text-accent-foreground/85"
                        : "text-muted-foreground",
                    )}
                  >
                    Process only a selected portion
                  </p>
                </button>
              </div>
              {rangeMode === "custom" && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] text-muted-foreground">
                      Start (mm:ss)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      placeholder="00:00"
                      className="mt-1 w-full px-3 py-2 rounded-lg bg-card border border-border outline-none focus:ring-2 focus:ring-ring text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground">
                      End (mm:ss)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      placeholder="01:30"
                      className="mt-1 w-full px-3 py-2 rounded-lg bg-card border border-border outline-none focus:ring-2 focus:ring-ring text-sm font-mono"
                    />
                  </div>
                  <p className="col-span-2 text-[11px] text-muted-foreground">
                    Frames will be captured every {interval}s within this range only.
                  </p>
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {!processing ? (
                <button
                  onClick={startProcessing}
                  disabled={!videoUrl}
                  title={!videoUrl ? "Upload a video file first" : "Capture frames and run OCR"}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium shadow hover:opacity-95 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  <Play className="w-4 h-4" /> Start Processing
                </button>
              ) : (
                <button
                  onClick={cancelProcessing}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-destructive text-destructive-foreground font-medium shadow hover:opacity-95 transition"
                >
                  <X className="w-4 h-4" /> Cancel
                </button>
              )}

              <button
                onClick={generateNotes}
                disabled={frames.length === 0 || generatingNotes || processing}
                title={
                  frames.length === 0
                    ? "Run Start Processing first to capture frames"
                    : "Generate structured notes from the captured frames"
                }
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-foreground text-background font-medium shadow hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {generatingNotes ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Generate Notes
              </button>

              {(frames.length > 0 || notes) && (
                <button
                  onClick={() => {
                    reset();
                  }}
                  className="inline-flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border bg-card hover:bg-secondary text-sm transition"
                >
                  <Trash2 className="w-4 h-4" /> Clear
                </button>
              )}
            </div>

            {!videoUrl && (
              <p className="mt-3 text-xs text-muted-foreground">
                Upload a video file above to enable
                <span className="text-foreground font-medium"> Start Processing</span>.
                YouTube links are preview-only.
              </p>
            )}
            {videoUrl && frames.length === 0 && !processing && (
              <p className="mt-3 text-xs text-muted-foreground">
                Click <span className="text-foreground font-medium">Start Processing</span>{" "}
                to capture frames. Then{" "}
                <span className="text-foreground font-medium">Generate Notes</span> will activate.
              </p>
            )}

            {(processing || phase) && (
              <div className="mt-4">
                <div className="h-2 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-accent transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-2">{phase}</p>
                {(processing || statFrames > 0) && (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-lg bg-secondary/60 border border-border px-3 py-2 text-center">
                      <p className="text-lg font-semibold tabular-nums">{statFrames}</p>
                      <p className="text-[10px] text-muted-foreground">Frames</p>
                    </div>
                    <div className="rounded-lg bg-secondary/60 border border-border px-3 py-2 text-center">
                      <p className="text-lg font-semibold tabular-nums">{statOcr}</p>
                      <p className="text-[10px] text-muted-foreground">OCR done</p>
                    </div>
                    <div className="rounded-lg bg-secondary/60 border border-border px-3 py-2 text-center">
                      <p className="text-lg font-semibold tabular-nums">
                        {statElapsed < 60 ? `${statElapsed}s` : `${Math.floor(statElapsed / 60)}m${statElapsed % 60}s`}
                      </p>
                      <p className="text-[10px] text-muted-foreground">Elapsed</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Frames */}
          {frames.length > 0 && (
            <div className="glass rounded-xl p-4 sm:p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold">
                  Captured frames{" "}
                  <span className="text-xs text-muted-foreground font-normal">
                    ({frames.length} unique • {totalText.toLocaleString()} chars OCR)
                  </span>
                </h2>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[520px] overflow-auto pr-1">
                {frames.map((f) => (
                  <div
                    key={f.id}
                    className="rounded-lg border border-border bg-card overflow-hidden"
                  >
                    <div className="relative aspect-video bg-black">
                      <img
                        src={f.thumb}
                        className="w-full h-full object-contain"
                        alt={`Frame at ${fmtTime(f.timestamp)}`}
                      />
                      <span className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white">
                        {fmtTime(f.timestamp)}
                      </span>
                    </div>
                    <div className="p-2">
                      <div className="h-1 rounded-full bg-secondary overflow-hidden">
                        <div
                          className={classNames(
                            "h-full transition-all",
                            f.ocrDone ? "bg-emerald-500" : "bg-primary",
                          )}
                          style={{ width: `${Math.round(f.ocrProgress * 100)}%` }}
                        />
                      </div>
                      <p className="mt-1.5 text-[11px] text-muted-foreground line-clamp-3 min-h-[2.4em]">
                        {f.text || (f.ocrDone ? "(no text)" : "Reading text...")}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Right: notes */}
        <aside className="lg:col-span-5">
          <div className="glass rounded-xl p-4 sm:p-5 lg:sticky lg:top-[76px]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" /> Generated notes
              </h2>
              {notes && (
                <div className="flex items-center gap-1 flex-wrap">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(notes);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-card hover:bg-secondary transition"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    onClick={() =>
                      downloadFile(
                        `${(title || "lecture-notes").replace(/\s+/g, "-")}.md`,
                        notes,
                      )
                    }
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-card hover:bg-secondary transition"
                  >
                    <Download className="w-3.5 h-3.5" /> .md
                  </button>
                  <button
                    onClick={() => window.print()}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-card hover:bg-secondary transition"
                    title="Print or save as PDF"
                  >
                    <Printer className="w-3.5 h-3.5" /> PDF
                  </button>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-card p-4 min-h-[420px] max-h-[72vh] overflow-auto">
              {generatingNotes && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Writing notes...
                </div>
              )}
              {!generatingNotes && !notes && (
                <div className="text-sm text-muted-foreground space-y-3">
                  <p className="font-medium text-foreground">No notes yet.</p>
                  <ol className="list-decimal pl-5 space-y-1.5">
                    <li>Upload a video file.</li>
                    <li>Pick an interval (5s recommended).</li>
                    <li>Click <span className="text-foreground font-medium">Start Processing</span>.</li>
                    <li>Choose Smart or Exact mode.</li>
                    <li>Click <span className="text-foreground font-medium">Generate Notes</span>.</li>
                  </ol>
                </div>
              )}
              {!generatingNotes && notes && (
                <div key={notes.length} className="prose-notes text-sm notes-fade-in">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </aside>
      </main>

      {/* Floating chat button (mobile) */}
      <button
        onClick={() => setChatOpen(true)}
        className="sm:hidden fixed bottom-5 right-5 w-12 h-12 rounded-full bg-primary text-primary-foreground shadow-lg grid place-items-center"
      >
        <MessageCircle className="w-5 h-5" />
      </button>

      {/* Chat panel */}
      {chatOpen && (
        <div className="fixed inset-0 z-40 flex justify-end" onClick={() => setChatOpen(false)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
          <div
            className="relative w-full sm:max-w-md bg-card border-l border-border h-full flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-md bg-primary/10 grid place-items-center text-primary">
                  <MessageCircle className="w-4 h-4" />
                </div>
                <div>
                  <p className="font-semibold text-sm">Notes Assistant</p>
                  <p className="text-[11px] text-muted-foreground">
                    Help with the app and tips
                  </p>
                </div>
              </div>
              <button
                onClick={() => setChatOpen(false)}
                className="p-1.5 rounded-md hover:bg-secondary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div ref={chatScrollRef} className="flex-1 overflow-auto p-4 space-y-3">
              {chat.map((m, i) => (
                <div
                  key={i}
                  className={classNames(
                    "flex",
                    m.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={classNames(
                      "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                      m.role === "user"
                        ? "bg-primary text-primary-foreground rounded-br-sm"
                        : "bg-secondary text-secondary-foreground rounded-bl-sm",
                    )}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-secondary text-secondary-foreground rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking...
                  </div>
                </div>
              )}
            </div>

            <div className="p-3 border-t border-border">
              <div className="flex items-end gap-2">
                <textarea
                  rows={1}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendChat();
                    }
                  }}
                  placeholder="Ask about intervals, modes, or how to use the app..."
                  className="flex-1 resize-none px-3 py-2 rounded-lg bg-background border border-border outline-none focus:ring-2 focus:ring-ring text-sm max-h-32"
                />
                <button
                  onClick={sendChat}
                  disabled={!chatInput.trim() || chatLoading}
                  className="p-2.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  "How do I use this app?",
                  "Notes look repetitive — fix?",
                  "Best interval for slides?",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => setChatInput(q)}
                    className="text-[11px] px-2 py-1 rounded-full border border-border bg-background hover:bg-secondary transition"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
