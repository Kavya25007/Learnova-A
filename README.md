# Smart Lecture Notes

Turn lecture and tutorial videos into clean, structured study notes — automatically.

Upload a video or paste a YouTube link, pick a capture interval, and the app uses public captions when available. Otherwise it captures frames, runs OCR on each slide or diagram, deduplicates near-identical frames, then sends the extracted text to AI to produce structured markdown notes.

---

## Features

- **Video upload** — MP4, WebM, MOV (any browser-supported format)
- **YouTube processing** — paste a YouTube link; public captions are used first when available, with supported video download and server-side frame extraction as a fallback
- **Capture interval** — quick picks (3 / 5 / 10 s) plus a custom input (2–15 s). Default: 5 s
- **Perceptual-hash deduplication** — near-duplicate frames are dropped automatically before OCR
- **Client-side OCR** — Tesseract.js runs entirely in the browser; no file is uploaded to a server
- **Two note modes**
  - **Smart** — concise, deduplicated, easy to revise
  - **Exact** — preserves all detail, code blocks, and technical notation
- **Full Video or Custom Time Range** — process the entire video or pick a `mm:ss` start and end time
- **Markdown output** — copy to clipboard or download as `.md`
- **Built-in AI assistant** — chat panel for usage tips and questions about the app

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS v4 |
| OCR | Tesseract.js 5 (in-browser, English) |
| API | Express 5 (Node.js 24) |
| AI | OpenAI GPT via Replit AI Integrations |
| Monorepo | pnpm workspaces |
| Language | TypeScript 5.9 |

---

## Project structure

```
.
├── artifacts/
│   ├── lecture-notes/     # React + Vite frontend
│   │   └── src/
│   │       ├── App.tsx    # Main application component
│   │       └── index.css  # Tailwind + custom styles
│   └── api-server/        # Express API
│       └── src/
│           └── routes/
│               └── lecture.ts   # /api/notes/generate, /api/assistant/chat
├── lib/
│   └── integrations-openai-ai-server/  # OpenAI client wrapper
└── pnpm-workspace.yaml
```

---

## Getting started (Replit)

This project is designed to run on Replit. Open the project and both workflows start automatically:

| Workflow | Command |
|---|---|
| API Server | `pnpm --filter @workspace/api-server run dev` |
| Web app | `pnpm --filter @workspace/lecture-notes run dev` |

The web app is served at `/` and the API at `/api`, routed through a shared reverse proxy.

---

## Running locally (outside Replit)

### Prerequisites

- Node.js 20+
- pnpm 9+
- An OpenAI API key

### Setup

```bash
# Install dependencies
pnpm install

# Set environment variable
export OPENAI_API_KEY=your_key_here
# or add it to a .env file in artifacts/api-server/

# Start the API server (port 8080)
pnpm --filter @workspace/api-server run dev

# Start the frontend (separate terminal)
pnpm --filter @workspace/lecture-notes run dev
```

Open `http://localhost:5173` in your browser. The frontend proxies `/api` requests to port 8080.

---

## API endpoints

### `POST /api/notes/generate`

Converts OCR frame text into structured markdown notes.

**Request body**

```json
{
  "mode": "smart",
  "frames": [
    { "timestamp": 5, "text": "Introduction to Linear Algebra..." },
    { "timestamp": 10, "text": "Vector spaces and subspaces..." }
  ],
  "title": "Linear Algebra Lecture 1"
}
```

**Response**

```json
{
  "notes": "# Linear Algebra Lecture 1\n\n## Introduction\n..."
}
```

`mode` is `"smart"` (concise, deduped) or `"exact"` (full detail preserved).

---

### `POST /api/assistant/chat`

Chat assistant for app navigation help.

**Request body**

```json
{
  "messages": [
    { "role": "user", "content": "What interval should I use for slides?" }
  ]
}
```

**Response**

```json
{
  "reply": "For slide-based lectures, 5 seconds works well..."
}
```

---

### YouTube processing endpoints

#### `GET /api/youtube/meta?url=<youtube-url>`

Validates a single-video YouTube URL and returns title, channel, thumbnail, and video ID. Metadata requests use bounded timeouts and retries. Playlist-only links, non-YouTube hosts, and malformed video IDs are rejected.

#### `POST /api/youtube/start`

Starts an asynchronous YouTube job and returns a job ID.

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "interval": 0,
  "startTime": 0,
  "endTime": null
}
```

`interval: 0` selects adaptive intervals. Connect to `GET /api/youtube/events/<jobId>` for Server-Sent Events. The stream may emit:

- `status` — transcript check, download, or frame extraction progress
- `transcript` — timestamped public caption segments, when available
- `download_progress` — yt-dlp download progress
- `frame_count` and `frame` — extracted video frames when captions are unavailable
- `done` — terminal success event
- `error` — terminal failure event with a user-facing reason

The transcript path uses only captions publicly returned by yt-dlp. The video fallback uses supported yt-dlp behavior only; it does not bypass YouTube authentication, bot checks, age restrictions, geo restrictions, or PO-token requirements. When YouTube blocks access, the job fails clearly and the user can use the Upload tab instead.

---

## How it works

1. User uploads a local video file or submits a YouTube URL.
2. For YouTube, the server checks for public English captions first and sends timestamped text segments when available.
3. If captions are unavailable, the server downloads the video through supported yt-dlp behavior and extracts temporary frames with ffmpeg.
4. For local files, or downloaded YouTube frames, the app seeks at the chosen interval (within the selected range if Custom Time Range is active).
5. Each video frame is captured to a `<canvas>` element and a 16x16 perceptual hash is computed.
6. Frames whose hash differs from the previous accepted frame by 4 bits or fewer are skipped as duplicates.
7. Tesseract.js OCRs each unique video frame entirely in the browser. Caption segments skip OCR because they are already text.
8. The resulting text is sent to `POST /api/notes/generate`.
9. The API calls OpenAI with a structured prompt and returns markdown.
10. Notes are rendered with syntax-highlighted code blocks and full markdown formatting.

---

## Limitations

- YouTube videos cannot be frame-captured directly in the browser due to CORS restrictions. Public captions are preferred by the server; if captions are unavailable, the server attempts supported media download and frame extraction. Restricted videos remain unavailable and should be downloaded by the user and processed through the Upload tab.
- OCR accuracy depends on video resolution and text clarity. Blurry or low-contrast slides may produce incomplete text.
- Very long videos with short intervals produce many frames and increase processing time.
- The AI note generation uses a single API call for all frames. Very large frame sets may exceed token limits; use a longer interval or Custom Time Range to reduce the frame count.

---

## License

MIT
