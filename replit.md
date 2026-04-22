# Workspace

## Overview

Smart Lecture Notes Generator — a web app that turns lecture/tutorial videos into structured study notes via frame capture, OCR, and AI summarization. Built as a pnpm monorepo.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **AI**: OpenAI via Replit AI Integrations (no key required)
- **Frontend**: React 19 + Vite + Tailwind v4
- **OCR**: tesseract.js (client-side)

## Artifacts

- `artifacts/lecture-notes` (web, `/`) — main Smart Lecture Notes UI: upload video, set capture interval (3s/5s/10s), capture frames + OCR, generate Exact or Smart mode notes (markdown), built-in assistant chat.
- `artifacts/api-server` (api, `/api`) — Express server exposing:
  - `POST /api/notes/generate` — turns OCR frame text into structured markdown notes (Exact or Smart mode).
  - `POST /api/assistant/chat` — chat helper for app navigation/tips.
- `artifacts/mockup-sandbox` (design, `/__mockup`) — design canvas (unused for this build).

## Key Commands

- `pnpm run typecheck` — full typecheck
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/lecture-notes run dev` — run web app locally

## How the app works

1. User uploads a video file (YouTube links can be previewed but cannot be processed in-browser).
2. App seeks the video at a chosen interval, captures each frame to a canvas, and computes a quick perceptual hash to drop near-duplicate frames.
3. Tesseract.js OCRs each unique frame in the browser.
4. Frame text is sent to the API which uses OpenAI to produce structured markdown notes in either Exact or Smart mode.
5. A side chat assistant guides users with usage tips.
