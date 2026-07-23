---
name: YouTube pipeline bugs
description: Three bugs that broke the YouTube processing pipeline; root causes and fixes applied 2026-07-23
---

## Bug 1 — youtubei.js crashes Node.js process (unhandled PlayerError)
`youtubei.js` was added in a prior session as a "primary resolver" before yt-dlp fallback.
After its try/catch exits, the library spawns a background async task that calls `format.decipher()` on a format with no valid cipher data — throwing `PlayerError` as an unhandled rejection that kills the Node.js process.

**Fix:** Remove `youtubei.js` entirely. It is not part of the original implementation and causes crashes.

## Bug 2 — `android_embedded` is not a valid yt-dlp client
The client name `android_embedded` does not exist in yt-dlp 2025.06.30. yt-dlp silently falls back to `tv`/`ios` clients when it sees an unknown client name, which then fail for many videos.

**Fix:** Use `android` as the primary client. Format `18` (360p combined mp4) is accessible via the `android` client without a PO token for many public videos.

## Bug 3 — for-loop had no try/catch; first failure throws out of the whole function
`downloadWithYtDlp` iterated over clients but did not wrap the spawn promise in try/catch. The first client failure propagated out of the entire function instead of continuing to the next client.

**Fix:** Wrap the inner `await new Promise(...)` in try/catch inside the loop; log the failure and continue to the next client. Break early only for definitive blocks (bot-check, private, age-restricted).

## Working approach (as of fix)
- Phase 1: `yt-dlp` downloads video **to a temp file** (not `--get-url` streaming)
  - Clients tried in order: `android` → `ios` → `tv_embedded`
  - Format: `18/best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best`
  - Uses `spawn` (not `execFile`) to stream real-time progress events via SSE
- Phase 2: `stat()` to verify file exists and is non-zero size
- Phase 3: `ffprobe` on the local file for duration
- Phase 4: `ffmpeg` frame extraction from the local file
- Phase 5: Read frames and push via SSE `frame` events

## Known limitation
YouTube enforces SABR-only streaming for many educational videos from datacenter IPs (e.g. `YTJdBA9wZro`). These are completely inaccessible without a PO token. Format 18 (legacy 360p) is NOT available for many newer/educational videos. The error classification correctly identifies this and suggests downloading + using the Upload tab.

**Why:** PO token generation requires running YouTube's botguard JS; no server-side workaround exists without that.
