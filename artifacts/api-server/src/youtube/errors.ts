export type YouTubeFailureCode =
  | "bot_blocked"
  | "private"
  | "age_restricted"
  | "geo_blocked"
  | "unavailable"
  | "no_formats"
  | "timeout"
  | "tool_missing"
  | "transcript_unavailable"
  | "extractor_failure"
  | "network";

export interface ClassifiedYouTubeError {
  code: YouTubeFailureCode;
  message: string;
  retryable: boolean;
}

export function classifyYouTubeError(raw: string): ClassifiedYouTubeError {
  if (/sign in to confirm|confirm.*not a bot/i.test(raw)) {
    return {
      code: "bot_blocked",
      message:
        "YouTube is blocking access from this server. Download the video and use the Upload tab instead.",
      retryable: false,
    };
  }
  if (/private video|video is private/i.test(raw)) {
    return { code: "private", message: "This video is private.", retryable: false };
  }
  if (/age.?restrict|confirm your age/i.test(raw)) {
    return {
      code: "age_restricted",
      message: "This video is age-restricted and requires sign-in.",
      retryable: false,
    };
  }
  if (/geo.?block|not available in your country/i.test(raw)) {
    return {
      code: "geo_blocked",
      message: "This video is not available from the server's region.",
      retryable: false,
    };
  }
  if (/video has been removed|no longer available|video unavailable/i.test(raw)) {
    return {
      code: "unavailable",
      message: "This video is unavailable or has been removed.",
      retryable: false,
    };
  }
  if (/no video formats found|no suitable format|requested format is not available/i.test(raw)) {
    return {
      code: "no_formats",
      message:
        "YouTube did not provide a playable format for this video from the server.",
      retryable: false,
    };
  }
  if (/timed out|timeout|ETIMEDOUT/i.test(raw)) {
    return {
      code: "timeout",
      message: "YouTube took too long to respond. Please try again.",
      retryable: true,
    };
  }
  if (/spawn .*ENOENT|not found.*yt-dlp|yt-dlp.*not installed/i.test(raw)) {
    return {
      code: "tool_missing",
      message: "The YouTube processing tool is not available on the server.",
      retryable: false,
    };
  }
  if (/ECONNRESET|ECONNREFUSED|ENETUNREACH|network/i.test(raw)) {
    return {
      code: "network",
      message: "The server could not reach YouTube. Please try again.",
      retryable: true,
    };
  }
  return {
    code: "extractor_failure",
    message: "YouTube could not provide usable media for this video.",
    retryable: false,
  };
}

export function isTranscriptUnavailable(raw: string): boolean {
  return /no subtitles|subtitles are not available|requested format is not available|automatic captions are not available/i.test(
    raw,
  );
}