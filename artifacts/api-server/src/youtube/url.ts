const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export interface ParsedYouTubeUrl {
  originalUrl: string;
  canonicalUrl: string;
  videoId: string;
}

export class YouTubeUrlError extends Error {
  readonly code = "invalid_url";

  constructor(message: string) {
    super(message);
    this.name = "YouTubeUrlError";
  }
}

function withProtocol(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * Parse only supported single-video YouTube URLs. Playlist-only URLs and
 * lookalike hosts are rejected before any outbound request is made.
 */
export function parseYouTubeUrl(raw: unknown): ParsedYouTubeUrl {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new YouTubeUrlError("Paste a YouTube video URL.");
  }

  const originalUrl = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(withProtocol(originalUrl));
  } catch {
    throw new YouTubeUrlError("That is not a valid URL.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!YOUTUBE_HOSTS.has(hostname)) {
    throw new YouTubeUrlError("Only youtube.com and youtu.be video links are supported.");
  }

  let videoId: string | null = null;
  if (hostname === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (parsed.pathname === "/watch") {
    videoId = parsed.searchParams.get("v");
  } else {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (["embed", "shorts", "live"].includes(parts[0] ?? "")) {
      videoId = parts[1] ?? null;
    }
  }

  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    throw new YouTubeUrlError(
      "Use a direct YouTube video link, such as https://www.youtube.com/watch?v=VIDEO_ID.",
    );
  }

  return {
    originalUrl,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}